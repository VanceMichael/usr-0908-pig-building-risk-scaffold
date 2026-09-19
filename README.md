# Multi-storey pig-house risk service

Node.js 22 + TypeScript backend that ingests NDJSON sensor telemetry for a
multi-level pig house, computes 15-minute event-time risk windows per unit, and
drives a debounced alert state machine — fully on-premise. It never calls a
cloud farming platform, recognition model or message service.

## What it does

1. **Batch ingestion with per-line validation** (`POST /ingest`, NDJSON body).
   Every physical line is validated independently against the contract in
   `contracts/telemetry.schema.json`:
   - device ownership — `sensor_id` must be registered (`fixtures/sensors.json`);
   - metric type — must be one of the four contract metrics and match the
     metric the device is registered for;
   - timestamp — RFC 3339 date-time **with** a timezone offset;
   - value range — finite JSON number inside the sensor's physical range;
   - reading-id shape, contract field set, duplicates (in-batch and persisted).

   Rejected lines are returned with their **1-based physical line number** and
   a reason; sibling lines are still accepted and processed. Readings older
   than the per-unit event-time watermark minus the 10-minute late-arrival
   allowance are rejected at persistence time (also with a line number).

2. **15-minute event-time windows.** Readings are bucketed per unit by their
   `observed_at` (not arrival time). Each metric in a window is aggregated by
   arithmetic mean; each present metric is classified against the unit's
   growth-stage thresholds (`fixtures/thresholds.json`), and the four signals
   combine into one of `normal` / `watch` / `critical` (worst signal wins; a
   missing metric is *not* assumed abnormal). Comparisons are strict, so a
   value equal to a threshold stays on the safer side.

3. **Deterministic recompute on late data.** A window is *sealed* once its end
   is at or before `watermark - late_arrival`; the window containing the seal
   horizon stays mutable. Every batch rewrites, per affected unit, only the
   still-mutable window suffix, then replays the alert state machine over the
   full window history. The recompute boundary is derived from the watermark
   as it existed **before** the batch, so batch result never depends on the
   physical order of lines inside the batch.

4. **Alert state machine.**
   - opens only after **two consecutive abnormal** windows (anchored at the
     second abnormal window);
   - recovers only after **three consecutive normal** windows (anchored at the
     third safe window); any abnormal window resets the safe streak.

   Episodes are reconciled by their open-window anchor using upserts: late
   data can move, downgrade or remove a still-mutable episode but can **never
   create a duplicate transition**. Sealed anchors are immutable; divergence
   raises an integrity error rather than silently rewriting history.

5. **Persistence in PostgreSQL 16.** Readings, window results and alert
   episodes are stored in normal tables (`migrations/001_init.sql`), applied
   automatically on startup via a tracked `schema_migrations` table.

## HTTP API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness + database connectivity, unit/sensor counts |
| `POST` | `/ingest` | NDJSON batch; returns `accepted`, `rejected[]` (with `line`), `recomputed_units` |
| `GET` | `/units/:unit_id/risk` | Current (latest window) risk of a unit |
| `GET` | `/units/:unit_id/windows?from=&to=` | Window detail in a time range (RFC 3339, inclusive start / exclusive end) |
| `GET` | `/alerts/active?unit_id=` | Open alert episodes (all units or one) |
| `GET` | `/alerts/history?unit_id=&from=&to=` | Alert transition history |

### Example

```sh
curl -s -X POST localhost:8080/ingest \
  -H 'content-type: application/x-ndjson' \
  --data-binary @fixtures/sample-telemetry.ndjson

curl -s 'localhost:8080/units/UNIT-A-01/windows?from=2026-09-08T08:00:00%2B08:00&to=2026-09-08T09:00:00%2B08:00'
```

## Layout

```
contracts/        NDJSON record contract (provided)
fixtures/         topology, sensor registry, thresholds, sample + acceptance NDJSON
migrations/       PostgreSQL migrations (applied on startup)
scaffold/         original asset cross-validator (provided)
scripts/          container acceptance entrypoints
src/
  config.ts        fixture/config loading
  validation.ts    per-line NDJSON validation with physical line numbers
  risk.ts          windowing, threshold classification, alert state machine (pure)
  ingestion.ts     watermarks, sealing, deterministic recompute, alert reconciliation
  queries.ts       read APIs (current risk, windows, alerts, history)
  db.ts            migrations, reference-data seed, connection wait
  http.ts          HTTP server
  server.ts        process entrypoint
  acceptance.ts    container acceptance driver
  *.test.ts        unit + in-process PostgreSQL integration tests
```

## Running with Docker Compose

```sh
# full one-shot, repeatable acceptance (tears down volume first)
./scripts/acceptance.sh

# or run the service persistently
docker compose up --build
# service on http://localhost:8080, PostgreSQL 16 in the `postgres` service
```

The compose stack wires `postgres`, the `app` service (with a `/health`
healthcheck and startup migration/seed), the original `scaffold` validator, and
a one-shot `acceptance` service.

## Acceptance proof

`fixtures/acceptance/*.ndjson` are driven through the real HTTP API by
`src/acceptance.ts`:

1. all-in-range window → `normal`, no alert;
2. two consecutive abnormal windows → alert opens, anchored at the second;
3. a reading ~4 minutes late dilutes the second window → deterministic
   recompute, same episode row (no duplicate transition), peak downgraded;
4. three consecutive safe windows → recovery at the third;
5. one NDJSON batch with eight illegal lines interleaved with legal ones →
   exact physical line numbers 2–9 with the right reasons, legal lines kept;
6. a reading beyond the 10-minute watermark allowance is rejected by line
   number without touching stored state;
7. an independent unit maintains its own episode;
8. window-range and alert-history queries return the expected sequence;
9. the batch is replayed → every reading is rejected as a duplicate;
10. a **fresh application process** is started against the same database and
    re-checks all state (readings, windows, anchors, recovery, active alerts)
    to prove persistence across restart.

## Local development (no Docker required)

```sh
npm ci
npm run build
npm test          # node:test: pure logic + full SQL/transactional paths on
                  # an in-process PostgreSQL engine (PGlite)
DATABASE_URL=postgres://pig_risk:scaffold-only@localhost:5432/pig_risk \
FIXTURES_DIR=./fixtures npm start
```

## Background

Inspired by the 2026-09-08 China News report about intelligent multi-storey
pig farming in Zhengzhou. The service does not call or mirror any external
website or service at runtime.
