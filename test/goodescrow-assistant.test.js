"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assistant = require("../src/services/goodescrow-assistant.service");

test("GoodEscrow assistant gives honest guided operational help", () => {
  const result = assistant.advice({ query: "When should I release a milestone?" });
  assert.equal(result.mode, "guided");
  assert.equal(result.legalAdvice, false);
  assert.match(result.text, /objective release milestone/i);
  assert.match(result.text, /not legal advice/i);
  assert.throws(() => assistant.advice({ query: "  " }), /question is required/i);
});

test("GoodEscrow assistant drafts bounded deterministic release terms", () => {
  const result = assistant.draftTerms({
    title: "Website delivery",
    buyerName: "Buyer",
    sellerName: "Seller",
    amount: 2500,
    currency: "usd",
  });
  assert.equal(result.mode, "guided");
  assert.match(result.text, /2,500\.00 USD/);
  assert.match(result.text, /required evidence/);
  assert.throws(() => assistant.draftTerms({ amount: -1 }), /title, buyer, and seller/i);
});

test("GoodEscrow assistant is authenticated, app-scoped, and centrally mounted", () => {
  const routes = fs.readFileSync(
    path.join(__dirname, "../src/routes/goodescrow-assistant.routes.js"),
    "utf8",
  );
  const index = fs.readFileSync(path.join(__dirname, "../src/routes/index.js"), "utf8");
  assert.match(routes, /router\.use\(authRequired, requireGoodEscrowAccess, limiter\)/);
  assert.match(routes, /router\.post\("\/advice"/);
  assert.match(routes, /router\.post\("\/draft-terms"/);
  assert.match(index, /\/api\/apps\/goodescrow\/v1\/assistant/);
});
