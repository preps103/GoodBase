"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("advanced operations migration stores host teams, roadside, and telematics", () => {
  const migration = read("migrations/20260729_goodfleet_advanced_operations_v1.sql");
  for (const table of [
    "fleet_host_team_members",
    "fleet_host_team_vehicle_access",
    "fleet_roadside_cases",
    "fleet_roadside_events",
    "fleet_telematics_connections",
    "fleet_telematics_snapshots",
    "fleet_telematics_commands",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /UNIQUE \(organization_id, idempotency_key\)/);
});

test("advanced operations routes enforce permissions and fail closed", () => {
  const routes = read("src/routes/fleet-advanced-operations.routes.js");
  const marketplaceRoutes = read("src/routes/fleet-marketplace.routes.js");
  const index = read("src/routes/index.js");
  const packageJson = JSON.parse(read("package.json"));
  assert.match(index, /\/api\/fleet\/v1\/operations/);
  assert.match(routes, /router\.use\(requireFleetMember\)/);
  assert.match(routes, /requireManagement/);
  assert.match(routes, /REMOTE_LOCK_SAFETY_BLOCK/);
  assert.match(routes, /TELEMATICS_PROVIDER_NOT_CONFIGURED/);
  assert.match(routes, /ROADSIDE_PROVIDER_NOT_CONFIGURED/);
  assert.match(routes, /host-team\/invitations/);
  assert.match(marketplaceRoutes, /NOT EXISTS \(\s*SELECT 1\s*FROM fleet_host_team_vehicle_access scoped/);
  assert.match(marketplaceRoutes, /scoped\.vehicle_id=booking\.vehicle_id/);
  assert.match(marketplaceRoutes, /scoped\.vehicle_id=listing\.vehicle_id/);
  assert.match(packageJson.scripts.build, /apply-goodfleet-advanced-operations-migration\.js/);
});

test("native GoodFleet uses an exact local origin without weakening web origin policy", () => {
  const phase2Security = read("src/middleware/phase2-security.js");
  const environment = read("src/config/env.js");
  const app = read("src/app.js");
  for (const source of [phase2Security, environment, app]) {
    assert.match(source, /"https:\/\/localhost"/);
  }
  assert.doesNotMatch(phase2Security, /hostname\.endsWith\("localhost"\)/);
  assert.match(phase2Security, /https:\\\/\\\/\(\[a-z0-9-\]\+\\\.\)\*goodos\\\.app/);
});
