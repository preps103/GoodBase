"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  chooseBookingMatch,
  approvalBlockers,
  canTransition,
  accountingCsv,
} = require("../src/services/fleet-revenue-operations.service");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("incidentals migration stores deduplicated charges and audit events", () => {
  const migration = read("migrations/20260930_goodfleet_revenue_operations_v1.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_incidental_charges/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_incidental_events/);
  assert.match(migration, /UNIQUE \(organization_id, idempotency_key\)/);
  assert.match(migration, /fleet_incidental_source_reference_idx/);
  assert.match(migration, /match_confidence >= 0 AND match_confidence <= 1/);
});

test("matching engine automatically selects a decisive exact vehicle reservation", () => {
  const incident = {
    vehicleId: "vehicle-1",
    licensePlate: "8ABC123",
    occurredAt: "2026-09-20T12:00:00Z",
  };
  const result = chooseBookingMatch(incident, [
    {
      bookingId: "booking-1",
      vehicleId: "vehicle-1",
      licensePlate: "8ABC123",
      pickupAt: "2026-09-19T10:00:00Z",
      returnAt: "2026-09-21T10:00:00Z",
    },
    {
      bookingId: "booking-2",
      vehicleId: "vehicle-2",
      licensePlate: "9XYZ999",
      pickupAt: "2026-09-19T10:00:00Z",
      returnAt: "2026-09-21T10:00:00Z",
    },
  ]);
  assert.equal(result.automatic, true);
  assert.equal(result.match.bookingId, "booking-1");
  assert.ok(result.match.confidence >= 0.75);
  assert.deepEqual(result.match.reasons, [
    "vehicle_id_exact",
    "license_plate_exact",
    "inside_reservation_window",
  ]);
});

test("matching engine leaves ambiguous records for staff review", () => {
  const incident = {
    licensePlate: "8ABC123",
    occurredAt: "2026-09-20T12:00:00Z",
  };
  const common = {
    licensePlate: "8ABC123",
    pickupAt: "2026-09-19T10:00:00Z",
    returnAt: "2026-09-21T10:00:00Z",
  };
  const result = chooseBookingMatch(incident, [
    { ...common, bookingId: "booking-1", vehicleId: "vehicle-1" },
    { ...common, bookingId: "booking-2", vehicleId: "vehicle-1" },
  ]);
  assert.equal(result.automatic, false);
  assert.equal(result.match, null);
  assert.equal(result.suggestedMatch.bookingId, "booking-1");
});

test("approval requires evidence, a positive amount, and a confirmed match", () => {
  assert.deepEqual(approvalBlockers({
    matchStatus: "suggested",
    evidence: [],
    amount: 0,
  }), [
    "confirmed_reservation_match_required",
    "evidence_required",
    "positive_amount_required",
  ]);
  assert.deepEqual(approvalBlockers({
    matchStatus: "confirmed",
    evidence: [{ type: "receipt", value: "asset-123" }],
    amount: 15,
  }), []);
});

test("workflow transitions fail closed", () => {
  assert.equal(canTransition("review_required", "approved"), true);
  assert.equal(canTransition("approved", "collected"), false);
  assert.equal(canTransition("waived", "approved"), false);
});

test("accounting export neutralizes spreadsheet formula injection", () => {
  const csv = accountingCsv([{
    occurredAt: "2026-09-20",
    chargeType: "toll",
    description: "=HYPERLINK(\"bad\")",
    amount: 12.5,
    currency: "USD",
    reservationNumber: "GF-123",
    vehicleName: "2025 Test Car",
    licensePlate: "8ABC123",
    customerName: "Customer",
    workflowStatus: "approved",
    sourceProvider: "manual",
    sourceReference: "ref-1",
  }]);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /12\.50/);
});

test("revenue operations API is mounted and protected", () => {
  const index = read("src/routes/index.js");
  const routes = read("src/routes/fleet-revenue-operations.routes.js");
  const packageJson = JSON.parse(read("package.json"));
  assert.match(index, /fleetRevenueOperationsRoutes/);
  assert.match(routes, /router\.use\(authRequired\)/);
  assert.match(routes, /router\.use\(requireManagement\)/);
  assert.match(routes, /approvalBlockers/);
  assert.match(routes, /accounting\/export\.csv/);
  assert.match(packageJson.scripts.build, /apply-goodfleet-revenue-operations-migration\.js/);
});
