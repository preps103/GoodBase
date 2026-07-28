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

test("canonical deployment mappings include every product and platform service", () => {
  delete require.cache[require.resolve("../src/services/site-deployment.service")];
  const deployment = require("../src/services/site-deployment.service");
  const sites = deployment.canonicalDeploymentSites();

  assert.equal(sites.length, 17);
  assert.equal(new Set(sites.map((site) => site.appId)).size, 17);
  assert.deepEqual(
    sites.find((site) => site.appId === "goodvoice"),
    {
      appId: "goodvoice",
      name: "GoodVoice",
      domain: "voice.goodos.app",
      repositoryUrl: "git@github.com:preps103/GoodVoice-v1.3.git",
      appPath: "/home/mgoodlo3/GoodVoice",
      processName: "goodvoice",
      branch: "main",
      processManager: "pm2",
      healthUrl: "https://voice.goodos.app",
    }
  );
  assert.equal(
    sites.find((site) => site.appId === "goodbuilder").appPath,
    "/home/mgoodlo3/GoodBuilder"
  );
  assert.equal(
    sites.find((site) => site.appId === "goodcustoms").domain,
    "custom.goodos.app"
  );
});

test("PM2 discovery separates the live runtime folder from the deployment source folder", async (context) => {
  const childProcess = require("node:child_process");
  const originalSpawn = childProcess.spawn;

  childProcess.spawn = (_command, _args, _options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit(
        "data",
        JSON.stringify([
          {
            name: "goodads",
            pid: 123,
            pm2_env: {
              status: "online",
              pm_cwd: "/home/mgoodlo3/GoodAds/dist",
              env: {},
            },
          },
        ])
      );
      child.emit("close", 0, null);
    });
    return child;
  };

  context.after(() => {
    childProcess.spawn = originalSpawn;
  });

  delete require.cache[require.resolve("../src/services/site-deployment.service")];
  const deployment = require("../src/services/site-deployment.service");
  const targets = await deployment.discoverServerApps();

  assert.equal(targets.length, 1);
  assert.equal(targets[0].runtimePath, "/home/mgoodlo3/GoodAds/dist");
  assert.equal(targets[0].deploymentPath, "/home/mgoodlo3/GoodAds");
  assert.equal(targets[0].appPath, "/home/mgoodlo3/GoodAds");
  assert.equal(
    targets[0].repositoryUrl,
    "git@github.com:preps103/GoodAds-v1.2.git"
  );
});

test("non-GoodBase applications use build-first staged releases with rollback copies", () => {
  const service = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "site-deployment.service.js"),
    "utf8"
  );
  const routes = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "update-sites.routes.js"),
    "utf8"
  );
  const page = fs.readFileSync(
    path.join(__dirname, "..", "src", "public", "update-sites.js"),
    "utf8"
  );
  const provisioning = fs.readFileSync(
    path.join(__dirname, "..", "deploy", "provision-update-sites-access.sh"),
    "utf8"
  );

  assert.match(service, /executeStagedRelease/);
  assert.match(service, /Using a staged release/);
  assert.match(service, /"rsync"/);
  assert.match(service, /"--delete"/);
  assert.match(service, /copyPreservedRuntimeState/);
  assert.match(service, /restoreStagedBackup/);
  assert.match(routes, /reconcileCanonicalDeploymentSites/);
  assert.match(routes, /Staged release \(the live folder is replaced only after a successful build\)/);
  assert.match(page, /target\?\.deploymentPath \|\| target\?\.appPath \|\| site\.appPath/);
  assert.match(page, /site\.configuration\?\.ready/);
  assert.match(provisioning, /setfacl -m "u:\$\{deployment_user\}:--x"/);
  assert.match(provisioning, /"d:u:\$\{deployment_user\}:rwx"/);
  assert.doesNotMatch(provisioning, /chown -R|chmod -R/);
  assert.match(provisioning, /\/home\/mgoodlo3\/GoodVoice/);
  assert.match(provisioning, /\/var\/www\/GoodID/);
});

test("GoodBase self-deployment recovery is lock-protected and owner-controlled", () => {
  const routes = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "update-sites.routes.js"),
    "utf8"
  );
  const page = fs.readFileSync(
    path.join(__dirname, "..", "src", "public", "update-sites.js"),
    "utf8"
  );
  const restart = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "restart-goodbase-services.js"),
    "utf8"
  );

  assert.match(routes, /router\.use\(authRequired\)/);
  assert.match(routes, /router\.use\(requireOwnerOrAdmin\)/);
  assert.match(routes, /pg_try_advisory_lock/);
  assert.match(routes, /DEPLOYMENT_WORKER_ACTIVE/);
  assert.match(routes, /REGISTERED_SITE_DELETE_BLOCKED/);
  assert.match(routes, /isTemporaryGoodBaseRecoverySite/);
  assert.match(routes, /site\.name === "GoodBase Recovery"/);
  assert.match(routes, /site\.domain === "base\.goodos\.app"/);
  assert.match(routes, /site\.processName === "goodbase-api-ha"/);
  assert.match(routes, /git@github\.com:preps103\/GoodBase\.git/);
  assert.match(routes, /restart-goodbase-services/);
  assert.match(page, /Recover Stale Run/);
  assert.match(page, /Restart Services/);
  assert.match(page, /Remove Mapping/);
  assert.match(page, /isTemporaryGoodBaseRecoverySite\(site\)/);
  assert.match(
    restart,
    /PROCESSES = \["goodbase-worker", "goodbase-api-ha", "goodbase-api"\]/
  );
});
