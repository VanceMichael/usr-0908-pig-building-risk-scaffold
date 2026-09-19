import { Pool, type PoolClient } from "pg";
import type { Metric, RejectedLine, Risk, ThresholdConfig, WindowResult } from "./types.js";
import type { ReferenceData } from "./config.js";
import type { ValidatedReading } from "./protocol.js";
import { computeWindows, replayAlerts } from "./risk.js";

interface ReadingRow {
  reading_id: string;
  sensor_id: string;
  unit_id: string;
  metric: Metric;
  observed_at: Date;
  value: number;
}

interface EpisodeRow {
  id: number;
  unit_id: string;
  opened_window_start: Date;
  opened_at: Date;
  peak_risk: Risk;
  recovered_window_start: Date | null;
  recovered_at: Date | null;
}

export interface IngestResult {
  batch_id: number;
  accepted: number;
  rejected: RejectedLine[];
  recomputed_units: string[];
}

/**
 * First window start that may still change for the given watermark. A window is
 * sealed once its end is at or before watermark - late_arrival; the window
 * containing that horizon instant is still mutable.
 */
export function firstMutableWindowStart(watermark: Date, config: ThresholdConfig): Date {
  const horizon = watermark.getTime() - config.late_arrival_minutes * 60_000;
  return new Date(Math.floor(horizon / (config.window_minutes * 60_000)) *
    (config.window_minutes * 60_000));
}

// Units with no prior history have no sealed prefix: an early (but
// Postgres-representable) epoch makes every real window mutable.
const UNSEALED_EPOCH = new Date(Date.UTC(1970, 0, 1));

/**
 * Single ingestion engine. A batch runs in one transaction with per-unit
 * advisory locks taken in a deterministic order, so concurrent batches can
 * never interleave per-unit watermarks or double-replay alerts.
 */
export class IngestionService {
  constructor(
    private readonly pool: Pool,
    private readonly ref: ReferenceData,
  ) {}

  private get config(): ThresholdConfig {
    return this.ref.thresholds;
  }

  /**
   * Persists validated readings, enforces the 10-minute event-time watermark,
   * rewrites every still-mutable 15-minute window of affected units, and
   * reconciles alert episodes with a full deterministic state-machine replay.
   */
  async ingest(readings: ValidatedReading[]): Promise<IngestResult> {
    const rejected: RejectedLine[] = [];
    if (readings.length === 0) {
      const batchId = await this.recordBatch(this.pool, 0, 0);
      return { batch_id: batchId, accepted: 0, rejected, recomputed_units: [] };
    }

    const unitIds = [...new Set(readings.map((r) => r.unit_id))].sort();
    const client = await this.pool.connect();
    let batchId = 0;
    try {
      await client.query("BEGIN");
      for (const unitId of unitIds) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [unitId]);
      }

      const existing = new Set<string>();
      const { rows: existingRows } = await client.query<{ reading_id: string }>(
        "SELECT reading_id FROM readings WHERE reading_id = ANY($1)",
        [readings.map((r) => r.reading_id)],
      );
      for (const row of existingRows) existing.add(row.reading_id);

      // Per-unit event-time watermarks as committed BEFORE this batch. Lateness
      // decisions and the seal line are derived from these so the outcome of a
      // batch never depends on the physical ordering of its own lines.
      const priorWatermarks = new Map<string, Date>();
      for (const unitId of unitIds) {
        const { rows } = await client.query<{ max: Date | null }>(
          "SELECT max(observed_at) AS max FROM readings WHERE unit_id = $1",
          [unitId],
        );
        if (rows[0]?.max) priorWatermarks.set(unitId, rows[0].max);
      }

      const survivors: ValidatedReading[] = [];
      for (const reading of readings) {
        if (existing.has(reading.reading_id)) {
          rejected.push({
            line: reading.line,
            reading_id: reading.reading_id,
            reason: "duplicate reading_id already ingested",
          });
          continue;
        }
        const prior = priorWatermarks.get(reading.unit_id);
        if (prior) {
          const oldestAllowed =
            prior.getTime() - this.config.late_arrival_minutes * 60_000;
          if (reading.observed_at.getTime() < oldestAllowed) {
            rejected.push({
              line: reading.line,
              reading_id: reading.reading_id,
              reason: `observed_at ${reading.observed_at.toISOString()} exceeds the ${this.config.late_arrival_minutes}-minute late-arrival allowance (watermark ${prior.toISOString()})`,
            });
            continue;
          }
        }
        survivors.push(reading);
      }

      batchId = await this.recordBatch(client, survivors.length, rejected.length);
      for (const reading of survivors) {
        await client.query(
          `INSERT INTO readings
             (reading_id, sensor_id, unit_id, metric, observed_at, value, batch_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            reading.reading_id,
            reading.sensor_id,
            reading.unit_id,
            reading.metric,
            reading.observed_at,
            reading.value,
            batchId,
          ],
        );
      }

      const recomputedUnits = [...new Set(survivors.map((r) => r.unit_id))].sort();
      for (const unitId of recomputedUnits) {
        // The seal line is computed from the PRE-batch watermark: readings this
        // batch added to older windows (still within the lateness allowance)
        // must be included in the suffix recompute.
        await this.recomputeUnit(client, unitId, priorWatermarks.get(unitId) ?? null);
      }

      await client.query("COMMIT");
      return {
        batch_id: batchId,
        accepted: survivors.length,
        rejected,
        recomputed_units: recomputedUnits,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async recordBatch(
    executor: Pool | PoolClient,
    accepted: number,
    rejectedCount: number,
  ): Promise<number> {
    const { rows } = await executor.query<{ id: number }>(
      "INSERT INTO batches (accepted, rejected) VALUES ($1, $2) RETURNING id",
      [accepted, rejectedCount],
    );
    return rows[0]!.id;
  }

  /**
   * Rewrites the mutable window suffix of one unit and reconciles alerts:
   *
   * 1. sealed windows (end at/before watermark - lateness) are untouched;
   * 2. every later window is deleted and recomputed deterministically from
   *    stored readings;
   * 3. alert episodes are replayed over the FULL window history. Fully sealed
   *    episodes must already exist with identical anchors. Episodes touching
   *    the mutable suffix (including an open one opened before the seal line)
   *    are upserted by their open-window anchor, so a late reading updates the
   *    same transition and can never create a duplicate. Mutable episodes the
   *    replay no longer produces are deleted.
   */
  private async recomputeUnit(
    client: PoolClient,
    unitId: string,
    priorWatermark: Date | null,
  ): Promise<void> {
    // Without prior history nothing is sealed yet: recompute every window.
    const mutableStart = priorWatermark
      ? firstMutableWindowStart(priorWatermark, this.config)
      : UNSEALED_EPOCH;

    const { rows: readingRows } = await client.query<ReadingRow>(
      `SELECT reading_id, sensor_id, unit_id, metric, observed_at, value
       FROM readings
       WHERE unit_id = $1 AND observed_at >= $2
       ORDER BY observed_at, reading_id`,
      [unitId, mutableStart],
    );

    const unit = this.ref.units.get(unitId)!;
    const computed = computeWindows(
      readingRows,
      new Map([[unitId, { growth_stage: unit.growth_stage }]]),
      this.config,
    ).get(unitId) ?? [];

    await client.query(
      "DELETE FROM windows WHERE unit_id = $1 AND window_start >= $2",
      [unitId, mutableStart],
    );
    for (const window of computed) {
      await client.query(
        `INSERT INTO windows
           (unit_id, window_start, window_end, temperature_c, humidity_pct,
            ammonia_ppm, coughs_per_min, readings_count, risk, abnormal, safe, factors)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          window.unit_id,
          window.window_start,
          window.window_end,
          window.aggregates.temperature_c ?? null,
          window.aggregates.humidity_pct ?? null,
          window.aggregates.ammonia_ppm ?? null,
          window.aggregates.coughs_per_min ?? null,
          window.readings_count,
          window.risk,
          window.abnormal,
          window.safe,
          JSON.stringify(window.factors),
        ],
      );
    }

    const windowResults = await this.loadWindows(client, unitId);
    const expected = replayAlerts(windowResults, this.config);

    const { rows: storedRows } = await client.query<EpisodeRow>(
      `SELECT id, unit_id, opened_window_start, opened_at, peak_risk,
              recovered_window_start, recovered_at
       FROM alert_episodes WHERE unit_id = $1 ORDER BY opened_window_start`,
      [unitId],
    );
    const storedByAnchor = new Map(
      storedRows.map((row) => [row.opened_window_start.getTime(), row]),
    );

    for (const episode of expected) {
      const anchorMs = episode.opened_window_start.getTime();
      const anchorWindow = windowResults.find(
        (w) => w.window_start.getTime() === anchorMs,
      )!;
      const recoveryWindow = episode.recovered_window_start
        ? windowResults.find(
            (w) => w.window_start.getTime() === episode.recovered_window_start!.getTime(),
          ) ?? null
        : null;
      const openedAt = anchorWindow.window_end;
      const recoveredAt = recoveryWindow ? recoveryWindow.window_end : null;
      const fullySealed =
        episode.opened_window_start < mutableStart &&
        episode.recovered_window_start !== null &&
        episode.recovered_window_start < mutableStart;
      const stored = storedByAnchor.get(anchorMs);

      if (fullySealed) {
        if (!stored) {
          throw new Error(
            `integrity error: sealed episode ${unitId}@${episode.opened_window_start.toISOString()} missing`,
          );
        }
        if (
          !stored.recovered_window_start ||
          stored.recovered_window_start.getTime() !==
            episode.recovered_window_start!.getTime() ||
          stored.peak_risk !== episode.peak_risk
        ) {
          throw new Error(
            `integrity error: sealed episode ${unitId}@${episode.opened_window_start.toISOString()} diverged`,
          );
        }
        continue;
      }

      // Mutable or cross-boundary episode: anchor-based upsert keeps it one
      // transition even as late data moves the recovery point.
      await client.query(
        `INSERT INTO alert_episodes
           (unit_id, opened_window_start, opened_at, peak_risk,
            recovered_window_start, recovered_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (unit_id, opened_window_start) DO UPDATE SET
           opened_at = EXCLUDED.opened_at,
           peak_risk = EXCLUDED.peak_risk,
           recovered_window_start = EXCLUDED.recovered_window_start,
           recovered_at = EXCLUDED.recovered_at`,
        [
          unitId,
          episode.opened_window_start,
          openedAt,
          episode.peak_risk,
          episode.recovered_window_start,
          recoveredAt,
        ],
      );
    }

    // Episodes anchored in the mutable suffix that the replay no longer
    // produces (e.g. an abnormal window flipped back to normal by late data)
    // are removed. Sealed/cross-boundary anchors are never deleted.
    for (const stored of storedRows) {
      const stillExpected = expected.some(
        (episode) =>
          episode.opened_window_start.getTime() === stored.opened_window_start.getTime(),
      );
      if (!stillExpected && stored.opened_window_start >= mutableStart) {
        await client.query("DELETE FROM alert_episodes WHERE id = $1", [stored.id]);
      }
      if (!stillExpected && stored.opened_window_start < mutableStart) {
        throw new Error(
          `integrity error: sealed episode ${unitId}@${stored.opened_window_start.toISOString()} vanished from replay`,
        );
      }
    }
  }

  private async loadWindows(client: PoolClient, unitId: string): Promise<WindowResult[]> {
    const { rows } = await client.query<{
      unit_id: string;
      window_start: Date;
      window_end: Date;
      temperature_c: number | null;
      humidity_pct: number | null;
      ammonia_ppm: number | null;
      coughs_per_min: number | null;
      readings_count: number;
      risk: Risk;
      abnormal: boolean;
      safe: boolean;
      factors: WindowResult["factors"];
    }>(
      `SELECT unit_id, window_start, window_end, temperature_c, humidity_pct,
              ammonia_ppm, coughs_per_min, readings_count, risk, abnormal, safe, factors
       FROM windows WHERE unit_id = $1 ORDER BY window_start`,
      [unitId],
    );
    return rows.map((w) => ({
      unit_id: w.unit_id,
      window_start: w.window_start,
      window_end: w.window_end,
      aggregates: {
        ...(w.temperature_c !== null ? { temperature_c: w.temperature_c } : {}),
        ...(w.humidity_pct !== null ? { humidity_pct: w.humidity_pct } : {}),
        ...(w.ammonia_ppm !== null ? { ammonia_ppm: w.ammonia_ppm } : {}),
        ...(w.coughs_per_min !== null ? { coughs_per_min: w.coughs_per_min } : {}),
      } as Partial<Record<Metric, number>>,
      readings_count: w.readings_count,
      risk: w.risk,
      abnormal: w.abnormal,
      safe: w.safe,
      factors: Array.isArray(w.factors) ? w.factors : [],
    }));
  }
}
