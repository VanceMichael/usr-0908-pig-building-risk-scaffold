import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyMetric, computeWindows, maxRisk, replayAlerts } from "./risk.js";
import { firstMutableWindowStart } from "./ingestion.js";
import { validateTelemetry } from "./validation.js";
import type { SensorDef, ThresholdConfig, WindowResult } from "./types.js";

const config: ThresholdConfig = {
  threshold_version: "test",
  window_minutes: 15,
  late_arrival_minutes: 10,
  alert_open_windows: 2,
  alert_recovery_windows: 3,
  risk_values: ["normal", "watch", "critical"],
  growth_stages: {
    nursery: {
      temperature_c: { watch_below: 22, watch_above: 29, critical_below: 18, critical_above: 33 },
      humidity_pct: { watch_above: 75, critical_above: 88 },
      ammonia_ppm: { watch_above: 15, critical_above: 25 },
      coughs_per_min: { watch_above: 8, critical_above: 16 },
    },
    finisher: {
      temperature_c: { watch_below: 16, watch_above: 25, critical_below: 12, critical_above: 30 },
      humidity_pct: { watch_above: 78, critical_above: 90 },
      ammonia_ppm: { watch_above: 18, critical_above: 30 },
      coughs_per_min: { watch_above: 10, critical_above: 20 },
    },
    gestation: {
      temperature_c: { watch_below: 15, watch_above: 24, critical_below: 10, critical_above: 29 },
      humidity_pct: { watch_above: 80, critical_above: 92 },
      ammonia_ppm: { watch_above: 18, critical_above: 30 },
      coughs_per_min: { watch_above: 9, critical_above: 18 },
    },
  },
};

function sensor(id: string, metric: SensorDef["metric"]): SensorDef {
  return { sensor_id: id, unit_id: "UNIT-A-01", metric, min_value: 0, max_value: 100 };
}

const SENSORS = new Map<string, SensorDef>([
  ["SNS-A01-TEMP", sensor("SNS-A01-TEMP", "temperature_c")],
  ["SNS-A01-HUM", sensor("SNS-A01-HUM", "humidity_pct")],
  ["SNS-A01-NH3", sensor("SNS-A01-NH3", "ammonia_ppm")],
  ["SNS-A01-COUGH", sensor("SNS-A01-COUGH", "coughs_per_min")],
]);

test("maxRisk ordering", () => {
  assert.equal(maxRisk("normal", "watch"), "watch");
  assert.equal(maxRisk("critical", "watch"), "critical");
  assert.equal(maxRisk("watch", "watch"), "watch");
});

test("classifyMetric: strict boundary comparisons", () => {
  const t = config.growth_stages.nursery.temperature_c;
  assert.equal(classifyMetric(t, 29), "normal");
  assert.equal(classifyMetric(t, 29.0001), "watch");
  assert.equal(classifyMetric(t, 33), "watch");
  assert.equal(classifyMetric(t, 33.0001), "critical");
  assert.equal(classifyMetric(t, 22), "normal");
  assert.equal(classifyMetric(t, 21.99), "watch");
  assert.equal(classifyMetric(t, 18), "watch");
  assert.equal(classifyMetric(t, 17.99), "critical");
  const h = config.growth_stages.nursery.humidity_pct;
  assert.equal(classifyMetric(h, 75), "normal");
  assert.equal(classifyMetric(h, 75.1), "watch");
});

test("computeWindows: 15-minute event-time buckets with mean aggregation", () => {
  const readings = [
    { reading_id: "r1", sensor_id: "SNS-A01-NH3", unit_id: "UNIT-A-01", metric: "ammonia_ppm" as const, observed_at: new Date("2026-09-08T08:01:00+08:00"), value: 14, line: 1 },
    { reading_id: "r2", sensor_id: "SNS-A01-NH3", unit_id: "UNIT-A-01", metric: "ammonia_ppm" as const, observed_at: new Date("2026-09-08T08:10:00+08:00"), value: 18, line: 2 },
    { reading_id: "r3", sensor_id: "SNS-A01-NH3", unit_id: "UNIT-A-01", metric: "ammonia_ppm" as const, observed_at: new Date("2026-09-08T08:20:00+08:00"), value: 30, line: 3 },
  ];
  const byUnit = computeWindows(readings, new Map([["UNIT-A-01", { growth_stage: "nursery" }]]), config);
  const windows = byUnit.get("UNIT-A-01")!;
  assert.equal(windows.length, 2);
  assert.equal(windows[0]!.window_start.toISOString(), "2026-09-08T00:00:00.000Z");
  assert.ok(Math.abs(windows[0]!.aggregates.ammonia_ppm! - 16) < 1e-9);
  assert.equal(windows[0]!.risk, "watch");
  assert.equal(windows[0]!.readings_count, 2);
  assert.equal(windows[1]!.risk, "critical");
  assert.equal(windows[1]!.factors[0]!.metric, "ammonia_ppm");
});

test("computeWindows: missing metrics are not assumed abnormal", () => {
  const readings = [
    { reading_id: "r1", sensor_id: "SNS-A01-TEMP", unit_id: "UNIT-A-01", metric: "temperature_c" as const, observed_at: new Date("2026-09-08T08:01:00+08:00"), value: 26, line: 1 },
  ];
  const windows = computeWindows(readings, new Map([["UNIT-A-01", { growth_stage: "nursery" }]]), config).get("UNIT-A-01")!;
  assert.equal(windows[0]!.risk, "normal");
  assert.equal(windows[0]!.factors.length, 0);
});

function win(start: string, risk: WindowResult["risk"]): WindowResult {
  return {
    unit_id: "U",
    window_start: new Date(start),
    window_end: new Date(new Date(start).getTime() + 15 * 60_000),
    aggregates: {},
    readings_count: 1,
    risk,
    abnormal: risk !== "normal",
    safe: risk === "normal",
    factors: [],
  };
}

test("replayAlerts: opens on second consecutive abnormal window", () => {
  const episodes = replayAlerts(
    [win("2026-09-08T00:00:00Z", "normal"), win("2026-09-08T00:15:00Z", "watch"), win("2026-09-08T00:30:00Z", "critical")],
    config,
  );
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]!.opened_window_start.toISOString(), "2026-09-08T00:30:00.000Z");
  assert.equal(episodes[0]!.peak_risk, "critical");
  assert.equal(episodes[0]!.recovered_window_start, null);
});

test("replayAlerts: a single abnormal window does not open an alert", () => {
  const episodes = replayAlerts(
    [win("2026-09-08T00:00:00Z", "watch"), win("2026-09-08T00:15:00Z", "normal")],
    config,
  );
  assert.equal(episodes.length, 0);
});

test("replayAlerts: recovers on third consecutive safe window", () => {
  const episodes = replayAlerts(
    ["watch", "critical", "normal", "normal", "normal"].map((risk, i) =>
      win(new Date(2026, 8, 8, 0, i * 15).toISOString(), risk as WindowResult["risk"]),
    ),
    config,
  );
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]!.recovered_window_start!.toISOString(), "2026-09-08T01:00:00.000Z");
});

test("replayAlerts: any abnormal window resets the safe streak", () => {
  const episodes = replayAlerts(
    ["watch", "watch", "normal", "normal", "watch", "normal", "normal", "normal"].map((risk, i) =>
      win(new Date(2026, 8, 8, 0, i * 15).toISOString(), risk as WindowResult["risk"]),
    ),
    config,
  );
  assert.equal(episodes.length, 1);
  // Recovery lands on the third safe window after the resetting watch.
  assert.equal(episodes[0]!.recovered_window_start!.toISOString(), "2026-09-08T01:45:00.000Z");
});

test("replayAlerts: deterministic — same input yields identical episodes", () => {
  const seq = ["watch", "watch", "normal", "normal", "normal"].map((risk, i) =>
    win(new Date(2026, 8, 8, 0, i * 15).toISOString(), risk as WindowResult["risk"]),
  );
  const a = replayAlerts(seq, config);
  const b = replayAlerts(seq, config);
  assert.deepEqual(a, b);
});

test("firstMutableWindowStart: window containing the seal horizon stays mutable", () => {
  const cfg = config;
  // watermark 08:23 CST -> horizon 08:13 -> floor 08:00 CST (00:00 UTC)
  assert.equal(
    firstMutableWindowStart(new Date("2026-09-08T08:23:00+08:00"), cfg).toISOString(),
    "2026-09-08T00:00:00.000Z",
  );
  // watermark 08:25 -> horizon 08:15 exactly -> window 08:15 still mutable
  assert.equal(
    firstMutableWindowStart(new Date("2026-09-08T08:25:00+08:00"), cfg).toISOString(),
    "2026-09-08T00:15:00.000Z",
  );
  // watermark 08:24:59 -> horizon 08:14:59 -> floor 08:00
  assert.equal(
    firstMutableWindowStart(new Date("2026-09-08T08:24:59+08:00"), cfg).toISOString(),
    "2026-09-08T00:00:00.000Z",
  );
});

test("validateTelemetry: rejects bad lines by physical line number, keeps siblings", () => {
  const body = [
    '{"reading_id":"reading-ok-0001","sensor_id":"SNS-A01-TEMP","observed_at":"2026-09-08T08:01:00+08:00","metric":"temperature_c","value":26}',
    "not json at all",
    '{"reading_id":"reading-bad-sensor","sensor_id":"SNS-UNKNOWN","observed_at":"2026-09-08T08:01:00+08:00","metric":"temperature_c","value":26}',
    '{"reading_id":"reading-bad-metrc","sensor_id":"SNS-A01-TEMP","observed_at":"2026-09-08T08:01:00+08:00","metric":"ammonia_ppm","value":26}',
    '{"reading_id":"reading-bad-time1","sensor_id":"SNS-A01-TEMP","observed_at":"2026-09-08 08:01","metric":"temperature_c","value":26}',
    '{"reading_id":"reading-bad-rang","sensor_id":"SNS-A01-TEMP","observed_at":"2026-09-08T08:01:00+08:00","metric":"temperature_c","value":999}',
    '{"reading_id":"reading-extra-fld","sensor_id":"SNS-A01-TEMP","observed_at":"2026-09-08T08:01:00+08:00","metric":"temperature_c","value":26,"extra":1}',
    '{"reading_id":"reading-ok-0002","sensor_id":"SNS-A01-HUM","observed_at":"2026-09-08T08:02:00+08:00","metric":"humidity_pct","value":60}',
    "",
  ].join("\n");
  const { accepted, rejected } = validateTelemetry(body, SENSORS);
  assert.equal(accepted.length, 2);
  assert.deepEqual(rejected.map((r) => r.line), [2, 3, 4, 5, 6, 7]);
  assert.match(rejected[0]!.reason, /malformed JSON/);
  assert.match(rejected[1]!.reason, /unknown sensor/);
  assert.match(rejected[2]!.reason, /does not match sensor/);
  assert.match(rejected[3]!.reason, /invalid observed_at/);
  assert.match(rejected[4]!.reason, /outside sensor range/);
  assert.match(rejected[5]!.reason, /do not match contract/);
  assert.equal(accepted[0]!.line, 1);
  assert.equal(accepted[1]!.line, 8);
});

test("validateTelemetry: duplicate reading_id inside the batch rejected", () => {
  const body = [
    '{"reading_id":"reading-dup-0001","sensor_id":"SNS-A01-TEMP","observed_at":"2026-09-08T08:01:00+08:00","metric":"temperature_c","value":26}',
    '{"reading_id":"reading-dup-0001","sensor_id":"SNS-A01-HUM","observed_at":"2026-09-08T08:02:00+08:00","metric":"humidity_pct","value":60}',
  ].join("\n");
  const { accepted, rejected } = validateTelemetry(body, SENSORS);
  assert.equal(accepted.length, 1);
  assert.equal(rejected[0]!.line, 2);
});
