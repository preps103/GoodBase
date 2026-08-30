const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PRODUCTION_ROOT = "/var/www/GoodBase";
const SSHD_CONFIG = "/etc/ssh/sshd_config";
const SSHD_BINARY = "/usr/sbin/sshd";
const SYSTEMCTL_BINARY = "/usr/bin/systemctl";
const DROP_IN = "/etc/ssh/sshd_config.d/99-goodbase-backup.conf";
const DROP_IN_CONTENT = [
  "# Managed by GoodBase for resilient off-site backups.",
  "Port 22",
  "Port 2222",
  "",
].join("\n");

function restoreDropIn(fsImpl, dropInPath, previousContent) {
  if (previousContent === null) {
    fsImpl.rmSync(dropInPath, { force: true });
    return;
  }

  const rollbackPath = `${dropInPath}.${process.pid}.rollback`;
  fsImpl.writeFileSync(rollbackPath, previousContent, { mode: 0o644 });
  fsImpl.renameSync(rollbackPath, dropInPath);
}

function ensureBackupSshPort(options = {}) {
  const fsImpl = options.fs || fs;
  const run = options.execFileSync || execFileSync;
  const platform = options.platform || process.platform;
  const getuid = options.getuid || process.getuid;
  const runtimeRoot = path.resolve(
    options.runtimeRoot || path.join(__dirname, "..", ".."),
  );
  const paths = {
    productionRoot: PRODUCTION_ROOT,
    sshdConfig: SSHD_CONFIG,
    sshdBinary: SSHD_BINARY,
    systemctlBinary: SYSTEMCTL_BINARY,
    dropIn: DROP_IN,
    ...options.paths,
  };

  if (
    platform !== "linux" ||
    typeof getuid !== "function" ||
    getuid() !== 0 ||
    runtimeRoot !== paths.productionRoot
  ) {
    return { status: "skipped", reason: "not-goodbase-production-root" };
  }

  if (!fsImpl.existsSync(paths.sshdConfig) || !fsImpl.existsSync(paths.sshdBinary)) {
    return { status: "skipped", reason: "openssh-server-unavailable" };
  }

  const previousContent = fsImpl.existsSync(paths.dropIn)
    ? fsImpl.readFileSync(paths.dropIn, "utf8")
    : null;

  if (previousContent === DROP_IN_CONTENT) {
    return { status: "ready", port: 2222 };
  }

  fsImpl.mkdirSync(path.dirname(paths.dropIn), { recursive: true, mode: 0o755 });
  const temporaryPath = `${paths.dropIn}.${process.pid}.tmp`;

  try {
    fsImpl.writeFileSync(temporaryPath, DROP_IN_CONTENT, { mode: 0o644 });
    fsImpl.renameSync(temporaryPath, paths.dropIn);
    run(paths.sshdBinary, ["-t"], { stdio: "pipe" });
    run(paths.systemctlBinary, ["reload", "ssh"], { stdio: "pipe" });
    return { status: "configured", port: 2222 };
  } catch (error) {
    fsImpl.rmSync(temporaryPath, { force: true });
    restoreDropIn(fsImpl, paths.dropIn, previousContent);

    try {
      run(paths.sshdBinary, ["-t"], { stdio: "pipe" });
      run(paths.systemctlBinary, ["reload", "ssh"], { stdio: "pipe" });
    } catch {
      // Preserve the original failure while leaving the prior configuration restored.
    }

    throw error;
  }
}

module.exports = {
  DROP_IN_CONTENT,
  PRODUCTION_ROOT,
  ensureBackupSshPort,
};
