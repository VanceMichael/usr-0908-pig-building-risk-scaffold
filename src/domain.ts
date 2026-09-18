import type {
  Metric,
  MetricThreshold,
  Risk,
  Thresholds,
} from "./types.js";
import { RISK_RANK } from "./types.js";

export const WINDOW_MS_CACHE = new Map<number, number>();

/** Floors an event timestamp to the 15-minute window start (UTC grid). */
export function windowStart(observedAt: Date, windowMinutes: number): Date {
  const windowMs = windowMinutes * 60_000;
  const ms = observedAt.getTime();
  return new Date(Math.floor(ms / windowMs) * windowMs);
}

export function windowEnd(start: Date, windowMinutes: number): Date {
  return new Date(start.getTime() + windowMinutes * 60_000);
}

/**
 * Classifies one metric value against a growth-stage threshold.
 * Boundary values are treated as abnormal (inclusive), e.g. a temperature
 * equal to watch_above is "watch".
 */
export function classifyMetric(
  metric: Metric,
  value: number,
  threshold: MetricThreshold,
): Risk {
  if (threshold.critical_below !== undefined && value <= threshold.critical_below)
    return "critical";
  if (threshold.critical_above !== undefined && value >= threshold.critical_above)
    return "critical";
  if (threshold.watch_below !== undefined && value <= threshold.watch_below)
    return "watch";
  if (threshold.watch_above !== undefined && value >= threshold.watch_above)
    return "watch";
  return "normal";
}

function worse(a: Risk, b: Risk): Risk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

export interface MetricAggregate {
  metric: Metric;
  avg: number;
  min: number;
  max: number;
  count: number;
  level: Risk;
}

export interface ReadingPoint {
  metric: Metric;
  value: number;
  observed_at: Date;
}

export interface WindowAggregation {
  risk: Risk;
  breakdown: Record<Metric, MetricAggregate>;
  metricsPresent: Metric[];
  sampleCount: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
}

/**
 * Combines every reading that falls in one (unit, window) into a single
 * risk label. Each metric is averaged, the average is classified against
 * the growth-stage thresholds, and the window risk is the worst metric
 * level (temperature + humidity + ammonia + cough combined).
 */
export function aggregateWindow(
  points: ReadingPoint[],
  stageThresholds: Record<Metric, MetricThreshold>,
): WindowAggregation {
  const byMetric = new Map<Metric, ReadingPoint[]>();
  let first = Infinity;
  let last = -Infinity;
  for (const point of points) {
    const list = byMetric.get(point.metric) ?? [];
    list.push(point);
    byMetric.set(point.metric, list);
    const t = point.observed_at.getTime();
    if (t < first) first = t;
    if (t > last) last = t;
  }

  const breakdown = {} as Record<Metric, MetricAggregate>;
  const metricsPresent: Metric[] = [];
  let risk: Risk = "normal";
  let sampleCount = 0;

  for (const [metric, list] of byMetric) {
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const p of list) {
      sum += p.value;
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    }
    const avg = sum / list.length;
    const level = classifyMetric(metric, avg, stageThresholds[metric]);
    breakdown[metric] = {
      metric,
      avg: round(avg),
      min: round(min),
      max: round(max),
      count: list.length,
      level,
    };
    metricsPresent.push(metric);
    sampleCount += list.length;
    risk = worse(risk, level);
  }

  metricsPresent.sort();

  return {
    risk,
    breakdown,
    metricsPresent,
    sampleCount,
    firstObservedAt: new Date(first),
    lastObservedAt: new Date(last),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface WindowRiskPoint {
  window_start: Date;
  risk: Risk;
}

export interface DerivedEpisode {
  unitId: string;
  openedWindow: Date;
  openedAt: Date;
  recoveredWindow: Date | null;
  recoveredAt: Date | null;
  peakRisk: Exclude<Risk, "normal">;
  status: "open" | "recovered";
  windowRisks: Array<{ window_start: string; risk: Risk }>;
}

/**
 * Pure alert state machine over a unit's windows in event-time order:
 *
 *  - two consecutive abnormal (watch/critical) windows open an episode;
 *  - three consecutive normal windows while open recover it;
 *  - a missing window (a gap on the 15-minute grid) breaks every streak;
 *  - a new abnormal run after recovery opens a new episode.
 *
 * Episode timestamps are deterministic event-time values (the closing
 * boundary of the triggering window), so late-data recomputation never
 * changes an episode's identity or duplicates a transition.
 */
export function deriveEpisodes(
  unitId: string,
  windows: WindowRiskPoint[],
  windowMinutes: number,
): DerivedEpisode[] {
  const episodes: DerivedEpisode[] = [];
  const windowMs = windowMinutes * 60_000;

  let abnormalStreak = 0;
  let normalStreak = 0;
  let runWindows: WindowRiskPoint[] = [];
  let previousStart: number | null = null;
  let current: DerivedEpisode | null = null;

  const closeBoundary = (start: Date) => new Date(start.getTime() + windowMs);
  const toRisk = (p: WindowRiskPoint) => ({
    window_start: p.window_start.toISOString(),
    risk: p.risk,
  });

  for (const w of windows) {
    const startMs = w.window_start.getTime();
    if (previousStart !== null && startMs - previousStart !== windowMs) {
      // A gap on the window grid: no evidence either way, streaks reset.
      abnormalStreak = 0;
      normalStreak = 0;
      runWindows = [];
    }
    previousStart = startMs;

    if (w.risk === "normal") {
      abnormalStreak = 0;
      runWindows = [];
      if (current && current.status === "open") {
        current.windowRisks.push(toRisk(w));
        normalStreak += 1;
        if (normalStreak >= 3) {
          current.status = "recovered";
          current.recoveredWindow = w.window_start;
          current.recoveredAt = closeBoundary(w.window_start);
          current = null;
          normalStreak = 0;
        }
      }
      continue;
    }

    const abnormal = w.risk as Exclude<Risk, "normal">;
    normalStreak = 0;
    if (abnormalStreak === 0) runWindows = [];
    abnormalStreak += 1;
    runWindows.push(w);

    if (current && current.status === "open") {
      current.peakRisk =
        RISK_RANK[abnormal] > RISK_RANK[current.peakRisk]
          ? abnormal
          : current.peakRisk;
      current.windowRisks.push(toRisk(w));
    } else if (abnormalStreak === 2) {
      const peak = runWindows.reduce<Exclude<Risk, "normal">>(
        (acc, p) => (RISK_RANK[p.risk] > RISK_RANK[acc] ? (p.risk as Exclude<Risk, "normal">) : acc),
        "watch",
      );
      const episode: DerivedEpisode = {
        unitId,
        // The alert opens on the second consecutive abnormal window.
        openedWindow: w.window_start,
        openedAt: closeBoundary(w.window_start),
        recoveredWindow: null,
        recoveredAt: null,
        peakRisk: peak,
        status: "open",
        windowRisks: runWindows.map(toRisk),
      };
      current = episode;
      episodes.push(episode);
    }
  }

  return episodes;
}

/** Resolves the growth-stage metric thresholds, throwing on configuration gaps. */
export function stageThresholds(
  thresholds: Thresholds,
  growthStage: string,
): Record<Metric, MetricThreshold> {
  const stage = thresholds.growth_stages[growthStage];
  if (!stage) throw new Error(`no thresholds configured for stage ${growthStage}`);
  return stage;
}
