#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

BACKUP_ROOT="${GOODBASE_BACKUP_ROOT:-/var/backups/goodos-enterprise-v1}"
RETENTION_DAYS="${GOODBASE_BACKUP_RETENTION_DAYS:-14}"
MINIMUM_LOGICAL="${GOODBASE_MINIMUM_LOGICAL_BACKUPS:-7}"
MINIMUM_BASE="${GOODBASE_MINIMUM_BASE_BACKUPS:-2}"

case "$RETENTION_DAYS:$MINIMUM_LOGICAL:$MINIMUM_BASE" in
  *[!0-9:]*) echo "Retention settings must be non-negative integers." >&2; exit 2 ;;
esac

[ "$RETENTION_DAYS" -ge 7 ] || { echo "Retention must be at least 7 days." >&2; exit 2; }

DATABASE_DIR="$BACKUP_ROOT/database"
BASE_DIR="$BACKUP_ROOT/base"
WAL_DIR="$BACKUP_ROOT/wal"

for directory in "$DATABASE_DIR" "$BASE_DIR" "$WAL_DIR"; do
  [ -d "$directory" ] || { echo "Missing backup directory: $directory" >&2; exit 1; }
done

logical_count="$(find "$DATABASE_DIR" -maxdepth 1 -type f -name '*.dump.age' | wc -l | tr -d ' ')"
base_count="$(find "$BASE_DIR" -maxdepth 1 -type f -name '*.tar.gz.age' | wc -l | tr -d ' ')"

[ "$logical_count" -ge "$MINIMUM_LOGICAL" ] || { echo "Refusing retention: only $logical_count logical backups exist." >&2; exit 1; }
[ "$base_count" -ge "$MINIMUM_BASE" ] || { echo "Refusing retention: only $base_count base backups exist." >&2; exit 1; }

deleted_logical=0
deleted_base=0
deleted_wal=0

while IFS= read -r -d '' artifact; do
  rm -f -- "$artifact" "${artifact}.sha256"
  deleted_logical=$((deleted_logical + 1))
done < <(find "$DATABASE_DIR" -maxdepth 1 -type f -name '*.dump.age' -mtime "+$RETENTION_DAYS" -print0)

while IFS= read -r -d '' artifact; do
  remaining="$(find "$BASE_DIR" -maxdepth 1 -type f -name '*.tar.gz.age' | wc -l | tr -d ' ')"
  [ "$remaining" -gt "$MINIMUM_BASE" ] || break
  rm -f -- "$artifact" "${artifact}.sha256"
  deleted_base=$((deleted_base + 1))
done < <(find "$BASE_DIR" -maxdepth 1 -type f -name '*.tar.gz.age' -mtime "+$RETENTION_DAYS" -print0)

while IFS= read -r -d '' artifact; do
  rm -f -- "$artifact" "${artifact%.age}.sha256"
  deleted_wal=$((deleted_wal + 1))
done < <(find "$WAL_DIR" -maxdepth 1 -type f -name '*.age' -mtime "+$RETENTION_DAYS" -print0)

# Remove sidecars only when their corresponding encrypted artifact is absent.
while IFS= read -r -d '' sidecar; do
  artifact="${sidecar%.sha256}"
  [ -e "$artifact" ] || rm -f -- "$sidecar"
done < <(find "$DATABASE_DIR" "$BASE_DIR" -maxdepth 1 -type f -name '*.age.sha256' -print0)

while IFS= read -r -d '' sidecar; do
  artifact="${sidecar%.sha256}.age"
  [ -e "$artifact" ] || rm -f -- "$sidecar"
done < <(find "$WAL_DIR" -maxdepth 1 -type f -name '*.sha256' -print0)

printf '{"success":true,"retentionDays":%s,"deletedLogical":%s,"deletedBase":%s,"deletedWal":%s}\n' \
  "$RETENTION_DAYS" "$deleted_logical" "$deleted_base" "$deleted_wal"
