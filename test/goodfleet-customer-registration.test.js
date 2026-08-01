"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodFleet public registration protects credentials and provisions the requested role", () => {
  const routes = read("src/routes/auth.routes.js");
  const registration = routes.slice(
    routes.indexOf('router.post(\n  "/register"'),
    routes.indexOf('router.post(\n  "/resend-verification"'),
  );

  assert.match(registration, /strongSignupPassword\(password\)/);
  assert.match(registration, /password !== confirmPassword/);
  assert.match(registration, /bcrypt\.hash\(password, 12\)/);
  assert.match(registration, /password_hash/);
  assert.match(registration, /email_verified/);
  assert.match(registration, /'pending'/);
  assert.match(registration, /'goodfleet'/);
  assert.match(registration, /goodFleetRole/);
  assert.match(registration, /createVerificationToken/);
  assert.match(registration, /\[\s*email,\s*passwordHash,/);
});

test("Email verification activates both the identity and GoodFleet membership", () => {
  const routes = read("src/routes/auth.routes.js");
  const verification = routes.slice(
    routes.indexOf('router.get(\n  "/verify-email"'),
    routes.indexOf('router.post(\n  "/login"'),
  );

  assert.match(verification, /email_verified = true/);
  assert.match(verification, /status = 'active'/);
  assert.match(verification, /app_id IN \('goodos', 'goodfleet'\)/);
  assert.match(verification, /token\.status = 'active'/);
  assert.match(verification, /token\.used_at IS NULL/);
  assert.match(verification, /token\.expires_at > NOW\(\)/);
});
