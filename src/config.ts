export interface AppConfig {
  port: number;
  databaseUrl: string;
  fixturesDir: string;
  migrationsDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl =
    env.DATABASE_URL ??
    "postgres://pig_risk:scaffold-only@postgres:5432/pig_risk";
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl,
    fixturesDir: env.FIXTURES_DIR ?? "/app/fixtures",
    migrationsDir: env.MIGRATIONS_DIR ?? "/app/migrations",
  };
}
