#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.prod.yml}"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/backups}"
TS="$(date -u +"%Y%m%dT%H%M%SZ")"

mkdir -p "$OUT_DIR"

docker compose -f "$COMPOSE_FILE" exec -T postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$OUT_DIR/postgres_${TS}.sql"

echo "Saved Postgres backup: $OUT_DIR/postgres_${TS}.sql"
