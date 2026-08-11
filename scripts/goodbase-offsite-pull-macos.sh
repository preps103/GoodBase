#!/bin/zsh
set -euo pipefail
umask 077

DRIVE="${GOODBASE_BACKUP_DRIVE:-/Volumes/G-DRIVE mobile USB-C}"
DEST_ROOT="${GOODBASE_RECOVERY_ROOT:-$DRIVE/GoodOS-Backups/srv1592310}"
VPS="${GOODBASE_BACKUP_VPS:-root@2.24.206.16}"
SSH_KEY="${GOODBASE_BACKUP_SSH_KEY:-$HOME/.ssh/id_ed25519}"
LOG_FILE="${GOODBASE_BACKUP_LOG:-$HOME/Library/Logs/GoodOS/offsite-backup.log}"
LOCAL_STATUS_DIR="${GOODBASE_LOCAL_STATUS_DIR:-$HOME/Library/Application Support/Goodbase Recovery/status}"
LOCK_DIRECTORY="${TMPDIR:-/tmp}/goodbase-offsite-backup.lock"
RUN_COMPLETED=0

timestamp() {
  /bin/date -u '+%Y-%m-%dT%H:%M:%SZ'
}

json_escape() {
  printf '%s' "$1" | /usr/bin/sed 's/\\/\\\\/g; s/"/\\"/g; s/[[:cntrl:]]/ /g'
}

notify_failure() {
  /usr/bin/osascript -e 'display notification "The off-site backup copy failed. Review the Goodbase recovery log." with title "Goodbase Recovery"' >/dev/null 2>&1 || true
}

write_local_failure() {
  message="$1"
  /bin/mkdir -p "$LOCAL_STATUS_DIR"
  temporary="$LOCAL_STATUS_DIR/last-copy-failure.json.tmp"
  cat >"$temporary" <<EOF
{
  "schemaVersion": 1,
  "status": "failed",
  "completedAt": "$(timestamp)",
  "destination": "$(json_escape "$DEST_ROOT")",
  "message": "$(json_escape "$message")"
}
EOF
  /bin/chmod 600 "$temporary"
  /bin/mv "$temporary" "$LOCAL_STATUS_DIR/last-copy-failure.json"
  notify_failure
}

fail() {
  message="$1"
  echo "$(timestamp) ERROR: $message" >&2
  write_local_failure "$message"
  exit 1
}

on_error() {
  exit_code="$?"
  trap - ZERR
  write_local_failure "Backup pull stopped unexpectedly with status $exit_code"
  exit "$exit_code"
}

trap on_error ZERR

/bin/mkdir -p "$(/usr/bin/dirname "$LOG_FILE")" "$LOCAL_STATUS_DIR"
exec >>"$LOG_FILE" 2>&1

echo
echo '=================================================='
echo "$(timestamp) Goodbase off-site backup pull started"
echo '=================================================='

[ -d "$DRIVE" ] || fail "External recovery drive is not connected"
[ -w "$DRIVE" ] || fail "External recovery drive is not writable"
[ -r "$SSH_KEY" ] || fail "Backup SSH identity is unavailable"

if ! /bin/mkdir "$LOCK_DIRECTORY" 2>/dev/null; then
  LOCK_PID_FILE="$LOCK_DIRECTORY/pid"
  LOCK_PID="$(/bin/cat "$LOCK_PID_FILE" 2>/dev/null || true)"
  if [[ "$LOCK_PID" == <-> ]] && /bin/kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "$(timestamp) Another backup pull is already running."
    exit 0
  fi
  /bin/rm -rf "$LOCK_DIRECTORY"
  /bin/mkdir "$LOCK_DIRECTORY" || fail "Unable to replace a stale backup lock"
  echo "$(timestamp) Recovered a stale backup lock."
fi
/bin/echo "$$" >"$LOCK_DIRECTORY/pid"

cleanup() {
  /bin/rmdir "$LOCK_DIRECTORY" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

/bin/mkdir -p \
  "$DEST_ROOT/database" \
  "$DEST_ROOT/base" \
  "$DEST_ROOT/wal" \
  "$DEST_ROOT/metadata" \
  "$DEST_ROOT/status"

SSH_OPTIONS=(
  -i "$SSH_KEY"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o ConnectTimeout=15
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -o AddKeysToAgent=yes
  -o UseKeychain=yes
)

REMOTE_FILE_COUNT="$(
  /usr/bin/ssh "${SSH_OPTIONS[@]}" "$VPS" '
    find \
      /var/backups/goodos-enterprise-v1/database \
      /var/backups/goodos-enterprise-v1/base \
      /var/backups/goodos-enterprise-v1/wal \
      -type f | wc -l | tr -d " "
  '
)"

export RSYNC_RSH="/usr/bin/ssh -i $SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o AddKeysToAgent=yes -o UseKeychain=yes"

for directory in database base wal; do
  /usr/bin/rsync -a --partial \
    "$VPS:/var/backups/goodos-enterprise-v1/$directory/" \
    "$DEST_ROOT/$directory/"
done

/usr/bin/rsync -a "$VPS:/etc/goodos/backup-age-recipient.txt" "$DEST_ROOT/metadata/backup-age-recipient.txt"
/usr/bin/rsync -a "$VPS:/etc/goodos/PITR-RECOVERY.txt" "$DEST_ROOT/metadata/PITR-RECOVERY.txt"
unset RSYNC_RSH

if /usr/bin/find "$DEST_ROOT" -type f -name 'backup-age.key' -print -quit | /usr/bin/grep -q .; then
  fail "Private age identity was copied into the external backup destination"
fi

LOCAL_FILE_COUNT="$(
  /usr/bin/find "$DEST_ROOT/database" "$DEST_ROOT/base" "$DEST_ROOT/wal" -type f |
    /usr/bin/wc -l | /usr/bin/tr -d ' '
)"

[ "$LOCAL_FILE_COUNT" -ge "$REMOTE_FILE_COUNT" ] || fail "Local recovery file count is below the remote count"

LOCAL_BYTES="$(
  /usr/bin/du -sk "$DEST_ROOT/database" "$DEST_ROOT/base" "$DEST_ROOT/wal" |
    /usr/bin/awk '{total += $1} END {print total * 1024}'
)"
COMPLETED_AT="$(timestamp)"
EXTERNAL_STATUS="$DEST_ROOT/status/last-success.json"
TEMPORARY_STATUS="${EXTERNAL_STATUS}.tmp"

cat >"$TEMPORARY_STATUS" <<EOF
{
  "schemaVersion": 1,
  "status": "completed",
  "completedAt": "$COMPLETED_AT",
  "source": "$VPS",
  "remoteFilesBeforeTransfer": $REMOTE_FILE_COUNT,
  "localRecoveryFiles": $LOCAL_FILE_COUNT,
  "localRecoveryBytes": $LOCAL_BYTES,
  "privateDecryptionIdentityCopied": false
}
EOF

/bin/chmod 600 "$TEMPORARY_STATUS"
/bin/mv "$TEMPORARY_STATUS" "$EXTERNAL_STATUS"
/bin/cp "$EXTERNAL_STATUS" "$LOCAL_STATUS_DIR/last-copy-success.json"
/bin/chmod 600 "$LOCAL_STATUS_DIR/last-copy-success.json"
/bin/rm -f "$LOCAL_STATUS_DIR/last-copy-failure.json"

RUN_COMPLETED=1
echo "$(timestamp) Backup pull completed successfully."
echo "Remote files before transfer: $REMOTE_FILE_COUNT"
echo "Local recovery files: $LOCAL_FILE_COUNT"
echo "Local recovery bytes: $LOCAL_BYTES"
echo 'Private decryption identity copied: false'
