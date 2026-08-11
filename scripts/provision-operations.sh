#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this provisioner as root." >&2
  exit 1
fi

GOODBASE_ROOT="${GOODBASE_ROOT:-/var/www/GoodBase}"
SYSTEMD_ROOT="/etc/systemd/system"

for command_name in curl gzip install node npm openssl pm2 systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is missing: $command_name" >&2
    exit 1
  }
done

install -d -m 0700 /var/log/goodos-security /var/cache/goodos-security-audit
install -d -m 0700 /var/lib/goodos/privacy
install -d -m 0700 /var/backups/goodvoice-state
install -m 0755 "$GOODBASE_ROOT/scripts/goodos-ha-watchdog.sh" /usr/local/sbin/goodos-ha-watchdog.sh
install -m 0755 "$GOODBASE_ROOT/scripts/goodos-security-audit" /usr/local/sbin/goodos-security-audit
install -m 0755 "$GOODBASE_ROOT/scripts/goodos-wal-archive" /usr/local/sbin/goodos-wal-archive
install -m 0755 "$GOODBASE_ROOT/scripts/goodbase-enterprise-retention.sh" /usr/local/sbin/goodbase-enterprise-retention

for unit in \
  goodos-ha-watchdog.service \
  goodos-ha-watchdog.timer \
  goodos-operations-check.service \
  goodos-operations-check.timer \
  goodos-privacy-retention.service \
  goodos-privacy-retention.timer \
  goodos-security-audit.service \
  goodos-security-audit.timer \
  goodvoice-state-backup.service \
  goodvoice-state-backup.timer \
  goodbase-backup-retention.service \
  goodbase-backup-retention.timer
do
  install -m 0644 "$GOODBASE_ROOT/deploy/systemd/$unit" "$SYSTEMD_ROOT/$unit"
done

if [[ -f "$GOODBASE_ROOT/.env" ]]; then
  if ! grep -q '^GOODVOICE_PROVIDER_VAULT_KEY=.' "$GOODBASE_ROOT/.env"; then
    printf 'GOODVOICE_PROVIDER_VAULT_KEY=%s\n' "$(openssl rand -hex 32)" >>"$GOODBASE_ROOT/.env"
  fi
  if ! grep -q '^GOODOS_VOICE_SECRET=.' "$GOODBASE_ROOT/.env"; then
    printf 'GOODOS_VOICE_SECRET=%s\n' "$(openssl rand -hex 32)" >>"$GOODBASE_ROOT/.env"
  fi
  chmod 0600 "$GOODBASE_ROOT/.env"
fi

systemctl daemon-reload
systemctl enable --now \
  goodos-ha-watchdog.timer \
  goodos-operations-check.timer \
  goodos-privacy-retention.timer \
  goodos-security-audit.timer \
  goodvoice-state-backup.timer \
  goodbase-backup-retention.timer

systemctl reset-failed \
  goodos-ha-watchdog.service \
  goodos-operations-check.service \
  goodos-privacy-retention.service \
  goodos-security-audit.service \
  goodvoice-state-backup.service || true

echo "GoodBase production operations services are provisioned."
