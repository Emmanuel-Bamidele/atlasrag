#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
BASE_ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

DOCKER_BIN="${DOCKER_BIN:-/usr/local/bin/docker}"
if [ ! -x "$DOCKER_BIN" ]; then
  DOCKER_BIN="$(command -v docker || true)"
fi
if [ -z "$DOCKER_BIN" ] || [ ! -x "$DOCKER_BIN" ]; then
  echo "docker not found; set DOCKER_BIN or install Docker." >&2
  exit 1
fi

# Ensure Docker credential helpers are resolvable when compose builds images.
export PATH="/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

OUT_HOST_FILE="$ROOT_DIR/telemetry/events_ttl_amvl_lru.ndjson"
OUT_CONTAINER_FILE="/app/telemetry/events_ttl_amvl_lru.ndjson"

COLLECTION="${EVAL_COLLECTION:-eval_ttl_amvl}"
USERNAME="${EVAL_USERNAME:-ci_admin}"
PASSWORD="${EVAL_PASSWORD:-ci_admin_password}"
SEED="${EVAL_SEED:-1337}"
WRITES="${EVAL_WRITES:-50000}"
READS_REQUIRED="$((WRITES / 5))"
ASKS_REQUIRED="${EVAL_MIN_ASKS:-10000}"
RECALL_K="${EVAL_RECALL_K:-24}"
ASK_K="${EVAL_ASK_K:-48}"
TTL_SECONDS="${EVAL_TTL_SECONDS:-2592000}"
SNAPSHOT_EVERY="${EVAL_SNAPSHOT_EVERY:-1000}"
CONCURRENCY="${EVAL_CONCURRENCY:-12}"
LOG_EVERY="${EVAL_LOG_EVERY:-1000}"
LRU_WARM_SAMPLE_K="${EVAL_LRU_WARM_SAMPLE_K:-8}"

COMPOSE_BASE=("$DOCKER_BIN" compose -f "$COMPOSE_FILE")

timestamp() {
  date -u +"%Y%m%d-%H%M%S"
}

wait_for_redis_ready() {
  local env_file="$1"
  local max_attempts="${EVAL_REDIS_READY_MAX_ATTEMPTS:-120}"
  local sleep_seconds="${EVAL_REDIS_READY_SLEEP_SECONDS:-2}"
  local attempt=0

  while true; do
    attempt=$((attempt + 1))
    if "${COMPOSE_BASE[@]}" --env-file "$env_file" exec -T gateway node -e "
      const net = require('net');
      const s = net.connect({ host: 'redis', port: 6379 }, () => { console.log('ready'); s.end(); process.exit(0); });
      s.on('error', () => process.exit(1));
      setTimeout(() => process.exit(2), 1200);
    " >/tmp/ttl_amvl_redis_probe.out 2>/tmp/ttl_amvl_redis_probe.err; then
      echo "redis ready (attempt=$attempt)"
      break
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "redis readiness check failed after $attempt attempts" >&2
      cat /tmp/ttl_amvl_redis_probe.err >&2 || true
      return 1
    fi

    sleep "$sleep_seconds"
  done
}

create_env_file() {
  local mode="$1"
  local config_id="$2"
  local run_id="$3"
  local env_file
  env_file="$(mktemp -t "ttl-amvl-${mode}")"
  cp "$BASE_ENV_FILE" "$env_file"

  cat >>"$env_file" <<ENV_APPEND

# --- TTL/AMV-L eval overrides ($mode) ---
OPENAI_API_KEY=
EMBED_FALLBACK_ON_ERROR=1
OPENAI_TIMEOUT_MS=30000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=1000000
TENANT_RATE_LIMIT_WINDOW_MS=60000
TENANT_RATE_LIMIT_MAX=1000000
TELEMETRY_ENABLED=1
TELEMETRY_FILE=$OUT_CONTAINER_FILE
TELEMETRY_CONFIG_ID=$config_id
TELEMETRY_RUN_ID=$run_id
TELEMETRY_SNAPSHOT_INTERVAL_MS=5000
MEMORY_RETRIEVAL_COLD_PROBE_EPSILON=0
ENV_APPEND

  if [ "$mode" = "ttl" ]; then
    cat >>"$env_file" <<'ENV_TTL'
TTL_SWEEP_INTERVAL_MS=86400000
MEMORY_VALUE_DECAY_INTERVAL_MS=0
MEMORY_REDUNDANCY_INTERVAL_MS=0
MEMORY_LIFECYCLE_INTERVAL_MS=0
MEMORY_LIFECYCLE_MIN_AGE_HOURS=24
MEMORY_LIFECYCLE_MAX_DELETES=0
MEMORY_LIFECYCLE_DRY_RUN=0
MEMORY_RETRIEVAL_WARM_SAMPLE_K=2000
MEMORY_RETRIEVAL_WARM_SAMPLE_POOL_MULTIPLIER=8
MEMORY_TIER_HOT_UP=0.51
MEMORY_TIER_HOT_DOWN=0.01
MEMORY_TIER_WARM_UP=0.50
MEMORY_TIER_WARM_DOWN=0.00
MEMORY_TIER_EVICT=0.00
MEMORY_INIT_VALUE=0.50
ENV_TTL
  elif [ "$mode" = "amvl" ]; then
    cat >>"$env_file" <<'ENV_AMVL'
TTL_SWEEP_INTERVAL_MS=300000
MEMORY_VALUE_DECAY_INTERVAL_MS=5000
MEMORY_REDUNDANCY_INTERVAL_MS=5000
MEMORY_LIFECYCLE_INTERVAL_MS=5000
MEMORY_LIFECYCLE_MIN_AGE_HOURS=0
MEMORY_LIFECYCLE_MAX_DELETES=200
MEMORY_LIFECYCLE_DRY_RUN=0
MEMORY_LIFECYCLE_DELETE_THRESHOLD=0.25
MEMORY_LIFECYCLE_SUMMARY_THRESHOLD=0.45
MEMORY_LIFECYCLE_PROMOTE_THRESHOLD=0.70
MEMORY_LIFECYCLE_COMPACT_GROUP_SIZE=5
MEMORY_RETRIEVAL_WARM_SAMPLE_K=8
MEMORY_RETRIEVAL_WARM_SAMPLE_POOL_MULTIPLIER=4
MEMORY_TIER_HOT_UP=0.72
MEMORY_TIER_HOT_DOWN=0.62
MEMORY_TIER_WARM_UP=0.45
MEMORY_TIER_WARM_DOWN=0.25
MEMORY_TIER_EVICT=0.20
MEMORY_INIT_VALUE=0.50
ENV_AMVL
  elif [ "$mode" = "lru" ]; then
    cat >>"$env_file" <<ENV_LRU
TTL_SWEEP_INTERVAL_MS=86400000
MEMORY_VALUE_DECAY_INTERVAL_MS=0
MEMORY_REDUNDANCY_INTERVAL_MS=0
MEMORY_LIFECYCLE_INTERVAL_MS=0
MEMORY_LIFECYCLE_MIN_AGE_HOURS=24
MEMORY_LIFECYCLE_MAX_DELETES=0
MEMORY_LIFECYCLE_DRY_RUN=0
MEMORY_RETRIEVAL_WARM_SAMPLE_K=$LRU_WARM_SAMPLE_K
MEMORY_RETRIEVAL_WARM_SAMPLE_POOL_MULTIPLIER=1
MEMORY_RETRIEVAL_WARM_SELECTION=lru
MEMORY_TIER_HOT_UP=0.99
MEMORY_TIER_HOT_DOWN=0.01
MEMORY_TIER_WARM_UP=0.00
MEMORY_TIER_WARM_DOWN=0.00
MEMORY_TIER_EVICT=0.00
MEMORY_INIT_VALUE=0.50
MEMORY_ACCESS_ALPHA=0
MEMORY_CONTRIBUTION_BETA=0
MEMORY_NEGATIVE_STEP=0
MEMORY_VALUE_DECAY_LAMBDA=0
ENV_LRU
  else
    echo "Unsupported eval mode: $mode" >&2
    rm -f "$env_file"
    exit 1
  fi

  echo "$env_file"
}

run_phase() {
  local mode="$1"
  local config_id="$2"
  local run_id="$3"

  echo "==> Starting phase: $mode config_id=$config_id run_id=$run_id"
  local env_file
  env_file="$(create_env_file "$mode" "$config_id" "$run_id")"

  "${COMPOSE_BASE[@]}" --env-file "$env_file" up -d --build --force-recreate gateway
  wait_for_redis_ready "$env_file"

  "${COMPOSE_BASE[@]}" --env-file "$env_file" exec -T gateway node scripts/ensure_user.js \
    --username "$USERNAME" \
    --password "$PASSWORD" \
    --tenant "$USERNAME" \
    --roles "admin,indexer,reader"

  "${COMPOSE_BASE[@]}" --env-file "$env_file" exec -T gateway node scripts/run_seeded_workload.js \
    --base-url "http://127.0.0.1:3000" \
    --username "$USERNAME" \
    --password "$PASSWORD" \
    --collection "$COLLECTION" \
    --seed "$SEED" \
    --writes "$WRITES" \
    --min-asks "$ASKS_REQUIRED" \
    --recall-k "$RECALL_K" \
    --ask-k "$ASK_K" \
    --ttl-seconds "$TTL_SECONDS" \
    --snapshot-every "$SNAPSHOT_EVERY" \
    --concurrency "$CONCURRENCY" \
    --log-every "$LOG_EVERY" \
    --telemetry-file "$OUT_CONTAINER_FILE" \
    --config-id "$config_id" \
    --run-id "$run_id"

  rm -f "$env_file"
}

mkdir -p "$ROOT_DIR/telemetry"
: > "$OUT_HOST_FILE"

RUN_ID_TTL="baseline-ttl-$(timestamp)"
RUN_ID_AMVL="baseline-amvl-$(timestamp)"
RUN_ID_LRU="baseline-lru-$(timestamp)"

run_phase "ttl" "baseline-ttl" "$RUN_ID_TTL"
run_phase "amvl" "baseline-amvl" "$RUN_ID_AMVL"
run_phase "lru" "baseline-lru" "$RUN_ID_LRU"

"${COMPOSE_BASE[@]}" exec -T gateway node scripts/filter_health_events.js --input "$OUT_CONTAINER_FILE"
summary_args=(
  --input "$OUT_CONTAINER_FILE"
  --ttl-config "baseline-ttl"
  --amvl-config "baseline-amvl"
  --lru-config "baseline-lru"
  --require-writes "$WRITES"
  --require-reads "$READS_REQUIRED"
  --require-asks "$ASKS_REQUIRED"
)
"${COMPOSE_BASE[@]}" exec -T gateway node scripts/summarize_eval_telemetry.js "${summary_args[@]}"

echo "\nDone. Output: $OUT_HOST_FILE"
echo "TTL run_id:  $RUN_ID_TTL"
echo "AMV-L run_id: $RUN_ID_AMVL"
echo "LRU run_id:  $RUN_ID_LRU"
