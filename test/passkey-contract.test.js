"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("GoodBase exposes durable, user-verified passkey ceremonies", () => {
  const routes = read("src/routes/auth.routes.js");
  const service = read("src/services/passkey.service.js");
  const migration = read("migrations/20260822_goodbase_passkeys.sql");

  assert.match(routes, /\/passkeys\/registration\/options/);
  assert.match(routes, /\/passkeys\/registration\/verify/);
  assert.match(routes, /\/passkeys\/authentication\/options/);
  assert.match(routes, /\/passkeys\/authentication\/verify/);
  assert.match(service, /residentKey:\s*"required"/);
  assert.match(service, /userVerification:\s*"required"/);
  assert.match(service, /requireUserVerification:\s*true/);
  assert.match(service, /consumed_at = NOW\(\)/);
  assert.match(service, /authMethod:\s*"passkey"/);
  assert.match(migration, /credential_id TEXT NOT NULL UNIQUE/);
  assert.match(migration, /public_key BYTEA NOT NULL/);
  assert.match(migration, /expires_at TIMESTAMPTZ NOT NULL/);
});
