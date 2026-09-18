import { createPool, runMigrations, syncReferenceData } from "./db.js";
import { createApp } from "./http.js";
import { loadConfig } from "./config.js";
import { loadStaticData } from "./staticData.js";

async function waitForDatabase(
  connect: () => Promise<unknown>,
  attempts = 30,
  delayMs = 1000,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await connect();
      return;
    } catch (error) {
      lastError = error;
      console.log(
        `waiting for database (attempt ${attempt}/${attempts}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `database not reachable after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  await waitForDatabase(() => pool.query("SELECT 1"));
  await runMigrations(pool, config.migrationsDir);

  const staticData = await loadStaticData(config.fixturesDir);
  await syncReferenceData(pool, {
    units: [...staticData.units.values()],
    sensors: [...staticData.sensors.values()],
  });

  const app = createApp({ pool, data: staticData });
  const server = app.listen(config.port, () => {
    console.log(
      `pig-house risk service listening on :${config.port} ` +
        `(${[...staticData.units.keys()].length} units, ` +
        `${staticData.sensors.size} sensors)`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("fatal startup error:", error);
  process.exit(1);
});
