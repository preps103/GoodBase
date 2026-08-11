#!/usr/bin/env bash
set -Eeuo pipefail

export PM2_HOME="/root/.pm2"

PM2_BIN="/usr/bin/pm2"
CURL_BIN="/usr/bin/curl"
LOGGER_BIN="/usr/bin/logger"
FLOCK_BIN="/usr/bin/flock"
PRIMARY_NAME="goodbase-api"
SECONDARY_NAME="goodbase-api-ha"
PRIMARY_PORT="8001"
SECONDARY_PORT="8002"

exec 9>/run/lock/goodos-ha-watchdog.lock
"$FLOCK_BIN" -n 9 || exit 0

probe() {
  "$CURL_BIN" -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:$1/health" >/dev/null
}

PRIMARY_OK=0
SECONDARY_OK=0
probe "$PRIMARY_PORT" && PRIMARY_OK=1
probe "$SECONDARY_PORT" && SECONDARY_OK=1

if [ "$PRIMARY_OK" -eq 0 ] && [ "$SECONDARY_OK" -eq 1 ]; then
  "$LOGGER_BIN" -t goodos-ha-watchdog "Primary GoodBase API failed; restarting it while the secondary serves traffic."
  "$PM2_BIN" restart "$PRIMARY_NAME" --update-env >/dev/null
elif [ "$PRIMARY_OK" -eq 1 ] && [ "$SECONDARY_OK" -eq 0 ]; then
  "$LOGGER_BIN" -t goodos-ha-watchdog "Secondary GoodBase API failed; restarting it while the primary serves traffic."
  "$PM2_BIN" restart "$SECONDARY_NAME" --update-env >/dev/null
elif [ "$PRIMARY_OK" -eq 0 ] && [ "$SECONDARY_OK" -eq 0 ]; then
  "$LOGGER_BIN" -t goodos-ha-watchdog "Both GoodBase API instances failed; avoiding a restart loop."
  exit 1
fi

"$CURL_BIN" -4 -fsS --connect-timeout 5 --max-time 15 \
  -H 'Cache-Control: no-cache' \
  "https://base.goodos.app/api/health/ready?ha-watchdog=$(date +%s)" >/dev/null
