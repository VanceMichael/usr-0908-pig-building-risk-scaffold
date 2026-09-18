import type { PgPool } from "./db.js";

export interface UnitCurrentRisk {
  unit_id: string;
  growth_stage: string;
  risk: "normal" | "watch" | "critical" | null;
  window_start: string | null;
  window_end: string | null;
  updated_at: string | null;
  alert_status: "open" | "recovered" | "none";
  metric_breakdown: unknown;
}

/** Latest window result per unit, plus whether an alert episode is open. */
export async function getCurrentRisk(
  pool: PgPool,
  windowMinutes: number,
  unitIds?: string[],
): Promise<UnitCurrentRisk[]> {
  const params: unknown[] = [windowMinutes];
  let filter = "";
  if (unitIds && unitIds.length > 0) {
    params.push(unitIds);
    filter = "WHERE u.unit_id = ANY($2::text[])";
  }
  const { rows } = await pool.query(
    `SELECT u.unit_id,
            u.growth_stage,
            w.risk,
            w.window_start,
            w.metric_breakdown,
            w.updated_at,
            (w.window_start + make_interval(mins => $1::int)) AS window_end,
            (SELECT status FROM alert_episodes a
              WHERE a.unit_id = u.unit_id
              ORDER BY a.opened_window DESC LIMIT 1) AS alert_status
     FROM units u
     LEFT JOIN LATERAL (
       SELECT * FROM window_results wr
       WHERE wr.unit_id = u.unit_id
       ORDER BY wr.window_start DESC LIMIT 1
     ) w ON true
     ${filter}
     ORDER BY u.unit_id`,
    params,
  );
  return rows.map((r) => ({
    unit_id: r.unit_id,
    growth_stage: r.growth_stage,
    risk: r.risk,
    window_start: r.window_start ? new Date(r.window_start).toISOString() : null,
    window_end: r.window_end ? new Date(r.window_end).toISOString() : null,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    alert_status: r.alert_status ?? "none",
    metric_breakdown: r.metric_breakdown,
  }));
}

export interface AlertRow {
  id: number;
  unit_id: string;
  status: "open" | "recovered";
  peak_risk: "watch" | "critical";
  opened_window: string;
  opened_at: string;
  recovered_window: string | null;
  recovered_at: string | null;
  detail: unknown;
}

function mapAlert(r: Record<string, unknown>): AlertRow {
  return {
    id: Number(r.id),
    unit_id: String(r.unit_id),
    status: r.status as AlertRow["status"],
    peak_risk: r.peak_risk as AlertRow["peak_risk"],
    opened_window: new Date(r.opened_window as Date).toISOString(),
    opened_at: new Date(r.opened_at as Date).toISOString(),
    recovered_window: r.recovered_window
      ? new Date(r.recovered_window as Date).toISOString()
      : null,
    recovered_at: r.recovered_at
      ? new Date(r.recovered_at as Date).toISOString()
      : null,
    detail: r.detail,
  };
}

/** Open alert episodes, newest first. */
export async function getActiveAlerts(
  pool: PgPool,
  unitIds?: string[],
): Promise<AlertRow[]> {
  const clauses = ["status = 'open'"];
  const params: unknown[] = [];
  if (unitIds && unitIds.length > 0) {
    params.push(unitIds);
    clauses.push(`unit_id = ANY($${params.length}::text[])`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM alert_episodes WHERE ${clauses.join(" AND ")}
     ORDER BY opened_window DESC, unit_id`,
    params,
  );
  return rows.map(mapAlert);
}

/**
 * Alert history overlapping an event-time range. Episodes that opened before
 * `from` but remain open (or recover inside) the range are included.
 */
export async function getAlertHistory(
  pool: PgPool,
  options: { from: Date; to: Date; unitIds?: string[] },
): Promise<AlertRow[]> {
  const params: unknown[] = [options.from, options.to];
  // Episode interval [opened_window, recovered_window) overlaps [from, to).
  const clauses = [
    "opened_window < $2",
    "(recovered_window IS NULL OR recovered_window >= $1)",
  ];
  if (options.unitIds && options.unitIds.length > 0) {
    params.push(options.unitIds);
    clauses.push(`unit_id = ANY($${params.length}::text[])`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM alert_episodes WHERE ${clauses.join(" AND ")}
     ORDER BY unit_id, opened_window`,
    params,
  );
  return rows.map(mapAlert);
}

export interface WindowDetail {
  unit_id: string;
  window_start: string;
  window_end: string;
  growth_stage: string;
  risk: string;
  sample_count: number;
  metrics_present: string[];
  metric_breakdown: unknown;
  first_observed_at: string | null;
  last_observed_at: string | null;
  recompute_count: number;
  updated_at: string;
}

/** Window results in an event-time range. */
export async function getWindows(
  pool: PgPool,
  windowMinutes: number,
  options: { from: Date; to: Date; unitIds?: string[] },
): Promise<WindowDetail[]> {
  const params: unknown[] = [options.from, options.to, windowMinutes];
  const clauses = ["window_start >= $1", "window_start < $2"];
  if (options.unitIds && options.unitIds.length > 0) {
    params.push(options.unitIds);
    clauses.push(`unit_id = ANY($${params.length}::text[])`);
  }
  const { rows } = await pool.query(
    `SELECT *, (window_start + make_interval(mins => $3::int)) AS window_end
     FROM window_results WHERE ${clauses.join(" AND ")}
     ORDER BY unit_id, window_start`,
    params,
  );
  return rows.map((r) => ({
    unit_id: r.unit_id,
    window_start: new Date(r.window_start).toISOString(),
    window_end: new Date(r.window_end).toISOString(),
    growth_stage: r.growth_stage,
    risk: r.risk,
    sample_count: r.sample_count,
    metrics_present: r.metrics_present,
    metric_breakdown: r.metric_breakdown,
    first_observed_at: r.first_observed_at
      ? new Date(r.first_observed_at).toISOString()
      : null,
    last_observed_at: r.last_observed_at
      ? new Date(r.last_observed_at).toISOString()
      : null,
    recompute_count: r.recompute_count,
    updated_at: new Date(r.updated_at).toISOString(),
  }));
}

export interface ReadingDetail {
  reading_id: string;
  sensor_id: string;
  unit_id: string;
  metric: string;
  observed_at: string;
  value: number;
  ingested_at: string;
}

/** Persisted readings in an event-time range (persistence query API). */
export async function getReadings(
  pool: PgPool,
  options: { from: Date; to: Date; unitIds?: string[]; limit?: number },
): Promise<ReadingDetail[]> {
  const params: unknown[] = [options.from, options.to];
  const clauses = ["observed_at >= $1", "observed_at < $2"];
  if (options.unitIds && options.unitIds.length > 0) {
    params.push(options.unitIds);
    clauses.push(`unit_id = ANY($${params.length}::text[])`);
  }
  const limit = Math.min(options.limit ?? 500, 5000);
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM readings WHERE ${clauses.join(" AND ")}
     ORDER BY observed_at, reading_id LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    reading_id: r.reading_id,
    sensor_id: r.sensor_id,
    unit_id: r.unit_id,
    metric: r.metric,
    observed_at: new Date(r.observed_at).toISOString(),
    value: Number(r.value),
    ingested_at: new Date(r.ingested_at).toISOString(),
  }));
}
