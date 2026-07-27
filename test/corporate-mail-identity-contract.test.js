"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const service = fs.readFileSync(
  path.join(root, "src", "services", "corporate-mail-identity.service.js"),
  "utf8"
);
const auth = fs.readFileSync(
  path.join(root, "src", "services", "auth.service.js"),
  "utf8"
);

test("GoodBase bridges verified GoodMail identities across every active application", () => {
  assert.match(service, /http:\/\/127\.0\.0\.1:3021\/api\/login/);
  assert.match(service, /AbortSignal\.timeout\(5000\)/);
  assert.match(service, /response\.ok/);
  assert.match(service, /bcrypt\.hash\(password, 12\)/);
  assert.match(service, /corporateMailboxLinked/);
  assert.match(service, /ensureCorporateAppAccess/);
  assert.match(service, /FROM apps application/);
  assert.match(service, /WHERE application\.status = 'active'/);
  assert.doesNotMatch(service, /CORPORATE_APP_ACCESS/);
  assert.match(service, /WHEN app_memberships\.role = 'owner' THEN 'owner'/);
  assert.match(service, /ELSE 'admin'/);
  assert.doesNotMatch(service, /console\.(?:log|error).*password/i);
  assert.match(auth, /synchronizeCorporateIdentity/);
  assert.match(auth, /ensureCorporateAppAccess\(email, user\.id\)/);
});
