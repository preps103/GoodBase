"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = fs.readFileSync(
  path.join(__dirname, "..", "migrations", "20260725_gpanel_application.sql"),
  "utf8",
);

test("registers GPanel for application-scoped notifications", () => {
  assert.match(migration, /'gpanel'/);
  assert.match(migration, /'panel\.goodos\.app'/);
  assert.match(migration, /INSERT INTO apps/);
  assert.match(migration, /INSERT INTO app_memberships/);
  assert.match(migration, /platform_role = 'owner'/);
  assert.match(migration, /ON CONFLICT \(user_id, app_id\) DO UPDATE/);
});
