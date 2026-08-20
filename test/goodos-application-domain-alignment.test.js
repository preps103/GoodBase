"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = fs.readFileSync(
  path.join(__dirname, "../migrations/20260820_align_goodos_application_domains.sql"),
  "utf8"
);
const runner = fs.readFileSync(
  path.join(__dirname, "../scripts/apply-goodos-application-domain-migration.js"),
  "utf8"
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")
);

test("canonical GoodSure and GoodSupply domains are repaired idempotently", () => {
  assert.match(migration, /WHERE id = 'goodsure'/);
  assert.match(migration, /domain = 'sure\.goodos\.app'/);
  assert.match(migration, /WHERE id = 'supplyguyz'/);
  assert.match(migration, /name = 'GoodSupply'/);
  assert.match(migration, /domain = 'supply\.goodos\.app'/);
  assert.match(migration, /IS DISTINCT FROM/);
  assert.match(migration, /status = 'active'/);
});

test("domain alignment has a locked and verified production runner", () => {
  assert.match(runner, /20260820_align_goodos_application_domains\.sql/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /isAligned\(before\)/);
  assert.match(runner, /isAligned\(after\)/);
  assert.match(packageJson.scripts["migrate:applications"], /apply-goodsupply-rename-migration/);
  assert.match(packageJson.scripts["migrate:applications"], /apply-goodos-application-domain-migration/);
  assert.match(packageJson.scripts.build, /npm run migrate:applications/);
});
