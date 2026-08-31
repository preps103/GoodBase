"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("migrations/20260721_goodbase_phases11_15.sql");
const developerRoutes = read("src/routes/goodbase-developer-platform.routes.js");
const authRoutes = read("src/routes/goodbase-auth-product.routes.js");

test("application launcher renders every registered GoodOS application beneath Voice", () => {
  const source = read("src/public/console-voice-link.js");
  assert.match(source, /fetch\("\/api\/apps"/);
  assert.match(source, /GoodOS Voice/);
  assert.match(source, /goodos-app-launcher-list/);
  assert.doesNotMatch(source, /GoodFleet|GoodQR|GoodTrust/);
  assert.match(migration, /domain='base\.goodos\.app'/);
  assert.match(migration, /name='GoodBase'/);
});

test("Phase 11 provides single-use passwordless auth and tenant-isolated identity controls", () => {
  for (const table of ["goodbase_auth_channels", "goodbase_auth_challenges", "goodbase_auth_identities", "goodbase_passkey_credentials", "goodbase_auth_hooks", "goodbase_auth_security_policies", "goodbase_auth_events"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(authRoutes, /passwordless\/start/);
  assert.match(authRoutes, /passwordless\/verify/);
  assert.match(authRoutes, /status='consumed'/);
  assert.match(authRoutes, /max_attempts/);
  assert.match(migration, /goodbase_backend_service/);
  assert.match(migration, /'goodbase_queues','goodbase_queue_messages','goodbase_schedules'/);
});

test("Phase 12 ships a noninteractive Goodbase CLI and version-pinned local stack", () => {
  const result = spawnSync(process.execPath, [path.join(root, "bin/goodbase.js"), "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "1.0.0");
  const compose = read("deploy/local/compose.yaml");
  assert.match(compose, /postgres:17\.5-bookworm/);
  assert.match(compose, /postgrest\/postgrest:v14\.12/);
  assert.match(compose, /axllent\/mailpit:v1\.27\.8/);
});

test("Phase 13 SDK supports retries, cancellation, passwordless auth, queues, migrations, and previews", () => {
  const sdk = read("src/public/sdk/goodos.js");
  for (const feature of ["maxRetries", "AbortController", "startPasswordless", "sendQueueMessage", "validateMigration", "createPreview"]) {
    assert.match(sdk, new RegExp(feature));
  }
  const index = read("src/routes/index.js");
  assert.match(index, /public", "sdk", "goodos\.js/);
});

test("Phase 14 locks migration checksums, lint results, approvals, and drift snapshots", () => {
  for (const table of ["goodbase_migration_plans", "goodbase_migration_steps", "goodbase_schema_snapshots", "goodbase_migration_locks"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(developerRoutes, /analyzeSql/);
  assert.match(developerRoutes, /GOODBASE_PRIVILEGED_MFA_REQUIRED/);
  assert.match(developerRoutes, /checksum/);
});

test("Phase 15 models isolated resources, lifecycle limits, reconciliation, and MFA-gated promotion", () => {
  for (const table of ["goodbase_preview_environments", "goodbase_preview_resources", "goodbase_preview_events"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /database_name TEXT NOT NULL UNIQUE/);
  assert.match(migration, /credential_secret_ref TEXT NOT NULL/);
  assert.match(developerRoutes, /\/previews\/:id\/promote/);
  assert.match(read("src/services/job.service.js"), /GOODBASE_PREVIEW_PROVISIONER_URL/);
});

test("Phase 11-15 management routes require authentication, tenant context, and administrator access", () => {
  assert.match(developerRoutes, /router\.use\(authRequired, tenantContext, dataPlaneAdminRequired\)/);
  const index = read("src/routes/index.js");
  assert.match(index, /\/api\/goodbase\/v1\/developer/);
  assert.match(index, /\/api\/auth\/v3/);
});
