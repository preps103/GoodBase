"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodFleet contract signing is mounted before the employee-only fleet API", () => {
  const index = read("src/routes/index.js");
  const contractsMount = index.indexOf('router.use("/api/fleet/v1/contracts", fleetContractsRoutes)');
  const fleetMount = index.indexOf('router.use("/api/fleet/v1", fleetRoutes)');

  assert.ok(contractsMount >= 0, "contract signing routes must be mounted");
  assert.ok(fleetMount > contractsMount, "public and customer signing routes must not inherit the employee-only fleet boundary");
});

test("Contract signing separates public, customer, and employee authorization boundaries", () => {
  const routes = read("src/routes/fleet-contracts.routes.js");
  const publicRoute = routes.indexOf('router.get("/sign/:token"');
  const customerBoundary = routes.indexOf("router.use(authRequired)");
  const customerRoute = routes.indexOf('router.get("/mine"');
  const employeeBoundary = routes.indexOf("router.use(employeeScope)");
  const employeeRoute = routes.indexOf('router.get("/templates"');

  assert.ok(publicRoute >= 0 && publicRoute < customerBoundary);
  assert.ok(customerBoundary < customerRoute && customerRoute < employeeBoundary);
  assert.ok(employeeBoundary < employeeRoute);
  assert.match(routes, /EMPLOYEE_ROLES/);
  assert.match(routes, /organization_id=\$1/);
  assert.match(routes, /lower\(recipient\.email\)=lower\(\$2\)/);
  assert.match(routes, /signingLimiter/);
});

test("Signing links are random, one-time, hashed, expiring, and revoked", () => {
  const routes = read("src/routes/fleet-contracts.routes.js");

  assert.match(routes, /crypto\.randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(routes, /access_token_hash=\$1/);
  assert.match(routes, /access_token_expires_at/);
  assert.match(routes, /access_token_hash=NULL/);
  assert.match(routes, /SIGNING_LINK_INVALID/);
  assert.match(routes, /Cache-Control", "no-store"/);
});

test("Electronic signature completion requires affirmative consent, identity confirmation, and intent", () => {
  const routes = read("src/routes/fleet-contracts.routes.js");

  assert.match(routes, /body\?\.consent !== true/);
  assert.match(routes, /ELECTRONIC_CONSENT_REQUIRED/);
  assert.match(routes, /SIGNER_NAME_MISMATCH/);
  assert.match(routes, /\["typed", "drawn"\]/);
  assert.match(routes, /affirmativeConsent: true/);
  assert.match(routes, /intentToSign: true/);
  assert.match(routes, /disclosureHash/);
  assert.match(routes, /documentHash/);
  assert.match(routes, /signed_ip/);
  assert.match(routes, /signed_user_agent/);
});

test("Contract storage freezes the agreement and preserves tamper-evident completion evidence", () => {
  const migration = read("migrations/20260728_goodfleet_contract_signing_v1.sql");
  const routes = read("src/routes/fleet-contracts.routes.js");

  for (const table of [
    "fleet_contract_templates",
    "fleet_contract_envelopes",
    "fleet_contract_recipients",
    "fleet_contract_events",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /content_snapshot text NOT NULL/);
  assert.match(migration, /disclosure_snapshot text NOT NULL/);
  assert.match(migration, /document_hash char\(64\) NOT NULL/);
  assert.match(migration, /completed_record_hash char\(64\)/);
  assert.match(migration, /previous_event_hash char\(64\)/);
  assert.match(migration, /event_hash char\(64\) NOT NULL/);
  assert.match(migration, /fleet_contract_events is append-only/);
  assert.match(routes, /sha256\(`\$\{content\}\|\$\{disclosure\}`\)/);
  assert.match(routes, /completedRecordHash/);
  assert.match(routes, /auditChainHead/);
});

test("Sending and reminding customers creates durable in-app notifications", () => {
  const routes = read("src/routes/fleet-contracts.routes.js");

  assert.match(routes, /fleet_customer_notifications/);
  assert.match(routes, /fleet_customer_notification_deliveries/);
  assert.match(routes, /backend_email_queue/);
  assert.match(routes, /ARRAY\['in_app','email'\]/);
  assert.match(routes, /This link is personal, expires automatically/);
  assert.match(routes, /'\/account\/contracts'/);
  assert.match(routes, /router\.post\("\/:envelopeId\/send"/);
  assert.match(routes, /router\.post\("\/:envelopeId\/remind"/);
});

test("Fleet readiness includes the contract signing schema", () => {
  const routes = read("src/routes/fleet.routes.js");
  assert.match(routes, /contract_schema_ready/);
  assert.match(routes, /fleet_contract_envelopes/);
});
