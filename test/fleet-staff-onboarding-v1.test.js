"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodFleet staff onboarding is durable, personal, and tenant scoped", () => {
  const routes = read("src/routes/fleet.routes.js");
  const migration = read("migrations/20260728_goodfleet_staff_onboarding_v1.sql");

  assert.match(routes, /router\.get\("\/staff-onboarding"/);
  assert.match(routes, /router\.put\("\/staff-onboarding"/);
  assert.match(routes, /organization_id=\$1 AND user_id=\$2/);
  assert.match(routes, /ON CONFLICT \(organization_id,user_id\)/);
  assert.match(routes, /ONBOARDING_MODULES/);
  assert.match(routes, /completed_modules/);
  assert.match(routes, /normalizedFleetRole/);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_staff_onboarding_progress/);
  assert.match(migration, /PRIMARY KEY \(organization_id, user_id\)/);
  assert.match(migration, /user_id uuid NOT NULL REFERENCES users\(id\)/);
  assert.match(migration, /completed_modules text\[\]/);
  assert.match(migration, /completed_at timestamptz/);
});

test("Only management can view team onboarding completion", () => {
  const routes = read("src/routes/fleet.routes.js");

  assert.match(routes, /router\.get\("\/staff-onboarding\/team"/);
  assert.match(routes, /\["owner", "admin", "manager"\]\.includes\(goodFleetAccessRole\(request\)\)/);
  assert.match(routes, /ONBOARDING_OVERVIEW_FORBIDDEN/);
  assert.match(routes, /app_membership\.app_id='goodfleet'/);
  assert.match(routes, /LEFT JOIN fleet_staff_onboarding_progress/);
});

test("Fleet health includes onboarding storage readiness", () => {
  const routes = read("src/routes/fleet.routes.js");
  assert.match(routes, /onboarding_ready/);
  assert.match(routes, /fleet_staff_onboarding_progress/);
});
