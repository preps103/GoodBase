#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/var/www/GoodBase"
BACKUP_DIR="$APP_DIR/backups/database"
BACKUP_GROUP="${BACKUP_GROUP:-goodapp}"
DB_NAME="goodos_backend"
NOW="$(date -u +%Y%m%dT%H%M%SZ)"
RAND="$(openssl rand -hex 4)"
BACKUP_ID="backup_${NOW}_${RAND}"
FILE_NAME="${DB_NAME}_${NOW}_${RAND}.dump"
FILE_PATH="$BACKUP_DIR/$FILE_NAME"

mkdir -p "$BACKUP_DIR"
chown postgres:"$BACKUP_GROUP" "$BACKUP_DIR"
chmod 750 "$BACKUP_DIR"

sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO backend_backups (
  id,
  name,
  type,
  status,
  size_bytes,
  file_path,
  notes,
  created_by,
  backup_format,
  database_name,
  metadata_json
)
VALUES (
  '$BACKUP_ID',
  'Database Backup $NOW',
  'database',
  'running',
  0,
  '$FILE_PATH',
  'Real pg_dump backup started from Goodbase console.',
  'console',
  'custom',
  '$DB_NAME',
  '{"startedAt":"$NOW","tool":"pg_dump","format":"custom"}'::jsonb
);
SQL

set +e
sudo -u postgres pg_dump -Fc --no-owner --no-acl -d "$DB_NAME" -f "$FILE_PATH"
PG_DUMP_STATUS=$?
set -e

if [ "$PG_DUMP_STATUS" -ne 0 ]; then
  sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
UPDATE backend_backups
SET
  status = 'failed',
  error_message = 'pg_dump failed with status $PG_DUMP_STATUS',
  completed_at = NOW()
WHERE id = '$BACKUP_ID';
SQL
  echo "BACKUP_ID=$BACKUP_ID"
  echo "STATUS=failed"
  echo "ERROR=pg_dump failed with status $PG_DUMP_STATUS"
  exit "$PG_DUMP_STATUS"
fi

SIZE_BYTES="$(stat -c%s "$FILE_PATH")"
CHECKSUM_SHA256="$(sha256sum "$FILE_PATH" | awk '{print $1}')"

sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
UPDATE backend_backups
SET
  status = 'completed',
  size_bytes = $SIZE_BYTES,
  checksum_sha256 = '$CHECKSUM_SHA256',
  notes = 'Real pg_dump backup completed successfully.',
  completed_at = NOW(),
  metadata_json = jsonb_build_object(
    'completedAt', NOW(),
    'tool', 'pg_dump',
    'format', 'custom',
    'fileName', '$FILE_NAME'
  )
WHERE id = '$BACKUP_ID';
SQL

chown postgres:"$BACKUP_GROUP" "$FILE_PATH"
chmod 640 "$FILE_PATH"

echo "BACKUP_ID=$BACKUP_ID"
echo "STATUS=completed"
echo "FILE_PATH=$FILE_PATH"
echo "SIZE_BYTES=$SIZE_BYTES"
echo "CHECKSUM_SHA256=$CHECKSUM_SHA256"
