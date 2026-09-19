import { Pool } from "pg";
import type { Risk } from "./types.js";

export interface WindowRow {
  unit_id: string;
  window_start: Date;
  window_end: Date;
  temperature_c: number | null;
  humidity_pct: number | null;
  ammonia_ppm: number | null;
  coughs_per_min: number | null;
  readings_count: number;
  risk: Risk;
  abnormal: boolean;
  safe: boolean;
  factors: unknown;
}

export interface AlertRow {
  id: number;
  unit_id: string;
  opened_window_start: Date;
  opened_at: Date;
  peak_risk: Risk;
  recovered_window_start: Date | null;
  recovered_at: Date | null;
}

export interface CurrentRiskRow extends WindowRow {
  growth_stage: string;
  campus_id: string;
  building_id: string;
  floor_id: string;
}

export class QueryService {
  constructor(private readonly pool: Pool) {}

  /** Latest computed window of a unit; null when the unit has no windows yet. */
  async currentRisk(unitId: string): Promise<CurrentRiskRow | null> {
    const { rows } = await this.pool.query<CurrentRiskRow>(
      `SELECT w.*, u.growth_stage, u.campus_id, u.building_id, u.floor_id
       FROM windows w JOIN units u USING (unit_id)
       WHERE w.unit_id = $1
       ORDER BY w.window_start DESC
       LIMIT 1`,
      [unitId],
    );
    return rows[0] ?? null;
  }

  async activeAlerts(unitId?: string | null): Promise<AlertRow[]> {
    const { rows } = await this.pool.query<AlertRow>(
      `SELECT id, unit_id, opened_window_start, opened_at, peak_risk,
              recovered_window_start, recovered_at
       FROM alert_episodes
       WHERE recovered_at IS NULL
         AND ($1::text IS NULL OR unit_id = $1)
       ORDER BY opened_window_start, unit_id`,
      [unitId ?? null],
    );
    return rows;
  }

  async windowsInRange(
    unitId: string,
    from: Date,
    to: Date,
  ): Promise<WindowRow[]> {
    const { rows } = await this.pool.query<WindowRow>(
      `SELECT unit_id, window_start, window_end, temperature_c, humidity_pct,
              ammonia_ppm, coughs_per_min, readings_count, risk, abnormal, safe, factors
       FROM windows
       WHERE unit_id = $1 AND window_start >= $2 AND window_start < $3
       ORDER BY window_start`,
      [unitId, from, to],
    );
    return rows;
  }

  async alertHistory(
    unitId?: string | null,
    from?: Date,
    to?: Date,
  ): Promise<AlertRow[]> {
    const { rows } = await this.pool.query<AlertRow>(
      `SELECT id, unit_id, opened_window_start, opened_at, peak_risk,
              recovered_window_start, recovered_at
       FROM alert_episodes
       WHERE ($1::text IS NULL OR unit_id = $1)
         AND ($2::timestamptz IS NULL OR opened_window_start >= $2)
         AND ($3::timestamptz IS NULL OR opened_window_start < $3)
       ORDER BY opened_window_start, unit_id`,
      [unitId ?? null, from ?? null, to ?? null],
    );
    return rows;
  }

  async readingById(readingId: string): Promise<{ reading_id: string } | null> {
    const { rows } = await this.pool.query<{ reading_id: string }>(
      "SELECT reading_id FROM readings WHERE reading_id = $1",
      [readingId],
    );
    return rows[0] ?? null;
  }

  async countReadings(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM readings",
    );
    return Number(rows[0]?.count ?? 0);
  }
}
