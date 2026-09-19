export type Metric = "temperature_c" | "humidity_pct" | "ammonia_ppm" | "coughs_per_min";
export type Risk = "normal" | "watch" | "critical";
export type GrowthStage = "nursery" | "finisher" | "gestation";

export const METRICS = ["temperature_c", "humidity_pct", "ammonia_ppm", "coughs_per_min"] as const;
export const RISKS = ["normal", "watch", "critical"] as const;

export interface UnitDef {
  unit_id: string;
  campus_id: string;
  building_id: string;
  floor_id: string;
  growth_stage: GrowthStage;
  pens: string[];
}

export interface SensorDef {
  sensor_id: string;
  unit_id: string;
  metric: Metric;
  min_value: number;
  max_value: number;
}

/** A single numeric threshold band. Missing keys mean no band on that side. */
export interface MetricThreshold {
  watch_below?: number;
  watch_above?: number;
  critical_below?: number;
  critical_above?: number;
}

export interface ThresholdConfig {
  threshold_version: string;
  window_minutes: number;
  late_arrival_minutes: number;
  alert_open_windows: number;
  alert_recovery_windows: number;
  risk_values: Risk[];
  growth_stages: Record<GrowthStage, Record<Metric, MetricThreshold>>;
}

/** A validated reading belonging to a known sensor. */
export interface AcceptedReading {
  reading_id: string;
  sensor_id: string;
  unit_id: string;
  metric: Metric;
  observed_at: Date;
  value: number;
}

export interface RejectedLine {
  line: number;
  reading_id: string | null;
  reason: string;
}

export interface MetricFactor {
  metric: Metric;
  value: number;
  level: Risk;
}

export interface WindowResult {
  unit_id: string;
  window_start: Date;
  window_end: Date;
  aggregates: Partial<Record<Metric, number>>;
  readings_count: number;
  risk: Risk;
  abnormal: boolean; // risk !== normal
  safe: boolean; // risk === normal
  factors: MetricFactor[];
}

export interface AlertTransition {
  type: "opened" | "recovered";
  unit_id: string;
  window_start: Date;
  peak_risk?: Risk;
}
