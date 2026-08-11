"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("GoodBoost growth operations migration provides normalized product data", () => {
  const migration = read("migrations/20260802_goodboost_growth_operations.sql");
  const delivery = read("migrations/20260811_goodboost_delivery_worker.sql");
  for (const table of ["goodboost_publishing_posts", "goodboost_inbox_items", "goodboost_metric_snapshots"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /pending_approval/);
  assert.match(migration, /UNIQUE\(user_id,idempotency_key\)/);
  assert.match(delivery, /attempts INTEGER NOT NULL DEFAULT 0/);
  assert.match(delivery, /provider_receipt JSONB/);
  assert.match(delivery, /job_goodboost_social_publish/);
  assert.match(delivery, /goodboost\.social\.publish/);
});

test("GoodBoost exposes planner, inbox, analytics, and report routes", () => {
  const routes = read("src/routes/goodboost.routes.js");
  const social = read("src/services/goodboost-social.service.js");
  const jobs = read("src/services/job.service.js");
  for (const contract of [
    'router.get("/operations"',
    'router.post("/publishing/posts"',
    'router.patch("/publishing/posts/:id"',
    'router.patch("/inbox/:id"',
    'router.get("/reports/export"',
  ]) assert.equal(routes.includes(contract), true, `${contract} should exist`);
  assert.match(routes, /Idempotency-Key/);
  assert.match(routes, /Cache-Control", "private, no-store/);
  assert.match(routes, /GOODBOOST_PUBLISHING_NOT_CONFIGURED/);
  assert.match(routes, /safePublicHttpsUrl/);
  assert.match(routes, /publishingPlatforms/);
  assert.match(routes, /publishingReadiness/);
  assert.match(social, /FOR UPDATE SKIP LOCKED/);
  assert.match(social, /adapter\(provider,"PUBLISH"/);
  assert.match(social, /MAX_ADAPTER_RESPONSE_BYTES/);
  assert.match(social, /goodboost_inbox_items/);
  assert.match(social, /goodboost_metric_snapshots/);
  assert.match(jobs, /case "goodboost\.social\.publish"/);
  assert.doesNotMatch(routes, /new Set\(\["draft","pending_approval","scheduled","publishing","published","failed"\]\)/);
});
