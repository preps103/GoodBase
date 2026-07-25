#!/usr/bin/env bash
set -euo pipefail

APP_DB="goodos_backend"
BACKUP_ROOT="/var/www/GoodBase/backups/database"
RETENTION_DAYS="$(sudo -u postgres psql -d "$APP_DB" -t -A -P pager=off -c "
SELECT COALESCE(NULLIF(value_json ->> 'value', '')::int, 30)
FROM backend_platform_settings
WHERE setting_key = 'backups.retention_days'
LIMIT 1;
" 2>/dev/null || echo "30")"

if [ -z "$RETENTION_DAYS" ]; then
  RETENTION_DAYS="30"
fi

CHECKED=0
DELETED=0
ERRORS=0

mapfile -t ROWS < <(sudo -u postgres psql -d "$APP_DB" -t -A -F '|' -P pager=off -c "
SELECT id, COALESCE(file_path, '')
FROM backend_backups
WHERE deleted_at IS NULL
  AND created_at < NOW() - ('$RETENTION_DAYS days')::interval
ORDER BY created_at ASC
LIMIT 250;
")

for ROW in "${ROWS[@]}"; do
  [ -z "$ROW" ] && continue

  CHECKED=$((CHECKED + 1))

  BACKUP_ID="$(echo "$ROW" | cut -d'|' -f1)"
  FILE_PATH="$(echo "$ROW" | cut -d'|' -f2-)"

  FILE_DELETED="false"

  if [ -n "$FILE_PATH" ] && [ -f "$FILE_PATH" ]; then
    case "$FILE_PATH" in
      "$BACKUP_ROOT"/*) ;;
      *)
        ERRORS=$((ERRORS + 1))
        continue
        ;;
    esac

    rm -f "$FILE_PATH" && FILE_DELETED="true"
  fi

  set +e
  sudo -u postgres psql -d "$APP_DB" -v ON_ERROR_STOP=1 -P pager=off -c "
  UPDATE backend_backups
  SET
    status = CASE WHEN status = 'completed' THEN 'deleted' ELSE status END,
    deleted_at = NOW(),
    deleted_by = 'system-retention',
    deleted_reason = 'Scheduled retention cleanup after $RETENTION_DAYS days.',
    file_deleted = true
  WHERE id = '$BACKUP_ID';
  " >/dev/null
  UPDATE_STATUS=$?
  set -e

  if [ "$UPDATE_STATUS" -eq 0 ]; then
    DELETED=$((DELETED + 1))
  else
    ERRORS=$((ERRORS + 1))
  fi
done

AUDIT_ID="audit_$(openssl rand -hex 16)"

sudo -u postgres psql -d "$APP_DB" -v ON_ERROR_STOP=1 -P pager=off -c "
INSERT INTO backend_admin_audit_logs (
  id,
  actor,
  action,
  target_type,
  target_id,
  after_json,
  ip_address,
  user_agent
)
VALUES (
  '$AUDIT_ID',
  'system-retention',
  'backup.retention_timer',
  'backup_retention',
  'systemd-timer',
  jsonb_build_object(
    'retentionDays', $RETENTION_DAYS,
    'checked', $CHECKED,
    'deleted', $DELETED,
    'errors', $ERRORS
  ),
  '127.0.0.1',
  'systemd'
);
" >/dev/null

echo "RETENTION_DAYS=$RETENTION_DAYS"
echo "CHECKED=$CHECKED"
echo "DELETED=$DELETED"
echo "ERRORS=$ERRORS"
