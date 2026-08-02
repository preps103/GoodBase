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
  assert.match(routes, /goodFleetAppRole/);
  assert.match(routes, /requireOwner/);
  assert.match(routes, /requireFleetEditor/);
  assert.match(routes, /requireBookingEditor/);
  assert.match(routes, /allowedWorkspaceKeys/);
  assert.match(routes, /fleet\.goodos\.app/);
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

test("Pending reservations preserve requested vehicles without unsafe assignment", () => {
  const routes = read("src/routes/fleet.routes.js");
  assert.match(routes, /requestedVehicleId = text\(body\.requestedCarId \|\| body\.carId/);
  assert.match(routes, /else if \(requestedVehicleId\)/);
  assert.match(routes, /Requested vehicle not found/);
  assert.match(routes, /if \(customer\.status !== "active"\)/);
  assert.doesNotMatch(routes, /new Date\(customer\.license_expiry\) < new Date\(pickupAt\)/);
  assert.doesNotMatch(
    routes,
    /customer\.status !== "active" \|\| customer\.license_verification_status !== "verified"/
  );
});

test("Vehicle checkout requires an assigned vehicle and verified renter ID", () => {
  const routes = read("src/routes/fleet.routes.js");
  assert.match(routes, /merged\.status === "checked_out"/);
  assert.match(routes, /VEHICLE_ASSIGNMENT_REQUIRED/);
  assert.match(routes, /ID_VERIFICATION_REQUIRED/);
  assert.match(routes, /license_verification_status !== "verified"/);
  assert.match(routes, /Verify a valid government-issued driver license before vehicle checkout/);
  assert.match(routes, /SET status='checked_out',version=version\+1/);
  assert.match(routes, /vehicle\.checked_out/);
});

test("Customer intake defers identification and in-person verification is audited", () => {
  const routes = read("src/routes/fleet.routes.js");
  const migration = read("migrations/20260728_goodfleet_checkout_identity.sql");
  assert.match(routes, /text\(body\.licenseNumber, 100\) \|\| null/);
  assert.match(routes, /text\(body\.licenseExpiry, 20\) \|\| null/);
  assert.match(routes, /router\.post\("\/customers\/:customerId\/license-verification", requireLicenseVerifier/);
  assert.match(routes, /customer\.license_verified/);
  assert.match(routes, /license_verification_method='in_person'/);
  assert.match(migration, /ALTER COLUMN license_number DROP NOT NULL/);
  assert.match(migration, /ALTER COLUMN license_expiry DROP NOT NULL/);
  assert.match(migration, /license_verified_at/);
  assert.match(migration, /license_verified_by/);
  assert.match(migration, /INSERT INTO backend_organization_memberships/);
  assert.match(migration, /membership\.app_id = 'goodfleet'/);
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
  assert.match(routes, /router\.delete\("\/bookings\/:bookingId", requireBookingManager/);
  assert.match(routes, /BOOKING_DELETE_ACCESS_REQUIRED/);
  assert.match(routes, /ACTIVE_RENTAL_CANNOT_BE_DELETED/);
  assert.match(routes, /SET status='cancelled',archived_at=NOW\(\)/);
  assert.match(routes, /booking\.deleted/);
  assert.match(routes, /vehicle\.reservation_released/);
  assert.match(routes, /router\.post\("\/bookings\/quote"/);
  assert.match(routes, /router\.post\("\/bookings\/:bookingId\/extensions"/);
  assert.match(routes, /calculateBookingPrice/);
  assert.match(routes, /BOOKING_NOT_EDITABLE/);
  assert.match(routes, /additionalCharges/);
  assert.match(routes, /router\.delete\("\/vehicles\/:vehicleId"/);
  assert.match(routes, /router\.delete\("\/branches\/:branchId", requireFleetEditor/);
  assert.match(routes, /LAST_BRANCH_REQUIRED/);
  assert.match(routes, /BRANCH_IN_USE/);
  assert.match(routes, /assigned_branch_id=\$2/);
  assert.match(routes, /pickup_branch_id=\$2 OR return_branch_id=\$2/);
  assert.match(routes, /pricingRules: pricingReferences/);
  assert.match(routes, /router\.post\("\/staff\/invitations"/);
  assert.match(routes, /router\.patch\("\/staff\/:userId"/);
  assert.match(routes, /router\.delete\("\/staff\/:userId"/);
  assert.match(routes, /inviteTeamMemberForUser/);
  assert.match(routes, /updateTeamMemberForUser/);
  assert.match(routes, /INSERT INTO app_memberships/);
  assert.match(routes, /app_id='goodfleet'/);
  assert.match(routes, /app_role=\$2/);
  assert.match(routes, /fleet_payment_operations WHERE organization_id=\$1/);
  assert.match(routes, /payments: payments\.rows\.map\(paymentPayload\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_workspace_state/);
  assert.match(migration, /archived_at/);
  assert.match(migration, /fleet_bookings_organization_id_id_v2_key/);
});

test("Fleet workspace edits produce durable module-level audit records", () => {
  const routes = read("src/routes/fleet.routes.js");
  assert.match(routes, /WORKSPACE_AUDIT_DESCRIPTORS/);
  assert.match(routes, /auditWorkspaceChanges/);
  assert.match(routes, /changedWorkspaceFields/);
  assert.match(routes, /`\$\{entityType\}\.\$\{operation\}`/);
  assert.match(routes, /auditLogs: auditEvents\.rows\.map\(auditPayload\)/);
});

test("Fleet returns and mileage updates publish durable operational notifications", () => {
  const routes = read("src/routes/fleet.routes.js");
  const migration = read("migrations/20260729_goodfleet_operational_notifications_v1.sql");
  assert.match(routes, /notificationService\.createNotification/);
  assert.match(routes, /returnInspectionStatus = "required"/);
  assert.match(routes, /status='inspection'/);
  assert.match(routes, /fleet\.return_inspection_required/);
  assert.match(routes, /fleet\.oil_change_approaching/);
  assert.match(routes, /maintenanceReminderMiles/);
  assert.match(routes, /maybeNotifyOilService\(org, actor\(request\), vehicle\)/);
  assert.match(routes, /tab=checklists&action=new/);
  assert.match(routes, /tab=maintenance&action=new/);
  assert.match(migration, /backend_notifications_goodfleet_operation_once_idx/);
  assert.match(migration, /source = 'goodfleet-operations'/);
});

test("GoodFleet owner controls are durable and protected at the API boundary", () => {
  const routes = read("src/routes/fleet.routes.js");
  const migration = read("migrations/20260728_goodfleet_vehicle_images_and_owner_settings_v3.sql");
  assert.match(routes, /WORKSPACE_OBJECT_KEYS = new Set\(\["branding", "billingSettings", "ownerSettings"\]\)/);
  assert.match(routes, /function allowedWorkspaceKeys/);
  assert.match(routes, /permittedWorkspaceKeys/);
  assert.match(routes, /delete state\[key\]/);
  assert.match(migration, /2014-chevrolet-cruze-blue-metallic\.webp/);
  assert.match(migration, /2014-hyundai-sonata-pearl-white\.webp/);
  assert.match(migration, /Blue metallic glitter/);
  assert.match(migration, /Pearl white/);
});

test("Fleet payments stay disabled without credentials and expose the complete provider workflow", () => {
  const routes = read("src/routes/fleet-payments.routes.js");
  const index = read("src/routes/index.js");
  const migration = read("migrations/20260726_goodfleet_readiness_v2.sql");
  const productionMigration = read("migrations/20260728_goodfleet_payments_v3.sql");
  assert.match(routes, /router\.use\(authRequired, tenantContext, requirePaymentEmployee\)/);
  assert.match(routes, /PAYMENTS_NOT_ACTIVATED/);
  assert.match(routes, /new Set\(\["owner", "admin", "manager"\]\)/);
  assert.match(routes, /acceptingPayments: credentialsReady/);
  assert.match(routes, /STRIPE_WEBHOOK_SECRET/);
  assert.match(routes, /router\.post\("\/webhooks\/stripe"/);
  assert.match(routes, /constructEvent/);
  assert.match(routes, /expand: \["latest_charge"\]/);
  assert.match(routes, /receipt_url/);
  assert.match(routes, /booking\.status === "pending_payment"/);
  assert.match(routes, /"confirmed"/);
  assert.match(routes, /booking\.payment_confirmed/);
  assert.match(routes, /router\.post\("\/checkout-sessions"/);
  assert.match(routes, /router\.post\("\/manual-payments"/);
  assert.match(routes, /router\.post\("\/authorizations"/);
  assert.match(routes, /router\.post\("\/:paymentId\/capture"/);
  assert.match(routes, /router\.post\("\/:paymentId\/refunds"/);
  assert.match(routes, /router\.post\("\/:paymentId\/void"/);
  assert.match(index, /router\.use\("\/api\/fleet\/v1\/payments", fleetPaymentsRoutes\)/);
  assert.match(migration, /fleet_payment_operations/);
  assert.match(migration, /fleet_payment_webhook_events/);
  assert.match(migration, /fleet_bookings_org_id_unique_idx/);
  assert.match(migration, /UNIQUE USING INDEX fleet_bookings_org_id_unique_idx/);
  assert.match(migration, /UNIQUE \(organization_id, idempotency_key\)/);
  assert.match(migration, /TO goodapp_backend_user/);
  assert.match(productionMigration, /manual_payment/);
  assert.match(productionMigration, /parent_operation_id/);
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
