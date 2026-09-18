#!/usr/bin/env bash
# Repeatable container acceptance: rebuilds the stack from scratch, runs the
# phase-1 scenario (per-line rejection, normal/abnormal windows, out-of-order
# recompute, alert open/recover), restarts the application process while
# PostgreSQL keeps its volume, then runs the read-only phase-2 persistence
# verification against the restarted service.
#
# Usage:  scripts/acceptance.sh
set -euo pipefail

cd "$(dirname "$0")/.."

compose() { docker compose --profile acceptance "$@"; }

compose down -v --remove-orphans >/dev/null 2>&1 || true
trap 'compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT

echo "==> building and starting postgres + app"
compose up -d --build postgres app

echo "==> phase 1: ingestion, windows, alert state machine"
compose run --rm -e ACCEPTANCE_PHASE=phase1 acceptance

echo "==> restarting app (database volume survives)"
compose restart app

echo "==> phase 2: persistence after restart"
compose run --rm -e ACCEPTANCE_PHASE=phase2 acceptance

echo "==> ACCEPTANCE PASSED (containerised, repeatable)"
