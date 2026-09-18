import type { PgPool } from "./db.js";
import {
  aggregateWindow,
  deriveEpisodes,
  stageThresholds,
  windowStart,
} from "./domain.js";
import type {
  Metric,
  ReadingInput,
  RejectedLine,
  Thresholds,
  UnitRecord,
} from "./types.js";

interface ValidReading extends ReadingInput {
  unit_id: string;
  line: number;
}

export interface IngestOutcome {
  accepted: Array<{
    line: number;
    reading_id: string;
    unit_id: string;
    window_start: string;
  }>;
  rejected: RejectedLine[];
  windows_changed: Array<{ unit_id: string; window_start: string; risk: string }>;
  alert_transitions: Array<{
    unit_id: string;
    opened_window: string;
    transition: "opened" | "recovered";
  }>;
}

interface StoredWindow {
  unit_id: string;
  window_start: Date;
  risk: "normal" | "watch" | "critical";
}

/**
 * Ingests one validated batch atomically:
 *
 *  1. locks every affected unit so concurrent batches for the same unit
 *     serialise (deterministic event-time results);
 *  2. rejects persisted duplicate reading_ids and readings more than
 *     late_arrival_minutes behind the unit event-time watermark;
 *  3. inserts readings, advances watermarks, and recomputes every affected
 *     window from its readings (idempotent aggregation);
 *  4. re-derives alert episodes over the unit's complete window history and
 *     reconciles them by stable identity (unit_id, opened_window), so late
 *     data updates transitions in place instead of duplicating them.
 */
export async function ingestBatch(
  pool: PgPool,
  validReadings: ValidReading[],
  parseRejections: RejectedLine[],
  thresholds: Thresholds,
  units: Map<string, UnitRecord>,
): Promise<IngestOutcome> {
  const rejected = [...parseRejections];
  const accepted: IngestOutcome["accepted"] = [];
  const transitions: IngestOutcome["alert_transitions"] = [];
  const windowsChanged: IngestOutcome["windows_changed"] = [];

  if (validReadings.length === 0) {
    return { accepted, rejected, windows_changed: windowsChanged, alert_transitions: transitions };
  }

  const unitIds = [...new Set(validReadings.map((r) => r.unit_id))].sort();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialise per unit. Row locks on units also order concurrent batches.
    const { rows: locked } = await client.query<{ unit_id: string }>(
      "SELECT unit_id FROM units WHERE unit_id = ANY($1::text[]) ORDER BY unit_id FOR UPDATE",
      [unitIds],
    );
    if (locked.length !== unitIds.length) {
      throw new Error("internal: unit lock set mismatch");
    }

    // Persisted duplicate check.
    const candidateIds = validReadings.map((r) => r.reading_id);
    const { rows: dupRows } = await client.query<{ reading_id: string }>(
      "SELECT reading_id FROM readings WHERE reading_id = ANY($1::text[])",
      [candidateIds],
    );
    const persistedDuplicates = new Set(dupRows.map((r) => r.reading_id));

    // Per-unit running watermark (max accepted event time so far).
    const { rows: wmRows } = await client.query<{
      unit_id: string;
      watermark: Date;
    }>(
      `SELECT unit_id, watermark FROM unit_watermarks
       WHERE unit_id = ANY($1::text[])`,
      [unitIds],
    );
    const watermark = new Map<string, Date>();
    for (const row of wmRows) watermark.set(row.unit_id, row.watermark);

    const lateMs = thresholds.late_arrival_minutes * 60_000;
    const toInsert: ValidReading[] = [];
    const affectedWindows = new Map<string, Set<string>>();

    // Arrival order inside the batch is physical line order.
    for (const reading of [...validReadings].sort((a, b) => a.line - b.line)) {
      if (persistedDuplicates.has(reading.reading_id)) {
        rejected.push({
          line: reading.line,
          code: "duplicate_reading_id",
          message: `reading_id ${reading.reading_id} already persisted`,
          reading_id: reading.reading_id,
        });
        continue;
      }
      const observedAt = new Date(reading.observed_at);
      const wm = watermark.get(reading.unit_id);
      if (wm) {
        const behind = wm.getTime() - observedAt.getTime();
        if (behind > lateMs) {
          rejected.push({
            line: reading.line,
            code: "too_late",
            message:
              `reading is ${Math.round(behind / 60000)} minutes behind the unit watermark ` +
              `${wm.toISOString()}; lateness limit is ${thresholds.late_arrival_minutes} minutes`,
            reading_id: reading.reading_id,
          });
          continue;
        }
      }

      toInsert.push(reading);
      if (!wm || observedAt.getTime() > wm.getTime()) {
        watermark.set(reading.unit_id, observedAt);
      }
      const start = windowStart(observedAt, thresholds.window_minutes);
      const key = start.toISOString();
      let set = affectedWindows.get(reading.unit_id);
      if (!set) {
        set = new Set();
        affectedWindows.set(reading.unit_id, set);
      }
      set.add(key);
    }

    if (toInsert.length > 0) {
      // Bulk insert readings.
      const cols = [
        "reading_id",
        "sensor_id",
        "unit_id",
        "metric",
        "observed_at",
        "value",
      ];
      const values: unknown[] = [];
      const placeholders = toInsert
        .map((r, i) => {
          const base = i * cols.length;
          values.push(
            r.reading_id,
            r.sensor_id,
            r.unit_id,
            r.metric,
            new Date(r.observed_at),
            r.value,
          );
          return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`;
        })
        .join(",");
      await client.query(
        `INSERT INTO readings (${cols.join(",")}) VALUES ${placeholders}`,
        values,
      );

      // Advance watermarks.
      for (const [unitId, wm] of watermark) {
        await client.query(
          `INSERT INTO unit_watermarks (unit_id, watermark, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (unit_id) DO UPDATE SET watermark = EXCLUDED.watermark, updated_at = now()`,
          [unitId, wm],
        );
      }

      // Recompute affected units from the earliest affected window through
      // the unit's last window that contains data.
      const recomputedUnits = new Set(toInsert.map((r) => r.unit_id));
      for (const unitId of recomputedUnits) {
        const affectedStarts = [...(affectedWindows.get(unitId) ?? [])].sort();
        const earliest = affectedStarts[0]!;

        const { rows: pointRows } = await client.query<{
          metric: Metric;
          observed_at: Date;
          value: number;
        }>(
          `SELECT metric, observed_at, value FROM readings
           WHERE unit_id = $1 AND observed_at >= $2
           ORDER BY observed_at`,
          [unitId, earliest],
        );

        const groups = new Map<
          string,
          Array<{ metric: Metric; observed_at: Date; value: number }>
        >();
        let lastStart = earliest;
        for (const row of pointRows) {
          const start = windowStart(
            row.observed_at,
            thresholds.window_minutes,
          ).toISOString();
          if (start > lastStart) lastStart = start;
          const list = groups.get(start) ?? [];
          list.push({
            metric: row.metric,
            observed_at: new Date(row.observed_at),
            value: row.value,
          });
          groups.set(start, list);
        }

        const unit = units.get(unitId);
        if (!unit) throw new Error(`internal: unknown unit ${unitId}`);
        const stage = stageThresholds(thresholds, unit.growth_stage);
        const affectedSet = affectedWindows.get(unitId) ?? new Set<string>();

        for (const [startIso, points] of groups) {
          // Only windows whose inputs actually changed are rewritten; alert
          // episodes further below are still re-derived from full history.
          if (!affectedSet.has(startIso)) continue;
          const aggregation = aggregateWindow(points, stage);
          const start = new Date(startIso);
          await client.query(
            `INSERT INTO window_results
               (unit_id, window_start, growth_stage, risk, metric_breakdown,
                sample_count, metrics_present, first_observed_at, last_observed_at,
                threshold_version, recompute_count, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,now())
             ON CONFLICT (unit_id, window_start) DO UPDATE SET
               growth_stage = EXCLUDED.growth_stage,
               risk = EXCLUDED.risk,
               metric_breakdown = EXCLUDED.metric_breakdown,
               sample_count = EXCLUDED.sample_count,
               metrics_present = EXCLUDED.metrics_present,
               first_observed_at = EXCLUDED.first_observed_at,
               last_observed_at = EXCLUDED.last_observed_at,
               threshold_version = EXCLUDED.threshold_version,
               recompute_count = window_results.recompute_count + 1,
               updated_at = now()`,
            [
              unitId,
              start,
              unit.growth_stage,
              aggregation.risk,
              JSON.stringify(aggregation.breakdown),
              aggregation.sampleCount,
              aggregation.metricsPresent,
              aggregation.firstObservedAt,
              aggregation.lastObservedAt,
              thresholds.threshold_version,
            ],
          );
          windowsChanged.push({
            unit_id: unitId,
            window_start: startIso,
            risk: aggregation.risk,
          });
        }
      }

      // Reconcile alert episodes over each affected unit's FULL history.
      for (const unitId of new Set(toInsert.map((r) => r.unit_id))) {
        const { rows: windowRows } = await client.query<StoredWindow>(
          `SELECT unit_id, window_start, risk FROM window_results
           WHERE unit_id = $1 ORDER BY window_start`,
          [unitId],
        );
        const derived = deriveEpisodes(
          unitId,
          windowRows.map((w) => ({
            window_start: new Date(w.window_start),
            risk: w.risk,
          })),
          thresholds.window_minutes,
        );

        const { rows: existingRows } = await client.query<{
          id: number;
          opened_window: Date;
          status: string;
        }>(
          `SELECT id, opened_window, status FROM alert_episodes
           WHERE unit_id = $1 FOR UPDATE`,
          [unitId],
        );
        const existing = new Map(
          existingRows.map((r) => [new Date(r.opened_window).toISOString(), r]),
        );
        const desiredKeys = new Set(derived.map((e) => e.openedWindow.toISOString()));

        for (const episode of derived) {
          const key = episode.openedWindow.toISOString();
          const prior = existing.get(key);
          const detail = { window_risks: episode.windowRisks };
          if (!prior) {
            await client.query(
              `INSERT INTO alert_episodes
                 (unit_id, status, peak_risk, opened_window, opened_at,
                  recovered_window, recovered_at, detail, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
              [
                unitId,
                episode.status,
                episode.peakRisk,
                episode.openedWindow,
                episode.openedAt,
                episode.recoveredWindow,
                episode.recoveredAt,
                JSON.stringify(detail),
              ],
            );
            transitions.push({
              unit_id: unitId,
              opened_window: key,
              transition: "opened",
            });
          } else {
            await client.query(
              `UPDATE alert_episodes SET
                 status = $2,
                 peak_risk = $3,
                 recovered_window = $4,
                 recovered_at = $5,
                 detail = $6,
                 updated_at = now()
               WHERE id = $1`,
              [
                prior.id,
                episode.status,
                episode.peakRisk,
                episode.recoveredWindow,
                episode.recoveredAt,
                JSON.stringify(detail),
              ],
            );
            if (prior.status === "open" && episode.status === "recovered") {
              transitions.push({
                unit_id: unitId,
                opened_window: key,
                transition: "recovered",
              });
            }
          }
        }

        // Episodes that no longer derive (late data rewrote history) vanish.
        for (const [key, row] of existing) {
          if (!desiredKeys.has(key)) {
            await client.query("DELETE FROM alert_episodes WHERE id = $1", [row.id]);
          }
        }
      }
    }

    for (const reading of toInsert) {
      accepted.push({
        line: reading.line,
        reading_id: reading.reading_id,
        unit_id: reading.unit_id,
        window_start: windowStart(
          new Date(reading.observed_at),
          thresholds.window_minutes,
        ).toISOString(),
      });
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  accepted.sort((a, b) => a.line - b.line);
  rejected.sort((a, b) => a.line - b.line);
  windowsChanged.sort((a, b) =>
    a.unit_id === b.unit_id
      ? a.window_start.localeCompare(b.window_start)
      : a.unit_id.localeCompare(b.unit_id),
  );
  return { accepted, rejected, windows_changed: windowsChanged, alert_transitions: transitions };
}
