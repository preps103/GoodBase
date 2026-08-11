#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

# Goodbase Recovery Node
#
# Validates the encrypted off-site copy and restores the newest logical backup
# into a disposable PostgreSQL cluster. The same script is intentionally usable
# on a desktop, laptop, or NAS by changing only environment variables.

RECOVERY_ROOT="${GOODBASE_RECOVERY_ROOT:-/Volumes/G-DRIVE mobile USB-C/GoodOS-Backups/srv1592310}"
STATUS_DIR="${GOODBASE_RECOVERY_STATUS_DIR:-$RECOVERY_ROOT/status}"
IDENTITY_FILE="${GOODBASE_AGE_IDENTITY_FILE:-$HOME/Library/Application Support/Goodbase Recovery/backup-age.key}"
NODE_ID="${GOODBASE_RECOVERY_NODE_ID:-$(hostname -s 2>/dev/null || hostname)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLES_FILE="${GOODBASE_RECOVERY_ROLES_FILE:-$SCRIPT_DIR/goodbase-recovery-roles.txt}"
MAX_LOGICAL_AGE_MINUTES="${GOODBASE_MAX_LOGICAL_AGE_MINUTES:-1560}"
MAX_WAL_AGE_MINUTES="${GOODBASE_MAX_WAL_AGE_MINUTES:-20}"
MAX_BASE_AGE_MINUTES="${GOODBASE_MAX_BASE_AGE_MINUTES:-11520}"
MAX_COPY_AGE_MINUTES="${GOODBASE_MAX_COPY_AGE_MINUTES:-30}"
ALERT_TITLE="Goodbase Recovery"

WORK_DIR=""
PG_DATA=""
PG_SOCKET=""
PG_STARTED=0
START_EPOCH="$(date +%s)"

timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log() {
  printf '%s %s\n' "$(timestamp)" "$*"
}

notify_failure() {
  message="$1"
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"Goodbase recovery verification failed. Review the recovery log.\" with title \"$ALERT_TITLE\"" >/dev/null 2>&1 || true
  fi
  if [ -n "${GOODBASE_RECOVERY_ALERT_COMMAND:-}" ]; then
    GOODBASE_RECOVERY_ALERT_MESSAGE="$message" sh -c "$GOODBASE_RECOVERY_ALERT_COMMAND" || true
  fi
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/[[:cntrl:]]/ /g'
}

write_failure() {
  message="$1"
  mkdir -p "$STATUS_DIR"
  temporary="$STATUS_DIR/last-restore-failure.json.tmp"
  cat >"$temporary" <<EOF
{
  "schemaVersion": 1,
  "nodeId": "$(json_escape "$NODE_ID")",
  "status": "failed",
  "completedAt": "$(timestamp)",
  "message": "$(json_escape "$message")"
}
EOF
  chmod 600 "$temporary"
  mv "$temporary" "$STATUS_DIR/last-restore-failure.json"
  notify_failure "$message"
}

fail() {
  message="$1"
  log "ERROR: $message" >&2
  write_failure "$message"
  exit 1
}

cleanup() {
  if [ "$PG_STARTED" -eq 1 ] && [ -n "${PG_CTL:-}" ] && [ -n "$PG_DATA" ]; then
    "$PG_CTL" -D "$PG_DATA" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf -- "$WORK_DIR"
  fi
}

trap cleanup EXIT INT TERM

on_error() {
  line="$1"
  status="$2"
  trap - ERR
  message="Recovery controller stopped unexpectedly at line $line (status $status)"
  log "ERROR: $message" >&2
  write_failure "$message"
  exit "$status"
}

trap 'on_error "$LINENO" "$?"' ERR

require_directory() {
  [ -d "$1" ] || fail "Required backup directory is unavailable: $1"
}

find_command() {
  name="$1"
  shift
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi
  for candidate in "$@"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

file_epoch() {
  if stat -f '%m' "$1" >/dev/null 2>&1; then
    stat -f '%m' "$1"
  else
    stat -c '%Y' "$1"
  fi
}

file_size() {
  if stat -f '%z' "$1" >/dev/null 2>&1; then
    stat -f '%z' "$1"
  else
    stat -c '%s' "$1"
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

age_minutes() {
  modified="$(file_epoch "$1")"
  now="$(date +%s)"
  printf '%s\n' "$(( (now - modified) / 60 ))"
}

newest_matching() {
  directory="$1"
  pattern="$2"
  {
    find "$directory" -maxdepth 1 -type f -name "$pattern" -exec ls -1t {} + 2>/dev/null |
      head -1
  } || true
}

verify_encrypted_checksum() {
  artifact="$1"
  sidecar="${artifact}.sha256"
  [ -s "$sidecar" ] || fail "Checksum sidecar is missing for $(basename "$artifact")"
  expected="$(awk 'NR == 1 {print $1}' "$sidecar")"
  actual="$(sha256_file "$artifact")"
  [ "$expected" = "$actual" ] || fail "Encrypted checksum mismatch for $(basename "$artifact")"
}

validate_integer() {
  value="$1"
  label="$2"
  case "$value" in
    ''|*[!0-9]*) fail "$label must be a non-negative integer" ;;
  esac
}

for value_and_label in \
  "$MAX_LOGICAL_AGE_MINUTES:logical freshness limit" \
  "$MAX_WAL_AGE_MINUTES:WAL freshness limit" \
  "$MAX_BASE_AGE_MINUTES:base-backup freshness limit" \
  "$MAX_COPY_AGE_MINUTES:copy freshness limit"
do
  validate_integer "${value_and_label%%:*}" "${value_and_label#*:}"
done

require_directory "$RECOVERY_ROOT"
require_directory "$RECOVERY_ROOT/database"
require_directory "$RECOVERY_ROOT/base"
require_directory "$RECOVERY_ROOT/wal"
[ -r "$IDENTITY_FILE" ] || fail "The recovery identity is unavailable on this node"
[ -r "$ROLES_FILE" ] || fail "The recovery role manifest is unavailable: $ROLES_FILE"

identity_mode="$(stat -f '%Lp' "$IDENTITY_FILE" 2>/dev/null || stat -c '%a' "$IDENTITY_FILE")"
case "$identity_mode" in
  600|400) ;;
  *) fail "The recovery identity must be readable only by its owner (mode 600 or 400)" ;;
esac

AGE="$(find_command age /opt/homebrew/bin/age /usr/local/bin/age)" || fail "age is not installed"
GZIP="$(find_command gzip /usr/bin/gzip /bin/gzip)" || fail "gzip is not installed"
PG_BIN="${GOODBASE_PG_BIN:-}"
if [ -z "$PG_BIN" ]; then
  for candidate in /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin /usr/lib/postgresql/16/bin; do
    if [ -x "$candidate/pg_restore" ]; then
      PG_BIN="$candidate"
      break
    fi
  done
fi
[ -n "$PG_BIN" ] || fail "PostgreSQL 16 client and server tools are not installed"

for command_name in initdb pg_ctl createdb pg_restore psql; do
  [ -x "$PG_BIN/$command_name" ] || fail "Missing PostgreSQL recovery command: $PG_BIN/$command_name"
done

mkdir -p "$STATUS_DIR"

LOGICAL="$(newest_matching "$RECOVERY_ROOT/database" '*.dump.age')"
BASE="$(newest_matching "$RECOVERY_ROOT/base" '*.tar.gz.age')"
WAL="$(newest_matching "$RECOVERY_ROOT/wal" '*.age')"
COPY_STATUS="$STATUS_DIR/last-success.json"

[ -n "$LOGICAL" ] && [ -s "$LOGICAL" ] || fail "No encrypted logical backup is available"
[ -n "$BASE" ] && [ -s "$BASE" ] || fail "No encrypted base backup is available"
[ -n "$WAL" ] && [ -s "$WAL" ] || fail "No encrypted WAL segment is available"
[ -s "$COPY_STATUS" ] || fail "No completed off-site copy status is available"

LOGICAL_AGE="$(age_minutes "$LOGICAL")"
BASE_AGE="$(age_minutes "$BASE")"
WAL_AGE="$(age_minutes "$WAL")"
COPY_AGE="$(age_minutes "$COPY_STATUS")"

[ "$LOGICAL_AGE" -le "$MAX_LOGICAL_AGE_MINUTES" ] || fail "Logical backup is stale (${LOGICAL_AGE} minutes)"
[ "$BASE_AGE" -le "$MAX_BASE_AGE_MINUTES" ] || fail "Base backup is stale (${BASE_AGE} minutes)"
[ "$WAL_AGE" -le "$MAX_WAL_AGE_MINUTES" ] || fail "WAL archive is stale (${WAL_AGE} minutes)"
[ "$COPY_AGE" -le "$MAX_COPY_AGE_MINUTES" ] || fail "Off-site copy is stale (${COPY_AGE} minutes)"

verify_encrypted_checksum "$LOGICAL"
verify_encrypted_checksum "$BASE"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goodbase-recovery.XXXXXX")"
PLAIN_DUMP="$WORK_DIR/backup.dump"
PLAIN_WAL="$WORK_DIR/wal.segment"
WAL_CONTAINER="$WORK_DIR/wal.container"
PLAIN_BASE="$WORK_DIR/base.tar.gz"

log "Decrypting and validating $(basename "$LOGICAL")"
"$AGE" --decrypt --identity "$IDENTITY_FILE" --output "$PLAIN_DUMP" "$LOGICAL"
"$PG_BIN/pg_restore" --list "$PLAIN_DUMP" >"$WORK_DIR/archive.list"
ARCHIVE_ENTRIES="$(grep -cvE '^(;|$)' "$WORK_DIR/archive.list")"
[ "$ARCHIVE_ENTRIES" -ge 5 ] || fail "Logical backup contains too few restore entries"

log "Validating newest WAL segment $(basename "$WAL")"
WAL_CHECKSUM="${WAL%.age}.sha256"
[ -s "$WAL_CHECKSUM" ] || fail "Checksum sidecar is missing for $(basename "$WAL")"
"$AGE" --decrypt --identity "$IDENTITY_FILE" --output "$WAL_CONTAINER" "$WAL"
if "$GZIP" -t "$WAL_CONTAINER" >/dev/null 2>&1; then
  "$GZIP" -dc "$WAL_CONTAINER" >"$PLAIN_WAL"
else
  mv "$WAL_CONTAINER" "$PLAIN_WAL"
fi
WAL_EXPECTED="$(awk 'NR == 1 {print $1}' "$WAL_CHECKSUM")"
WAL_ACTUAL="$(sha256_file "$PLAIN_WAL")"
[ -n "$WAL_EXPECTED" ] && [ "$WAL_EXPECTED" = "$WAL_ACTUAL" ] || fail "Decrypted WAL checksum mismatch"

log "Validating encrypted base archive $(basename "$BASE")"
"$AGE" --decrypt --identity "$IDENTITY_FILE" --output "$PLAIN_BASE" "$BASE"
tar -tzf "$PLAIN_BASE" >"$WORK_DIR/base.list"
grep -Eq '(^|/)backup_label$' "$WORK_DIR/base.list" || fail "Base backup is missing backup_label"
grep -Eq '(^|/)backup_manifest$' "$WORK_DIR/base.list" || fail "Base backup is missing backup_manifest"
grep -Eq '(^|/)global/pg_control$' "$WORK_DIR/base.list" || fail "Base backup is missing pg_control"
rm -f "$PLAIN_BASE" "$PLAIN_WAL" "$WAL_CONTAINER"

PG_DATA="$WORK_DIR/postgres"
PG_SOCKET="$WORK_DIR/socket"
mkdir -p "$PG_SOCKET"

log "Starting disposable PostgreSQL 16 restore target"
"$PG_BIN/initdb" -D "$PG_DATA" --auth=trust --no-locale --encoding=UTF8 >/dev/null
printf "listen_addresses = ''\n" >>"$PG_DATA/postgresql.auto.conf"
PORT=''
for startup_attempt in 1 2 3; do
  candidate_port="$((20000 + (RANDOM % 30000)))"
  if "$PG_BIN/pg_ctl" \
    -D "$PG_DATA" \
    -l "$WORK_DIR/postgres-startup.log" \
    -o "-k $PG_SOCKET -p $candidate_port" \
    -w start \
    >/dev/null 2>&1
  then
    PORT="$candidate_port"
    PG_STARTED=1
    break
  fi
done

if [ "$PG_STARTED" -ne 1 ]; then
  log "Disposable PostgreSQL startup log:" >&2
  tail -n 40 "$WORK_DIR/postgres-startup.log" >&2 || true
  fail "Disposable PostgreSQL restore target could not start after three attempts"
fi

"$PG_BIN/createdb" -h "$PG_SOCKET" -p "$PORT" goodbase_restore_verify

# A logical recovery node may not have every production extension binary (for
# example pg_graphql on macOS). Extension-owned objects are not included in a
# pg_dump archive, so omit only the unavailable CREATE/COMMENT entries while
# continuing to fail on every application schema or data restore error. The
# production physical PITR drill separately proves the full extension runtime.
RESTORE_LIST="$WORK_DIR/restore.list"
cp "$WORK_DIR/archive.list" "$RESTORE_LIST"
MISSING_EXTENSIONS=()
while IFS= read -r recovery_extension; do
  [ -n "$recovery_extension" ] || continue
  case "$recovery_extension" in *[!A-Za-z0-9_-]*) fail "Invalid extension name in recovery archive" ;; esac
  extension_available="$(
    "$PG_BIN/psql" -h "$PG_SOCKET" -p "$PORT" -d goodbase_restore_verify -Atqc \
      "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='$recovery_extension') THEN 1 ELSE 0 END"
  )"
  if [ "$extension_available" != "1" ]; then
    MISSING_EXTENSIONS+=("$recovery_extension")
    filtered_list="$RESTORE_LIST.filtered"
    awk -v extension="$recovery_extension" '
      index($0, " EXTENSION - " extension) == 0 &&
      index($0, " COMMENT - EXTENSION " extension) == 0 { print }
    ' "$RESTORE_LIST" >"$filtered_list"
    mv "$filtered_list" "$RESTORE_LIST"
    log "Logical restore will omit unavailable extension binary: $recovery_extension"
  fi
done < <(awk '$4 == "EXTENSION" && $5 == "-" { print $6 }' "$WORK_DIR/archive.list" | sort -u)

while IFS='|' read -r recovery_role recovery_inherit; do
  case "$recovery_role" in
    ''|'#'*) continue ;;
    *[!A-Za-z0-9_]*) fail "Invalid role name in recovery manifest" ;;
  esac
  case "$recovery_inherit" in
    inherit) inherit_sql=INHERIT ;;
    noinherit) inherit_sql=NOINHERIT ;;
    *) fail "Invalid inheritance setting for recovery role $recovery_role" ;;
  esac
  "$PG_BIN/psql" \
    -h "$PG_SOCKET" \
    -p "$PORT" \
    -d postgres \
    -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE \"$recovery_role\" NOLOGIN $inherit_sql;" \
    >/dev/null
done <"$ROLES_FILE"

"$PG_BIN/pg_restore" \
  --exit-on-error \
  --no-owner \
  --no-acl \
  --use-list="$RESTORE_LIST" \
  --host="$PG_SOCKET" \
  --port="$PORT" \
  --dbname=goodbase_restore_verify \
  "$PLAIN_DUMP"

SMOKE_RESULT="$(
  "$PG_BIN/psql" \
    -h "$PG_SOCKET" \
    -p "$PORT" \
    -d goodbase_restore_verify \
    -v ON_ERROR_STOP=1 \
    -Atqc "
      SELECT CASE
        WHEN to_regclass('public.users') IS NOT NULL
         AND to_regclass('public.backend_projects') IS NOT NULL
         AND (SELECT COUNT(*) FROM users) > 0
         AND (SELECT COUNT(*) FROM backend_projects) > 0
        THEN 'verified'
        ELSE 'incomplete'
      END;
    "
)"
[ "$SMOKE_RESULT" = "verified" ] || fail "Restored database smoke checks did not pass"

TABLE_COUNT="$(
  "$PG_BIN/psql" -h "$PG_SOCKET" -p "$PORT" -d goodbase_restore_verify -Atqc \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';"
)"
USER_COUNT="$(
  "$PG_BIN/psql" -h "$PG_SOCKET" -p "$PORT" -d goodbase_restore_verify -Atqc \
    "SELECT COUNT(*) FROM users;"
)"
PROJECT_COUNT="$(
  "$PG_BIN/psql" -h "$PG_SOCKET" -p "$PORT" -d goodbase_restore_verify -Atqc \
    "SELECT COUNT(*) FROM backend_projects;"
)"

MISSING_EXTENSIONS_JSON="["
for recovery_extension in "${MISSING_EXTENSIONS[@]}"; do
  [ "$MISSING_EXTENSIONS_JSON" = "[" ] || MISSING_EXTENSIONS_JSON+=","
  MISSING_EXTENSIONS_JSON+="\"$(json_escape "$recovery_extension")\""
done
MISSING_EXTENSIONS_JSON+="]"

"$PG_BIN/pg_ctl" -D "$PG_DATA" -m fast -w stop >/dev/null
PG_STARTED=0

END_EPOCH="$(date +%s)"
DURATION_SECONDS="$((END_EPOCH - START_EPOCH))"
RTO_MINUTES="$(awk -v seconds="$DURATION_SECONDS" 'BEGIN {printf "%.2f", seconds / 60}')"
LOGICAL_CHECKSUM="$(sha256_file "$LOGICAL")"
EVIDENCE="$STATUS_DIR/last-restore-success.json"
TEMP_EVIDENCE="${EVIDENCE}.tmp"

cat >"$TEMP_EVIDENCE" <<EOF
{
  "schemaVersion": 1,
  "nodeId": "$(json_escape "$NODE_ID")",
  "status": "passed",
  "completedAt": "$(timestamp)",
  "sourceArtifact": "$(json_escape "$(basename "$LOGICAL")")",
  "sourceChecksumSha256": "$LOGICAL_CHECKSUM",
  "sourceSizeBytes": $(file_size "$LOGICAL"),
  "encrypted": true,
  "checksumVerified": true,
  "decryptionVerified": true,
  "archiveEntries": $ARCHIVE_ENTRIES,
  "isolatedRestoreVerified": true,
  "unavailableExtensionBinaries": $MISSING_EXTENSIONS_JSON,
  "walChecksumVerified": true,
  "baseArchiveVerified": true,
  "restoredPublicTables": $TABLE_COUNT,
  "restoredUsers": $USER_COUNT,
  "restoredProjects": $PROJECT_COUNT,
  "rpoMinutes": $LOGICAL_AGE,
  "walLagMinutes": $WAL_AGE,
  "rtoMinutes": $RTO_MINUTES,
  "temporaryClusterDestroyed": true
}
EOF

chmod 600 "$TEMP_EVIDENCE"
mv "$TEMP_EVIDENCE" "$EVIDENCE"
printf '%s  %s\n' "$(sha256_file "$EVIDENCE")" "$(basename "$EVIDENCE")" >"${EVIDENCE}.sha256"
chmod 600 "${EVIDENCE}.sha256"
rm -f "$STATUS_DIR/last-restore-failure.json"

log "Recovery verification passed: RPO ${LOGICAL_AGE}m, WAL lag ${WAL_AGE}m, RTO ${RTO_MINUTES}m"
