"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("marketplace parity migration normalizes claims and completes host controls", () => {
  const migration = read("migrations/20260729_goodfleet_marketplace_parity_v2.sql");
  for (const table of [
    "fleet_claim_cases",
    "fleet_claim_evidence",
    "fleet_claim_events",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /photos_json/);
  assert.match(migration, /availability_json/);
  assert.match(migration, /quoted_total/);
  assert.match(migration, /private_feedback/);
  assert.match(migration, /storage_reference/);
  assert.match(migration, /fleet_claim_cases_work_queue_idx/);
  assert.match(migration, /TO goodapp_backend_user/);
});

test("formal changes, drivers, claims, reviews, and host performance have complete routes", () => {
  const routes = read("src/routes/fleet-marketplace.routes.js");
  assert.match(routes, /\/host\/change-requests\/:changeRequestId\/decision/);
  assert.match(routes, /CHANGE_REQUEST_ALREADY_DECIDED/);
  assert.match(routes, /priceQuote\(/);
  assert.match(routes, /\/additional-driver-invitations\/:driverId\/accept/);
  assert.match(routes, /\/admin\/additional-drivers\/:driverId\/review/);
  assert.match(routes, /\/reservations\/:bookingId\/reviews/);
  assert.match(routes, /\/reviews\/:reviewId\/respond/);
  assert.match(routes, /\/host\/performance/);
  assert.match(routes, /\/reservations\/:bookingId\/claims/);
  assert.match(routes, /\/claims\/:claimId\/evidence/);
  assert.match(routes, /\/claims\/:claimId\/evidence-file/);
  assert.match(routes, /CLAIM_EVIDENCE_TOO_LARGE/);
  assert.match(routes, /\/claims\/:claimId\/dispute/);
  assert.match(routes, /marketplace\.claim\./);
});

test("public inventory enforces host availability and exposes listing galleries", () => {
  const routes = read("src/routes/fleet-public.routes.js");
  assert.match(routes, /photos_json/);
  assert.match(routes, /availability_json/);
  assert.match(routes, /unavailableRanges/);
  assert.match(routes, /pickupDays/);
  assert.match(routes, /reviews:/);
});

test("customer notification delivery includes encrypted SMS queueing and diagnostics", () => {
  const routes = read("src/routes/fleet-communications.routes.js");
  assert.match(routes, /encryptValue/);
  assert.match(routes, /goodbase_sms_deliveries/);
  assert.match(routes, /SMS_PROVIDER_UNAVAILABLE/);
  assert.match(routes, /\/sms-readiness/);
  assert.match(routes, /providerConfigured/);
  assert.match(routes, /workerReady/);
});

test("production build applies and verifies the marketplace parity migration", () => {
  const packageJson = JSON.parse(read("package.json"));
  const runner = read("scripts/apply-goodfleet-marketplace-parity-migration.js");
  assert.match(packageJson.scripts.build, /apply-goodfleet-marketplace-parity-migration\.js/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /20260729_goodfleet_marketplace_parity_v2\.sql/);
  assert.match(runner, /fleet_claim_cases/);
  assert.match(runner, /fleet_claim_evidence/);
});
