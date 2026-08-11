"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("production operations use canonical GoodBase paths and domains", () => {
  const sources = [
    "scripts/goodos-ha-watchdog.sh",
    "scripts/goodos-security-audit",
    "scripts/provision-operations.sh",
    "deploy/systemd/goodos-operations-check.service",
    "deploy/systemd/goodos-privacy-retention.service",
    "deploy/systemd/goodos-security-audit.service",
  ].map(read).join("\n");

  assert.doesNotMatch(sources, /GoodAppBackEnd|backend\.goodos\.app/);
  assert.match(sources, /\/var\/www\/GoodBase/);
  assert.match(sources, /base\.goodos\.app/);
});

test("HA recovery controls the actual GoodBase PM2 processes", () => {
  const watchdog = read("scripts/goodos-ha-watchdog.sh");
  assert.match(watchdog, /PRIMARY_NAME="goodbase-api"/);
  assert.match(watchdog, /SECONDARY_NAME="goodbase-api-ha"/);
  assert.match(watchdog, /127\.0\.0\.1:\$1\/health/);
  assert.match(watchdog, /api\/health\/ready/);
});

test("WAL archives are compressed while recovery remains backward compatible", () => {
  const archive = read("scripts/goodos-wal-archive");
  const drill = read("scripts/goodbase-physical-pitr-drill");
  const recovery = read("scripts/goodbase-recovery-node.sh");
  const retention = read("scripts/goodbase-enterprise-retention.sh");
  const retentionUnit = read("deploy/systemd/goodbase-backup-retention.service");

  assert.match(archive, /gzip|GZIP/);
  assert.match(archive, /-n -1 -c/);
  assert.match(drill, /gzip -t/);
  assert.match(recovery, /GZIP.*find_command/);
  assert.match(retention, /GOODBASE_BACKUP_RETENTION_DAYS:-14/);
  assert.match(retentionUnit, /GOODBASE_BACKUP_RETENTION_DAYS=14/);
});

test("operations provisioner installs every repaired timer", () => {
  const provisioner = read("scripts/provision-operations.sh");
  for (const timer of [
    "goodos-ha-watchdog.timer",
    "goodos-operations-check.timer",
    "goodos-privacy-retention.timer",
    "goodos-security-audit.timer",
    "goodvoice-state-backup.timer",
    "goodbase-backup-retention.timer",
  ]) {
    assert.match(provisioner, new RegExp(timer.replaceAll(".", "\\.")));
  }
});

test("GoodVoice state receives a bounded, checksummed daily backup", () => {
  const backup = read("scripts/goodvoice-state-backup.sh");
  const service = read("deploy/systemd/goodvoice-state-backup.service");
  const timer = read("deploy/systemd/goodvoice-state-backup.timer");

  assert.match(backup, /sha256sum/);
  assert.match(backup, /GOODVOICE_STATE_BACKUP_RETENTION_DAYS:-14/);
  assert.match(backup, /GOODVOICE_STATE_MINIMUM_BACKUPS:-2/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /\/var\/backups\/goodvoice-state/);
  assert.match(service, /\/var\/lib\/goodapp-backend/);
  assert.doesNotMatch(service, /\/var\/www\/GoodBase\/data/);
  assert.match(timer, /OnCalendar=/);
});
