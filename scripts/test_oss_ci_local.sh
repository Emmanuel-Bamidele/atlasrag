#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}"
TMP_DIR=""

HOST_PORT="${OSS_SMOKE_HOST_PORT:-3100}"
ENV_TEMPLATE="${OSS_SMOKE_ENV_TEMPLATE:-$ROOT_DIR/.env.example}"
KEEP_TMP="${OSS_SMOKE_KEEP_TEMP:-0}"

cleanup() {
  local status=$?
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] && [ "$KEEP_TMP" != "1" ]; then
    rm -rf "$TMP_DIR"
  elif [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    echo "Keeping OSS smoke workspace: $TMP_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

if ! command -v tar >/dev/null 2>&1; then
  echo "tar is required for the OSS smoke test" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required for the OSS smoke test" >&2
  exit 1
fi

if [ ! -f "$ENV_TEMPLATE" ]; then
  echo "env template not found: $ENV_TEMPLATE" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMP_ROOT%/}/supavector-oss-smoke.XXXXXX")"

echo "Preparing public OSS smoke workspace: $TMP_DIR"
tar -C "$ROOT_DIR" \
  --exclude=".git" \
  --exclude=".env" \
  --exclude="node_modules" \
  --exclude="telemetry" \
  --exclude=".DS_Store" \
  -cf - . | tar -C "$TMP_DIR" -xf -

cp "$ENV_TEMPLATE" "$TMP_DIR/.env"
cat >> "$TMP_DIR/.env" <<EOF
POSTGRES_PASSWORD=${OSS_SMOKE_POSTGRES_PASSWORD:-supavector}
JWT_SECRET=${OSS_SMOKE_JWT_SECRET:-ci_jwt_secret}
COOKIE_SECRET=${OSS_SMOKE_COOKIE_SECRET:-ci_cookie_secret}
COOKIE_SECURE=0
PUBLIC_BASE_URL=http://localhost:${HOST_PORT}
OPENAPI_BASE_URL=http://localhost:${HOST_PORT}
GATEWAY_HOST_PORT=${HOST_PORT}
MIGRATIONS_ATTEMPTS=${OSS_SMOKE_MIGRATIONS_ATTEMPTS:-30}
MIGRATIONS_DELAY_MS=${OSS_SMOKE_MIGRATIONS_DELAY_MS:-1000}
RATE_LIMIT_MAX=${OSS_SMOKE_RATE_LIMIT_MAX:-500}
TENANT_RATE_LIMIT_MAX=${OSS_SMOKE_TENANT_RATE_LIMIT_MAX:-500}
LOGIN_RATE_LIMIT_MAX=${OSS_SMOKE_LOGIN_RATE_LIMIT_MAX:-200}
AUTH_MAX_ATTEMPTS=${OSS_SMOKE_AUTH_MAX_ATTEMPTS:-20}
AUTH_LOCK_MINUTES=${OSS_SMOKE_AUTH_LOCK_MINUTES:-1}
ALLOW_PRINCIPAL_OVERRIDE=0
TELEMETRY_ENABLED=0
FETCH_USER_AGENT=${OSS_SMOKE_FETCH_USER_AGENT:-supavector-oss-smoke}
EOF

echo "Installing public root dependencies..."
(
  cd "$TMP_DIR"
  npm ci
)

echo "Running CLI smoke tests..."
(
  cd "$TMP_DIR"
  npm run test:cli
)

echo "Running self-hosted OSS end-to-end flow..."
(
  cd "$TMP_DIR"
  HEALTH_URL="http://127.0.0.1:${HOST_PORT}/health" \
  DOWN_ON_SUCCESS=1 \
  DOWN_ON_FAIL=1 \
  ./scripts/test_ci_local.sh
)
