import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig, loadReferenceData } from "./config.js";
import { runMigrations, seedReferenceData, waitForDatabase } from "./db.js";
import { createApp } from "./http.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const ref = await loadReferenceData(config.fixturesDir);

  const pool = await waitForDatabase(config.databaseUrl);
  const here = path.dirname(fileURLToPath(import.meta.url));
  await runMigrations(pool, path.resolve(here, "..", "migrations"));
  await seedReferenceData(pool, ref);

  const server = createApp({ pool, ref });
  server.listen(config.port, () => {
    console.log(
      `pig-house-risk listening on :${config.port} ` +
        `(${ref.units.size} units, ${ref.sensors.size} sensors)`,
    );
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => void pool.end().then(() => process.exit(0)));
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("startup failed:", error);
  process.exit(1);
});
