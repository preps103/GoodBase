"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodFleet production audit checks tables, integrity, constraints, and providers", () => {
  const audit = read("scripts/audit-goodfleet-readiness.js");
  const packageJson = JSON.parse(read("package.json"));

  assert.match(audit, /REQUIRED_TABLES/);
  assert.match(audit, /bookings_without_customer/);
  assert.match(audit, /listings_without_vehicle/);
  assert.match(audit, /messages_without_conversation/);
  assert.match(audit, /constraint_record\.convalidated/);
  assert.match(audit, /paymentExcludedReadiness/);
  assert.match(audit, /listing_photos_incomplete/);
  assert.match(audit, /current_workspace_without_revision/);
  assert.match(audit, /booking_financial_mismatches/);
  assert.match(audit, /incomplete_completed_contracts/);
  assert.match(audit, /incomplete_submitted_condition_reports/);
  assert.match(audit, /notification_channels_without_delivery/);
  assert.match(audit, /legacyDataWarnings/);
  assert.match(audit, /recovered-legacy-live-ledger/);
  assert.equal(
    packageJson.scripts["audit:goodfleet"],
    "node scripts/audit-goodfleet-readiness.js",
  );
});

test("GoodFleet retains immutable workspace recovery points and owner restore controls", () => {
  const migration = read(
    "migrations/20260731_goodfleet_workspace_recovery_v1.sql",
  );
  const runner = read(
    "scripts/apply-goodfleet-workspace-recovery-migration.js",
  );
  const routes = read("src/routes/fleet.routes.js");
  const packageJson = read("package.json");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_workspace_revisions/);
  assert.match(migration, /CREATE TRIGGER fleet_workspace_revision_append_only/);
  assert.match(migration, /workspace recovery points are append-only/);
  assert.match(migration, /previous_revision_hash/);
  assert.match(migration, /revision_hash/);
  assert.match(migration, /ON CONFLICT \(organization_id, workspace_version\) DO NOTHING/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /current_workspace_captured/);
  assert.match(runner, /append_only_trigger/);
  assert.match(routes, /router\.get\("\/workspace\/revisions"/);
  assert.match(routes, /router\.post\("\/workspace\/revisions\/:revisionId\/restore"/);
  assert.match(routes, /async function recordWorkspaceRevision/);
  assert.match(routes, /source: "save"/);
  assert.match(routes, /source: "branch_delete"/);
  assert.match(routes, /source: "restore"/);
  assert.match(routes, /workspace\.restored/);
  assert.match(
    packageJson,
    /apply-goodfleet-workspace-recovery-migration\.js/,
  );
});

test("GoodFleet validates all previously deferred production constraints", () => {
  const migration = read(
    "migrations/20260730_goodfleet_constraint_validation_v1.sql",
  );
  const runner = read(
    "scripts/apply-goodfleet-constraint-validation-migration.js",
  );
  const packageJson = read("package.json");
  const constraints = [
    "fleet_vehicles_status_v2_check",
    "fleet_customers_status_v2_check",
    "fleet_customers_license_status_v2_check",
    "fleet_customers_license_verification_method_check",
    "fleet_bookings_payment_status_v2_check",
  ];

  for (const constraint of constraints) {
    assert.match(migration, new RegExp(`VALIDATE CONSTRAINT ${constraint}`));
    assert.match(runner, new RegExp(constraint));
  }
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /GoodFleet constraints were not validated completely/);
  assert.match(
    packageJson,
    /apply-goodfleet-constraint-validation-migration\.js/,
  );
});

test("public marketplace inventory requires a complete six-photo gallery", () => {
  const publicRoutes = read("src/routes/fleet-public.routes.js");
  const operationsRoutes = read(
    "src/routes/fleet-advanced-operations.routes.js",
  );

  assert.match(
    publicRoutes,
    /jsonb_array_length\(listing\.photos_json\)>=6/,
  );
  assert.match(
    operationsRoutes,
    /Number\(row\.photo_count \|\| 0\) < 6\) blockers\.push\("listing_photos_incomplete"\)/,
  );
});

test("host listing photos use managed storage and public read-only delivery", () => {
  const hostRoutes = read("src/routes/fleet-marketplace.routes.js");
  const publicRoutes = read("src/routes/fleet-public.routes.js");

  assert.match(
    hostRoutes,
    /router\.post\(\s*"\/host\/listings\/:listingId\/photos"/,
  );
  assert.match(hostRoutes, /receiveListingMedia/);
  assert.match(hostRoutes, /LISTING_PHOTO_TOO_LARGE/);
  assert.match(hostRoutes, /fleet_managed_assets/);
  assert.match(hostRoutes, /'vehicle_image','vehicle'/);
  assert.match(hostRoutes, /marketplace\.host\.listing_photo_uploaded/);
  assert.match(hostRoutes, /publicBackendUrl\(\)/);
  assert.match(
    publicRoutes,
    /router\.get\("\/listing-media\/:assetId"/,
  );
  assert.match(publicRoutes, /asset\.category='vehicle_image'/);
  assert.match(publicRoutes, /listing\.status='active'/);
  assert.match(publicRoutes, /safeManagedAssetPath/);
  assert.match(publicRoutes, /Cache-Control", "public, max-age=86400, immutable"/);
});
