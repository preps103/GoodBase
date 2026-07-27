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

test("GoodBase deployments restart both API instances and the worker", () => {
  delete require.cache[require.resolve("../src/services/site-deployment.service")];
  const deployment = require("../src/services/site-deployment.service");

  assert.deepEqual(
    deployment.pm2ProcessNamesForSite({
      name: "GoodBase",
      appPath: "/var/www/GoodBase",
      processName: "goodbase-api",
    }),
    ["goodbase-api", "goodbase-api-ha", "goodbase-worker"]
  );
  assert.deepEqual(
    deployment.pm2ProcessNamesForSite({
      name: "GoodAds",
      appPath: "/home/mgoodlo3/GoodAds",
      processName: "goodads",
    }),
    ["goodads"]
  );
});

test("deployment PM2 control is restricted to the root-owned helper", () => {
  const deploymentSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "site-deployment.service.js"),
    "utf8"
  );
  const helper = fs.readFileSync(
    path.join(__dirname, "..", "deploy", "goodos-pm2-control"),
    "utf8"
  );
  const sudoers = fs.readFileSync(
    path.join(__dirname, "..", "deploy", "goodbase-deployment-sudoers"),
    "utf8"
  );

  assert.match(deploymentSource, /PM2_CONTROL_COMMAND = "\/usr\/local\/sbin\/goodos-pm2-control"/);
  assert.match(deploymentSource, /\["-n", PM2_CONTROL_COMMAND, "discover"\]/);
  assert.match(deploymentSource, /\["-n", PM2_CONTROL_COMMAND, "restart", processName\]/);
  assert.match(helper, /case "\$\{candidate\}"/);
  assert.match(helper, /goodbase-api\|goodbase-api-ha\|goodbase-worker/);
  assert.doesNotMatch(helper, /eval|sh -c/);
  assert.match(sudoers, /^goodapp ALL=\(root\) NOPASSWD: /);
  assert.doesNotMatch(sudoers, /\/bin\/sh|\/bin\/bash/);
});
