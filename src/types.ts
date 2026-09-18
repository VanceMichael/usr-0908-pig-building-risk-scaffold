export type Metric =
  | "temperature_c"
  | "humidity_pct"
  | "ammonia_ppm"
  | "coughs_per_min";

export type Risk = "normal" | "watch" | "critical";

export const METRICS: readonly Metric[] = [
  "temperature_c",
  "humidity_pct",
  "ammonia_ppm",
  "coughs_per_min",
];

export const RISK_RANK: Record<Risk, number> = {
  normal: 0,
  "watch": 1,
  "critical": 2,
};

export interface SensorRecord {
  sensor_id: string;
  unit_id: string;
  metric: Metric;
  min_value: number;
  max_value: number;
}

export interface UnitRecord {
  unit_id: string;
  campus_id: string;
  building_id: string;
  floor_id: string;
  growth_stage: string;
  pens: string[];
}

export interface MetricThreshold {
  watch_below?: number;
  watch_above?: number;
  critical_below?: number;
  critical_above?: number;
}

export interface Thresholds {
  threshold_version: string;
  window_minutes: number;
  late_arrival_minutes: number;
  alert_open_windows: number;
  alert_recovery_windows: number;
  growth_stages: Record<string, Record<Metric, MetricThreshold>>;
}

export interface Topology {
  campus_id: string;
  timezone: string;
  buildings: Array<{
    building_id: string;
    floors: Array<{
      floor_id: string;
      units: Array<{
        unit_id: string;
        growth_stage: string;
        pens: string[];
      }>;
    }>;
  }>;
}

export interface SensorRegistry {
  registry_version: string;
  sensors: SensorRecord[];
}

export interface ReadingInput {
  reading_id: string;
  sensor_id: string;
  observed_at: string;
  metric: Metric;
  value: number;
}

export interface RejectedLine {
  line: number;
  code:
    | "invalid_json"
    | "invalid_record"
    | "unknown_sensor"
    | "metric_mismatch"
    | "value_out_of_range"
    | "duplicate_reading_id"
    | "too_late"
    | "internal_error";
  message: string;
  reading_id?: string;
}

export interface AcceptedLine {
  line: number;
  reading_id: string;
  unit_id: string;
  window_start: string;
}
