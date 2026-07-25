#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SOURCE_DIR="${GOODBASE_CERT_SOURCE_DIR:-/etc/letsencrypt/live/base.goodos.app}"
TARGET_DIR="${GOODBASE_PGBOUNCER_TLS_DIR:-/etc/goodbase/pgbouncer-tls}"
CONTAINER_GROUP_ID="${GOODBASE_PGBOUNCER_GROUP_ID:-70}"
APP_DIR="${GOODBASE_APP_DIR:-/var/www/GoodBase}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
test -s "$SOURCE_DIR/fullchain.pem"
test -s "$SOURCE_DIR/privkey.pem"

install -d -o root -g "$CONTAINER_GROUP_ID" -m 0750 "$TARGET_DIR"
install -o root -g "$CONTAINER_GROUP_ID" -m 0640 "$SOURCE_DIR/fullchain.pem" "$TARGET_DIR/fullchain.pem"
install -o root -g "$CONTAINER_GROUP_ID" -m 0640 "$SOURCE_DIR/privkey.pem" "$TARGET_DIR/privkey.pem"

if [ -f /etc/goodbase/data-platform.env ] && command -v docker >/dev/null 2>&1; then
  cd "$APP_DIR/deploy/data-platform"
  docker compose --env-file /etc/goodbase/data-platform.env up -d \
    pgbouncer-transaction pgbouncer-session
fi
