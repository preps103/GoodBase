"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodBoost stores user-owned application data in GoodBase", () => {
  const migration = read("migrations/20260723_goodboost_application.sql");
  for (const table of ["goodboost_profiles", "goodboost_campaigns", "goodboost_activity"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /'goodboost', 'GoodBoost', 'boost\.goodos\.app'/);
});

test("GoodBoost API is authenticated, origin-bound, and server-validates campaigns", () => {
  const routes = read("src/routes/goodboost.routes.js");
  const index = read("src/routes/index.js");
  assert.match(index, /router\.use\("\/api\/goodboost", goodboostRoutes\)/);
  assert.match(routes, /router\.use\(authRequired\)/);
  assert.match(routes, /GOODBOOST_ORIGIN_DENIED/);
  assert.match(routes, /GOODBOOST_ACCESS_REQUIRED/);
  assert.match(routes, /X-Requested-With/);
  assert.match(routes, /url\.protocol !== "https:"/);
  assert.match(routes, /WHERE user_id=\$1/);
  assert.doesNotMatch(routes, /req\.body\?\.userId/);
});

test("GoodBoost persists the current onboarding completion state", () => {
  const routes = read("src/routes/goodboost.routes.js");
  assert.match(routes, /onboardingCompleted: settings\.onboardingCompleted === true/);
  assert.match(routes, /onboardingVersion: settings\.onboardingCompleted === true \? 1 : 0/);
});

test("GoodBase exposes only active social OIDC login providers", () => {
  const oidc = read("src/routes/oidc-login.routes.js");
  assert.match(oidc, /"\/providers"/);
  assert.match(oidc, /status = 'active'/);
  assert.match(oidc, /https:\/\/boost\.goodos\.app/);
});
