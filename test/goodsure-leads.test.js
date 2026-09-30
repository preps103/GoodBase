"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const leads = require("../src/services/goodsure-leads.service");

test("GoodSure leads validate and normalize customer input", () => {
  const lead = leads.normalizeLead({
    name: " Maurice Goodloe ",
    email: "MAURICE@GOODOS.APP",
    phone: "(555) 555-1212",
    age: 35,
    coverageAmount: 500_000,
  });
  assert.equal(lead.name, "Maurice Goodloe");
  assert.equal(lead.email, "maurice@goodos.app");
  assert.equal(lead.coverageAmount, 500_000);
  assert.throws(() => leads.normalizeLead({}), /valid name/);
  assert.throws(
    () => leads.normalizeLead({ ...lead, age: 17 }),
    /between 18 and 100/,
  );
});

test("GoodSure lead updates only permit workflow fields", () => {
  assert.deepEqual(
    leads.normalizeUpdates({ status: "warmed", dialAttempts: 2 }),
    { status: "warmed", dial_attempts: 2 },
  );
  assert.throws(() => leads.normalizeUpdates({ email: "changed@example.com" }), /No supported/);
  assert.throws(() => leads.normalizeUpdates({ status: "deleted" }), /Invalid lead status/);
});

test("GoodSure routes expose public intake and protected management", () => {
  const routes = fs.readFileSync(
    path.join(__dirname, "../src/routes/goodsure-leads.routes.js"),
    "utf8",
  );
  const index = fs.readFileSync(path.join(__dirname, "../src/routes/index.js"), "utf8");
  assert.match(routes, /router\.post\("\/", intakeLimiter/);
  assert.match(routes, /router\.use\(authRequired, requireGoodSureAdmin\)/);
  assert.match(routes, /router\.get\("\/", readLimiter/);
  assert.match(routes, /router\.patch\("\/:leadId"/);
  assert.match(index, /\/api\/apps\/goodsure\/v1\/leads/);
});

test("GoodSure lead storage remains deployment-owned", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "../migrations/20260822_goodsure_leads.sql"),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodsure_leads/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE/);
  assert.doesNotMatch(migration, /REFERENCES users/);
});
