#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/backups}"
VOLUME_NAME="${VECTOR_VOLUME:-atlasrag_vector_data}"
TS="$(date -u +"%Y%m%dT%H%M%SZ")"

mkdir -p "$OUT_DIR"

docker run --rm \
  -v "$VOLUME_NAME:/data" \
  -v "$OUT_DIR:/backup" \
  alpine sh -lc "tar czf /backup/vector_wal_${TS}.tgz -C /data ."

echo "Saved vector WAL backup: $OUT_DIR/vector_wal_${TS}.tgz"
