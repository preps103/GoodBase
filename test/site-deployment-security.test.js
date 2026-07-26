"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

test("deployment commands scope Git safe.directory to the selected application", async (context) => {
  const childProcess = require("node:child_process");
  const originalSpawn = childProcess.spawn;
  let invocation;

  childProcess.spawn = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => child.emit("close", 0, null));
    return child;
  };

  context.after(() => {
    childProcess.spawn = originalSpawn;
  });

  delete require.cache[require.resolve("../src/services/site-deployment.service")];
  const deployment = require("../src/services/site-deployment.service");
  await deployment.runCommand("git", ["status", "--short"], {
    cwd: "/var/www/GoodBase",
  });

  assert.equal(invocation.command, "git");
  assert.deepEqual(invocation.args.slice(0, 2), [
    "-c",
    "safe.directory=/var/www/GoodBase",
  ]);
  assert.deepEqual(invocation.args.slice(2), ["status", "--short"]);
});

test("deployment npm commands use the guarded deployment cache", () => {
  const deploymentSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "site-deployment.service.js"),
    "utf8"
  );

  assert.match(
    deploymentSource,
    /NPM_CACHE_ROOT = path\.join\(BACKUP_ROOT, "npm-cache"\)/
  );
  assert.match(
    deploymentSource,
    /env: \{ NPM_CONFIG_CACHE: NPM_CACHE_ROOT \}/
  );
  assert.doesNotMatch(deploymentSource, /\/root\/\.npm/);
});
