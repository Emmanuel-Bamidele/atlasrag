#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

E2E_USERNAME="${E2E_USERNAME:-ci_admin}"
E2E_PASSWORD="${E2E_PASSWORD:-ci_admin_password}"
E2E_TENANT="${E2E_TENANT:-ci_admin}"
E2E_ROLES="${E2E_ROLES:-admin,indexer,reader}"

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/health}"
HEALTH_WAIT_SECONDS="${HEALTH_WAIT_SECONDS:-180}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-2}"

DOWN_ON_SUCCESS="${DOWN_ON_SUCCESS:-0}"
DOWN_ON_FAIL="${DOWN_ON_FAIL:-0}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but not found in PATH" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required but not found in PATH" >&2
  exit 1
fi

COMPOSE_CMD=(docker compose -f "$COMPOSE_FILE")
if [ -f "$ENV_FILE" ]; then
  COMPOSE_CMD+=(--env-file "$ENV_FILE")
fi

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "Test flow failed. Recent compose logs:" >&2
    "${COMPOSE_CMD[@]}" logs --tail=200 gateway postgres redis || true
    if [ "$DOWN_ON_FAIL" = "1" ]; then
      "${COMPOSE_CMD[@]}" down -v || true
    fi
    return
  fi

  if [ "$DOWN_ON_SUCCESS" = "1" ]; then
    "${COMPOSE_CMD[@]}" down -v || true
  fi
}
trap on_exit EXIT

echo "Starting services..."
"${COMPOSE_CMD[@]}" up -d --build

echo "Waiting for gateway health: $HEALTH_URL"
deadline=$((SECONDS + HEALTH_WAIT_SECONDS))
while true; do
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    break
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Gateway did not become healthy within ${HEALTH_WAIT_SECONDS}s" >&2
    exit 1
  fi
  sleep "$HEALTH_INTERVAL_SECONDS"
done

echo "Ensuring e2e user: $E2E_USERNAME"
"${COMPOSE_CMD[@]}" exec -T gateway node scripts/ensure_user.js \
  --username "$E2E_USERNAME" \
  --password "$E2E_PASSWORD" \
  --tenant "$E2E_TENANT" \
  --roles "$E2E_ROLES"

echo "Running gateway test suite..."
"${COMPOSE_CMD[@]}" exec -T gateway sh -lc \
  "E2E_USERNAME='$E2E_USERNAME' E2E_PASSWORD='$E2E_PASSWORD' npm run test:all"

echo "All tests passed."
