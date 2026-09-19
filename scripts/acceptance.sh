#!/bin/sh
# Repeatable container acceptance, run from the host.
#
#   ./scripts/acceptance.sh
#
# Tears down any previous stack AND its data volume, rebuilds images, starts
# PostgreSQL + the application, then runs the in-container acceptance driver
# (ingest scenarios -> window/alert assertions -> fresh-process persistence
# check). Exits non-zero on the first failed assertion. No cloud platform,
# recognition model or message service is contacted.
set -eu

cd "$(dirname "$0")/.."

COMPOSE="docker compose"

echo "== [1/4] removing previous stack and data volume =="
$COMPOSE down -v --remove-orphans

echo "== [2/4] building images =="
$COMPOSE build

echo "== [3/4] validating source fixtures with the scaffold checker =="
$COMPOSE --profile validate run --rm scaffold

echo "== [4/4] running acceptance driver against the app =="
$COMPOSE --profile acceptance up --abort-on-container-exit --exit-code-from acceptance
status=$?

$COMPOSE logs app | tail -40 >&2 || true

if [ "$status" -eq 0 ]; then
  echo ""
  echo "ACCEPTANCE PASSED"
  $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
else
  echo ""
  echo "ACCEPTANCE FAILED (exit $status); stack left up for inspection: docker compose logs" >&2
fi
exit "$status"
