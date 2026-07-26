"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("GoodBase deployment applies the idempotent GoodAds growth migration", () => {
  const packageJson = JSON.parse(read("package.json"));
  const runner = read("scripts/apply-goodads-growth-migration.js");
  const migration = read("migrations/20260725_goodads_growth_engine.sql");

  assert.equal(packageJson.scripts.build, "node scripts/apply-goodads-growth-migration.js");
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /DATABASE_URL is required/);
  assert.match(runner, /20260725_goodads_growth_engine\.sql/);
  assert.match(runner, /if \(!hasGrowthTypes\(before\)\)/);
  assert.doesNotMatch(runner, /process\.env\.(?:DATABASE_URL|JWT_SECRET)/);
  for (const resourceType of ["funnels", "lead_forms", "leads"]) {
    assert.match(migration, new RegExp(`'${resourceType}'`));
  }
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_goodads_lead_capture_idempotency/);
});
