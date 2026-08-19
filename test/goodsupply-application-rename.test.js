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

test("the legacy SupplyGuyz registry record is displayed as GoodSupply", () => {
  assert.match(migration, /UPDATE apps/);
  assert.match(migration, /name = 'GoodSupply'/);
  assert.match(migration, /WHERE id = 'supplyguyz'/);
  assert.match(migration, /updated_at = NOW\(\)/);
});
