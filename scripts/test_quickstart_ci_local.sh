#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

QUICKSTART_USERNAME="${QUICKSTART_USERNAME:-smoke_admin}"
QUICKSTART_PASSWORD="${QUICKSTART_PASSWORD:-smoke_admin_password}"
QUICKSTART_TENANT="${QUICKSTART_TENANT:-smoke}"
QUICKSTART_ROLE="${QUICKSTART_ROLE:-admin}"

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/health}"
BASE_URL_DEFAULT="${HEALTH_URL%/health}"
BASE_URL="${BASE_URL:-$BASE_URL_DEFAULT}"
HEALTH_WAIT_SECONDS="${HEALTH_WAIT_SECONDS:-600}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-2}"
HEALTH_LOG_INTERVAL_SECONDS="${HEALTH_LOG_INTERVAL_SECONDS:-15}"

DOWN_ON_SUCCESS="${DOWN_ON_SUCCESS:-0}"
DOWN_ON_FAIL="${DOWN_ON_FAIL:-0}"
RESET_VOLUMES_BEFORE_UP="${RESET_VOLUMES_BEFORE_UP:-1}"
VECTOR_WAL="${VECTOR_WAL:-0}"
COMPOSE_UP_RETRIES="${COMPOSE_UP_RETRIES:-4}"
COMPOSE_UP_RETRY_DELAY_SECONDS="${COMPOSE_UP_RETRY_DELAY_SECONDS:-10}"

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

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required but not found in PATH" >&2
  exit 1
fi

COMPOSE_CMD=("$DOCKER_BIN" compose -f "$COMPOSE_FILE")
if [ -f "$ENV_FILE" ]; then
  COMPOSE_CMD+=(--env-file "$ENV_FILE")
fi

export VECTOR_WAL

compose_up_with_retry() {
  local attempt=1
  while [ "$attempt" -le "$COMPOSE_UP_RETRIES" ]; do
    if "${COMPOSE_CMD[@]}" up -d --build; then
      return 0
    fi
    if [ "$attempt" -ge "$COMPOSE_UP_RETRIES" ]; then
      echo "docker compose up failed after ${COMPOSE_UP_RETRIES} attempts." >&2
      return 1
    fi
    echo "docker compose up failed (attempt ${attempt}/${COMPOSE_UP_RETRIES}). Retrying in ${COMPOSE_UP_RETRY_DELAY_SECONDS}s..." >&2
    sleep "$COMPOSE_UP_RETRY_DELAY_SECONDS"
    attempt=$((attempt + 1))
  done
}

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "Quickstart smoke failed. Recent compose logs:" >&2
    "${COMPOSE_CMD[@]}" logs --tail=200 gateway postgres redis || true
    if [ "$DOWN_ON_FAIL" = "1" ]; then
      "${COMPOSE_CMD[@]}" down -v --remove-orphans || true
    fi
    return
  fi

  if [ "$DOWN_ON_SUCCESS" = "1" ]; then
    "${COMPOSE_CMD[@]}" down -v --remove-orphans || true
  fi
}
trap on_exit EXIT

echo "Starting quickstart services..."
if [ "$RESET_VOLUMES_BEFORE_UP" = "1" ]; then
  echo "Resetting compose volumes before start (RESET_VOLUMES_BEFORE_UP=1)..."
"${COMPOSE_CMD[@]}" down -v --remove-orphans || true
fi
compose_up_with_retry

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

echo "Ensuring quickstart admin user: $QUICKSTART_USERNAME"
"${COMPOSE_CMD[@]}" exec -T gateway node scripts/ensure_user.js \
  --username "$QUICKSTART_USERNAME" \
  --password "$QUICKSTART_PASSWORD" \
  --tenant "$QUICKSTART_TENANT" \
  --roles "$QUICKSTART_ROLE"

run_request() {
  local name="$1"
  local expected_status="$2"
  local method="$3"
  local url="$4"
  local body="${5:-}"
  local auth_header="${6:-}"
  local extra_header="${7:-}"
  local output_file
  output_file="$(mktemp)"
  local -a curl_cmd=(curl -sS --max-time 30 -o "$output_file" -w "%{http_code}" -X "$method" "$url")
  if [ -n "$body" ]; then
    curl_cmd+=(-H "content-type: application/json" -d "$body")
  fi
  if [ -n "$auth_header" ]; then
    curl_cmd+=(-H "$auth_header")
  fi
  if [ -n "$extra_header" ]; then
    curl_cmd+=(-H "$extra_header")
  fi

  local status
  if ! status="$("${curl_cmd[@]}")"; then
    echo "${name} request failed before a response was returned" >&2
    rm -f "$output_file"
    exit 1
  fi
  if [ "$status" != "$expected_status" ]; then
    echo "${name} returned HTTP ${status}, expected ${expected_status}" >&2
    cat "$output_file" >&2
    rm -f "$output_file"
    exit 1
  fi
  printf '%s\n' "$output_file"
}

UNIQUE_SUFFIX="${QUICKSTART_UNIQUE_SUFFIX:-$(date +%s)-$$}"
DOC_ID="${QUICKSTART_DOC_ID:-welcome-${UNIQUE_SUFFIX}}"
IDEMPOTENCY_KEY="${QUICKSTART_IDEMPOTENCY_KEY:-quickstart-doc-${UNIQUE_SUFFIX}}"

LOGIN_BODY=$(cat <<EOF
{"username":"${QUICKSTART_USERNAME}","password":"${QUICKSTART_PASSWORD}"}
EOF
)
LOGIN_FILE="$(run_request "login" "200" "POST" "${BASE_URL}/v1/login" "$LOGIN_BODY")"
TOKEN="$(python3 - "$LOGIN_FILE" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    payload = json.load(fh)
assert payload["ok"] is True
token = payload["data"]["token"]
assert isinstance(token, str) and token.strip()
print(token)
PY
)"
rm -f "$LOGIN_FILE"

INDEX_BODY=$(cat <<EOF
{"docId":"${DOC_ID}","text":"SupaVector stores memory for agents and returns grounded answers with citations."}
EOF
)
INDEX_FILE="$(run_request "index" "200" "POST" "${BASE_URL}/v1/docs" "$INDEX_BODY" "authorization: Bearer ${TOKEN}" "Idempotency-Key: ${IDEMPOTENCY_KEY}")"
python3 - "$INDEX_FILE" "$DOC_ID" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    payload = json.load(fh)
assert payload["ok"] is True
assert payload["data"]["docId"] == sys.argv[2]
assert payload["data"]["chunksIndexed"] >= 1
PY
rm -f "$INDEX_FILE"

ASK_BODY=$(cat <<EOF
{"question":"What does SupaVector store?","k":3}
EOF
)
ASK_FILE="$(run_request "ask" "200" "POST" "${BASE_URL}/v1/ask" "$ASK_BODY" "authorization: Bearer ${TOKEN}")"
python3 - "$ASK_FILE" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    payload = json.load(fh)
assert payload["ok"] is True
answer = payload["data"].get("answer")
assert isinstance(answer, str) and answer.strip()
PY
rm -f "$ASK_FILE"

echo "Quickstart smoke passed."
