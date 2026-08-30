const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DROP_IN_CONTENT,
  PRODUCTION_ROOT,
  ensureBackupSshPort,
} = require("../src/runtime/backup-ssh-port");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goodbase-ssh-port-"));
  const etc = path.join(root, "etc");
  const sshdConfig = path.join(etc, "ssh", "sshd_config");
  const sshdBinary = path.join(root, "usr", "sbin", "sshd");
  const systemctlBinary = path.join(root, "usr", "bin", "systemctl");
  const dropIn = path.join(etc, "ssh", "sshd_config.d", "99-goodbase-backup.conf");

  fs.mkdirSync(path.dirname(sshdConfig), { recursive: true });
  fs.mkdirSync(path.dirname(sshdBinary), { recursive: true });
  fs.mkdirSync(path.dirname(systemctlBinary), { recursive: true });
  fs.writeFileSync(sshdConfig, "Include /etc/ssh/sshd_config.d/*.conf\n");
  fs.writeFileSync(sshdBinary, "");
  fs.writeFileSync(systemctlBinary, "");

  return {
    root,
    paths: {
      productionRoot: PRODUCTION_ROOT,
      sshdConfig,
      sshdBinary,
      systemctlBinary,
      dropIn,
    },
  };
}

test("backup SSH configuration is gated to the GoodBase production process", () => {
  const result = ensureBackupSshPort({
    platform: "darwin",
    getuid: () => 501,
    cwd: "/tmp/GoodBase",
  });

  assert.deepEqual(result, {
    status: "skipped",
    reason: "not-goodbase-production-root",
  });
});

test("backup SSH configuration rejects a root process outside the production checkout", () => {
  const result = ensureBackupSshPort({
    platform: "linux",
    getuid: () => 0,
    runtimeRoot: "/root/GoodBase",
  });

  assert.deepEqual(result, {
    status: "skipped",
    reason: "not-goodbase-production-root",
  });
});

test("backup SSH configuration preserves port 22 and adds port 2222", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const calls = [];

  const result = ensureBackupSshPort({
    platform: "linux",
    getuid: () => 0,
    runtimeRoot: PRODUCTION_ROOT,
    paths: fixture.paths,
    execFileSync: (file, args) => calls.push([file, args]),
  });

  assert.deepEqual(result, { status: "configured", port: 2222 });
  assert.equal(fs.readFileSync(fixture.paths.dropIn, "utf8"), DROP_IN_CONTENT);
  assert.deepEqual(calls, [
    [fixture.paths.sshdBinary, ["-t"]],
    [fixture.paths.systemctlBinary, ["reload", "ssh"]],
  ]);
});

test("invalid SSH configuration is rolled back before the error is reported", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const previousContent = "Port 22\n";
  fs.mkdirSync(path.dirname(fixture.paths.dropIn), { recursive: true });
  fs.writeFileSync(fixture.paths.dropIn, previousContent);
  let callCount = 0;

  assert.throws(
    () =>
      ensureBackupSshPort({
        platform: "linux",
        getuid: () => 0,
        runtimeRoot: PRODUCTION_ROOT,
        paths: fixture.paths,
        execFileSync: () => {
          callCount += 1;
          if (callCount === 1) throw new Error("invalid sshd configuration");
        },
      }),
    /invalid sshd configuration/,
  );

  assert.equal(fs.readFileSync(fixture.paths.dropIn, "utf8"), previousContent);
  assert.equal(callCount, 3);
});

test("backup SSH configuration is independent of the process-manager cwd", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = ensureBackupSshPort({
    platform: "linux",
    getuid: () => 0,
    cwd: "/root",
    runtimeRoot: PRODUCTION_ROOT,
    paths: fixture.paths,
    execFileSync: () => {},
  });

  assert.deepEqual(result, { status: "configured", port: 2222 });
});
