import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import type { ReferenceData } from "./config.js";

/**
 * Applies every migrations/*.sql file exactly once, tracked in
 * schema_migrations. Migration files are immutable once shipped: version
 * numbers sort lexicographically and must never be reused.
 */
export async function runMigrations(pool: Pool, migrationsDir: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations",
  );
  const applied = new Set(rows.map((row) => row.version));

  const files = (await listMigrationFiles(migrationsDir)).filter((file) => !applied.has(file));
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
        [file],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }
}

async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  // Node has no recursive fs.readdir requirement here; the folder is flat.
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(migrationsDir);
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

/** Seeds (and re-aligns) the reference tables from the validated fixtures. */
export async function seedReferenceData(pool: Pool, ref: ReferenceData): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const unit of ref.units.values()) {
      await client.query(
        `INSERT INTO units (unit_id, campus_id, building_id, floor_id, growth_stage, pens)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (unit_id) DO UPDATE SET
           campus_id = EXCLUDED.campus_id,
           building_id = EXCLUDED.building_id,
           floor_id = EXCLUDED.floor_id,
           growth_stage = EXCLUDED.growth_stage,
           pens = EXCLUDED.pens,
           updated_at = now()`,
        [unit.unit_id, unit.campus_id, unit.building_id, unit.floor_id, unit.growth_stage, JSON.stringify(unit.pens)],
      );
    }
    for (const sensor of ref.sensors.values()) {
      await client.query(
        `INSERT INTO sensors (sensor_id, unit_id, metric, min_value, max_value)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (sensor_id) DO UPDATE SET
           unit_id = EXCLUDED.unit_id,
           metric = EXCLUDED.metric,
           min_value = EXCLUDED.min_value,
           max_value = EXCLUDED.max_value,
           updated_at = now()`,
        [sensor.sensor_id, sensor.unit_id, sensor.metric, sensor.min_value, sensor.max_value],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function waitForDatabase(connectionString: string, attempts = 30, delayMs = 1000): Promise<Pool> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pool = new Pool({ connectionString, max: 10 });
    try {
      await pool.query("SELECT 1");
      return pool;
    } catch (error) {
      lastError = error;
      await pool.end();
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`database not reachable after ${attempts} attempts: ${String(lastError)}`);
}
