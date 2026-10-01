"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  bookingPolicy,
  cancellationOutcome,
  noShowOutcome,
} = require("../src/services/fleet-booking-policies.service");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("booking policy defaults are safe and do not invent fees", () => {
  assert.deepEqual(bookingPolicy({}), {
    cancellationWindowHours: 24,
    lateCancellationFee: 0,
    noShowGracePeriodMinutes: 120,
    noShowFee: 0,
  });
});

test("late cancellation calculates fee, refund review, and collection review deterministically", () => {
  const state = { ownerSettings: { reservations: {
    cancellationWindowHours: 48,
    lateCancellationFee: 75,
  } } };
  const refund = cancellationOutcome({
    pickupAt: "2026-10-02T12:00:00.000Z",
    now: "2026-10-01T12:00:00.000Z",
    totalAmount: 300,
    paidAmount: 200,
    state,
  });
  assert.equal(refund.insideFeeWindow, true);
  assert.equal(refund.feeAmount, 75);
  assert.equal(refund.refundDue, 125);
  assert.equal(refund.balanceDue, 0);
  assert.equal(refund.disposition, "refund_review");

  const collection = cancellationOutcome({
    pickupAt: "2026-10-02T12:00:00.000Z",
    now: "2026-10-01T12:00:00.000Z",
    totalAmount: 300,
    paidAmount: 25,
    state,
  });
  assert.equal(collection.refundDue, 0);
  assert.equal(collection.balanceDue, 50);
  assert.equal(collection.disposition, "collection_review");
});

test("free-window cancellations and management waivers produce no fee", () => {
  const state = { ownerSettings: { reservations: {
    cancellationWindowHours: 24,
    lateCancellationFee: 100,
  } } };
  const early = cancellationOutcome({
    pickupAt: "2026-10-05T12:00:00.000Z",
    now: "2026-10-01T12:00:00.000Z",
    totalAmount: 300,
    paidAmount: 0,
    state,
  });
  assert.equal(early.feeAmount, 0);
  const waived = cancellationOutcome({
    pickupAt: "2026-10-01T13:00:00.000Z",
    now: "2026-10-01T12:00:00.000Z",
    totalAmount: 300,
    paidAmount: 0,
    state,
    waiveFee: true,
  });
  assert.equal(waived.feeWaived, true);
  assert.equal(waived.feeAmount, 0);
});

test("no-show workflow enforces the configured grace period", () => {
  const state = { ownerSettings: { reservations: {
    noShowGracePeriodMinutes: 90,
    noShowFee: 125,
  } } };
  assert.throws(() => noShowOutcome({
    pickupAt: "2026-10-01T10:00:00.000Z",
    now: "2026-10-01T11:00:00.000Z",
    totalAmount: 400,
    paidAmount: 0,
    state,
  }), error => error.code === "NO_SHOW_GRACE_PERIOD_ACTIVE");
  const outcome = noShowOutcome({
    pickupAt: "2026-10-01T10:00:00.000Z",
    now: "2026-10-01T12:00:00.000Z",
    totalAmount: 400,
    paidAmount: 50,
    state,
  });
  assert.equal(outcome.feeAmount, 125);
  assert.equal(outcome.balanceDue, 75);
});

test("booking policy migration and routes are production wired", () => {
  const migration = read("migrations/20261001_goodfleet_booking_policies_v1.sql");
  const runner = read("scripts/apply-goodfleet-booking-policies-migration.js");
  const routes = read("src/routes/fleet.routes.js");
  const marketplace = read("src/routes/fleet-marketplace.routes.js");
  const packageJson = JSON.parse(read("package.json"));

  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_booking_policy_actions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_inventory_transfer_plans/);
  assert.match(migration, /UNIQUE \(organization_id,idempotency_key\)/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(packageJson.scripts.build, /apply-goodfleet-booking-policies-migration/);
  assert.match(routes, /"\/bookings\/:bookingId\/cancellation-quote"/);
  assert.match(routes, /"\/bookings\/:bookingId\/cancel"/);
  assert.match(routes, /"\/bookings\/:bookingId\/no-show"/);
  assert.match(routes, /BOOKING_POLICY_ENDPOINT_REQUIRED/);
  assert.match(routes, /assigned_branch_id=\$5/);
  assert.match(routes, /"\/inventory-transfers"/);
  assert.match(marketplace, /"\/reservations\/:bookingId\/cancellation-quote"/);
  assert.match(marketplace, /recordPolicyAction/);
  assert.doesNotMatch(
    marketplace.slice(
      marketplace.indexOf('"/reservations/:bookingId/cancel"'),
      marketplace.indexOf('"/reservations/:bookingId/change-requests"'),
    ),
    /CANCELLATION_REVIEW_REQUIRED/,
  );
});
