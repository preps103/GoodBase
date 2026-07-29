"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const analytics = require("../src/services/goodads-analytics.service");

test("GoodAds analytics accepts bounded provider reporting periods", () => {
  assert.deepEqual(
    analytics._test.normalizePeriod("2026-07-01", "2026-07-29"),
    { start: "2026-07-01", end: "2026-07-29" }
  );
  assert.throws(
    () => analytics._test.normalizePeriod("2026-01-01", "2026-07-29"),
    /cannot exceed 93 days/
  );
  assert.throws(
    () => analytics._test.normalizePeriod("2026-07-30", "2026-07-29"),
    /valid analytics date range/
  );
});

test("Meta conversion parsing counts only explicit result actions", () => {
  const actions = [
    { action_type: "lead", value: "3" },
    { action_type: "purchase", value: "2" },
    { action_type: "page_engagement", value: "99" },
  ];
  assert.equal(analytics._test.actionTotal(actions, new Set(["lead", "purchase"])), 5);
  assert.equal(analytics._test.actionTotal(actions, new Set(["purchase"])), 2);
});

test("analytics migration persists provider snapshots and automatic sync", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "../migrations/20260729_goodads_analytics.sql"),
    "utf8"
  );
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  const jobs = fs.readFileSync(path.join(__dirname, "../src/services/job.service.js"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_analytics_snapshots/);
  assert.match(migration, /spend_micros BIGINT/);
  assert.match(migration, /conversion_value_micros BIGINT/);
  assert.match(migration, /'goodads\.analytics\.sync'/);
  assert.match(routes, /\/analytics\/overview/);
  assert.match(routes, /\/analytics\/provider-sync/);
  assert.match(jobs, /case "goodads\.analytics\.sync"/);
  assert.match(packageJson.scripts.build, /apply-goodads-analytics-migration/);
});

test("analytics reports verified provider values and keeps revenue separated by currency", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/goodads-analytics.service.js"),
    "utf8"
  );
  assert.match(source, /DISTINCT ON \(snapshot\.provider_campaign_id\)/);
  assert.match(source, /GROUP BY provider, COALESCE/);
  assert.match(source, /GROUP BY currency/);
  assert.match(source, /resource_type = 'leads'/);
  assert.match(source, /link_hubs\.clicked/);
  assert.doesNotMatch(source, /sample/i);
});
