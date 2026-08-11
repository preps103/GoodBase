"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodFleet publishes sanitized locations and active offers", () => {
  const routes = read("src/routes/fleet-public.routes.js");
  assert.match(routes, /router\.get\("\/locations"/);
  assert.match(routes, /router\.get\("\/offers"/);
  assert.match(routes, /publicLocation/);
  assert.match(routes, /isPublishableLocation/);
  assert.match(routes, /placeholderAddress/);
  assert.match(routes, /validTimezone/);
  assert.match(routes, /validPhone/);
  assert.match(routes, /discount\?\.status === "active"/);
  assert.doesNotMatch(routes, /financialConfig/);
  assert.doesNotMatch(routes, /locationSurcharge/);
});

test("Customer check-in is identity scoped and fails closed on readiness", () => {
  const routes = read("src/routes/fleet-communications.routes.js");
  assert.match(routes, /router\.post\("\/customer-checkins"/);
  assert.match(routes, /license_verification_status !== "verified"/);
  assert.match(routes, /CUSTOMER_CHECKIN_BOOKING_STATUSES/);
  assert.match(routes, /booking\.rows\[0\]\.payment_status !== "paid"/);
  assert.match(routes, /customer_id=\$3/);
  assert.match(routes, /customer\.checkin\.submitted/);
});

test("Customer support tickets are durable, scoped, and employee actionable", () => {
  const routes = read("src/routes/fleet-communications.routes.js");
  const migration = read("migrations/20260727_goodfleet_customer_experience.sql");
  assert.match(routes, /router\.post\("\/customer-support-tickets"/);
  assert.match(routes, /router\.get\("\/support-tickets", employeeScope/);
  assert.match(routes, /customer_id=\$3/);
  assert.match(routes, /customer\.support\.opened/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_customer_support_tickets/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_customer_support_messages/);
  assert.match(migration, /FOREIGN KEY \(organization_id, customer_id\)/);
});

test("Initial GoodFleet inventory restoration is idempotent and preserves active assignments", () => {
  const migration = read("migrations/20260727_goodfleet_customer_experience.sql");
  assert.match(migration, /Hyundai/);
  assert.match(migration, /Sonata 2\.0 Turbo/);
  assert.match(migration, /Chevrolet/);
  assert.match(migration, /Cruze LT 2\.0 Turbo/);
  assert.match(migration, /ON CONFLICT \(organization_id, vin\) DO UPDATE/);
  assert.match(migration, /booking\.payload->>'legacyVehicleId'/);
  assert.match(migration, /THEN 'checked_out'/);
  assert.match(migration, /recordCompleteness/);
});
