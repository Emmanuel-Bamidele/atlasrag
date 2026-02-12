#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: restore_vector.sh /path/to/vector_wal.tgz" >&2
  exit 1
fi

BACKUP_FILE="$1"
if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

VOLUME_NAME="${VECTOR_VOLUME:-atlasrag_vector_data}"

docker run --rm \
  -v "$VOLUME_NAME:/data" \
  -v "$BACKUP_FILE:/backup/input.tgz:ro" \
  alpine sh -lc "rm -rf /data/* && tar xzf /backup/input.tgz -C /data"

echo "Vector WAL restore complete: $BACKUP_FILE"
