"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("GoodBase deployment applies the complete GoodAds payment migration", () => {
  const packageJson = JSON.parse(read("package.json"));
  const runner = read("scripts/apply-goodads-payments-migration.js");
  const migration = read("migrations/20260726_goodads_payments.sql");

  assert.match(packageJson.scripts.build, /apply-goodads-payments-migration\.js/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /20260726_goodads_payments\.sql/);
  for (const table of [
    "goodads_payment_connections",
    "goodads_payment_preferences",
    "goodads_payment_offers",
    "goodads_payment_sessions",
    "goodads_payment_webhook_events",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /credential_ciphertext TEXT NOT NULL/);
  assert.match(migration, /UNIQUE \(organization_id, idempotency_key\)/);
  assert.match(migration, /amount_minor BIGINT NOT NULL/);
  assert.match(migration, /provider IN \('stripe', 'paypal', 'square'\)/);
  assert.doesNotMatch(migration, /secret_key|client_secret|access_token/i);
});
