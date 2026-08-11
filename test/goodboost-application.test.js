"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodBoost stores user-owned application data in GoodBase", () => {
  const migration = read("migrations/20260811_goodboost_production_core.sql");
  const runner = read("scripts/apply-goodboost-social-migration.js");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodboost_profiles/);
  assert.match(migration, /REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /'goodboost', 'GoodBoost', 'boost\.goodos\.app'/);
  assert.match(migration, /social-audience and growth-operations workspace/);
  assert.doesNotMatch(migration, /goodboost_campaigns|goodboost_activity|credit/);
  assert.match(runner, /20260811_goodboost_production_core\.sql/);
  assert.match(runner, /goodboost_profiles/);
  assert.match(runner, /client\.query\("BEGIN"\)/);
  assert.match(runner, /client\.query\("ROLLBACK"\)/);
});

test("GoodBoost API is authenticated, origin-bound, and excludes the retired exchange prototype", () => {
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
  assert.doesNotMatch(routes, /router\.post\("\/campaigns"/);
  assert.doesNotMatch(routes, /router\.post\("\/activity"/);
  assert.doesNotMatch(routes, /publicCampaign/);
  assert.doesNotMatch(routes, /activityLogs/);
  assert.match(routes, /safePublicHttpsUrl\(webhook\)/);
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
