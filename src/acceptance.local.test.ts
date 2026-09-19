import { rm } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { readFile } from "node:fs/promises";
import { loadReferenceData } from "./config.js";
import { createApp } from "./http.js";

// Boots the real HTTP app on PGlite and runs the compiled container acceptance
// driver (phase 1: ingest + every assertion) against it over real HTTP. The
// container-restart phase lives in scripts/acceptance-container.sh.
test("acceptance driver phase 1 passes against repository fixtures", { timeout: 120_000 }, async () => {
  await rm("/tmp/pgrisk-pglite-acceptance", { recursive: true, force: true });
  const db = new PGlite("/tmp/pgrisk-pglite-acceptance");
  const root = process.cwd();
  await db.exec(await readFile(path.join(root, "migrations", "001_init.sql"), "utf8"));
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

  const server = createApp({ pool, ref });
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn("node", ["dist/acceptance.js"], {
      env: { ...process.env, BASE_URL: baseUrl, FIXTURES_DIR: path.join(root, "fixtures") },
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      server.close();
      void db.close().then(() => (code === 0 ? resolve() : reject(new Error(`driver exit ${code}`))));
    });
  });
});
