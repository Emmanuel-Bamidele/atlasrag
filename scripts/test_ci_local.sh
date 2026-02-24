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
HEALTH_WAIT_SECONDS="${HEALTH_WAIT_SECONDS:-600}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-2}"
HEALTH_LOG_INTERVAL_SECONDS="${HEALTH_LOG_INTERVAL_SECONDS:-15}"

DOWN_ON_SUCCESS="${DOWN_ON_SUCCESS:-0}"
DOWN_ON_FAIL="${DOWN_ON_FAIL:-0}"
RESET_VOLUMES_BEFORE_UP="${RESET_VOLUMES_BEFORE_UP:-1}"
VECTOR_WAL="${VECTOR_WAL:-0}"

DOCKER_BIN="$(command -v docker || true)"
if [ -z "$DOCKER_BIN" ] && [ -x "/usr/local/bin/docker" ]; then
  DOCKER_BIN="/usr/local/bin/docker"
fi
if [ -z "$DOCKER_BIN" ]; then
  echo "docker is required but not found in PATH" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required but not found in PATH" >&2
  exit 1
fi

COMPOSE_CMD=("$DOCKER_BIN" compose -f "$COMPOSE_FILE")
if [ -f "$ENV_FILE" ]; then
  COMPOSE_CMD+=(--env-file "$ENV_FILE")
fi

export VECTOR_WAL

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
if [ "$RESET_VOLUMES_BEFORE_UP" = "1" ]; then
  echo "Resetting compose volumes before start (RESET_VOLUMES_BEFORE_UP=1)..."
  "${COMPOSE_CMD[@]}" down -v --remove-orphans || true
fi
"${COMPOSE_CMD[@]}" up -d --build

echo "Waiting for gateway health: $HEALTH_URL"
deadline=$((SECONDS + HEALTH_WAIT_SECONDS))
last_health_log_ts=$SECONDS
last_health_code="n/a"
last_health_body=""
health_attempt=0
while true; do
  health_attempt=$((health_attempt + 1))
  health_tmp="$(mktemp)"
  if health_code="$(curl -sS --max-time 5 -o "$health_tmp" -w "%{http_code}" "$HEALTH_URL" 2>/dev/null)"; then
    last_health_code="$health_code"
    last_health_body="$(tr '\n' ' ' < "$health_tmp" | head -c 240)"
    rm -f "$health_tmp"
    if [ "$health_code" = "200" ]; then
      break
    fi
  else
    rm -f "$health_tmp"
    last_health_code="curl_error"
    last_health_body=""
  fi

  if [ $((SECONDS - last_health_log_ts)) -ge "$HEALTH_LOG_INTERVAL_SECONDS" ]; then
    echo "Health pending (attempt=${health_attempt}, code=${last_health_code}): ${last_health_body:-no response body}" >&2
    last_health_log_ts=$SECONDS
  fi

  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Gateway did not become healthy within ${HEALTH_WAIT_SECONDS}s (last code=${last_health_code}, body=${last_health_body:-n/a})" >&2
    exit 1
  fi

  sleep "$HEALTH_INTERVAL_SECONDS"
done

echo "Gateway health OK."

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
