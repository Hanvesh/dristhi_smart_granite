#!/usr/bin/env bash
#
# DRISHTI - start everything from scratch.
#
# Brings up infra (Docker), Python backend services, and both UIs. Designed to
# be idempotent and to degrade gracefully: if Docker is unavailable the backend
# still runs using the gateway's in-memory store.
#
# Usage:
#   ./scripts/bootstrap.sh            # full stack (infra + services + UIs)
#   ./scripts/bootstrap.sh --no-infra # skip Docker; services use in-memory store
#   ./scripts/bootstrap.sh --stop     # stop everything started by this script
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDDIR="$ROOT/.run"
VENV="$ROOT/.venv"
mkdir -p "$PIDDIR"

log() { printf "\033[1;34m[drishti]\033[0m %s\n" "$*"; }

stop_all() {
  log "Stopping services..."
  for f in "$PIDDIR"/*.pid; do
    [ -e "$f" ] || continue
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
  if command -v docker >/dev/null 2>&1; then
    (cd "$ROOT/infra" && docker compose down 2>/dev/null || true)
  fi
  log "Stopped."
}

if [ "${1:-}" = "--stop" ]; then stop_all; exit 0; fi

NO_INFRA=0
[ "${1:-}" = "--no-infra" ] && NO_INFRA=1

# 1) Infra ------------------------------------------------------------------
if [ "$NO_INFRA" -eq 0 ] && command -v docker >/dev/null 2>&1; then
  log "Starting infra (postgres, keycloak, prometheus, grafana, loki)..."
  log "MinIO is optional and skipped by default; enable with: (cd infra && docker compose --profile storage up -d)"
  PG_PORT="${DRISHTI_PG_PORT:-5432}"
  DRISHTI_PG_PORT="$PG_PORT" bash -c "cd '$ROOT/infra' && docker compose up -d"
  export DATABASE_URL="postgresql://dristhi:dristhi@localhost:${PG_PORT}/dristhi"
else
  log "Skipping Docker infra; backend will use the in-memory store."
  export DATABASE_URL=""
fi

# 2) Python venv + backend deps --------------------------------------------
if [ ! -d "$VENV" ]; then
  log "Creating Python venv..."
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
log "Installing backend requirements..."
pip install -q --upgrade pip
pip install -q -r "$ROOT/services/gateway/requirements.txt" \
                 -r "$ROOT/services/vision/requirements.txt" \
                 -r "$ROOT/services/seigniorage/requirements.txt" \
                 -r "$ROOT/services/omeps-adapter/requirements.txt"

start_service() {
  local name="$1" dir="$2" port="$3"
  log "Starting $name on :$port"
  (cd "$ROOT/services/$dir" && "$VENV/bin/uvicorn" main:app --host 0.0.0.0 --port "$port" \
     > "$PIDDIR/$name.log" 2>&1 & echo $! > "$PIDDIR/$name.pid")
}

start_service vision       vision       8001
start_service seigniorage  seigniorage  8002
start_service omeps        omeps-adapter 8003
start_service gateway      gateway      8080

# 3) UIs --------------------------------------------------------------------
if command -v npm >/dev/null 2>&1; then
  log "Installing UI deps (npm workspaces)..."
  (cd "$ROOT" && npm install --silent)
  log "Starting Portal (:5173) and Robot Console (:5174)"
  (cd "$ROOT" && npm run dev:portal > "$PIDDIR/portal.log" 2>&1 & echo $! > "$PIDDIR/portal.pid")
  (cd "$ROOT" && npm run dev:robot  > "$PIDDIR/robot-console.log" 2>&1 & echo $! > "$PIDDIR/robot-console.pid")
else
  log "npm not found; skipping UIs. Install Node 18+ to run the front-ends."
fi

sleep 4
log "Up. Endpoints:"
cat <<EOF
  Portal (UI #1):        http://localhost:5173   (officer/officer, operator/operator, admin-user/admin)
  Robot Console (UI #2): http://localhost:5174   (robotop/robotop)
  Gateway API:           http://localhost:8080/docs
  Vision API:            http://localhost:8001/docs
  Seigniorage API:       http://localhost:8002/docs
  OMEPS Adapter API:     http://localhost:8003/docs
  MinIO console:         http://localhost:9001    (dristhi/dristhi123)  [only if started with --profile storage]
  Keycloak:              http://localhost:8090    (admin/admin)
  Grafana:               http://localhost:3000    (admin/admin)

Run the smoke test:   ./scripts/smoke_test.sh
Simulate a robot:     python3 robot/sim_agent.py --count 5
Stop everything:      ./scripts/bootstrap.sh --stop
EOF
