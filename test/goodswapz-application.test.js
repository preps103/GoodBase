"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodSwapz imports legacy listings without changing their ownership boundary", () => {
  const migration = read("migrations/20260726_goodswapz_marketplace_handoff.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodswapz_marketplace_listings/);
  assert.match(migration, /FROM goodswapz_listings AS legacy/);
  assert.match(migration, /ROUND\(legacy\.price \* 100\)::bigint/);
  assert.doesNotMatch(migration, /ALTER TABLE goodswapz_listings/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodswapz_handoffs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodswapz_handoff_steps/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodswapz_escrow_webhook_events/);
  assert.match(migration, /'goodswapz'/);
});

test("GoodSwapz routes enforce identity, tenant, entitlement, and MFA boundaries", () => {
  const route = read("src/routes/goodswapz.routes.js");
  const index = read("src/routes/index.js");
  assert.match(index, /router\.use\("\/api\/swapz\/v1", goodswapzRoutes\)/);
  assert.match(route, /router\.use\(authRequired, tenantContext, requireGoodSwapzAccess\)/);
  assert.match(route, /GOODSWAPZ_ACCESS_REQUIRED/);
  assert.match(route, /GOODSWAPZ_ADMIN_REQUIRED/);
  assert.match(route, /MFA_VERIFICATION_REQUIRED/);
  assert.match(route, /X-GoodEscrow-Signature/);
  assert.match(route, /Idempotency-Key/);
  assert.doesNotMatch(route, /req\.body\?\.userId/);
});

test("GoodSwapz handoffs reject credential exchange and require verified participants", () => {
  const service = read("src/services/goodswapz.service.js");
  assert.match(service, /SECRET_CONTENT_REJECTED/);
  assert.match(service, /GOODSWAPZ_IDENTITY_VERIFICATION_REQUIRED/);
  assert.match(service, /requireApprovedIdentity/);
  assert.match(service, /Complete the earlier required steps first/);
  assert.match(service, /timingSafeEqual/);
  assert.match(service, /aes-256-gcm/);
  assert.match(service, /appId: APP_ID/);
});
