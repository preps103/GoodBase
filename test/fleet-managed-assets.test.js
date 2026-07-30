"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodFleet managed assets are tenant scoped, validated, private, and audited", () => {
  const migration = read("migrations/20260729_goodfleet_managed_assets_v1.sql");
  const routes = read("src/routes/fleet-assets.routes.js");
  const index = read("src/routes/index.js");
  const runner = read("scripts/apply-goodfleet-managed-assets-migration.js");
  const packageJson = read("package.json");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_managed_assets/);
  assert.match(migration, /checksum_sha256 char\(64\) NOT NULL/);
  assert.match(migration, /size_bytes bigint NOT NULL CHECK/);
  assert.match(migration, /'vehicle_image'/);
  assert.match(migration, /'expense_receipt'/);
  assert.match(migration, /'vehicle', 'expense'/);
  assert.match(routes, /router\.use\(authRequired, tenantContext, requireEmployee\)/);
  assert.match(routes, /Use a JPEG, PNG, WebP, or PDF file/);
  assert.match(routes, /Cache-Control", "private, no-store"/);
  assert.match(routes, /asset\.uploaded/);
  assert.match(routes, /asset\.deleted/);
  assert.match(index, /"\/api\/fleet\/v1\/assets", fleetAssetsRoutes/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /vehicle_images/);
  assert.match(packageJson, /apply-goodfleet-managed-assets-migration\.js/);
});
