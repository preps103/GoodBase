#!/usr/bin/env bash
set -euo pipefail

BACKUP_ID="${1:-}"
APP_DB="goodos_backend"
BACKUP_ROOT="/var/www/GoodBase/backups/database"

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

FILE_PATH="$(sudo -u postgres psql -d "$APP_DB" -t -A -v ON_ERROR_STOP=1 -c "SELECT COALESCE(file_path, '') FROM backend_backups WHERE id = '$BACKUP_ID' LIMIT 1;")"

if [ -z "$FILE_PATH" ]; then
  echo "STATUS=ok"
  echo "FILE_DELETED=false"
  echo "MESSAGE=No backup file path was found."
  exit 0
fi

case "$FILE_PATH" in
  "$BACKUP_ROOT"/*) ;;
  *)
    echo "STATUS=failed"
    echo "ERROR=Backup path is outside the database backup root"
    exit 1
    ;;
esac

if [ -f "$FILE_PATH" ]; then
  rm -f "$FILE_PATH"
  echo "STATUS=ok"
  echo "FILE_DELETED=true"
  echo "FILE_PATH=$FILE_PATH"
else
  echo "STATUS=ok"
  echo "FILE_DELETED=false"
  echo "FILE_PATH=$FILE_PATH"
fi
