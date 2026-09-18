#!/usr/bin/env node
// Repeatable end-to-end acceptance test for the pig-house risk service.
//
// It drives only the public HTTP API of the service using fixtures from the
// repository (registered SNS-A01-* sensors, nursery growth-stage thresholds):
//
//   phase1  ingest: per-line rejections, normal/abnormal windows, late
//           (out-of-order) recompute, alert open, late recompute that must
//           not duplicate a transition, three-safe-window recovery
//   phase2  read-only persistence verification after an app restart
//   all     phase1 followed immediately by phase2 (default)
//
// Exit code is non-zero if any assertion fails. No cloud platform, model
// inference or message service is involved.

import { readFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const PHASE = process.env.ACCEPTANCE_PHASE ?? "all";
const FIXTURES_DIR = process.env.FIXTURES_DIR ?? "/app/fixtures";
const UNIT = "UNIT-A-01";
const TZ = "+08:00";

const failures = [];
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

function eq(name, actual, expected) {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

async function getJson(urlPath) {
  const res = await fetch(`${BASE_URL}${urlPath}`);
  if (!res.ok) {
    throw new Error(`GET ${urlPath} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function postNdjson(urlPath, body) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body,
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function waitForReady(attempts = 60) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`service at ${BASE_URL} never became ready`);
}

function ts(hhmm) {
  return `2026-09-08T${hhmm}:00${TZ}`;
}
function reading(readingId, sensorId, observedAt, metric, value) {
  return JSON.stringify({
    reading_id: readingId,
    sensor_id: sensorId,
    observed_at: ts(observedAt),
    metric,
    value,
  });
}

// Window starts on the UTC 15-minute grid (08:00+08 == 00:00Z).
const W = {
  w1: "2026-09-08T00:00:00.000Z",
  w2: "2026-09-08T00:15:00.000Z",
  w3: "2026-09-08T00:30:00.000Z",
  w4: "2026-09-08T00:45:00.000Z",
  w5: "2026-09-08T01:00:00.000Z",
  w6: "2026-09-08T01:15:00.000Z",
  w7: "2026-09-08T01:30:00.000Z",
};
const RANGE_FROM = "2026-09-08T00:00:00.000Z";
const RANGE_TO = "2026-09-08T02:00:00.000Z";

async function phase1() {
  console.log("\n=== phase 1: ingestion, windows, alert state machine ===");

  // ---- fixtures are the source of truth for sensors and thresholds -------
  const sensorsPath = path.join(FIXTURES_DIR, "sensors.json");
  let sensorsFixtureOk = true;
  let sensorIds = [];
  try {
    const reg = JSON.parse(await readFile(sensorsPath, "utf8"));
    sensorIds = reg.sensors.map((s) => s.sensor_id);
  } catch {
    sensorsFixtureOk = false;
  }
  check("acceptance uses repository sensor registry fixtures", sensorsFixtureOk);
  check(
    "registry contains the four UNIT-A-01 devices",
    ["SNS-A01-TEMP", "SNS-A01-HUM", "SNS-A01-NH3", "SNS-A01-COUGH"].every((id) =>
      sensorIds.includes(id),
    ),
  );

  const health = await getJson("/healthz");
  eq("healthz reports database ok", health.status, "ok");
  const live = await fetch(`${BASE_URL}/livez`);
  eq("liveness endpoint responds 200", live.status, 200);

  // ---- batch 1: W1/W2 normal + seven illegal physical lines ---------------
  const batch1 = [
    reading("acc-a01-w1-temp-01", "SNS-A01-TEMP", "08:01", "temperature_c", 25.5),
    '{"reading_id":"acc-bad-json","sensor_id":"SNS-A01-TEMP",',
    reading("acc-a01-w1-hum-01", "SNS-A01-HUM", "08:04", "humidity_pct", 65),
    '{"reading_id":"acc-extra-field-x","sensor_id":"SNS-A01-TEMP","observed_at":"2026-09-08T08:05:00+08:00","metric":"temperature_c","value":25,"extra":1}',
    reading("acc-a01-w1-nh3-01", "SNS-A01-NH3", "08:08", "ammonia_ppm", 10),
    reading("acc-a01-w1-cough-01", "SNS-A01-COUGH", "08:11", "coughs_per_min", 4),
    reading("acc-a01-w1-temp-01", "SNS-A01-TEMP", "08:01", "temperature_c", 25.5), // line 7: duplicate id in batch
    reading("acc-a01-unknown-01", "SNS-Z99-TEMP", "08:06", "temperature_c", 25), // line 8: unknown sensor
    reading("acc-a01-mismatch-01", "SNS-A01-HUM", "08:07", "temperature_c", 25), // line 9: metric mismatch
    reading("acc-a01-range-01", "SNS-A01-TEMP", "08:09", "temperature_c", 999), // line 10: value out of range
    reading("acc-a01-badts-01", "SNS-A01-TEMP", "08:10", "temperature_c", 25).replace(
      /"observed_at":"[^"]+"/,
      '"observed_at":"2026-09-08 08:10:00"',
    ), // line 11: bad timestamp
    reading("acc-a01-w2-temp-01", "SNS-A01-TEMP", "08:16", "temperature_c", 25.8),
    reading("acc-a01-w2-hum-01", "SNS-A01-HUM", "08:19", "humidity_pct", 66),
    reading("acc-a01-w2-nh3-01", "SNS-A01-NH3", "08:22", "ammonia_ppm", 11),
    reading("acc-a01-w2-cough-01", "SNS-A01-COUGH", "08:25", "coughs_per_min", 5),
  ].join("\n");

  const r1 = await postNdjson("/v1/telemetry", batch1);
  eq("batch1 HTTP status is 207 multi-status", r1.status, 207);
  eq("batch1 accepts the 8 legal lines", r1.json.accepted_count, 8);
  eq("batch1 rejects the 7 illegal lines", r1.json.rejected_count, 7);
  eq("batch1 accounts for every physical line", r1.json.batch_size, 15);

  const byCode = Object.fromEntries(
    r1.json.rejected.map((r) => [r.code, r.line]),
  );
  eq("malformed JSON reports physical line 2", byCode.invalid_json, 2);
  check(
    "contract field violation reports physical line 4",
    r1.json.rejected.some((r) => r.line === 4 && r.code === "invalid_record"),
  );
  eq(
    "in-batch duplicate id reports physical line 7",
    byCode.duplicate_reading_id,
    7,
  );
  eq("unknown sensor reports physical line 8", byCode.unknown_sensor, 8);
  eq("metric mismatch reports physical line 9", byCode.metric_mismatch, 9);
  eq("value out of range reports physical line 10", byCode.value_out_of_range, 10);
  check(
    "bad timestamp is also an invalid_record on physical line 11",
    r1.json.rejected.some((r) => r.line === 11 && r.code === "invalid_record"),
  );
  check(
    "legal lines were not tainted by their neighbours",
    r1.json.accepted
      .map((a) => a.line)
      .join(","),
  );
  eq(
    "accepted physical line numbers are exactly 1,3,5,6,12,13,14,15",
    r1.json.accepted.map((a) => a.line),
    [1, 3, 5, 6, 12, 13, 14, 15],
  );

  let wins = await getJson(
    `/v1/units/${UNIT}/windows?from=${RANGE_FROM}&to=${RANGE_TO}`,
  );
  eq("two windows materialise after batch1", wins.count, 2);
  eq(
    "W1 and W2 are normal",
    wins.windows.map((w) => w.risk),
    ["normal", "normal"],
  );
  let active = await getJson("/v1/alerts/active");
  eq("no active alerts after normal windows", active.count, 0);

  // ---- W3 first computed as watch ------------------------------------------
  const batch2 = [
    reading("acc-a01-w3-temp-01", "SNS-A01-TEMP", "08:31", "temperature_c", 25.9),
    reading("acc-a01-w3-hum-01", "SNS-A01-HUM", "08:34", "humidity_pct", 70),
    reading("acc-a01-w3-nh3-01", "SNS-A01-NH3", "08:37", "ammonia_ppm", 16),
    reading("acc-a01-w3-cough-01", "SNS-A01-COUGH", "08:44", "coughs_per_min", 6),
  ].join("\n");
  const r2 = await postNdjson("/v1/telemetry", batch2);
  eq("batch2 accepts 4 readings", r2.json.accepted_count, 4);
  wins = await getJson(`/v1/units/${UNIT}/windows?from=${W.w3}&to=${W.w4}`);
  eq("W3 initially computes as watch", wins.windows[0]?.risk, "watch");
  active = await getJson("/v1/alerts/active");
  eq("one abnormal window does not open an alert", active.count, 0);

  // ---- out-of-order arrival within 10 minutes flips W3 to critical --------
  // Watermark is 08:44; 08:36 is 8 minutes behind and must trigger recompute.
  const lateW3 = reading(
    "acc-a01-w3-nh3-late",
    "SNS-A01-NH3",
    "08:36",
    "ammonia_ppm",
    36,
  );
  const r3 = await postNdjson("/v1/telemetry", lateW3);
  eq("late in-bound reading is accepted", r3.json.accepted_count, 1);
  eq(
    "late reading maps to the earlier W3 window",
    r3.json.accepted[0]?.window_start,
    W.w3,
  );
  wins = await getJson(`/v1/units/${UNIT}/windows?from=${W.w3}&to=${W.w4}`);
  eq("W3 deterministically recomputes to critical", wins.windows[0]?.risk, "critical");
  eq("W3 recompute_count is 2", wins.windows[0]?.recompute_count, 2);
  eq(
    "W3 NH3 average combines all five? no — five? (two NH3 readings)",
    wins.windows[0]?.metric_breakdown?.ammonia_ppm?.avg,
    26,
  );
  active = await getJson("/v1/alerts/active");
  eq("still no alert: only one abnormal window after recompute", active.count, 0);

  // ---- watermark lateness bound rejects older events -----------------------
  const tooLate = reading(
    "acc-a01-w2-temp-toolate",
    "SNS-A01-TEMP",
    "08:20",
    "temperature_c",
    10,
  );
  const rLate = await postNdjson("/v1/telemetry", tooLate);
  eq("reading 24 minutes behind watermark is rejected", rLate.json.rejected_count, 1);
  eq("lateness rejection uses code too_late", rLate.json.rejected[0]?.code, "too_late");
  eq("lateness rejection carries physical line 1", rLate.json.rejected[0]?.line, 1);

  // ---- W4 critical: second consecutive abnormal window OPENS alert --------
  const batch3 = [
    reading("acc-a01-w4-temp-01", "SNS-A01-TEMP", "08:46", "temperature_c", 34),
    reading("acc-a01-w4-hum-01", "SNS-A01-HUM", "08:49", "humidity_pct", 89),
    reading("acc-a01-w4-nh3-01", "SNS-A01-NH3", "08:52", "ammonia_ppm", 26),
    reading("acc-a01-w4-cough-01", "SNS-A01-COUGH", "08:55", "coughs_per_min", 18),
  ].join("\n");
  const r4 = await postNdjson("/v1/telemetry", batch3);
  eq("batch3 accepts 4 readings", r4.json.accepted_count, 4);
  eq(
    "alert opens exactly once on the second consecutive abnormal window",
    r4.json.alert_transitions,
    [{ unit_id: UNIT, opened_window: W.w4, transition: "opened" }],
  );
  active = await getJson("/v1/alerts/active");
  eq("one active alert after W4", active.count, 1);
  eq("active alert opened on W4", active.alerts[0]?.opened_window, W.w4);
  eq("active alert peak risk is critical", active.alerts[0]?.peak_risk, "critical");

  // ---- another late reading recomputes W4 WITHOUT a duplicate transition --
  const lateW4 = reading(
    "acc-a01-w4-cough-late",
    "SNS-A01-COUGH",
    "08:50",
    "coughs_per_min",
    20,
  );
  const r5 = await postNdjson("/v1/telemetry", lateW4);
  eq("late W4 reading accepted", r5.json.accepted_count, 1);
  eq(
    "late W4 recompute emits no alert transition",
    r5.json.alert_transitions,
    [],
  );
  active = await getJson("/v1/alerts/active");
  eq("late recompute did not duplicate the alert", active.count, 1);
  wins = await getJson(`/v1/units/${UNIT}/windows?from=${W.w4}&to=${W.w5}`);
  eq("W4 recompute_count is 2 after late arrival", wins.windows[0]?.recompute_count, 2);

  // ---- three consecutive safe windows RECOVER the alert --------------------
  const pad = (n) => String(n).padStart(2, "0");
  const safeWindow = (tag, baseHour, baseMinute) => {
    const metrics = [
      ["temp", "SNS-A01-TEMP", "temperature_c", 25, 1],
      ["hum", "SNS-A01-HUM", "humidity_pct", 60, 4],
      ["nh3", "SNS-A01-NH3", "ammonia_ppm", 8, 7],
      ["cough", "SNS-A01-COUGH", "coughs_per_min", 3, 10],
    ];
    return metrics
      .map(([suffix, sensorId, metric, value, offset]) => {
        const total = baseHour * 60 + baseMinute + offset;
        const hh = pad(Math.floor(total / 60));
        const mm = pad(total % 60);
        return reading(`acc-a01-${tag}-${suffix}`, sensorId, `${hh}:${mm}`, metric, value);
      })
      .join("\n");
  };
  const r6 = await postNdjson("/v1/telemetry", safeWindow("w5", 9, 0));
  eq("first safe window keeps the alert open (1/3)", r6.json.alert_transitions, []);
  active = await getJson("/v1/alerts/active");
  eq("alert still open after one normal window", active.count, 1);

  const r7 = await postNdjson("/v1/telemetry", safeWindow("w6", 9, 15));
  eq("second safe window keeps the alert open (2/3)", r7.json.alert_transitions, []);
  active = await getJson("/v1/alerts/active");
  eq("alert still open after two normal windows", active.count, 1);

  const r8 = await postNdjson("/v1/telemetry", safeWindow("w7", 9, 30));
  eq(
    "third consecutive safe window recovers the alert once",
    r8.json.alert_transitions,
    [{ unit_id: UNIT, opened_window: W.w4, transition: "recovered" }],
  );
  active = await getJson("/v1/alerts/active");
  eq("no active alerts after recovery", active.count, 0);

  // ---- current risk reflects the latest safe window ------------------------
  const current = await getJson(`/v1/units/${UNIT}/risk`);
  eq("current unit risk is normal after recovery", current.risk, "normal");
  eq("current risk window is W7", current.window_start, W.w7);
  eq("current alert status is recovered", current.alert_status, "recovered");

  console.log("\nphase 1 complete.");
}

async function phase2(label) {
  console.log(`\n=== phase 2: ${label} ===`);

  const health = await getJson("/healthz");
  eq("healthz ok against persistent store", health.status, "ok");

  const all = await getJson(
    `/v1/units/${UNIT}/windows?from=${RANGE_FROM}&to=${RANGE_TO}`,
  );
  eq("persisted window count is 7", all.count, 7);
  eq(
    "persisted window risk sequence",
    all.windows.map((w) => w.risk),
    ["normal", "normal", "critical", "critical", "normal", "normal", "normal"],
  );
  eq(
    "window starts align to the event-time grid",
    all.windows.map((w) => w.window_start),
    [W.w1, W.w2, W.w3, W.w4, W.w5, W.w6, W.w7],
  );
  const w3 = all.windows.find((w) => w.window_start === W.w3);
  const w4 = all.windows.find((w) => w.window_start === W.w4);
  eq("W3 persisted recompute_count is 2", w3?.recompute_count, 2);
  eq("W4 persisted recompute_count is 2", w4?.recompute_count, 2);

  const history = await getJson(
    `/v1/alerts?from=${RANGE_FROM}&to=${RANGE_TO}`,
  );
  eq("exactly one alert episode in history", history.count, 1);
  const episode = history.alerts[0];
  eq("episode status recovered", episode?.status, "recovered");
  eq("episode opened_window W4", episode?.opened_window, W.w4);
  eq("episode recovered_window W7", episode?.recovered_window, W.w7);
  eq("episode peak critical", episode?.peak_risk, "critical");

  const active = await getJson("/v1/alerts/active");
  eq("no active alerts persisted", active.count, 0);

  const readings = await getJson(
    `/v1/readings?from=${RANGE_FROM}&to=${RANGE_TO}&unit_id=${UNIT}`,
  );
  eq("all 30 accepted readings persisted", readings.count, 30);

  const riskRows = await getJson(`/v1/risk?unit_id=${UNIT}`);
  eq("risk overview contains the unit", riskRows.units?.length, 1);
  eq("risk overview latest risk normal", riskRows.units[0]?.risk, "normal");

  const badRange = await fetch(
    `${BASE_URL}/v1/windows?from=${encodeURIComponent("not-a-date")}&to=${RANGE_TO}`,
  );
  eq("invalid time range rejected with 400", badRange.status, 400);
  const unknownUnit = await fetch(`${BASE_URL}/v1/units/UNIT-NOPE/risk`);
  eq("unknown unit rejected with 404", unknownUnit.status, 404);
}

async function main() {
  await waitForReady();
  if (PHASE === "all" || PHASE === "phase1") await phase1();
  if (PHASE === "all" || PHASE === "phase2") await phase2("persistence verification");

  console.log(`\n----------------------------------------`);
  console.log(`checks: ${checks}, failures: ${failures.length}`);
  if (failures.length > 0) {
    console.error("ACCEPTANCE FAILED");
    for (const f of failures) console.error(` - ${f.name} :: ${f.detail ?? ""}`);
    process.exit(1);
  }
  console.log("ACCEPTANCE PASSED");
}

main().catch((error) => {
  console.error("acceptance harness error:", error);
  process.exit(1);
});
