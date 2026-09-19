#!/bin/sh
# Runs INSIDE the acceptance container.
#
# Phase 1: drive the already-running `app` service over the network with all
#          fixtures/acceptance scenarios and assert every response.
# Phase 2: start a BRAND-NEW application process in this container against the
#          same PostgreSQL (fresh connection pool, migrations and seed re-run
#          idempotently) and re-execute read-only checks against it, proving
#          readings, windows and alert history are durably persisted and a
#          restart reconstructs identical state.
set -eu

BASE_URL="${BASE_URL:-http://app:8080}"
export BASE_URL

echo "########## PHASE 1: ingest + assertions via ${BASE_URL} ##########"
node dist/acceptance.js

echo ""
echo "########## PHASE 2: fresh app process, persistence checks ##########"
PORT=8081 \
DATABASE_URL="${DATABASE_URL:-postgres://pig_risk:scaffold-only@postgres:5432/pig_risk}" \
FIXTURES_DIR=/app/fixtures \
node dist/server.js &
APP_PID=$!

# The driver itself waits for /health; make sure the background server is
# stopped on exit.
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT INT TERM

BASE_URL="http://127.0.0.1:8081" node dist/acceptance.js --read

echo ""
echo "CONTAINER ACCEPTANCE: ALL PHASES PASSED"
