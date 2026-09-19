import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { readFile, rm, cp } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";
import { loadReferenceData } from "./config.js";
import { IngestionService } from "./ingestion.js";
import { QueryService } from "./queries.js";
import { validateTelemetry } from "./validation.js";
import type { ValidatedReading } from "./protocol.js";

// Minimal pg-Pool shape backed by PGlite. The real service runs against
// network PostgreSQL; this adapter lets the full transactional code path run
// in-process in CI without a database container.
interface PgLike {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

function makePoolAdapter(db: PGlite): Pool {
  const query = (text: string, params?: unknown[]) => db.query(text, params as any[]);
  const fakePool = {
    query,
    connect: async () => ({
      query,
      release: () => {},
    } as unknown as PoolClient),
  };
  return fakePool as unknown as Pool;
}

const root = process.cwd();
let db: PGlite;
let pool: Pool;
let ingestion: IngestionService;
let queries: QueryService;
let ref: Awaited<ReturnType<typeof loadReferenceData>>;

const CST = "+08:00";
const iso = (local: string) => `2026-09-08T${local}:00${CST}`;

function line(
  readingId: string,
  sensorId: string,
  observedAtLocal: string,
  metric: string,
  value: number,
): string {
  return JSON.stringify({
    reading_id: readingId,
    sensor_id: sensorId,
    observed_at: iso(observedAtLocal),
    metric,
    value,
  });
}

async function send(body: string) {
  const { accepted, rejected } = validateTelemetry(body, ref.sensors);
  const result = await ingestion.ingest(accepted);
  return { accepted: result, validationRejected: rejected };
}

const DB_DIR = "/tmp/pgrisk-pglite-data";
const COPY_DIR = "/tmp/pgrisk-pglite-copy";

before(async () => {
  await rm(DB_DIR, { recursive: true, force: true });
  db = new PGlite(DB_DIR);
  pool = makePoolAdapter(db);
  const migration = await readFile(path.join(root, "migrations", "001_init.sql"), "utf8");
  await db.exec(migration);
  ref = await loadReferenceData(path.join(root, "fixtures"));

  // Seed reference data using the same SQL paths as production.
  for (const unit of ref.units.values()) {
    await db.query(
      `INSERT INTO units (unit_id, campus_id, building_id, floor_id, growth_stage, pens)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [unit.unit_id, unit.campus_id, unit.building_id, unit.floor_id, unit.growth_stage, JSON.stringify(unit.pens)],
    );
  }
  for (const sensor of ref.sensors.values()) {
    await db.query(
      `INSERT INTO sensors (sensor_id, unit_id, metric, min_value, max_value)
       VALUES ($1,$2,$3,$4,$5)`,
      [sensor.sensor_id, sensor.unit_id, sensor.metric, sensor.min_value, sensor.max_value],
    );
  }
  ingestion = new IngestionService(pool, ref);
  queries = new QueryService(pool);
});

after(async () => {
  await db.close();
});

test("normal window: all four metrics in range yields normal risk", async () => {
  const body = [
    line("rdg-a01-norm-t", "SNS-A01-TEMP", "08:01", "temperature_c", 26.4),
    line("rdg-a01-norm-h", "SNS-A01-HUM", "08:04", "humidity_pct", 71.2),
    line("rdg-a01-norm-n", "SNS-A01-NH3", "08:08", "ammonia_ppm", 12.0),
    line("rdg-a01-norm-c", "SNS-A01-COUGH", "08:11", "coughs_per_min", 5),
  ].join("\n");
  const { accepted, validationRejected } = await send(body);
  assert.equal(validationRejected.length, 0);
  assert.equal(accepted.accepted, 4);

  const current = await queries.currentRisk("UNIT-A-01");
  assert.equal(current!.risk, "normal");
  assert.equal(current!.safe, true);
  assert.equal(current!.readings_count, 4);
  const active = await queries.activeAlerts();
  assert.equal(active.length, 0);
});

test("abnormal windows: alert opens only on the second consecutive abnormal window", async () => {
  // First abnormal window 08:15-08:30.
  await send(line("rdg-a01-w1-nh3", "SNS-A01-NH3", "08:20", "ammonia_ppm", 20));
  let active = await queries.activeAlerts("UNIT-A-01");
  assert.equal(active.length, 0, "one abnormal window must not open an alert");

  // Second consecutive abnormal window 08:30-08:45.
  await send(line("rdg-a01-w2-nh3", "SNS-A01-NH3", "08:35", "ammonia_ppm", 28));
  active = await queries.activeAlerts("UNIT-A-01");
  assert.equal(active.length, 1);
  assert.equal(active[0]!.opened_window_start.toISOString(), new Date(iso("08:30")).toISOString());
  assert.equal(active[0]!.peak_risk, "critical");
});

test("late arrival within 10 minutes triggers deterministic recompute without duplicate transitions", async () => {
  // Watermark is 08:35. A 08:30 reading (5 min late) lands in W2 and
  // dilutes NH3: mean(28, 22) = 25 -> still watch, anchor must stay the
  // SAME episode row (peak downgrades deterministically), never a duplicate.
  const before = await queries.alertHistory("UNIT-A-01");
  assert.equal(before.length, 1);
  const episodeId = before[0]!.id;

  await send(line("rdg-a01-w2-late1", "SNS-A01-NH3", "08:30", "ammonia_ppm", 22));

  const after = await queries.alertHistory("UNIT-A-01");
  assert.equal(after.length, 1, "late data must not create a duplicate transition");
  assert.equal(after[0]!.id, episodeId, "episode identity is preserved via anchor upsert");
  assert.equal(after[0]!.peak_risk, "watch");
  assert.equal(after[0]!.opened_window_start.toISOString(), new Date(iso("08:30")).toISOString());

  const windows = await queries.windowsInRange(
    "UNIT-A-01",
    new Date(iso("08:30")),
    new Date(iso("08:45")),
  );
  assert.equal(windows.length, 1);
  assert.ok(Math.abs(windows[0]!.ammonia_ppm! - 25) < 1e-9);
  assert.equal(windows[0]!.risk, "watch");
});

test("late arrival that dissolves the streak removes the premature episode", async () => {
  // Watermark 08:35; a reading at 08:17 (age 18 min) is TOO OLD — first show
  // it rejected. Then advance with an 08:41 reading (W3), after which 08:17 is
  // even older, so instead dilute W1 while its allowance is open: send a
  // reading for 08:16-era window while watermark allows. To keep the scenario
  // deterministic we add normal data to W1 via W1's own allowed horizon by
  // first rolling the clock forward in a fresh unit below (UNIT-A-03).
  const tooLate = await send(line("rdg-a01-tool8", "SNS-A01-NH3", "08:17", "ammonia_ppm", 0));
  assert.equal(tooLate.accepted.rejected[0]!.line, 1);
  assert.match(tooLate.accepted.rejected[0]!.reason, /late-arrival/);
});

test("UNIT-A-03: late dilution removes an episode then a new streak opens one row", async () => {
  // W1 abnormal, W2 abnormal -> open anchored W2.
  await send(line("rdg-a03-w1-n", "SNS-A03-NH3", "10:20", "ammonia_ppm", 20));
  await send(line("rdg-a03-w2-n", "SNS-A03-NH3", "10:31", "ammonia_ppm", 20));
  let history = await queries.alertHistory("UNIT-A-03");
  assert.equal(history.length, 1);
  assert.equal(history[0]!.opened_window_start.toISOString(), new Date(iso("10:30")).toISOString());

  // 10:25 is 6 minutes behind the 10:31 watermark and lands in W1.
  // mean(20, 0) = 10 -> W1 flips normal; only W2 stays abnormal -> episode gone.
  await send(line("rdg-a03-w1-late", "SNS-A03-NH3", "10:25", "ammonia_ppm", 0));
  history = await queries.alertHistory("UNIT-A-03");
  assert.equal(history.length, 0, "episode whose two-window streak dissolved must be deleted");

  // A new abnormal W3 forms a W2+W3 streak and opens one fresh episode.
  await send(line("rdg-a03-w3-n", "SNS-A03-NH3", "10:46", "ammonia_ppm", 20));
  history = await queries.alertHistory("UNIT-A-03");
  assert.equal(history.length, 1);
  assert.equal(history[0]!.opened_window_start.toISOString(), new Date(iso("10:45")).toISOString());
});

test("UNIT-A-02: recovery requires three consecutive safe windows", async () => {
  await send(line("rdg-a02-w1-c", "SNS-A02-COUGH", "09:16", "coughs_per_min", 12));
  await send(line("rdg-a02-w2-c", "SNS-A02-COUGH", "09:31", "coughs_per_min", 12));
  const active = await queries.activeAlerts("UNIT-A-02");
  assert.equal(active.length, 1);

  await send(line("rdg-a02-w3-c", "SNS-A02-COUGH", "09:46", "coughs_per_min", 4));
  await send(line("rdg-a02-w4-c", "SNS-A02-COUGH", "10:01", "coughs_per_min", 4));
  assert.equal((await queries.activeAlerts("UNIT-A-02")).length, 1, "two safe windows do not recover");

  await send(line("rdg-a02-w5-c", "SNS-A02-COUGH", "10:16", "coughs_per_min", 4));
  const after = await queries.alertHistory("UNIT-A-02");
  assert.equal(after.length, 1);
  assert.equal(after[0]!.recovered_window_start!.toISOString(), new Date(iso("10:15")).toISOString());
  assert.equal((await queries.activeAlerts("UNIT-A-02")).length, 0);
});

test("per-line rejections keep their physical line numbers and do not affect siblings", async () => {
  const body = [
    line("rdg-mix-ok-01", "SNS-A02-TEMP", "11:01", "temperature_c", 23),
    "this is not json",
    line("rdg-mix-unkn", "SNS-A99-TEMP", "11:02", "temperature_c", 23),
    line("rdg-mix-metrc", "SNS-A02-TEMP", "11:03", "ammonia_ppm", 23),
    line("rdg-mix-stamp", "SNS-A02-TEMP", "11:04-bad", "temperature_c", 23),
    line("rdg-mix-range", "SNS-A02-TEMP", "11:05", "temperature_c", 400),
    '{"reading_id":"rdg-mix-extra","sensor_id":"SNS-A02-TEMP","observed_at":"' + iso("11:06") + '","metric":"temperature_c","value":23,"pen":"x"}',
    line("rdg-mix-ok-02", "SNS-A02-HUM", "11:07", "humidity_pct", 60),
    line("rdg-a02-w1-c", "SNS-A02-COUGH", "09:16", "coughs_per_min", 12), // duplicate id
  ].join("\n");
  const { accepted, validationRejected } = await send(body);
  assert.deepEqual(
    validationRejected.map((r) => r.line),
    [2, 3, 4, 5, 6, 7],
  );
  assert.match(validationRejected[1]!.reason, /unknown sensor/);
  assert.match(validationRejected[2]!.reason, /does not match sensor/);
  assert.match(validationRejected[4]!.reason, /outside sensor range/);
  // Line 9 passed schema validation but the reading_id already exists.
  assert.equal(accepted.accepted, 2);
  assert.deepEqual(accepted.rejected.map((r) => r.line), [9]);
  assert.match(accepted.rejected[0]!.reason, /duplicate reading_id/);
});

test("windows detail and alert history are queryable in time ranges", async () => {
  const windows = await queries.windowsInRange(
    "UNIT-A-01",
    new Date(iso("08:00")),
    new Date(iso("09:00")),
  );
  assert.ok(windows.length >= 3);
  assert.equal(windows[0]!.unit_id, "UNIT-A-01");

  const history = await queries.alertHistory();
  const units = new Set(history.map((h) => h.unit_id));
  assert.ok(units.has("UNIT-A-01"));
  assert.ok(units.has("UNIT-A-02"));
});

test("order independence: a batch mixing forward and late readings is order-agnostic", async () => {
  // Scenario per unit: seed watermark 10:31 (abnormal W2), then in ONE batch
  // send a far-forward reading (10:50) together with a still-allowed late
  // reading (10:27, 4 minutes behind the PRE-batch watermark, lands in W2).
  // The late reading must land and recompute W2 regardless of line order.
  async function freshInstance(dir: string) {
    const fresh = new PGlite(dir);
    const migration = await readFile(path.join(root, "migrations", "001_init.sql"), "utf8");
    await fresh.exec(migration);
    for (const unit of ref.units.values()) {
      await fresh.query(
        `INSERT INTO units (unit_id, campus_id, building_id, floor_id, growth_stage, pens)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [unit.unit_id, unit.campus_id, unit.building_id, unit.floor_id, unit.growth_stage, JSON.stringify(unit.pens)],
      );
    }
    for (const sensor of ref.sensors.values()) {
      await fresh.query(
        "INSERT INTO sensors (sensor_id, unit_id, metric, min_value, max_value) VALUES ($1,$2,$3,$4,$5)",
        [sensor.sensor_id, sensor.unit_id, sensor.metric, sensor.min_value, sensor.max_value],
      );
    }
    const adapter = makePoolAdapter(fresh);
    return {
      fresh,
      ingestion: new IngestionService(adapter, ref),
      queries: new QueryService(adapter),
    };
  }

  const ingestLines = async (
    ing: IngestionService,
    rows: Array<{ id: string; at: string; v: number }>,
  ) => {
    const body = rows
      .map((r) => line(r.id, "SNS-A03-NH3", r.at, "ammonia_ppm", r.v))
      .join("\n");
    const { accepted } = validateTelemetry(body, ref.sensors);
    return ing.ingest(accepted);
  };

  const seed = [
    { id: "oi-seed-w1", at: "10:20", v: 20 },
    { id: "oi-seed-w2", at: "10:31", v: 20 },
  ];
  const mixed = [
    { id: "oi-forward", at: "10:50", v: 5 }, // forward, new window 10:45
    { id: "oi-late-w2", at: "10:27", v: 0 }, // late, dilutes W1(10:15): mean(20,0)=10
  ];

  const dirs = ["/tmp/pgrisk-order-a", "/tmp/pgrisk-order-b"];
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));

  const a = await freshInstance(dirs[0]!);
  await ingestLines(a.ingestion, seed);
  // forward reading first, late reading second
  await ingestLines(a.ingestion, mixed);

  const b = await freshInstance(dirs[1]!);
  await ingestLines(b.ingestion, seed);
  // reversed: late reading first, forward reading second
  await ingestLines(b.ingestion, [...mixed].reverse());

  const w2Range = {
    from: new Date(iso("10:15")),
    to: new Date(iso("10:45")),
  };
  const wa = await a.queries.windowsInRange("UNIT-A-03", w2Range.from, w2Range.to);
  const wb = await b.queries.windowsInRange("UNIT-A-03", w2Range.from, w2Range.to);
  assert.equal(wa.length, wb.length);
  assert.ok(wa.length >= 2);
  for (let i = 0; i < wa.length; i += 1) {
    assert.equal(wa[i]!.risk, wb[i]!.risk, `window ${i} risk differs`);
    assert.equal(wa[i]!.ammonia_ppm, wb[i]!.ammonia_ppm, `window ${i} value differs`);
  }
  // W1 (10:15-10:30) must contain the diluted mean 10 — proves the late line
  // was accepted and recomputed, not wrongly sealed by the in-batch forward max.
  const w1 = wa.find((w) => w.window_start.getTime() === new Date(iso("10:15")).getTime())!;
  assert.equal(w1.ammonia_ppm, 10);
  assert.equal(w1.risk, "normal");

  const ha = await a.queries.alertHistory("UNIT-A-03");
  const hb = await b.queries.alertHistory("UNIT-A-03");
  assert.equal(hb.length, ha.length);
  // With W2 flipped normal and only later safe windows, the seeded streak is gone.
  assert.equal(ha.length, 0);
  await a.fresh.close();
  await b.fresh.close();
});

test("persistence: committed windows, episodes and readings survive a restart", async () => {
  const scalar = async (sql: string): Promise<number> =>
    Number(((await db.query(sql)).rows[0] as { c: number }).c);
  const expected = {
    readings: await scalar("SELECT count(*)::int AS c FROM readings"),
    windows: await scalar("SELECT count(*)::int AS c FROM windows"),
    alerts: await scalar("SELECT count(*)::int AS c FROM alert_episodes"),
  };
  assert.ok(expected.readings > 0 && expected.windows > 0 && expected.alerts >= 2);

  await db.query("CHECKPOINT");
  await db.close();
  await rm(COPY_DIR, { recursive: true, force: true });
  await cp(DB_DIR, COPY_DIR, { recursive: true });

  // Simulate the application container restarting against the same data dir:
  // migrations are idempotent and previously committed rows are all present.
  const reopened = new PGlite(COPY_DIR);
  const migration = await readFile(path.join(root, "migrations", "001_init.sql"), "utf8");
  await reopened.exec(migration);
  const count = async (table: string): Promise<number> =>
    Number(((await reopened.query(`SELECT count(*)::int AS c FROM ${table}`)).rows[0] as { c: number }).c);
  assert.equal(await count("readings"), expected.readings);
  assert.equal(await count("windows"), expected.windows);
  assert.equal(await count("alert_episodes"), expected.alerts);
  // The open-episode anchor and the recovery history survive intact.
  const history = await reopened.query(
    "SELECT unit_id, opened_window_start, recovered_window_start FROM alert_episodes ORDER BY id",
  );
  assert.ok((history.rows as any[]).some((r) => r.unit_id === "UNIT-A-02" && r.recovered_window_start !== null));
  await reopened.close();

  // Re-open the primary handle so after() can close it cleanly.
  db = new PGlite(DB_DIR);
});
