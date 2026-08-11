#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this provisioner as root." >&2
  exit 1
fi

GOODBASE_ROOT="${GOODBASE_ROOT:-/var/www/GoodBase}"
GOODSPEECH_ENV_FILE="${GOODSPEECH_ENV_FILE:-/etc/goodbase/goodspeech.env}"
GOODBASE_RUNTIME_USER="${GOODBASE_RUNTIME_USER:-goodapp}"
GOODBASE_PM2_USER="${GOODBASE_PM2_USER:-mgoodlo3}"
GOODBASE_PM2_HOME="${GOODBASE_PM2_HOME:-/home/${GOODBASE_PM2_USER}/.pm2}"
GOODBASE_PM2_RUNTIMES="${GOODBASE_PM2_RUNTIMES:-${GOODBASE_PM2_USER}:${GOODBASE_PM2_HOME} root:/root/.pm2}"
GOODBASE_PM2_PROCESSES="${GOODBASE_PM2_PROCESSES:-goodapp-backend goodapp-backend-ha goodbase-api goodbase-api-ha}"
SERVICE_SOURCE="${GOODBASE_ROOT}/deploy/systemd/goodspeech-inference.service"
SERVICE_TARGET="/etc/systemd/system/goodspeech-inference.service"
VIDEO_SERVICE_SOURCE="${GOODBASE_ROOT}/deploy/systemd/goodspeech-video.service"
VIDEO_SERVICE_TARGET="/etc/systemd/system/goodspeech-video.service"
GOODSPEECH_ENABLE_VIDEO="${GOODSPEECH_ENABLE_VIDEO:-0}"

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

ensure_env_value() {
  local key="$1"
  local value="$2"
  if ! grep -q "^${key}=" "${GOODSPEECH_ENV_FILE}"; then
    printf '%s=%s\n' "${key}" "${value}" >> "${GOODSPEECH_ENV_FILE}"
  fi
}

read_env_value() {
  local key="$1"
  awk -F= -v key="${key}" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "${GOODSPEECH_ENV_FILE}"
}

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

ensure_env_value "GOODSPEECH_REQUIRED" "true"
ensure_env_value "GOODMOTION_VIDEO_URL" ""
ensure_env_value "GOODMOTION_VIDEO_TOKEN" ""
ensure_env_value "GOODMOTION_JOB_SIGNING_SECRET" ""
ensure_env_value "GOODMOTION_RETENTION_SECONDS" "86400"
ensure_env_value "GOODAVATAR_LIVE_URL" ""
ensure_env_value "GOODAVATAR_LIVE_TOKEN" ""

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

kokoro_url="$(
  awk -F= '/^KOKORO_TTS_URL=/{sub(/^[^=]*=/, ""); print; exit}' "${GOODSPEECH_ENV_FILE}"
)"
kokoro_token="$(
  awk -F= '/^KOKORO_TTS_TOKEN=/{sub(/^[^=]*=/, ""); print; exit}' "${GOODSPEECH_ENV_FILE}"
)"
goodspeech_required="$(read_env_value GOODSPEECH_REQUIRED)"
goodmotion_url="$(read_env_value GOODMOTION_VIDEO_URL)"
goodmotion_token="$(read_env_value GOODMOTION_VIDEO_TOKEN)"
goodmotion_signing_secret="$(read_env_value GOODMOTION_JOB_SIGNING_SECRET)"
goodavatar_url="$(read_env_value GOODAVATAR_LIVE_URL)"
goodavatar_token="$(read_env_value GOODAVATAR_LIVE_TOKEN)"
release_commit="$(git -C "${GOODBASE_ROOT}" rev-parse HEAD)"

if [[ "${GOODSPEECH_ENABLE_VIDEO}" == "1" ]]; then
  if [[ ! -f "${VIDEO_SERVICE_SOURCE}" ]]; then
    echo "GoodMotion service definition was not found at ${VIDEO_SERVICE_SOURCE}." >&2
    exit 1
  fi
  if [[ -z "${goodmotion_url}" ]]; then
    sed -i.bak 's|^GOODMOTION_VIDEO_URL=.*|GOODMOTION_VIDEO_URL=http://127.0.0.1:8890|' "${GOODSPEECH_ENV_FILE}"
    goodmotion_url="http://127.0.0.1:8890"
  fi
  if [[ "${#goodmotion_token}" -lt 32 ]]; then
    goodmotion_token="$(openssl rand -hex 32)"
    sed -i.bak "s|^GOODMOTION_VIDEO_TOKEN=.*|GOODMOTION_VIDEO_TOKEN=${goodmotion_token}|" "${GOODSPEECH_ENV_FILE}"
  fi
  if [[ "${#goodmotion_signing_secret}" -lt 32 ]]; then
    goodmotion_signing_secret="$(openssl rand -hex 32)"
    sed -i.bak "s|^GOODMOTION_JOB_SIGNING_SECRET=.*|GOODMOTION_JOB_SIGNING_SECRET=${goodmotion_signing_secret}|" "${GOODSPEECH_ENV_FILE}"
  fi
  rm -f "${GOODSPEECH_ENV_FILE}.bak"
  install -m 0644 "${VIDEO_SERVICE_SOURCE}" "${VIDEO_SERVICE_TARGET}"
fi

install -m 0644 "${SERVICE_SOURCE}" "${SERVICE_TARGET}"
systemctl daemon-reload
systemctl enable --now goodspeech-inference.service

if [[ "${GOODSPEECH_ENABLE_VIDEO}" == "1" ]]; then
  systemctl enable --now goodspeech-video.service
  video_ready=0
  for _attempt in $(seq 1 180); do
    if curl --fail --silent --show-error --max-time 5 \
      -H "Authorization: Bearer ${goodmotion_token}" \
      http://127.0.0.1:8890/health/ready >/dev/null; then
      video_ready=1
      break
    fi
    sleep 5
  done
  if [[ "${video_ready}" -ne 1 ]]; then
    systemctl status goodspeech-video.service --no-pager >&2 || true
    echo "GoodMotion did not become ready before the provisioning timeout." >&2
    exit 1
  fi
fi

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

if command -v pm2 >/dev/null 2>&1; then
  restarted=0
  for pm2_runtime in ${GOODBASE_PM2_RUNTIMES}; do
    pm2_user="${pm2_runtime%%:*}"
    pm2_home="${pm2_runtime#*:}"

    if [[ -z "${pm2_user}" || -z "${pm2_home}" || "${pm2_home}" == "${pm2_runtime}" ]]; then
      echo "Ignoring invalid PM2 runtime candidate: ${pm2_runtime}" >&2
      continue
    fi

    if ! id "${pm2_user}" >/dev/null 2>&1; then
      continue
    fi

    runtime_restarted=0
    for process_name in ${GOODBASE_PM2_PROCESSES}; do
      if runuser -u "${pm2_user}" -- \
        env PM2_HOME="${pm2_home}" pm2 describe "${process_name}" >/dev/null 2>&1; then
        runuser -u "${pm2_user}" -- \
          env \
            PM2_HOME="${pm2_home}" \
            KOKORO_TTS_URL="${kokoro_url}" \
            KOKORO_TTS_TOKEN="${kokoro_token}" \
            GOODSPEECH_REQUIRED="${goodspeech_required}" \
            GOODBASE_RELEASE_COMMIT="${release_commit}" \
            GOODMOTION_VIDEO_URL="${goodmotion_url}" \
            GOODMOTION_VIDEO_TOKEN="${goodmotion_token}" \
            GOODMOTION_JOB_SIGNING_SECRET="${goodmotion_signing_secret}" \
            GOODAVATAR_LIVE_URL="${goodavatar_url}" \
            GOODAVATAR_LIVE_TOKEN="${goodavatar_token}" \
            pm2 restart "${process_name}" --update-env
        runtime_restarted=1
        restarted=1
      fi
    done

    if [[ "${runtime_restarted}" -eq 1 ]]; then
      runuser -u "${pm2_user}" -- \
        env PM2_HOME="${pm2_home}" pm2 save
      echo "Restarted Base from PM2 runtime ${pm2_user}:${pm2_home}."
      break
    fi
  done

  if [[ "${restarted}" -ne 1 ]]; then
    echo "No configured Base PM2 process was found. Set GOODBASE_PM2_RUNTIMES and GOODBASE_PM2_PROCESSES for the live runtime." >&2
    exit 1
  fi
fi

echo "GoodSpeech Kokoro is ready on the Base loopback interface at release ${release_commit}."
if [[ "${GOODSPEECH_ENABLE_VIDEO}" == "1" ]]; then
  echo "GoodMotion open video is ready on the Base loopback interface."
fi
