"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodFleet marketplace schema preserves host, guest, listing, and trip ownership", () => {
  const migration = read("migrations/20260729_goodfleet_marketplace_v1.sql");
  for (const table of [
    "fleet_host_profiles",
    "fleet_vehicle_listings",
    "fleet_booking_additional_drivers",
    "fleet_booking_change_requests",
    "fleet_trip_conversations",
    "fleet_trip_messages",
    "fleet_trip_message_reads",
    "fleet_trip_message_reports",
    "fleet_trip_reviews",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /ADD COLUMN IF NOT EXISTS guest_user_id/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS listing_id/);
  assert.match(migration, /UNIQUE \(organization_id, booking_id\)/);
  assert.match(migration, /UNIQUE \(organization_id, sender_user_id, client_message_id\)/);
  assert.match(migration, /fleet_trip_messages_scheduled_idx/);
  assert.match(migration, /CHECK \(operator_managed OR host_profile_id IS NOT NULL\)/);
  assert.match(migration, /TO goodapp_backend_user/);
});

test("Marketplace routes are mounted before the employee-only Fleet catch-all", () => {
  const index = read("src/routes/index.js");
  const marketplaceMount = index.indexOf(
    'router.use("/api/fleet/v1/marketplace", fleetMarketplaceRoutes)',
  );
  const fleetMount = index.indexOf('router.use("/api/fleet/v1", fleetRoutes)');
  assert.ok(marketplaceMount >= 0);
  assert.ok(fleetMount > marketplaceMount);
});

test("Guest booking is server-priced, owner-scoped, serialized, and does not require ID", () => {
  const routes = read("src/routes/fleet-marketplace.routes.js");
  assert.match(routes, /requireGuestMember/);
  assert.match(routes, /router\.use\(\["\/profile", "\/quote", "\/reservations"\], requireGuestMember\)/);
  assert.match(routes, /pg_advisory_xact_lock/);
  assert.match(routes, /FOR UPDATE OF listing,vehicle/);
  assert.match(routes, /VEHICLE_NOT_AVAILABLE/);
  assert.match(routes, /vehicle_id,guest_user_id,/);
  assert.match(routes, /request\.user\.id/);
  assert.match(routes, /priceQuote\(client, listing/);
  assert.doesNotMatch(
    routes.slice(
      routes.indexOf('router.post("/reservations"'),
      routes.indexOf('router.get("/reservations"'),
    ),
    /license_verification_status !== "verified"/,
  );
});

test("Public marketplace inventory fails closed on compliance and active conflicts", () => {
  const routes = read("src/routes/fleet-public.routes.js");
  assert.match(routes, /listing\.status='active'/);
  assert.match(routes, /host\.identity_verification_status='verified'/);
  assert.match(routes, /vehicle\.registration_expiry IS NOT NULL/);
  assert.match(routes, /vehicle\.insurance_expiry IS NOT NULL/);
  assert.match(routes, /vehicle\.registration_expiry >= \$3::date/);
  assert.match(routes, /vehicle\.insurance_expiry >= \$3::date/);
  assert.match(routes, /NOT EXISTS/);
  assert.match(routes, /booking\.status=ANY/);
});

test("Host onboarding requires employee identity and vehicle compliance review", () => {
  const routes = read("src/routes/fleet-marketplace.routes.js");
  assert.match(routes, /router\.get\("\/admin\/hosts", requireEmployee/);
  assert.match(routes, /\/admin\/hosts\/:hostId\/identity-review/);
  assert.match(routes, /marketplace\.host\.identity_\$\{status\}/);
  assert.match(routes, /HOST_IDENTITY_REQUIRED/);
  assert.match(routes, /VEHICLE_COMPLIANCE_REQUIRED/);
  assert.match(routes, /\/admin\/listings\/:listingId\/review/);
  assert.match(routes, /listing\.status='pending_review'/);
  assert.match(routes, /marketplace\.listing\.\$\{status\}/);
});

test("Host and guest messaging is trip-scoped, private, auditable, and idempotent", () => {
  const routes = read("src/routes/fleet-marketplace.routes.js");
  const worker = read("src/services/fleet-marketplace-message.service.js");
  assert.match(routes, /conversation\.guest_user_id === request\.user\.id/);
  assert.match(routes, /conversation\.host_user_id === request\.user\.id/);
  assert.match(routes, /EMPLOYEE_ROLES\.has\(role\)/);
  assert.match(routes, /CONVERSATION_CLOSED/);
  assert.match(routes, /client_message_id/);
  assert.match(routes, /Idempotency-Key/);
  assert.match(routes, /marketplace\.message\.sent/);
  assert.match(routes, /marketplace\.message\.scheduled/);
  assert.match(routes, /marketplace\.message\.reported/);
  assert.match(routes, /CANNOT_REPORT_OWN_MESSAGE/);
  assert.match(routes, /fleet_trip_message_reads/);
  assert.match(routes, /Only hosts and staff can schedule a future message/);
  assert.match(routes, /\/host\/messages\?booking=/);
  assert.match(routes, /\/account\/messages\?booking=/);
  assert.match(worker, /FOR UPDATE SKIP LOCKED/);
  assert.match(worker, /delivered_at=NOW\(\)/);
  assert.match(worker, /fleet\.marketplace\.message_scheduled/);
});

test("Guest checkout only accepts an owned booking and stays disabled without Stripe keys", () => {
  const routes = read("src/routes/fleet-payments.routes.js");
  assert.match(routes, /"\/customer-capability"/);
  assert.match(routes, /"\/customer-checkout-sessions"/);
  assert.match(routes, /requirePaymentCustomer/);
  assert.match(routes, /booking\.guest_user_id === request\.user\.id/);
  assert.match(routes, /AND user_id=\$3/);
  assert.match(routes, /PAYMENTS_NOT_ACTIVATED/);
  assert.match(routes, /requiredIdempotencyKey/);
  assert.match(routes, /success_url/);
  assert.match(routes, /cancel_url/);
});

test("Production build applies and verifies the GoodFleet marketplace migration", () => {
  const packageJson = JSON.parse(read("package.json"));
  const runner = read("scripts/apply-goodfleet-marketplace-migration.js");
  assert.match(
    packageJson.scripts.build,
    /node scripts\/apply-goodfleet-marketplace-migration\.js/,
  );
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /DATABASE_URL is required/);
  assert.match(runner, /20260729_goodfleet_marketplace_v1\.sql/);
  assert.match(runner, /guest_booking_owner/);
  assert.match(runner, /if \(!ready\(before\)\)/);
  assert.doesNotMatch(runner, /process\.env\.(?:DATABASE_URL|JWT_SECRET)/);
});
