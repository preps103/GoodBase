"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = fs.readFileSync(
  path.join(
    __dirname,
    "../migrations/20260731_goodos_application_registry_sites_expansion.sql"
  ),
  "utf8"
);

const expectedApps = [
  ["goodmac", "GoodMac", "mac.goodos.app"],
  ["goodtrading", "GoodTrading", "trading.goodos.app"],
  ["supplyguyz", "SupplyGuyz", "supplyguyz.goodos.app"],
];

test("GoodBase registers the three Sites-hosted GoodOS applications", () => {
  for (const [id, name, domain] of expectedApps) {
    assert.match(migration, new RegExp(`'${id}'`));
    assert.match(migration, new RegExp(`'${name}'`));
    assert.match(
      migration,
      new RegExp(`'${domain.replaceAll(".", "\\.")}'`)
    );
  }

  assert.match(migration, /ON CONFLICT \(id\) DO UPDATE SET/);
});

test("active GoodOS accounts receive full memberships for every added application", () => {
  for (const [id] of expectedApps) {
    assert.match(migration, new RegExp(`\\('${id}'\\)`));
  }

  assert.match(migration, /LOWER\(users\.email\) LIKE '%@goodos\.app'/);
  assert.match(migration, /users\.status = 'active'/);
  assert.match(migration, /users\.platform_role = 'owner' THEN 'owner'/);
  assert.match(migration, /ELSE 'admin'/);
  assert.match(migration, /ON CONFLICT \(user_id, app_id\) DO UPDATE SET/);
});
