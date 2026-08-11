#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

DATABASE_FILE="${GOODOS_VOICE_DB_PATH:-/var/lib/goodapp-backend/goodos-voice-db.json}"
STATE_DIR="${GOODVOICE_STATE_DIR:-$(dirname "$DATABASE_FILE")}"
SECRETS_FILE="${GOODVOICE_SECRETS_PATH:-$STATE_DIR/goodvoice-provider-secrets.json}"
BACKUP_ROOT="${GOODVOICE_STATE_BACKUP_ROOT:-/var/backups/goodvoice-state}"
STAMP_FILE="${GOODVOICE_STATE_BACKUP_STAMP:-$STATE_DIR/goodvoice-state-backup.timestamp}"
RETENTION_DAYS="${GOODVOICE_STATE_BACKUP_RETENTION_DAYS:-14}"
MINIMUM_BACKUPS="${GOODVOICE_STATE_MINIMUM_BACKUPS:-2}"

case "$RETENTION_DAYS:$MINIMUM_BACKUPS" in
  *[!0-9:]*) echo "GoodVoice backup settings must be non-negative integers." >&2; exit 2 ;;
esac

test -s "$DATABASE_FILE" || {
  echo "GoodVoice state database is missing: $DATABASE_FILE" >&2
  exit 1
}

mkdir -p "$BACKUP_ROOT" "$(dirname "$STAMP_FILE")"
chmod 700 "$BACKUP_ROOT"

WORK_DIR="$(mktemp -d)"
TEMP_ARCHIVE="$BACKUP_ROOT/.goodvoice-state.$$.$RANDOM.tmp"
TEMP_CHECKSUM="$TEMP_ARCHIVE.sha256"
cleanup() {
  rm -f "$TEMP_ARCHIVE" "$TEMP_CHECKSUM"
  find "$WORK_DIR" -depth -mindepth 1 -delete 2>/dev/null || true
  rmdir "$WORK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

install -m 0600 "$DATABASE_FILE" "$WORK_DIR/goodos-voice-db.json"
if [[ -s "$SECRETS_FILE" ]]; then
  install -m 0600 "$SECRETS_FILE" "$WORK_DIR/goodvoice-provider-secrets.json"
fi

COMPLETED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf '%s\n' "$COMPLETED_AT" >"$WORK_DIR/completed-at.txt"
tar -czf "$TEMP_ARCHIVE" -C "$WORK_DIR" .
test -s "$TEMP_ARCHIVE"

FINAL_ARCHIVE="$BACKUP_ROOT/goodvoice-state-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
sha256sum "$TEMP_ARCHIVE" | awk -v name="$(basename "$FINAL_ARCHIVE")" '{print $1 "  " name}' >"$TEMP_CHECKSUM"
chmod 600 "$TEMP_ARCHIVE" "$TEMP_CHECKSUM"
mv "$TEMP_ARCHIVE" "$FINAL_ARCHIVE"
mv "$TEMP_CHECKSUM" "${FINAL_ARCHIVE}.sha256"

STAMP_TEMP="${STAMP_FILE}.$$.$RANDOM.tmp"
printf '%s\n' "$COMPLETED_AT" >"$STAMP_TEMP"
chmod 600 "$STAMP_TEMP"
mv "$STAMP_TEMP" "$STAMP_FILE"

while IFS= read -r -d '' archive; do
  remaining="$(find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'goodvoice-state-*.tar.gz' | wc -l | tr -d ' ')"
  [[ "$remaining" -gt "$MINIMUM_BACKUPS" ]] || break
  rm -f -- "$archive" "${archive}.sha256"
done < <(find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'goodvoice-state-*.tar.gz' -mtime "+$RETENTION_DAYS" -print0)

cleanup
trap - EXIT
printf '{"success":true,"completedAt":"%s","archive":"%s"}\n' "$COMPLETED_AT" "$FINAL_ARCHIVE"
