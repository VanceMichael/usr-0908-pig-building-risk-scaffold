/**
 * Container acceptance driver. Drives the running HTTP service with the
 * repository fixtures/acceptance NDJSON scenarios and asserts the whole
 * contract: normal/abnormal windows, out-of-order recompute, alert open and
 * recovery, per-line rejection and persistence across a container restart.
 *
 * Modes:
 *   acceptance.ts            full run: ingests scenarios + read assertions
 *   acceptance.ts --read     read-only checks only (used after app restart)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://app:8080";
const FIXTURES = process.env.FIXTURES_DIR ?? "/app/fixtures";
const READ_ONLY = process.argv.includes("--read");

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
  }
}
function assertEqual(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : { expected, actual });
}

async function waitForHealth(attempts = 60): Promise<void> {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch {
      // service not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("service did not become healthy");
}

async function getJson(urlPath: string): Promise<any> {
  const response = await fetch(`${BASE_URL}${urlPath}`);
  if (!response.ok) {
    throw new Error(`GET ${urlPath} -> ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function ingestFile(file: string): Promise<any> {
  const body = await readFile(path.join(FIXTURES, "acceptance", file), "utf8");
  const response = await fetch(`${BASE_URL}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body,
  });
  if (!response.ok) {
    throw new Error(`POST /ingest ${file} -> ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

const CST_WINDOW = (local: string) => new Date(`2026-09-09T${local}:00+08:00`).toISOString();

async function readOnlyChecks(): Promise<void> {
  console.log("== read-only checks (post-restart persistence) ==");
  const health = await getJson("/health");
  check("health ok after restart", health.status === "ok" && health.database === "up", health);

  // Scenario outcome that must have survived the restart:
  const risk = await getJson("/units/UNIT-A-01/risk");
  assertEqual("UNIT-A-01 latest window safe", risk.current.risk, "normal");

  const history = await getJson("/alerts/history?unit_id=UNIT-A-01");
  assertEqual("exactly one episode for UNIT-A-01", history.alerts.length, 1);
  const episode = history.alerts[0]!;
  assertEqual("episode opened at second abnormal window (08:30 CST)",
    episode.opened_window_start, CST_WINDOW("08:30"));
  assertEqual("episode recovered at third safe window (09:15 CST)",
    episode.recovered_window_start, CST_WINDOW("09:15"));
  assertEqual("peak risk downgraded deterministically by late dilution",
    episode.peak_risk, "watch");

  const active = await getJson("/alerts/active");
  const activeUnits = active.alerts.map((a: any) => a.unit_id).sort();
  assertEqual("UNIT-A-02 alert still active, UNIT-A-01 not", activeUnits, ["UNIT-A-02"]);
}

async function main(): Promise<void> {
  await waitForHealth();

  if (READ_ONLY) {
    await readOnlyChecks();
    if (failures > 0) throw new Error(`${failures} acceptance check(s) failed`);
    console.log("read-only acceptance passed");
    return;
  }

  console.log("== scenario 01: normal window ==");
  const r01 = await ingestFile("01-normal.ndjson");
  assertEqual("01 accepted 4", r01.accepted, 4);
  assertEqual("01 rejected 0", r01.rejected.length, 0);
  const risk01 = await getJson("/units/UNIT-A-01/risk");
  assertEqual("01 current risk normal", risk01.current.risk, "normal");
  assertEqual("01 four readings counted", risk01.current.readings_count, 4);
  check("01 factors empty", Array.isArray(risk01.current.factors) && risk01.current.factors.length === 0,
    risk01.current.factors);

  console.log("== scenario 02: alert opens on two consecutive abnormal windows ==");
  const r02a = await ingestFile("02-alert-open.ndjson");
  assertEqual("02 accepted 2", r02a.accepted, 2);
  // Both readings arrive in one batch; W1 and W2 are computed together, so the
  // episode exists immediately but is anchored at the SECOND abnormal window.
  const afterW1 = await getJson("/alerts/active?unit_id=UNIT-A-01");
  assertEqual("episode exists after two abnormal windows", afterW1.alerts.length, 1);
  assertEqual("02 open anchor is W2 (08:30 CST)",
    afterW1.alerts[0]!.opened_window_start, CST_WINDOW("08:30"));
  assertEqual("02 peak critical", afterW1.alerts[0]!.peak_risk, "critical");

  console.log("== scenario 03: late arrival triggers deterministic recompute ==");
  const before = await getJson("/alerts/history?unit_id=UNIT-A-01");
  assertEqual("one episode before late data", before.alerts.length, 1);
  const episodeIdBefore = before.alerts[0]!.id;
  const r03 = await ingestFile("03-late-recompute.ndjson");
  assertEqual("03 late reading accepted within 10-minute allowance", r03.accepted, 1);
  const after = await getJson("/alerts/history?unit_id=UNIT-A-01");
  assertEqual("late data created no duplicate transition", after.alerts.length, 1);
  assertEqual("same episode row preserved (anchor upsert)",
    after.alerts[0]!.id, episodeIdBefore);
  assertEqual("peak recomputed from critical to watch by dilution",
    after.alerts[0]!.peak_risk, "watch");
  const w2 = await getJson(
    "/units/UNIT-A-01/windows?from=2026-09-09T08:30:00%2B08:00&to=2026-09-09T08:45:00%2B08:00",
  );
  assertEqual("W2 single window present", w2.windows.length, 1);
  assertEqual("W2 ammonia mean is 25", w2.windows[0]!.ammonia_ppm, 25);
  assertEqual("W2 risk downgraded to watch", w2.windows[0]!.risk, "watch");

  console.log("== scenario 04: recovery after three consecutive safe windows ==");
  const r04 = await ingestFile("04-recovery.ndjson");
  assertEqual("04 accepted 3", r04.accepted, 3);
  const activeDuring = await getJson("/alerts/active?unit_id=UNIT-A-01");
  assertEqual("UNIT-A-01 alert recovered", activeDuring.alerts.length, 0);
  const history04 = await getJson("/alerts/history?unit_id=UNIT-A-01");
  assertEqual("04 one episode with recovery", history04.alerts.length, 1);
  assertEqual("04 recovery anchor W6 (09:15 CST)",
    history04.alerts[0]!.recovered_window_start, CST_WINDOW("09:15"));
  check("04 recovered_at populated", history04.alerts[0]!.recovered_at !== null);

  console.log("== scenario 05: per-line rejection with physical line numbers ==");
  const r05 = await ingestFile("05-invalid-lines.ndjson");
  assertEqual("05 one sibling line accepted", r05.accepted, 1);
  assertEqual(
    "05 rejected physical lines 2..9",
    r05.rejected.map((r: any) => r.line),
    [2, 3, 4, 5, 6, 7, 8, 9],
  );
  assertEqual("05 line 2 malformed JSON", r05.rejected[0]!.reason.includes("malformed JSON"), true);
  assertEqual("05 line 3 unknown sensor", r05.rejected[1]!.reason.includes("unknown sensor"), true);
  assertEqual("05 line 4 metric mismatch", r05.rejected[2]!.reason.includes("does not match sensor"), true);
  assertEqual("05 line 5 bad timestamp", r05.rejected[3]!.reason.includes("invalid observed_at"), true);
  assertEqual("05 line 6 out of range", r05.rejected[4]!.reason.includes("outside sensor range"), true);
  assertEqual("05 line 7 contract fields", r05.rejected[5]!.reason.includes("do not match contract"), true);
  assertEqual("05 line 8 in-batch duplicate", r05.rejected[6]!.reason.includes("duplicate"), true);
  assertEqual("05 line 9 already-ingested duplicate", r05.rejected[7]!.reason.includes("already ingested"), true);

  console.log("== scenario 06: reading beyond 10-minute watermark is rejected ==");
  const r06 = await ingestFile("06-too-late.ndjson");
  assertEqual("06 accepted 0", r06.accepted, 0);
  assertEqual("06 rejected one line", r06.rejected.length, 1);
  assertEqual("06 physical line number 1", r06.rejected[0]!.line, 1);
  assertEqual("06 late-arrival reason", r06.rejected[0]!.reason.includes("late-arrival"), true);

  console.log("== scenario 07: independent unit produces its own episode ==");
  const r07 = await ingestFile("07-other-unit.ndjson");
  assertEqual("07 accepted 2", r07.accepted, 2);
  const activeA02 = await getJson("/alerts/active?unit_id=UNIT-A-02");
  assertEqual("07 UNIT-A-02 one active critical alert", activeA02.alerts.length, 1);
  assertEqual("07 UNIT-A-02 critical cough peak", activeA02.alerts[0]!.peak_risk, "critical");

  console.log("== range queries ==");
  const range = await getJson(
    "/units/UNIT-A-01/windows?from=2026-09-09T08:00:00%2B08:00&to=2026-09-09T09:30:00%2B08:00",
  );
  // Windows: 08:00 normal, 08:15 watch, 08:30 watch (recomputed), 08:45/09:00/09:15 safe.
  assertEqual("range returns six windows", range.windows.length, 6);
  assertEqual(
    "window risks in event-time order",
    range.windows.map((w: any) => w.risk),
    ["normal", "watch", "watch", "normal", "normal", "normal"],
  );
  const fullHistory = await getJson("/alerts/history");
  check("history covers both alerted units", fullHistory.alerts.length >= 2, fullHistory.alerts);

  console.log("== idempotency: replaying scenario 01 duplicates nothing ==");
  const replay = await ingestFile("01-normal.ndjson");
  assertEqual("replay accepted 0", replay.accepted, 0);
  assertEqual("replay rejected 4 duplicates", replay.rejected.length, 4);

  await readOnlyChecks();

  if (failures > 0) {
    throw new Error(`${failures} acceptance check(s) failed`);
  }
  console.log("\nALL ACCEPTANCE CHECKS PASSED");
}

main().catch((error) => {
  console.error("acceptance failed:", error);
  process.exit(1);
});
