#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this provisioner as root." >&2
  exit 1
fi

GOODBASE_ROOT="${GOODBASE_ROOT:-/var/www/Goodbase}"
GOODSPEECH_ENV_FILE="${GOODSPEECH_ENV_FILE:-/etc/goodbase/goodspeech.env}"
GOODBASE_RUNTIME_USER="${GOODBASE_RUNTIME_USER:-goodapp}"
GOODBASE_PM2_USER="${GOODBASE_PM2_USER:-mgoodlo3}"
GOODBASE_PM2_HOME="${GOODBASE_PM2_HOME:-/home/${GOODBASE_PM2_USER}/.pm2}"
SERVICE_SOURCE="${GOODBASE_ROOT}/deploy/systemd/goodspeech-inference.service"
SERVICE_TARGET="/etc/systemd/system/goodspeech-inference.service"

for command in curl docker openssl systemctl; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command is missing: ${command}" >&2
    exit 1
  fi
done

if [[ ! -f "${SERVICE_SOURCE}" ]]; then
  echo "GoodSpeech service definition was not found at ${SERVICE_SOURCE}." >&2
  exit 1
fi

install -d -m 0750 -o root -g "${GOODBASE_RUNTIME_USER}" "$(dirname "${GOODSPEECH_ENV_FILE}")"

if [[ ! -f "${GOODSPEECH_ENV_FILE}" ]]; then
  token="$(openssl rand -hex 32)"
  install -m 0640 -o root -g "${GOODBASE_RUNTIME_USER}" /dev/null "${GOODSPEECH_ENV_FILE}"
  {
    echo "KOKORO_TTS_URL=http://127.0.0.1:8880"
    echo "KOKORO_TTS_TOKEN=${token}"
    echo "KOKORO_CONCURRENCY=1"
  } > "${GOODSPEECH_ENV_FILE}"
  unset token
else
  chown root:"${GOODBASE_RUNTIME_USER}" "${GOODSPEECH_ENV_FILE}"
  chmod 0640 "${GOODSPEECH_ENV_FILE}"
fi

if ! grep -Eq '^KOKORO_TTS_URL=https?://' "${GOODSPEECH_ENV_FILE}"; then
  echo "KOKORO_TTS_URL is missing or invalid in ${GOODSPEECH_ENV_FILE}." >&2
  exit 1
fi

token_length="$(
  awk -F= '/^KOKORO_TTS_TOKEN=/{sub(/^[^=]*=/, ""); print length; exit}' "${GOODSPEECH_ENV_FILE}"
)"
if [[ -z "${token_length}" || "${token_length}" -lt 32 ]]; then
  echo "KOKORO_TTS_TOKEN must contain at least 32 characters." >&2
  exit 1
fi

install -m 0644 "${SERVICE_SOURCE}" "${SERVICE_TARGET}"
systemctl daemon-reload
systemctl enable --now goodspeech-inference.service

ready=0
for _attempt in $(seq 1 120); do
  if curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:8880/health/ready >/dev/null; then
    ready=1
    break
  fi
  sleep 5
done

if [[ "${ready}" -ne 1 ]]; then
  systemctl status goodspeech-inference.service --no-pager >&2 || true
  docker compose \
    --env-file "${GOODSPEECH_ENV_FILE}" \
    -f "${GOODBASE_ROOT}/deploy/goodspeech/compose.yaml" \
    logs --tail 100 >&2 || true
  echo "Kokoro did not become ready before the provisioning timeout." >&2
  exit 1
fi

if command -v pm2 >/dev/null 2>&1 && id "${GOODBASE_PM2_USER}" >/dev/null 2>&1; then
  for process_name in goodbase-api goodbase-api-ha; do
    if runuser -u "${GOODBASE_PM2_USER}" -- \
      env PM2_HOME="${GOODBASE_PM2_HOME}" pm2 describe "${process_name}" >/dev/null 2>&1; then
      runuser -u "${GOODBASE_PM2_USER}" -- \
        env PM2_HOME="${GOODBASE_PM2_HOME}" pm2 restart "${process_name}" --update-env
    fi
  done
  runuser -u "${GOODBASE_PM2_USER}" -- \
    env PM2_HOME="${GOODBASE_PM2_HOME}" pm2 save
fi

echo "GoodSpeech Kokoro is ready on the Base loopback interface."
