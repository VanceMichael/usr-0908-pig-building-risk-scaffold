import type {
  AcceptedReading,
  Metric,
  MetricFactor,
  MetricThreshold,
  Risk,
  ThresholdConfig,
  WindowResult,
} from "./types.js";

const RISK_RANK: Record<Risk, number> = { normal: 0, watch: 1, critical: 2 };

export function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

function floorWindowStart(observedAt: Date, windowMinutes: number): Date {
  const windowMs = windowMinutes * 60_000;
  return new Date(Math.floor(observedAt.getTime() / windowMs) * windowMs);
}

/**
 * Classifies one metric value against its growth-stage band.
 * Comparisons are strict: a value equal to a threshold stays on the safer side.
 */
export function classifyMetric(threshold: MetricThreshold | undefined, value: number): Risk {
  if (!threshold) return "normal";
  if (
    (threshold.critical_above !== undefined && value > threshold.critical_above) ||
    (threshold.critical_below !== undefined && value < threshold.critical_below)
  ) {
    return "critical";
  }
  if (
    (threshold.watch_above !== undefined && value > threshold.watch_above) ||
    (threshold.watch_below !== undefined && value < threshold.watch_below)
  ) {
    return "watch";
  }
  return "normal";
}

interface Accumulator {
  sum: number;
  count: number;
}

/**
 * Groups readings per unit into fixed event-time windows and combines the four
 * signals with the unit growth-stage thresholds.
 *
 * Representative value per metric inside a window is the arithmetic mean.
 * A window exists only when at least one reading falls in it; metrics that
 * have no reading in the window are ignored rather than assumed normal.
 */
export function computeWindows(
  readings: AcceptedReading[],
  units: Map<string, { growth_stage: keyof ThresholdConfig["growth_stages"] }>,
  config: ThresholdConfig,
): Map<string, WindowResult[]> {
  const byUnit = new Map<string, AcceptedReading[]>();
  for (const reading of readings) {
    const list = byUnit.get(reading.unit_id) ?? [];
    list.push(reading);
    byUnit.set(reading.unit_id, list);
  }

  const result = new Map<string, WindowResult[]>();
  for (const [unitId, unitReadings] of byUnit) {
    const stage = units.get(unitId)?.growth_stage;
    const stageThresholds = stage ? config.growth_stages[stage] : undefined;

    // bucket epoch ms -> metric -> accumulator, preserving insertion order.
    const buckets = new Map<number, Map<Metric, Accumulator>>();
    for (const reading of unitReadings) {
      const start = floorWindowStart(reading.observed_at, config.window_minutes).getTime();
      let bucket = buckets.get(start);
      if (!bucket) {
        bucket = new Map<Metric, Accumulator>();
        buckets.set(start, bucket);
      }
      const acc = bucket.get(reading.metric) ?? { sum: 0, count: 0 };
      acc.sum += reading.value;
      acc.count += 1;
      bucket.set(reading.metric, acc);
    }

    const windows: WindowResult[] = [];
    for (const [startMs, bucket] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      const windowStart = new Date(startMs);
      const windowEnd = new Date(startMs + config.window_minutes * 60_000);
      const aggregates: Partial<Record<Metric, number>> = {};
      const factors: MetricFactor[] = [];
      let risk: Risk = "normal";
      let readingsCount = 0;

      for (const metric of ["temperature_c", "humidity_pct", "ammonia_ppm", "coughs_per_min"] as const) {
        const acc = bucket.get(metric);
        if (!acc) continue;
        const value = acc.sum / acc.count;
        // Means of doubles can end just below a representation boundary; keep
        // full precision, the JSON layer rounds only for display.
        aggregates[metric] = value;
        readingsCount += acc.count;
        const level = classifyMetric(stageThresholds?.[metric], value);
        risk = maxRisk(risk, level);
        if (level !== "normal") {
          factors.push({ metric, value, level });
        }
      }

      windows.push({
        unit_id: unitId,
        window_start: windowStart,
        window_end: windowEnd,
        aggregates,
        readings_count: readingsCount,
        risk,
        abnormal: risk !== "normal",
        safe: risk === "normal",
        factors,
      });
    }
    result.set(unitId, windows);
  }
  return result;
}

export interface ReplayedEpisode {
  opened_window_start: Date;
  peak_risk: Risk;
  recovered_window_start: Date | null;
}

/**
 * Replays the alert state machine over one unit's windows in event-time order:
 *
 * - An episode opens after two consecutive abnormal (watch/critical) windows;
 *   it is anchored at the second abnormal window.
 * - It recovers after three consecutive normal windows; recovery is anchored
 *   at the third safe window.
 * - Any abnormal window resets the safe streak; a safe window resets the
 *   abnormal streak.
 *
 * Pure function: identical input windows always produce identical episodes.
 */
export function replayAlerts(
  windows: WindowResult[],
  config: Pick<ThresholdConfig, "alert_open_windows" | "alert_recovery_windows">,
): ReplayedEpisode[] {
  const sorted = [...windows].sort(
    (a, b) => a.window_start.getTime() - b.window_start.getTime(),
  );

  const episodes: ReplayedEpisode[] = [];
  let open: ReplayedEpisode | null = null;
  let abnormalStreak = 0;
  let safeStreak = 0;

  for (const window of sorted) {
    if (window.abnormal) {
      abnormalStreak += 1;
      safeStreak = 0;
      if (!open && abnormalStreak >= config.alert_open_windows) {
        open = {
          opened_window_start: window.window_start,
          peak_risk: window.risk === "normal" ? "watch" : window.risk,
          recovered_window_start: null,
        };
        episodes.push(open);
      } else if (open) {
        open.peak_risk = maxRisk(open.peak_risk, window.risk);
      }
    } else {
      safeStreak += 1;
      abnormalStreak = 0;
      if (open && safeStreak >= config.alert_recovery_windows) {
        open.recovered_window_start = window.window_start;
        open = null;
        safeStreak = 0;
      }
    }
  }
  return episodes;
}
