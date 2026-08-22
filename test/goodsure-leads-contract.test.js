"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "20260822_goodsure_leads.sql"), "utf8");
const runner = fs.readFileSync(path.join(__dirname, "..", "scripts", "apply-goodsure-leads-migration.js"), "utf8");

test("GoodBase provisions constrained GoodSure lead storage", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodsure_leads/);
  assert.match(migration, /coverage_amount BETWEEN 10000 AND 10000000/);
  assert.match(migration, /status IN \('new', 'dialing', 'transferred', 'warmed', 'closed', 'lost'\)/);
  assert.match(migration, /allowed_app_ids/);
  assert.match(migration, /ARRAY\['goodsure'\]/);
  assert.match(migration, /delete_enabled[\s\S]*false/);
});

test("GoodSure storage migration verifies both the table and published API", () => {
  assert.match(runner, /TO_REGCLASS\('public\.goodsure_leads'\)/);
  assert.match(runner, /api_slug = 'goodsure-leads'/);
  assert.match(runner, /pg_advisory_lock/);
});
