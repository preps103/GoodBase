"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodBase deployment applies and verifies the GoodSwapz handoff migration", () => {
  const packageJson = JSON.parse(read("package.json"));
  const runner = read("scripts/apply-goodswapz-marketplace-migration.js");

  assert.match(
    packageJson.scripts.build,
    /node scripts\/apply-goodswapz-marketplace-migration\.js$/
  );
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /DATABASE_URL is required/);
  assert.match(runner, /20260726_goodswapz_marketplace_handoff\.sql/);
  assert.match(runner, /organization_scope/);
  assert.match(runner, /integer_money/);
  assert.match(runner, /if \(!ready\(before\)\)/);
  assert.doesNotMatch(runner, /process\.env\.(?:DATABASE_URL|JWT_SECRET)/);
});
