"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("Fleet API is authenticated, tenant scoped, and mounted at a versioned path", () => {
  const routes = read("src/routes/fleet.routes.js");
  const index = read("src/routes/index.js");
  assert.match(routes, /router\.use\(authRequired, tenantContext\)/);
  assert.match(routes, /router\.use\(requireEmployee\)/);
  assert.match(routes, /EMPLOYEE_ACCESS_REQUIRED/);
  assert.match(routes, /request\.tenantContext\.organizationId/);
  assert.match(index, /router\.use\("\/api\/fleet\/v1", fleetRoutes\)/);
  assert.ok(
    index.indexOf('router.use("/api/fleet/v1/communications", fleetCommunicationsRoutes)') <
      index.indexOf('router.use("/api/fleet/v1", fleetRoutes)'),
    "customer and payment subroutes must be mounted before the employee-only catch-all route"
  );
  assert.ok(
    index.indexOf('router.use("/api/fleet/v1/payments", fleetPaymentsRoutes)') <
      index.indexOf('router.use("/api/fleet/v1", fleetRoutes)'),
    "payment subroutes must not be intercepted by the employee-only catch-all route"
  );
});

test("Fleet booking creation serializes by tenant and vehicle", () => {
  const routes = read("src/routes/fleet.routes.js");
  assert.match(routes, /pg_advisory_xact_lock/);
  assert.match(routes, /FOR UPDATE/);
  assert.match(routes, /VEHICLE_NOT_AVAILABLE/);
});

test("Fleet schema enforces tenant uniqueness, compliance, and buffered booking exclusion", () => {
  const migration = read("migrations/20260722_goodfleet_core_v1.sql");
  assert.match(migration, /UNIQUE \(organization_id, vin\)/);
  assert.match(migration, /UNIQUE \(organization_id, license_plate\)/);
  assert.match(migration, /tsrange\(/);
  assert.match(migration, /pickup_at AT TIME ZONE 'UTC'\) - interval '2 hours'/);
  assert.match(migration, /return_at AT TIME ZONE 'UTC'\) \+ interval '2 hours'/);
  assert.match(migration, /EXCLUDE USING gist/);
  assert.match(migration, /fleet_audit_events/);
});

test("Fleet v2 persists operational workspace state and supports durable core edits", () => {
  const routes = read("src/routes/fleet.routes.js");
  const migration = read("migrations/20260726_goodfleet_readiness_v2.sql");
  assert.match(routes, /router\.put\("\/workspace"/);
  assert.match(routes, /WORKSPACE_VERSION_CONFLICT/);
  assert.match(routes, /MAX_WORKSPACE_BYTES/);
  assert.match(routes, /router\.patch\("\/vehicles\/:vehicleId"/);
  assert.match(routes, /router\.patch\("\/customers\/:customerId"/);
  assert.match(routes, /router\.patch\("\/bookings\/:bookingId"/);
  assert.match(routes, /router\.delete\("\/vehicles\/:vehicleId"/);
  assert.match(routes, /router\.post\("\/staff\/invitations"/);
  assert.match(routes, /router\.patch\("\/staff\/:userId"/);
  assert.match(routes, /router\.delete\("\/staff\/:userId"/);
  assert.match(routes, /inviteTeamMemberForUser/);
  assert.match(routes, /updateTeamMemberForUser/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_workspace_state/);
  assert.match(migration, /archived_at/);
  assert.match(migration, /fleet_bookings_organization_id_id_v2_key/);
});

test("Fleet payment boundary is mounted but fails closed until processing is activated", () => {
  const routes = read("src/routes/fleet-payments.routes.js");
  const index = read("src/routes/index.js");
  const migration = read("migrations/20260726_goodfleet_readiness_v2.sql");
  assert.match(routes, /router\.use\(authRequired, tenantContext\)/);
  assert.match(routes, /PAYMENTS_NOT_ACTIVATED/);
  assert.match(routes, /acceptingPayments: false/);
  assert.match(routes, /STRIPE_WEBHOOK_SECRET/);
  assert.match(index, /router\.use\("\/api\/fleet\/v1\/payments", fleetPaymentsRoutes\)/);
  assert.match(migration, /fleet_payment_operations/);
  assert.match(migration, /fleet_payment_webhook_events/);
  assert.match(migration, /UNIQUE \(organization_id, idempotency_key\)/);
  assert.match(migration, /TO goodapp_backend_user/);
});

test("Public availability exposes sanitized inventory and honors booking conflicts", () => {
  const routes = read("src/routes/fleet-public.routes.js");
  const index = read("src/routes/index.js");
  assert.match(index, /router\.use\("\/api\/fleet\/v1\/public", fleetPublicRoutes\)/);
  assert.doesNotMatch(routes, /authRequired/);
  assert.match(routes, /router\.get\("\/availability"/);
  assert.match(routes, /vehicle\.archived_at IS NULL/);
  assert.match(routes, /NOT EXISTS/);
  assert.match(routes, /booking\.status=ANY/);
  assert.match(routes, /registration_expiry/);
  assert.doesNotMatch(routes, /license_plate/);
  assert.doesNotMatch(routes, /vin/);
});
