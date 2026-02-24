#!/usr/bin/env bash

set -u

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <suite_id> [interval_sec]"
  exit 1
fi

SUITE_ID="$1"
INTERVAL_SEC="${2:-600}"
AUTO_RECOVER="${AUTO_RECOVER:-1}"
DOCKER_BIN="${DOCKER_BIN:-/usr/local/bin/docker}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNS_DIR="$ROOT/telemetry/experiments_runs/$SUITE_ID"
EXP_DIR="$ROOT/telemetry/experiments/$SUITE_ID"
COMPOSE_FILE="$ROOT/docker-compose.yml"
PROJECT="atlasrag_exp_${SUITE_ID}"
LOG_FILE="$RUNS_DIR/watch_10m.log"

mkdir -p "$RUNS_DIR"
touch "$LOG_FILE"

now_utc() {
  date -u "+%Y-%m-%dT%H:%M:%SZ"
}

log() {
  printf "[%s] %s\n" "$(now_utc)" "$*" | tee -a "$LOG_FILE"
}

json_field() {
  local file="$1"
  local key="$2"
  if [ ! -f "$file" ]; then
    return 0
  fi
  sed -n "s/.*\"${key}\": \"\\([^\"]*\\)\".*/\\1/p" "$file" | head -n 1
}

latest_run_dir() {
  find "$RUNS_DIR" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1
}

max_op_from_ndjson() {
  local ndjson="$1"
  if [ ! -f "$ndjson" ]; then
    echo "0"
    return 0
  fi
  tail -n 50000 "$ndjson" \
    | sed -n 's/.*op:\([0-9][0-9]*\):.*/\1/p' \
    | awk 'BEGIN{m=0} {if ($1>m) m=$1} END{print m+0}'
}

log "monitor started suite_id=$SUITE_ID interval_sec=$INTERVAL_SEC auto_recover=$AUTO_RECOVER"

while true; do
  SUITE_MANIFEST="$RUNS_DIR/suite_manifest.json"
  ENDED_AT="$(json_field "$SUITE_MANIFEST" "ended_at")"

  LATEST_RUN="$(latest_run_dir)"
  if [ -z "$LATEST_RUN" ]; then
    log "no run directories yet under $RUNS_DIR"
    sleep "$INTERVAL_SEC"
    continue
  fi

  RUN_MANIFEST="$LATEST_RUN/run_manifest.json"
  RUN_ID="$(json_field "$RUN_MANIFEST" "run_id")"
  RUN_STATUS="$(json_field "$RUN_MANIFEST" "status")"
  RUN_STATUS="${RUN_STATUS:-in_progress}"

  GATEWAY_LINE="$($DOCKER_BIN ps -a --format '{{.Names}} {{.Status}}' | grep "^${PROJECT}-gateway-1 " || true)"
  REDIS_LINE="$($DOCKER_BIN ps -a --format '{{.Names}} {{.Status}}' | grep "^${PROJECT}-redis-1 " || true)"
  POSTGRES_LINE="$($DOCKER_BIN ps -a --format '{{.Names}} {{.Status}}' | grep "^${PROJECT}-postgres-1 " || true)"

  if [ "$AUTO_RECOVER" = "1" ] && [ -n "$GATEWAY_LINE" ]; then
    if echo "$GATEWAY_LINE" | grep -q "Exited" && [ "$RUN_STATUS" != "completed" ] && [ "$RUN_STATUS" != "failed" ]; then
      ENV_FILE="$LATEST_RUN/compose.env"
      if [ -f "$ENV_FILE" ]; then
        log "gateway exited mid-run (run_id=$RUN_ID); restarting in place using $ENV_FILE"
        if "$DOCKER_BIN" compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate gateway >>"$LOG_FILE" 2>&1; then
          log "gateway restart succeeded"
        else
          log "gateway restart failed"
        fi
      else
        log "gateway exited but env file missing: $ENV_FILE"
      fi
    fi
  fi

  NDJSON="$EXP_DIR/${RUN_ID}.ndjson"
  if [ -n "$RUN_ID" ] && [ -f "$NDJSON" ]; then
    LINE_COUNT="$(wc -l < "$NDJSON" | tr -d ' ')"
    MAX_OP="$(max_op_from_ndjson "$NDJSON")"
    log "run_id=$RUN_ID run_status=$RUN_STATUS lines=$LINE_COUNT max_op=$MAX_OP gateway='${GATEWAY_LINE:-missing}' redis='${REDIS_LINE:-missing}' postgres='${POSTGRES_LINE:-missing}'"
  else
    log "run_id=${RUN_ID:-unknown} run_status=$RUN_STATUS telemetry=missing gateway='${GATEWAY_LINE:-missing}' redis='${REDIS_LINE:-missing}' postgres='${POSTGRES_LINE:-missing}'"
  fi

  if [ -n "$ENDED_AT" ]; then
    log "suite complete ended_at=$ENDED_AT; stopping monitor"
    exit 0
  fi

  sleep "$INTERVAL_SEC"
done

