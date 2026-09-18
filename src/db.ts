import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

export function createPool(databaseUrl: string): PgPool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
  });
}

/**
 * Applies every pending SQL migration once, in filename order, tracking
 * applied files in schema_migrations. Safe to run on every boot.
 */
export async function runMigrations(
  pool: PgPool,
  migrationsDir: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows: applied } = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations",
    );
    const appliedSet = new Set(applied.map((r) => r.filename));

    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * (Re)loads the reference data from the repository fixtures. Reference data
 * is small and configuration-owned; it is upserted so fresh fixtures replace
 * stale rows without dropping telemetry.
 */
export async function syncReferenceData(
  pool: PgPool,
  data: {
    units: Array<{
      unit_id: string;
      campus_id: string;
      building_id: string;
      floor_id: string;
      growth_stage: string;
      pens: string[];
    }>;
    sensors: Array<{
      sensor_id: string;
      unit_id: string;
      metric: string;
      min_value: number;
      max_value: number;
    }>;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const unit of data.units) {
      await client.query(
        `INSERT INTO units (unit_id, campus_id, building_id, floor_id, growth_stage)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (unit_id) DO UPDATE
           SET campus_id = EXCLUDED.campus_id,
               building_id = EXCLUDED.building_id,
               floor_id = EXCLUDED.floor_id,
               growth_stage = EXCLUDED.growth_stage`,
        [unit.unit_id, unit.campus_id, unit.building_id, unit.floor_id, unit.growth_stage],
      );
      for (const penId of unit.pens) {
        await client.query(
          "INSERT INTO pens (pen_id, unit_id) VALUES ($1,$2) ON CONFLICT (pen_id) DO NOTHING",
          [penId, unit.unit_id],
        );
      }
    }
    for (const sensor of data.sensors) {
      await client.query(
        `INSERT INTO sensors (sensor_id, unit_id, metric, min_value, max_value)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (sensor_id) DO UPDATE
           SET unit_id = EXCLUDED.unit_id,
               metric = EXCLUDED.metric,
               min_value = EXCLUDED.min_value,
               max_value = EXCLUDED.max_value`,
        [sensor.sensor_id, sensor.unit_id, sensor.metric, sensor.min_value, sensor.max_value],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
