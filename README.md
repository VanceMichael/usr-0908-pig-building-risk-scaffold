# Multi-storey pig-house risk scaffold

This repository is a starting point for a backend service that combines environmental and respiratory telemetry across a multi-level pig-house topology. It intentionally contains no ingestion API, event-time window engine, alert state machine, migrations, or application persistence.

## Provided material

- `contracts/telemetry.schema.json`: contract for one NDJSON telemetry record.
- `fixtures/topology.json`: campus, building, floor, unit, and pen relationships.
- `fixtures/sensors.json`: registered devices, their unit ownership, and metric types.
- `fixtures/thresholds.json`: growth-stage thresholds and risk labels.
- `fixtures/sample-telemetry.ndjson`: representative input records without expected risk results.
- `scaffold/validate_inputs.mjs`: checks that the supplied assets agree with one another.
- `Dockerfile.scaffold` and `compose.yaml`: a reproducible validator plus PostgreSQL 16.

Validate the untouched starting material with:

```sh
docker compose up --build --abort-on-container-exit --exit-code-from scaffold
```

The scaffold is inspired by the 2026-09-08 China News report about intelligent multi-storey pig farming in Zhengzhou. It does not call or mirror the news website at runtime.
