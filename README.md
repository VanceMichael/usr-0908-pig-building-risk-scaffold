# Multi-storey pig-house risk service

A pure backend service (Node.js 22 + TypeScript) that ingests sensor telemetry
from a multi-level pig house — campus / building / floor / unit / pen topology —
and turns ventilation-related environmental signals (temperature, humidity,
ammonia) together with cough monitoring into a traceable per-unit risk state.

It never calls any cloud farming platform, recognition model, or message
service. All inputs arrive as batches; all state lives in PostgreSQL.

## What it does

1. **Batch ingestion & validation** — `POST /v1/telemetry` accepts NDJSON. Each
   line is validated independently against the field contract
   (`contracts/telemetry.schema.json`), the sensor registry
   (`fixtures/sensors.json`) and the registered value range: exact field set,
   reading/sensor id format, RFC 3339 timestamp, metric enumeration, device
   ownership, sensor/metric match, value range, and duplicate reading ids.
   Illegal lines are rejected **with their physical line number** and never
   affect the other lines of the batch (HTTP 207).
2. **Fifteen-minute event-time windows** — readings are grouped per unit by
   `floor(observed_at / 15 min)` on the UTC grid. Within a window every metric
   is averaged, classified against the unit's growth-stage thresholds
   (`fixtures/thresholds.json`), and the window risk is the worst metric level:
   `normal` / `watch` / `critical`.
3. **Deterministic late data** — a per-unit event-time watermark is tracked.
   Readings up to **10 minutes** behind the watermark are accepted and trigger
   a deterministic recomputation of the window (and alert history) from raw
   readings; older readings are rejected with `too_late`.
4. **Alert state machine** — an alert opens only after **two consecutive
   abnormal windows** and recovers only after **three consecutive normal
   windows** while open. Alert episodes have a stable identity
   `(unit_id, opened_window)` and deterministic event-time timestamps, so late
   recomputation updates rows in place and **never emits a duplicate
   transition** (it can also retract an episode whose triggering windows are
   rewritten to normal). Gaps on the window grid break streaks.
5. **Persistence & queries** — raw readings, window results (with metric
   breakdown and recompute counter), alert episodes and watermarks are stored
   in PostgreSQL 16. APIs expose current unit risk, active alerts, window
   detail and alert history over time ranges, plus persisted readings.

## Layout

```
contracts/         input record contract (provided)
fixtures/          topology, sensor registry, growth-stage thresholds (provided)
scaffold/          original asset validator (provided, unchanged)
migrations/        SQL migration (applied automatically at boot)
src/               TypeScript service
  config.ts          env configuration
  db.ts              pg pool, migration runner, reference-data sync
  staticData.ts      fixture loading
  types.ts           shared types
  validation.ts      per-line NDJSON validation
  domain.ts          pure windowing + threshold + alert state-machine logic
  engine.ts          transactional ingest, watermark/lateness, recompute
  queries.ts         risk / windows / alerts / readings query APIs
  http.ts            express routes
  main.ts            entrypoint
scripts/acceptance.mjs   repeatable end-to-end acceptance (HTTP only)
scripts/acceptance.sh    container wrapper incl. app restart persistence proof
Dockerfile         multi-stage Node 22 image
compose.yaml       postgres + app (+ scaffold, + acceptance profiles)
```

## Run with Docker Compose

```sh
# start the stack (PostgreSQL 16 + app on :8080)
docker compose up --build

# validate the original provided assets
docker compose --profile scaffold up --build --abort-on-container-exit --exit-code-from scaffold

# one-command acceptance: rebuild, run the full scenario, restart the app,
# and verify persistence afterwards (repeatable; tears down its volume)
scripts/acceptance.sh
```

Health checks:

- `GET /livez` — process alive
- `GET /healthz` — process + database (`SELECT 1`)

Compose marks `postgres` healthy with `pg_isready` and `app` healthy with
`/healthz`; the acceptance service waits for the app healthcheck.

## HTTP API

All telemetry bodies are `application/x-ndjson` (one JSON object per line).

### Ingest

```sh
curl -s -X POST localhost:8080/v1/telemetry \
  -H 'content-type: application/x-ndjson' \
  --data-binary @fixtures/sample-telemetry.ndjson
```

Response `207`:

```json
{
  "batch_size": 6,
  "accepted_count": 6,
  "rejected_count": 0,
  "accepted": [{"line": 1, "reading_id": "...", "unit_id": "UNIT-A-01", "window_start": "2026-09-08T00:00:00.000Z"}],
  "rejected": [],
  "windows_changed": [{"unit_id": "UNIT-A-01", "window_start": "...", "risk": "watch"}],
  "alert_transitions": [{"unit_id": "UNIT-A-01", "opened_window": "...", "transition": "opened"}]
}
```

Rejection codes: `invalid_json`, `invalid_record`, `unknown_sensor`,
`metric_mismatch`, `value_out_of_range`, `duplicate_reading_id`, `too_late`.
Every rejection carries the physical `line`.

### Queries

| Method & path | Purpose |
|---|---|
| `GET /v1/risk?unit_id=…` | latest window risk per unit (repeatable filter) |
| `GET /v1/units/:unitId/risk` | one unit's current risk + alert status |
| `GET /v1/alerts/active?unit_id=…` | open alert episodes |
| `GET /v1/alerts?from=&to=&unit_id=…` | alert history overlapping a range |
| `GET /v1/windows?from=&to=&unit_id=…` | window results in a range |
| `GET /v1/units/:unitId/windows?from=&to=` | one unit's window detail |
| `GET /v1/readings?from=&to=&unit_id=…` | persisted raw readings |
| `GET /healthz` / `GET /livez` | health |

Times accept ISO 8601 date-time (e.g. `2026-09-08T00:00:00Z`); all response
timestamps are ISO 8601 UTC. Ranges are half-open `[from, to)`.

## Windowing & alert semantics

- Windows are aligned to the UTC 15-minute grid regardless of the input
  offset (the campus timezone is Asia/Shanghai; `08:00+08:00` → `00:00Z`).
- Threshold comparisons are inclusive at the boundary (a value equal to
  `watch_above` is `watch`).
- A window's risk is the maximum metric level after averaging each metric's
  readings in that window.
- Streaks require consecutive windows on the grid with no gap; a missing
  window resets both the abnormal and the normal streak.
- Alert episode `opened_at` / `recovered_at` are deterministic event-time
  instants (the closing boundary of the triggering window), never wall-clock
  processing time — required so recomputation is reproducible.
- Recomputation rewrites only windows whose inputs changed; alert episodes
  are re-derived from the unit's whole window history inside the same
  transaction (row locks on `units` serialise concurrent batches per unit).

## Local development without Docker

```sh
npm ci
npm run build
DATABASE_URL=postgres://pig_risk:scaffold-only@localhost:5432/pig_risk \
FIXTURES_DIR=$PWD/fixtures MIGRATIONS_DIR=$PWD/migrations \
  node dist/main.js
BASE_URL=http://localhost:8080 npm run accept
```
