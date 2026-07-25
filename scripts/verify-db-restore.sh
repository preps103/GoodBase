#!/usr/bin/env bash
set -euo pipefail

BACKUP_ID="${1:-}"

if [ -z "$BACKUP_ID" ]; then
  echo "STATUS=failed"
  echo "ERROR=Missing backup id"
  exit 1
fi

if [[ ! "$BACKUP_ID" =~ ^[A-Za-z0-9_:-]+$ ]]; then
  echo "STATUS=failed"
  echo "ERROR=Invalid backup id"
  exit 1
fi

APP_DB="goodos_backend"
BACKUP_ROOT="/var/www/GoodBase/backups/database"
NOW="$(date -u +%Y%m%dT%H%M%SZ)"
RAND="$(openssl rand -hex 4)"
TEST_ID="restore_${NOW}_${RAND}"
TEST_DB="goodos_restore_verify_${NOW}_${RAND}"

BACKUP_INFO="$(sudo -u postgres psql -d "$APP_DB" -t -A -F '|' -v ON_ERROR_STOP=1 -c "SELECT file_path, status FROM backend_backups WHERE id = '$BACKUP_ID' LIMIT 1;")"

FILE_PATH="$(echo "$BACKUP_INFO" | cut -d'|' -f1)"
BACKUP_STATUS="$(echo "$BACKUP_INFO" | cut -d'|' -f2)"

if [ -z "$FILE_PATH" ]; then
  echo "STATUS=failed"
  echo "ERROR=Backup not found"
  exit 1
fi

case "$FILE_PATH" in
  "$BACKUP_ROOT"/*) ;;
  *)
    echo "STATUS=failed"
    echo "ERROR=Backup path is outside the database backup root"
    exit 1
    ;;
esac

sudo -u postgres psql -d "$APP_DB" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO backend_backup_restore_tests (
  id,
  backup_id,
  test_database,
  status
)
VALUES (
  '$TEST_ID',
  '$BACKUP_ID',
  '$TEST_DB',
  'running'
);
SQL

if [ "$BACKUP_STATUS" != "completed" ]; then
  sudo -u postgres psql -d "$APP_DB" -v ON_ERROR_STOP=1 <<SQL
UPDATE backend_backup_restore_tests
SET
  status = 'failed',
  error_message = 'Backup is not completed',
  completed_at = NOW()
WHERE id = '$TEST_ID';
SQL

  echo "TEST_ID=$TEST_ID"
  echo "STATUS=failed"
  echo "ERROR=Backup is not completed"
  exit 1
fi

if [ ! -f "$FILE_PATH" ]; then
  sudo -u postgres psql -d "$APP_DB" -v ON_ERROR_STOP=1 <<SQL
UPDATE backend_backup_restore_tests
SET
  status = 'failed',
  error_message = 'Backup file does not exist on disk',
  completed_at = NOW()
WHERE id = '$TEST_ID';
SQL

  echo "TEST_ID=$TEST_ID"
  echo "STATUS=failed"
  echo "ERROR=Backup file does not exist on disk"
  exit 1
fi

cleanup() {
  sudo -u postgres dropdb --if-exists "$TEST_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

set +e
sudo -u postgres createdb "$TEST_DB"
CREATEDB_STATUS=$?

if [ "$CREATEDB_STATUS" -ne 0 ]; then
  sudo -u postgres psql -d "$APP_DB" -v ON_ERROR_STOP=1 <<SQL
UPDATE backend_backup_restore_tests
SET
  status = 'failed',
  error_message = 'createdb failed with status $CREATEDB_STATUS',
  completed_at = NOW()
WHERE id = '$TEST_ID';
SQL

  echo "TEST_ID=$TEST_ID"
  echo "STATUS=failed"
  echo "ERROR=createdb failed with status $CREATEDB_STATUS"
  exit "$CREATEDB_STATUS"
fi

sudo -u postgres pg_restore --no-owner --no-acl -d "$TEST_DB" "$FILE_PATH"
RESTORE_STATUS=$?
set -e

if [ "$RESTORE_STATUS" -ne 0 ]; then
  sudo -u postgres psql -d "$APP_DB" -v ON_ERROR_STOP=1 <<SQL
UPDATE backend_backup_restore_tests
SET
  status = 'failed',
  error_message = 'pg_restore failed with status $RESTORE_STATUS',
  completed_at = NOW()
WHERE id = '$TEST_ID';
SQL

  echo "TEST_ID=$TEST_ID"
  echo "STATUS=failed"
  echo "ERROR=pg_restore failed with status $RESTORE_STATUS"
  exit "$RESTORE_STATUS"
fi

TABLE_COUNT="$(sudo -u postgres psql -d "$TEST_DB" -t -A -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")"

ROW_COUNT="$(sudo -u postgres psql -d "$TEST_DB" -t -A -v ON_ERROR_STOP=1 <<'SQL'
SELECT COALESCE(SUM(n_live_tup), 0)::bigint
FROM pg_stat_user_tables;
SQL
)"

sudo -u postgres psql -d "$APP_DB" -v ON_ERROR_STOP=1 <<SQL
UPDATE backend_backup_restore_tests
SET
  status = 'verified',
  table_count = $TABLE_COUNT,
  row_count = $ROW_COUNT,
  completed_at = NOW()
WHERE id = '$TEST_ID';
SQL

echo "TEST_ID=$TEST_ID"
echo "STATUS=verified"
echo "TEST_DB=$TEST_DB"
echo "TABLE_COUNT=$TABLE_COUNT"
echo "ROW_COUNT=$ROW_COUNT"
