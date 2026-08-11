"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");

function source(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("GoodScan API is mounted at the canonical versioned path", () => {
  assert.match(source("src/routes/index.js"), /router\.use\("\/api\/goodscan\/v1", goodScanRoutes\)/);
});

test("GoodScan workspace and capture routes require authentication and application access", () => {
  const routes = source("src/routes/goodscan.routes.js");
  const authIndex = routes.indexOf("router.use(authRequired, requireGoodScanAccess)");
  const workspaceIndex = routes.indexOf('router.get("/workspace"');
  const captureIndex = routes.indexOf('router.post("/captures"');

  assert.ok(authIndex >= 0);
  assert.ok(workspaceIndex > authIndex);
  assert.ok(captureIndex > authIndex);
  assert.match(routes, /captureLimiter/);
  assert.match(routes, /maxCount: 500/);
});

test("GoodScan originals use private persistent storage and randomized filenames", () => {
  const routes = source("src/routes/goodscan.routes.js");
  assert.match(routes, /path\.join\(STORAGE_ROOT, "goodscan-captures"\)/);
  assert.match(routes, /crypto\.randomUUID\(\)/);
  assert.doesNotMatch(routes, /os\.tmpdir/);
});

test("GoodScan database migration is run before the API starts", () => {
  const server = source("src/server.js");
  const migration = source("migrations/20260810_goodscan_production_workspace.sql");
  const creditMigration = source("migrations/20260810_goodscan_credit_billing.sql");
  const migrationRunner = source("scripts/apply-goodscan-migration.js");

  assert.match(server, /runGoodScanMigrations\(\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodscan_assets/);
  assert.match(migration, /visibility = 'public' AND status = 'completed'/);
  assert.match(creditMigration, /CREATE TABLE IF NOT EXISTS goodscan_credit_accounts/);
  assert.match(migrationRunner, /20260810_goodscan_credit_billing\.sql/);
});

test("GoodScan production release serializes migrations and exposes a fail-closed readiness gate", () => {
  const migration = source("scripts/apply-goodscan-migration.js");
  const readiness = source("scripts/goodscan-production-readiness.js");
  const packageJson = JSON.parse(source("package.json"));
  assert.match(migration, /pg_advisory_lock/);
  assert.match(migration, /goodscan-production-migrations/);
  assert.match(readiness, /GOODSCAN_STRIPE_WEBHOOK_SECRET/);
  assert.match(readiness, /goodscan_credit_webhook_events/);
  assert.match(packageJson.scripts.build, /migrate:goodscan/);
  assert.equal(packageJson.scripts["readiness:goodscan"], "node scripts/goodscan-production-readiness.js");
});
