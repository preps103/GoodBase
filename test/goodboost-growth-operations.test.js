"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("GoodBoost growth operations migration provides normalized product data", () => {
  const migration = read("migrations/20260802_goodboost_growth_operations.sql");
  for (const table of ["goodboost_publishing_posts", "goodboost_inbox_items", "goodboost_metric_snapshots"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /pending_approval/);
  assert.match(migration, /UNIQUE\(user_id,idempotency_key\)/);
});

test("GoodBoost exposes planner, inbox, analytics, and report routes", () => {
  const routes = read("src/routes/goodboost.routes.js");
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
  assert.doesNotMatch(routes, /new Set\(\["draft","pending_approval","scheduled","publishing","published","failed"\]\)/);
});
