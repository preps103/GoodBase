"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  evidenceItems,
  canTransition,
  allowedTransitions,
  transitionBlockers,
} = require("../src/services/fleet-financial-cases.service");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("financial cases store scoped fraud, chargeback, collection, and timeline records", () => {
  const migration = read("migrations/20261001_goodfleet_financial_cases_v1.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_financial_cases/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_financial_case_events/);
  assert.match(migration, /'fraud_review','chargeback','collection'/);
  assert.match(migration, /UNIQUE \(organization_id, idempotency_key\)/);
  assert.match(migration, /fleet_financial_cases_external_reference_idx/);
  assert.match(migration, /REFERENCES fleet_bookings\(organization_id, id\)/);
});

test("case transitions are type-specific and terminal states fail closed", () => {
  assert.equal(canTransition("chargeback", "investigating", "response_ready"), true);
  assert.equal(canTransition("collection", "investigating", "payment_plan"), true);
  assert.equal(canTransition("fraud_review", "investigating", "submitted"), false);
  assert.equal(canTransition("collection", "collected", "investigating"), false);
  assert.deepEqual(allowedTransitions("collection", "payment_plan"), ["collected", "investigating", "written_off"]);
});

test("chargeback submission and financial resolutions require evidence and reasons", () => {
  assert.deepEqual(transitionBlockers({ evidence: [], externalReference: "" }, "submitted", ""), [
    "evidence_required",
    "external_reference_required",
  ]);
  assert.deepEqual(transitionBlockers({
    evidence: [{ type: "receipt", reference: "asset-1" }],
    externalReference: "dp_123",
  }, "submitted", ""), []);
  assert.deepEqual(transitionBlockers({ evidence: [], externalReference: "" }, "written_off", "no"), [
    "resolution_note_required",
  ]);
  assert.deepEqual(transitionBlockers({ evidence: [], externalReference: "" }, "collected", "Paid in full"), []);
});

test("financial case evidence is bounded and normalized", () => {
  assert.deepEqual(evidenceItems([
    "asset-1",
    { type: "Customer Email", value: "message-2", description: "Customer confirmation" },
    { type: "empty" },
  ]), [
    { type: "reference", reference: "asset-1", description: "" },
    { type: "customer email", reference: "message-2", description: "Customer confirmation" },
  ]);
});

test("financial case API is management-only, audited, and migration-gated", () => {
  const routes = read("src/routes/fleet-revenue-operations.routes.js");
  const packageJson = JSON.parse(read("package.json"));
  assert.match(routes, /router\.use\(authRequired\)/);
  assert.match(routes, /router\.use\(requireManagement\)/);
  assert.match(routes, /router\.get\("\/financial-cases"/);
  assert.match(routes, /router\.post\("\/financial-cases"/);
  assert.match(routes, /router\.patch\("\/financial-cases\/:caseId\/evidence"/);
  assert.match(routes, /router\.patch\("\/financial-cases\/:caseId\/status"/);
  assert.match(routes, /financial_case\.status_changed/);
  assert.match(routes, /automatedProviderActions: "external_activation_required"/);
  assert.match(packageJson.scripts.build, /apply-goodfleet-financial-cases-migration\.js/);
});
