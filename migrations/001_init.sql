-- Multi-storey pig-house risk service: initial schema

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Spatial topology (campus / building / floor / unit / pen) -----------

CREATE TABLE IF NOT EXISTS units (
  unit_id      TEXT PRIMARY KEY,
  campus_id    TEXT NOT NULL,
  building_id  TEXT NOT NULL,
  floor_id     TEXT NOT NULL,
  growth_stage TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pens (
  pen_id  TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units(unit_id)
);
CREATE INDEX IF NOT EXISTS idx_pens_unit ON pens(unit_id);

-- ---- Sensor registry ------------------------------------------------------

CREATE TABLE IF NOT EXISTS sensors (
  sensor_id  TEXT PRIMARY KEY,
  unit_id    TEXT NOT NULL REFERENCES units(unit_id),
  metric     TEXT NOT NULL,
  min_value  DOUBLE PRECISION NOT NULL,
  max_value  DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sensors_unit ON sensors(unit_id);

-- ---- Raw readings ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS readings (
  reading_id  TEXT PRIMARY KEY,
  sensor_id   TEXT NOT NULL REFERENCES sensors(sensor_id),
  unit_id     TEXT NOT NULL REFERENCES units(unit_id),
  metric      TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  value       DOUBLE PRECISION NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_readings_unit_time ON readings(unit_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_readings_sensor_time ON readings(sensor_id, observed_at);

-- ---- Fifteen-minute event-time window results ------------------------------
-- One row per (unit, window_start). Recomputed deterministically when a
-- reading that falls inside the window arrives (within the lateness bound).

CREATE TABLE IF NOT EXISTS window_results (
  unit_id            TEXT NOT NULL REFERENCES units(unit_id),
  window_start       TIMESTAMPTZ NOT NULL,
  growth_stage       TEXT NOT NULL,
  risk               TEXT NOT NULL CHECK (risk IN ('normal', 'watch', 'critical')),
  metric_breakdown   JSONB NOT NULL DEFAULT '{}'::jsonb,
  sample_count       INTEGER NOT NULL,
  metrics_present    TEXT[] NOT NULL DEFAULT '{}',
  first_observed_at  TIMESTAMPTZ,
  last_observed_at   TIMESTAMPTZ,
  threshold_version  TEXT NOT NULL,
  recompute_count    INTEGER NOT NULL DEFAULT 1,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (unit_id, window_start)
);
CREATE INDEX IF NOT EXISTS idx_windows_unit_start ON window_results(unit_id, window_start);

-- ---- Alert episodes ---------------------------------------------------------
-- An episode is opened after two consecutive abnormal (watch/critical)
-- windows and recovered after three consecutive normal windows while open.
-- (unit_id, opened_window) is the stable identity: recomputes update rows
-- in place instead of creating duplicate transition records.

CREATE TABLE IF NOT EXISTS alert_episodes (
  id               BIGINT GENERATED ALWAYS AS IDENTITY,
  unit_id          TEXT NOT NULL REFERENCES units(unit_id),
  status           TEXT NOT NULL CHECK (status IN ('open', 'recovered')),
  peak_risk        TEXT NOT NULL CHECK (peak_risk IN ('watch', 'critical')),
  opened_window    TIMESTAMPTZ NOT NULL,
  opened_at        TIMESTAMPTZ NOT NULL,
  recovered_window TIMESTAMPTZ,
  recovered_at     TIMESTAMPTZ,
  detail           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (unit_id, opened_window)
);
CREATE INDEX IF NOT EXISTS idx_alerts_unit ON alert_episodes(unit_id, opened_window);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alert_episodes(status) WHERE status = 'open';

-- ---- Event-time watermark per unit ------------------------------------------

CREATE TABLE IF NOT EXISTS unit_watermarks (
  unit_id      TEXT PRIMARY KEY REFERENCES units(unit_id),
  watermark    TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
