import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { Server } from "node:http";
import { loadReferenceData } from "./config.js";
import { createApp } from "./http.js";

const root = process.cwd();
let db: PGlite;
let server: Server;
let baseUrl: string;

before(async () => {
  await rm("/tmp/pgrisk-pglite-http", { recursive: true, force: true });
  db = new PGlite("/tmp/pgrisk-pglite-http");
  const migration = await readFile(path.join(root, "migrations", "001_init.sql"), "utf8");
  await db.exec(migration);
  const ref = await loadReferenceData(path.join(root, "fixtures"));
  for (const unit of ref.units.values()) {
    await db.query(
      `INSERT INTO units (unit_id, campus_id, building_id, floor_id, growth_stage, pens)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [unit.unit_id, unit.campus_id, unit.building_id, unit.floor_id, unit.growth_stage, JSON.stringify(unit.pens)],
    );
  }
  for (const sensor of ref.sensors.values()) {
    await db.query(
      "INSERT INTO sensors (sensor_id, unit_id, metric, min_value, max_value) VALUES ($1,$2,$3,$4,$5)",
      [sensor.sensor_id, sensor.unit_id, sensor.metric, sensor.min_value, sensor.max_value],
    );
  }
  const query = (text: string, params?: unknown[]) =>
    db.query(text, params as any[]).then(
      (r): QueryResult<QueryResultRow> => ({
        rows: r.rows as QueryResultRow[],
        command: "",
        rowCount: r.rows.length,
        oid: 0,
        fields: [],
      }),
    );
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} } as unknown as PoolClient),
  } as unknown as Pool;

  server = createApp({ pool, ref });
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});

const rec = (readingId: string, sensor: string, at: string, metric: string, value: number) =>
  JSON.stringify({
    reading_id: readingId,
    sensor_id: sensor,
    observed_at: `2026-09-08T${at}:00+08:00`,
    metric,
    value,
  });

async function post(pathName: string, body: string): Promise<{ status: number; json: any }> {
  const response = await fetch(baseUrl + pathName, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body,
  });
  return { status: response.status, json: await response.json() };
}

async function get(pathName: string): Promise<{ status: number; json: any }> {
  const response = await fetch(baseUrl + pathName);
  return { status: response.status, json: await response.json() };
}

test("GET /health reports ok with database up", async () => {
  const { status, json } = await get("/health");
  assert.equal(status, 200);
  assert.equal(json.status, "ok");
  assert.equal(json.database, "up");
  assert.equal(json.sensors, 12);
});

test("POST /ingest accepts valid NDJSON and rejects lines by physical number", async () => {
  const body = [
    rec("http-ok-0001", "SNS-A01-NH3", "08:05", "ammonia_ppm", 10),
    "{broken",
    rec("http-bad-0002", "SNS-A01-HUM", "08:06", "temperature_c", 10),
    rec("http-ok-0003", "SNS-A01-TEMP", "08:07", "temperature_c", 25),
  ].join("\n");
  const { status, json } = await post("/ingest", body);
  assert.equal(status, 200);
  assert.equal(json.accepted, 2);
  assert.deepEqual(json.rejected.map((r: any) => r.line), [2, 3]);
  assert.equal(json.rejected[0].reason.includes("malformed JSON"), true);
});

test("current risk endpoint returns the latest window", async () => {
  const { status, json } = await get("/units/UNIT-A-01/risk");
  assert.equal(status, 200);
  assert.equal(json.current.unit_id, "UNIT-A-01");
  assert.equal(json.current.risk, "normal");
  assert.equal(typeof json.current.window_start, "string");
});

test("windows range endpoint validates parameters", async () => {
  const bad = await get("/units/UNIT-A-01/windows?from=2026-09-08T00:00:00Z");
  assert.equal(bad.status, 400);
  const reversed = await get(
    "/units/UNIT-A-01/windows?from=2026-09-08T09:00:00%2B08:00&to=2026-09-08T08:00:00%2B08:00",
  );
  assert.equal(reversed.status, 400);
  const ok = await get(
    "/units/UNIT-A-01/windows?from=2026-09-08T08:00:00%2B08:00&to=2026-09-08T09:00:00%2B08:00",
  );
  assert.equal(ok.status, 200);
  assert.ok(ok.json.windows.length >= 1);

  const missing = await get("/units/NO-SUCH-UNIT/risk");
  assert.equal(missing.status, 404);
});

test("active alerts and history endpoints", async () => {
  // Two consecutive abnormal windows for UNIT-A-03.
  await post("/ingest", rec("http-a03-w1", "SNS-A03-NH3", "09:05", "ammonia_ppm", 40));
  await post("/ingest", rec("http-a03-w2", "SNS-A03-NH3", "09:20", "ammonia_ppm", 40));

  const active = await get("/alerts/active");
  assert.equal(active.status, 200);
  assert.equal(active.json.alerts.length, 1);
  assert.equal(active.json.alerts[0].unit_id, "UNIT-A-03");
  assert.equal(active.json.alerts[0].peak_risk, "critical");
  assert.equal(active.json.alerts[0].recovered_at, null);

  const filtered = await get("/alerts/history?unit_id=UNIT-A-03");
  assert.equal(filtered.json.alerts.length, 1);
  const none = await get("/alerts/history?unit_id=UNIT-A-01");
  assert.equal(none.json.alerts.length, 0);

  const badUnit = await get("/alerts/active?unit_id=NOPE");
  assert.equal(badUnit.status, 404);
});

test("empty body and unknown routes are rejected cleanly", async () => {
  const empty = await post("/ingest", "");
  assert.equal(empty.status, 400);
  const notFound = await get("/nope");
  assert.equal(notFound.status, 404);
});
