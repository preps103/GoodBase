"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodBase deployment grants Ryan and Marissa verified manager access", () => {
  const packageJson = JSON.parse(read("package.json"));
  const runner = read("scripts/apply-manager-testers-access-migration.js");
  const migration = read("migrations/20260727_manager_testers_access.sql");

  assert.match(
    packageJson.scripts.build,
    /node scripts\/apply-manager-testers-access-migration\.js/
  );
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /DATABASE_URL is required/);
  assert.match(runner, /20260727_manager_testers_access\.sql/);
  assert.match(runner, /manager_memberships/);
  assert.match(runner, /active_manager_roles/);
  assert.match(runner, /password_configured/);
  assert.match(runner, /provisionMissingAccounts/);
  assert.match(runner, /requiresPasswordReset/);
  assert.match(runner, /crypto\.randomBytes/);
  assert.match(runner, /bcrypt\.hash/);
  assert.match(runner, /transactionBody/);
  assert.doesNotMatch(runner, /process\.env\.(?:DATABASE_URL|JWT_SECRET)/);

  for (const email of ["ryan@goodos.app", "marissa@goodos.app"]) {
    assert.match(migration, new RegExp(email.replace(".", "\\."), "i"));
  }
  assert.match(migration, /platform_role = 'admin'/);
  assert.match(migration, /'accessLevel', 'manager'/);
  assert.match(migration, /role = 'admin'/);
  assert.match(migration, /role_name = 'manager'/);
  assert.match(migration, /application\.status = 'active'/);
  assert.match(migration, /email_verified = TRUE/);
  assert.match(migration, /failed_login_count = 0/);
  assert.match(migration, /UPDATE sessions/);
  assert.match(migration, /status = 'revoked'/);
  assert.doesNotMatch(migration, /SET platform_role = 'owner'/);
});
