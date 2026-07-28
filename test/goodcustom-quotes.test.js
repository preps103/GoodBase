"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const database = require("../src/config/database");
const quotes = require("../src/services/goodcustom-quotes.service");

test("GoodCustom quotes validate and bound customer input", () => {
  const quote = quotes.normalizeQuote({
    name: " Maurice Goodloe ",
    email: "MAURICE@GOODOS.APP",
    phone: "(555) 555-1212",
    carModel: "Audi A6",
    service: "wrap",
    message: " Satin black ",
    startingEstimate: 3500,
    options: ["finish:satin"],
  });
  assert.equal(quote.email, "maurice@goodos.app");
  assert.equal(quote.message, "Satin black");
  assert.equal(quote.startingEstimate, 3500);
  assert.throws(() => quotes.normalizeQuote({}), /valid name/);
  assert.throws(
    () => quotes.normalizeQuote({ ...quote, service: "unsupported" }),
    /valid service/,
  );
});

test("GoodCustom quote management fails closed for regular members", async () => {
  const originalQuery = database.query;
  database.query = async () => ({ rows: [] });
  try {
    await assert.rejects(
      () => quotes.requireManagement({
        id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
        platformRole: "member",
      }),
      (error) => error.statusCode === 403
        && error.code === "GOODCUSTOM_QUOTE_MANAGEMENT_REQUIRED",
    );
  } finally {
    database.query = originalQuery;
  }
});

test("GoodCustom quote migration keeps application tables deployment-owned", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "../migrations/20260728_goodcustom_quote_requests.sql"),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodcustom_quote_requests/);
  assert.match(migration, /starting_estimate_cents BIGINT/);
  assert.match(migration, /idx_goodcustom_quote_request_key/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE/);
  assert.doesNotMatch(migration, /REFERENCES users/);
});

test("GoodCustom quotes ship an idempotent production migration runner", () => {
  const runner = fs.readFileSync(
    path.join(__dirname, "../scripts/apply-goodcustom-quotes-migration.js"),
    "utf8",
  );
  assert.match(runner, /DATABASE_URL is required/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /20260728_goodcustom_quote_requests\.sql/);
});

test("GoodCustom quote routes require authentication and expose management operations", () => {
  const routes = fs.readFileSync(
    path.join(__dirname, "../src/routes/goodcustom-quotes.routes.js"),
    "utf8",
  );
  assert.match(routes, /router\.use\(authRequired, requireGoodCustomAccess\)/);
  assert.match(routes, /router\.post\("\/"/);
  assert.match(routes, /router\.get\("\/"/);
  assert.match(routes, /router\.delete\("\/:quoteId"/);
  assert.match(routes, /Idempotency-Key/);
});
