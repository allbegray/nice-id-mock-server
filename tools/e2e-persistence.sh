#!/usr/bin/env bash
# Restart-persistence proof: compose up -> phase 1 (CRUD + persist prep) ->
# compose down -> compose up -> phase 2 (survival proof) -> compose down.
# Exit code propagates the first failure; containers never linger (trap).
set -u

E2E_EXIT=0

cleanup() {
  docker compose down >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

poll_health() {
  # $1 = label for log lines. Polls /health up to 60s; sets READY=1 on UP.
  local label="$1"
  echo "e2e-persistence: [$label] polling /health (<=60s)..."
  READY=0
  for _ in $(seq 1 60); do
    if curl -fsS http://localhost:8899/health 2>/dev/null | grep -q '"status":"UP"'; then
      READY=1
      break
    fi
    sleep 1
  done
  if [ "$READY" != "1" ]; then
    echo "e2e-persistence: FAIL: [$label] /health not UP within 60s" >&2
    curl -s http://localhost:8899/health || true
    return 1
  fi
  echo "e2e-persistence: [$label] health UP"
  return 0
}

docker compose up -d --build || { echo "e2e-persistence: FAIL: first compose up failed" >&2; E2E_EXIT=1; exit "$E2E_EXIT"; }
poll_health "boot" || { E2E_EXIT=1; exit "$E2E_EXIT"; }

echo "e2e-persistence: running phase 1 (admin CRUD + persist prep)..."
node tools/e2e-admin-persistence.mjs --phase 1
E2E_EXIT=$?
if [ "$E2E_EXIT" -ne 0 ]; then
  echo "e2e-persistence: FAIL: phase 1 exited $E2E_EXIT" >&2
  exit "$E2E_EXIT"
fi

echo "e2e-persistence: phase 1 done, restarting compose (down -> up)..."
docker compose down || { echo "e2e-persistence: FAIL: compose down (after phase 1) failed" >&2; E2E_EXIT=1; exit "$E2E_EXIT"; }
docker compose up -d || { echo "e2e-persistence: FAIL: second compose up failed" >&2; E2E_EXIT=1; exit "$E2E_EXIT"; }
poll_health "restart" || { E2E_EXIT=1; exit "$E2E_EXIT"; }

echo "e2e-persistence: running phase 2 (restart survival proof)..."
node tools/e2e-admin-persistence.mjs --phase 2
E2E_EXIT=$?
if [ "$E2E_EXIT" -ne 0 ]; then
  echo "e2e-persistence: FAIL: phase 2 exited $E2E_EXIT" >&2
  exit "$E2E_EXIT"
fi

echo "e2e-persistence: phase 1/2 PASS, bringing compose down..."
docker compose down || { echo "e2e-persistence: FAIL: final compose down failed" >&2; E2E_EXIT=1; exit "$E2E_EXIT"; }

echo "e2e-persistence: PASS"
exit "$E2E_EXIT"
