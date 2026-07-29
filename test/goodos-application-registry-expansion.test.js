"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = fs.readFileSync(
  path.join(__dirname, "../migrations/20260726_goodos_application_registry_expansion.sql"),
  "utf8"
);

const expectedApps = [
  ["gearheadracing", "GearHead Racing", "gearhead.goodos.app"],
  ["buyblack", "BuyBlack", "buyblack.goodos.app"],
  ["goodsure", "GoodSure", "sure.goodos.app"],
  ["gpanel", "GoodPanel", "panel.goodos.app"],
  ["goodbuilder", "GoodBuilder", "builder.goodos.app"],
];

test("GoodBase registers the five additional GoodOS applications", () => {
  for (const [id, name, domain] of expectedApps) {
    assert.match(migration, new RegExp(`'${id}'`));
    assert.match(migration, new RegExp(`'${name}'`));
    assert.match(migration, new RegExp(`'${domain.replaceAll(".", "\\.")}'`));
  }
  assert.match(migration, /ON CONFLICT \(id\) DO UPDATE SET/);
});

test("active platform owners receive active memberships for every added application", () => {
  for (const [id] of expectedApps) {
    assert.match(migration, new RegExp(`\\('${id}'\\)`));
  }
  assert.match(migration, /users\.platform_role = 'owner'/);
  assert.match(migration, /users\.status = 'active'/);
  assert.match(migration, /ON CONFLICT \(user_id, app_id\) DO UPDATE SET/);
});
