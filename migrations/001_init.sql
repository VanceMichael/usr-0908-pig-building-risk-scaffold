-- 001_init.sql: multi-storey pig-house risk service
-- Reference data, telemetry, 15-minute event-time windows, and the alert
-- episode state machine. Migration bookkeeping lives in src/db.ts.

CREATE TABLE IF NOT EXISTS units (
  unit_id       TEXT PRIMARY KEY,
  campus_id     TEXT NOT NULL,
  building_id   TEXT NOT NULL,
  floor_id      TEXT NOT NULL,
  growth_stage  TEXT NOT NULL,
  pens          JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sensors (
  sensor_id   TEXT PRIMARY KEY,
  unit_id     TEXT NOT NULL REFERENCES units(unit_id) ON UPDATE CASCADE,
  metric      TEXT NOT NULL CHECK (metric IN ('temperature_c','humidity_pct','ammonia_ppm','coughs_per_min')),
  min_value   DOUBLE PRECISION NOT NULL,
  max_value   DOUBLE PRECISION NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS readings (
  reading_id    TEXT PRIMARY KEY,
  sensor_id     TEXT NOT NULL REFERENCES sensors(sensor_id),
  unit_id       TEXT NOT NULL REFERENCES units(unit_id),
  metric        TEXT NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL,
  value         DOUBLE PRECISION NOT NULL,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  batch_id      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_readings_unit_time ON readings (unit_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_readings_ingested  ON readings (ingested_at);

-- One row per (unit, 15-minute event-time window start). Rewritten on
-- deterministic recomputation triggered by late arrivals.
CREATE TABLE IF NOT EXISTS windows (
  unit_id         TEXT NOT NULL REFERENCES units(unit_id),
  window_start    TIMESTAMPTZ NOT NULL,
  window_end      TIMESTAMPTZ NOT NULL,
  temperature_c   DOUBLE PRECISION,
  humidity_pct    DOUBLE PRECISION,
  ammonia_ppm     DOUBLE PRECISION,
  coughs_per_min  DOUBLE PRECISION,
  readings_count  INTEGER NOT NULL DEFAULT 0,
  risk            TEXT NOT NULL CHECK (risk IN ('normal','watch','critical')),
  abnormal        BOOLEAN NOT NULL,
  safe            BOOLEAN NOT NULL,
  factors         JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (unit_id, window_start)
);

-- Alert lifecycle. A row moves open -> recovered at most once; late data can
-- never create a duplicate transition for the same unit/window.
CREATE TABLE IF NOT EXISTS alert_episodes (
  id                   BIGSERIAL PRIMARY KEY,
  unit_id              TEXT NOT NULL REFERENCES units(unit_id),
  opened_window_start  TIMESTAMPTZ NOT NULL,
  opened_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  peak_risk            TEXT NOT NULL CHECK (peak_risk IN ('watch','critical')),
  recovered_window_start TIMESTAMPTZ,
  recovered_at         TIMESTAMPTZ,
  UNIQUE (unit_id, opened_window_start)
);
CREATE INDEX IF NOT EXISTS idx_alerts_unit_open ON alert_episodes (unit_id, opened_at)
  WHERE recovered_at IS NULL;

CREATE TABLE IF NOT EXISTS batches (
  id            BIGSERIAL PRIMARY KEY,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted      INTEGER NOT NULL,
  rejected      INTEGER NOT NULL
);
