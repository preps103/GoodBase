"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = fs.readFileSync(
  path.join(
    __dirname,
    "../migrations/20260819_rename_supplyguyz_to_goodsupply.sql"
  ),
  "utf8"
);
const runner = fs.readFileSync(
  path.join(__dirname, "../scripts/apply-goodsupply-rename-migration.js"),
  "utf8"
);

test("the legacy SupplyGuyz registry record is displayed as GoodSupply", () => {
  assert.match(migration, /UPDATE apps/);
  assert.match(migration, /name = 'GoodSupply'/);
  assert.match(migration, /WHERE id = 'supplyguyz'/);
  assert.match(migration, /updated_at = NOW\(\)/);
});

test("the GoodSupply registry rename has an idempotent production runner", () => {
  assert.match(runner, /20260819_rename_supplyguyz_to_goodsupply\.sql/);
  assert.match(runner, /before !== "GoodSupply"/);
  assert.match(runner, /after !== "GoodSupply"/);
  assert.match(runner, /pg_advisory_lock/);
});
