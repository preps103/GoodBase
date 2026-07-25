#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR="${GOODBASE_APP_DIR:-${GOODOS_APP_DIR:-/var/www/GoodBase}}"
ENV_DIR="${GOODBASE_DATA_PLATFORM_ENV_DIR:-${GOODOS_DATA_PLATFORM_ENV_DIR:-/etc/goodbase}}"
ENV_FILE="$ENV_DIR/data-platform.env"
APP_ENV_FILE="$APP_DIR/.env"
SERVICE_FILE="$APP_DIR/deploy/systemd/goodbase-data-platform.service"
TLS_REFRESH_SCRIPT="$APP_DIR/scripts/refresh-goodbase-tls.sh"
COMPOSE_DIR="$APP_DIR/deploy/data-platform"
DB_NAME="${GOODBASE_DB_NAME:-goodos_backend}"
PM2_PROCESS="${GOODBASE_PM2_PROCESS:-goodapp-backend}"
PUBLIC_URL="${GOODBASE_PUBLIC_URL:-https://base.goodos.app}"

MIGRATIONS=(
  "$APP_DIR/migrations/20260720_postgrest_data_plane.sql"
  "$APP_DIR/migrations/20260720_goodbase_rest_phase1.sql"
  "$APP_DIR/migrations/20260721_goodbase_graphql_phase2.sql"
  "$APP_DIR/migrations/20260721_goodbase_rls_phase3.sql"
  "$APP_DIR/migrations/20260721_goodbase_pooling_phase4.sql"
  "$APP_DIR/migrations/20260721_goodbase_realtime_phase5.sql"
  "$APP_DIR/migrations/20260721_goodbase_phases6_10.sql"
  "$APP_DIR/migrations/20260721_goodbase_phases11_15.sql"
  "$APP_DIR/migrations/20260721_goodbase_phases16_20.sql"
  "$APP_DIR/migrations/20260721_goodbase_phases21_25.sql"
  "$APP_DIR/migrations/20260721_goodbase_phases26_30.sql"
  "$APP_DIR/migrations/20260721_goodbase_phases31_38.sql"
  "$APP_DIR/migrations/20260721_goodbase_phases46_50.sql"
  "$APP_DIR/migrations/20260721_goodbase_operational_proof.sql"
  "$APP_DIR/migrations/20260721_goodbase_audit_corrections.sql"
  "$APP_DIR/migrations/20260722_goodbase_native_telemetry.sql"
)

fail() {
  echo "ERROR=$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

read_env_value() {
  local file="$1"
  local key="$2"

  [ -f "$file" ] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1 | tr -d '\r'
}

upsert_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local temporary

  temporary="$(mktemp)"
  if [ -f "$file" ]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { replaced = 0 }
      index($0, key "=") == 1 {
        if (!replaced) {
          print key "=" value
          replaced = 1
        }
        next
      }
      { print }
      END {
        if (!replaced) print key "=" value
      }
    ' "$file" > "$temporary"
  else
    printf '%s=%s\n' "$key" "$value" > "$temporary"
  fi

  if [ "$file" = "$APP_ENV_FILE" ]; then
    install -o root -g goodapp -m 0640 "$temporary" "$file"
  else
    install -o root -g root -m 0600 "$temporary" "$file"
  fi
  rm -f "$temporary"
}

[ "$(id -u)" -eq 0 ] || fail "Run this provisioning script as root."

for command in node openssl psql pg_dump docker curl systemctl awk sed; do
  require_command "$command"
done

for migration in "${MIGRATIONS[@]}"; do
  [ -f "$migration" ] || fail "Missing migration: $migration"
done
[ -f "$SERVICE_FILE" ] || fail "Missing service file: $SERVICE_FILE"
[ -f "$TLS_REFRESH_SCRIPT" ] || fail "Missing TLS refresh script: $TLS_REFRESH_SCRIPT"
[ -f "$COMPOSE_DIR/compose.yaml" ] || fail "Missing Compose file."

systemctl is-active --quiet postgresql || fail "PostgreSQL is not active."
systemctl is-active --quiet docker || fail "Docker is not active."

JWT_SECRET_VALUE="$(
  cd "$APP_DIR"
  node -e '
    require("dotenv").config();
    const value = String(process.env.JWT_SECRET || "");
    if (value.length < 32 || value.includes("\n")) process.exit(2);
    process.stdout.write(value);
  '
)" || fail "JWT_SECRET is missing or invalid."

DB_PASSWORD="$(read_env_value "$ENV_FILE" PGRST_DB_PASSWORD)"
[ -n "$DB_PASSWORD" ] || DB_PASSWORD="$(openssl rand -hex 32)"
TRANSACTION_POOL_PASSWORD="$(read_env_value "$ENV_FILE" GOODBASE_TRANSACTION_POOL_PASSWORD)"
[ -n "$TRANSACTION_POOL_PASSWORD" ] || TRANSACTION_POOL_PASSWORD="$(openssl rand -hex 32)"
SESSION_POOL_PASSWORD="$(read_env_value "$ENV_FILE" GOODBASE_SESSION_POOL_PASSWORD)"
[ -n "$SESSION_POOL_PASSWORD" ] || SESSION_POOL_PASSWORD="$(openssl rand -hex 32)"
REALTIME_DB_PASSWORD="$(read_env_value "$ENV_FILE" REALTIME_DB_PASSWORD)"
[ -n "$REALTIME_DB_PASSWORD" ] && [ "$REALTIME_DB_PASSWORD" != "not-provisioned" ] || REALTIME_DB_PASSWORD="$(openssl rand -hex 32)"
REALTIME_API_JWT_SECRET="$(read_env_value "$ENV_FILE" REALTIME_API_JWT_SECRET)"
[ -n "$REALTIME_API_JWT_SECRET" ] && [ "$REALTIME_API_JWT_SECRET" != "not-provisioned" ] || REALTIME_API_JWT_SECRET="$JWT_SECRET_VALUE"
REALTIME_SECRET_KEY_BASE="$(read_env_value "$ENV_FILE" REALTIME_SECRET_KEY_BASE)"
[ -n "$REALTIME_SECRET_KEY_BASE" ] && [ "$REALTIME_SECRET_KEY_BASE" != "not-provisioned" ] || REALTIME_SECRET_KEY_BASE="$(openssl rand -hex 64)"
REALTIME_DB_ENC_KEY="$(read_env_value "$ENV_FILE" REALTIME_DB_ENC_KEY)"
[ -n "$REALTIME_DB_ENC_KEY" ] || REALTIME_DB_ENC_KEY="$(openssl rand -hex 8)"

install -d -o postgres -g postgres -m 0750 /var/backups/goodbase
BACKUP_FILE="/var/backups/goodbase/pre-phase5-$(date -u +%Y%m%dT%H%M%SZ).dump"
sudo -u postgres pg_dump -Fc -d "$DB_NAME" -f "$BACKUP_FILE"
test -s "$BACKUP_FILE" || fail "Pre-Phase-5 database backup is empty."

CURRENT_WAL_LEVEL="$(sudo -u postgres psql -Atqc "SHOW wal_level")"
if [ "$CURRENT_WAL_LEVEL" != "logical" ]; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
ALTER SYSTEM SET wal_level = 'logical';
ALTER SYSTEM SET max_replication_slots = '10';
ALTER SYSTEM SET max_wal_senders = '10';
ALTER SYSTEM SET max_slot_wal_keep_size = '2GB';
SQL
  systemctl restart postgresql
  systemctl is-active --quiet postgresql || fail "PostgreSQL failed after logical replication restart."
fi

for migration in "${MIGRATIONS[@]}"; do
  echo "APPLYING=$(basename "$migration")"
  sudo -u postgres psql \
    -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 \
    -f "$migration"
done

sudo -u postgres psql \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -v role_password="$DB_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE goodos_postgrest_authenticator LOGIN NOINHERIT NOBYPASSRLS PASSWORD %L',
  :'role_password'
)
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_roles
  WHERE rolname = 'goodos_postgrest_authenticator'
) \gexec

SELECT format(
  'ALTER ROLE goodos_postgrest_authenticator WITH LOGIN NOINHERIT NOBYPASSRLS PASSWORD %L',
  :'role_password'
) \gexec

GRANT goodos_anon TO goodos_postgrest_authenticator;
GRANT goodos_authenticated TO goodos_postgrest_authenticator;
GRANT CONNECT ON DATABASE goodos_backend TO goodos_postgrest_authenticator;
SQL

sudo -u postgres psql \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -v transaction_password="$TRANSACTION_POOL_PASSWORD" \
  -v session_password="$SESSION_POOL_PASSWORD" \
  -v realtime_password="$REALTIME_DB_PASSWORD" <<'SQL'
SELECT format('ALTER ROLE goodbase_pool_transaction WITH LOGIN PASSWORD %L', :'transaction_password') \gexec
SELECT format('ALTER ROLE goodbase_pool_session WITH LOGIN PASSWORD %L', :'session_password') \gexec
SELECT format('ALTER ROLE goodbase_realtime WITH LOGIN REPLICATION PASSWORD %L', :'realtime_password') \gexec
SQL

HBA_FILE="$(sudo -u postgres psql -Atqc "SHOW hba_file")"
[ -f "$HBA_FILE" ] || fail "PostgreSQL HBA file was not found."
if ! grep -q "GOODBASE_MANAGED_POOL_AUTH" "$HBA_FILE"; then
  HBA_TEMPORARY="$(mktemp)"
  {
    echo "# GOODBASE_MANAGED_POOL_AUTH"
    echo "local ${DB_NAME} goodbase_pool_transaction scram-sha-256"
    echo "local ${DB_NAME} goodbase_pool_session scram-sha-256"
    cat "$HBA_FILE"
  } > "$HBA_TEMPORARY"
  install -o postgres -g postgres -m 0640 "$HBA_TEMPORARY" "$HBA_FILE"
  rm -f "$HBA_TEMPORARY"
  systemctl reload postgresql
fi

install -d -o root -g postgres -m 0710 "$ENV_DIR"
install -d -o root -g root -m 0755 /var/lib/goodbase
install -d -o goodapp -g goodapp -m 0755 /var/lib/goodbase/functions
install -d -o goodapp -g goodapp -m 0750 /var/lib/goodbase/uploads
install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
install -o root -g root -m 0755 "$TLS_REFRESH_SCRIPT" \
  /etc/letsencrypt/renewal-hooks/deploy/goodbase-data-platform
GOODBASE_APP_DIR="$APP_DIR" "$TLS_REFRESH_SCRIPT"

cat > "$ENV_FILE" <<EOF
PGRST_DB_URI=postgres://goodos_postgrest_authenticator:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}
PGRST_DB_PASSWORD=${DB_PASSWORD}
GOODOS_JWT_SECRET=${JWT_SECRET_VALUE}
PGRST_DB_POOL=20
PGRST_DB_POOL_ACQUISITION_TIMEOUT=10
PGRST_DB_MAX_ROWS=1000
PGRST_LOG_LEVEL=info
GOODBASE_DB_NAME=${DB_NAME}
GOODBASE_TRANSACTION_POOL_PASSWORD=${TRANSACTION_POOL_PASSWORD}
GOODBASE_SESSION_POOL_PASSWORD=${SESSION_POOL_PASSWORD}
GOODBASE_TRANSACTION_MAX_CLIENTS=200
GOODBASE_TRANSACTION_POOL_SIZE=20
GOODBASE_TRANSACTION_RESERVE_SIZE=5
GOODBASE_SESSION_MAX_CLIENTS=100
GOODBASE_SESSION_POOL_SIZE=10
GOODBASE_SESSION_RESERVE_SIZE=2
REALTIME_DB_NAME=${DB_NAME}
REALTIME_DB_USER=goodbase_realtime
REALTIME_DB_PASSWORD=${REALTIME_DB_PASSWORD}
REALTIME_DB_ENC_KEY=${REALTIME_DB_ENC_KEY}
REALTIME_API_JWT_SECRET=${REALTIME_API_JWT_SECRET}
REALTIME_SECRET_KEY_BASE=${REALTIME_SECRET_KEY_BASE}
REALTIME_MAX_CONNECTIONS=10000
REALTIME_NUM_ACCEPTORS=100
REALTIME_JWT_CLAIM_VALIDATORS={"iss":"${PUBLIC_URL}"}
EOF
chmod 0600 "$ENV_FILE"

upsert_env_value "$APP_ENV_FILE" GOODBASE_PUBLIC_URL "$PUBLIC_URL"
upsert_env_value "$APP_ENV_FILE" GOODBASE_POSTGREST_HOST "127.0.0.1"
upsert_env_value "$APP_ENV_FILE" GOODBASE_POSTGREST_PORT "8300"
upsert_env_value "$APP_ENV_FILE" GOODBASE_DATA_API_SCHEMA "goodos_api"
upsert_env_value "$APP_ENV_FILE" GOODBASE_REST_TIMEOUT_MS "30000"
upsert_env_value "$APP_ENV_FILE" GOODBASE_REST_MAX_QUERY_BYTES "8192"
upsert_env_value "$APP_ENV_FILE" GOODBASE_REST_MAX_BODY_BYTES "1048576"
upsert_env_value "$APP_ENV_FILE" GOODBASE_REST_MAX_RESPONSE_BYTES "10485760"
upsert_env_value "$APP_ENV_FILE" GOODBASE_TRANSACTION_POOL_PORT "6543"
upsert_env_value "$APP_ENV_FILE" GOODBASE_SESSION_POOL_PORT "5433"
upsert_env_value "$APP_ENV_FILE" GOODBASE_REALTIME_PORT "8400"
upsert_env_value "$APP_ENV_FILE" GOODBASE_EDGE_RUNTIME_URL "http://127.0.0.1:8500"

install \
  -o root \
  -g root \
  -m 0644 \
  "$SERVICE_FILE" \
  /etc/systemd/system/goodbase-data-platform.service

systemctl daemon-reload

cd "$COMPOSE_DIR"
docker compose --env-file "$ENV_FILE" config --quiet
docker compose --env-file "$ENV_FILE" pull postgrest pgbouncer-transaction pgbouncer-session realtime edge-runtime
systemctl enable --now goodbase-data-platform.service
systemctl reload goodbase-data-platform.service

for attempt in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:8301/ready >/dev/null 2>&1 &&
     curl -fsS --max-time 5 \
       -H 'Accept: application/openapi+json' \
       http://127.0.0.1:8300/ >/dev/null 2>&1; then
    break
  fi

  if [ "$attempt" -eq 30 ]; then
    docker compose --env-file "$ENV_FILE" logs --tail 120 postgrest
    fail "PostgREST did not become ready."
  fi

  sleep 2
done

if command -v pm2 >/dev/null 2>&1 &&
   pm2 describe "$PM2_PROCESS" >/dev/null 2>&1; then
  cd "$APP_DIR"
  pm2 restart "$PM2_PROCESS" --update-env
fi

for attempt in $(seq 1 30); do
  if curl -fsS --max-time 5 \
    http://127.0.0.1:8001/api/data-platform/health >/dev/null 2>&1; then
    break
  fi

  if [ "$attempt" -eq 30 ]; then
    fail "Goodbase backend health route did not become ready."
  fi

  sleep 2
done

for port in 5433 6543 8400 8500; do
  for attempt in $(seq 1 45); do
    if timeout 2 bash -c "</dev/tcp/127.0.0.1/${port}" >/dev/null 2>&1; then
      break
    fi
    if [ "$attempt" -eq 45 ]; then
      docker compose --env-file "$ENV_FILE" ps
      docker compose --env-file "$ENV_FILE" logs --tail 120
      fail "Goodbase service on port ${port} did not become ready."
    fi
    sleep 2
  done
done

sudo -u postgres psql \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -c "
    UPDATE backend_data_plane_components
    SET
      status = 'active',
      health_status = 'healthy',
      last_health_check_at = NOW(),
      metadata_json =
        COALESCE(metadata_json, '{}'::jsonb) ||
        jsonb_build_object(
          'brand', 'Goodbase',
          'publicBaseUrl', '${PUBLIC_URL}',
          'provisionedAt', NOW()
        ),
      updated_at = NOW()
    WHERE component = 'postgrest';
  " >/dev/null

echo "STATUS=ready"
echo "PRODUCT=Goodbase"
echo "COMPONENT=postgrest"
echo "LOCAL_ENDPOINT=http://127.0.0.1:8300"
echo "PUBLIC_ENDPOINT=${PUBLIC_URL}/rest/v1"
echo "HEALTH_ENDPOINT=${PUBLIC_URL}/api/data-platform/health"
echo "TRANSACTION_POOL=postgresql://${PUBLIC_URL#https://}:6543/${DB_NAME}"
echo "SESSION_POOL=postgresql://${PUBLIC_URL#https://}:5433/${DB_NAME}"
echo "REALTIME_ENDPOINT=${PUBLIC_URL}/realtime/v1"
echo "BACKUP_FILE=${BACKUP_FILE}"
