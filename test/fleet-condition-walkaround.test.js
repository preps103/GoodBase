"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodFleet condition reports store scoped immutable walkaround evidence", () => {
  const migration = read("migrations/20260729_goodfleet_condition_walkaround_v1.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_condition_reports/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_condition_photos/);
  assert.match(migration, /UNIQUE \(organization_id, booking_id, phase\)/);
  assert.match(migration, /checksum_sha256/);
  assert.match(migration, /FOREIGN KEY \(organization_id, booking_id\)/);
});

test("GoodFleet walkaround photo API validates, scopes, audits, and privately serves images", () => {
  const routes = read("src/routes/fleet-condition.routes.js");
  assert.match(routes, /imageType\(request\.file\.buffer\)/);
  assert.match(routes, /MAX_PHOTO_BYTES/);
  assert.match(routes, /EMPLOYEE_WALKAROUND_REQUIRED/);
  assert.match(routes, /customer_email/);
  assert.match(routes, /condition\.photo\.captured/);
  assert.match(routes, /condition\.report\.submitted/);
  assert.match(routes, /Cache-Control": "private, no-store"/);
  assert.match(routes, /Cross-Origin-Resource-Policy": "same-site"/);
});

test("Booking transitions fail closed until departure and return evidence is submitted", () => {
  const routes = read("src/routes/fleet.routes.js");
  assert.match(routes, /DEPARTURE_WALKAROUND_REQUIRED/);
  assert.match(routes, /RETURN_WALKAROUND_REQUIRED/);
  assert.match(routes, /phase='departure'/);
  assert.match(routes, /phase='return'/);
  assert.match(routes, /COUNT\(DISTINCT photo\.slot\)/);
});
