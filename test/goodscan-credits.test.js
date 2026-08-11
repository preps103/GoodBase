"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const credits = require("../src/services/goodscan-credits.service");

const root = path.join(__dirname, "..");
const source = relativePath => fs.readFileSync(path.join(root, relativePath), "utf8");

function manifest(overrides = {}) {
  return {
    schema: "goodscan.ai-generation.v1",
    mode: "text",
    settings: { quality: "balanced", generationCount: 1, textureResolution: "2K", ...overrides.settings },
    operations: ["remesh"],
    outputFormats: ["GLB"],
    ...overrides,
  };
}

test("GoodScan generation quotes are deterministic and increase for advanced work", () => {
  const basic = credits.quoteGeneration(manifest());
  const advanced = credits.quoteGeneration(manifest({
    mode: "multiview",
    settings: { quality: "high-detail", generationCount: 2, textureResolution: "8K" },
    operations: ["remesh", "uv-unwrap", "pbr-texture", "rig", "animate"],
    outputFormats: ["GLB", "OBJ", "FBX", "USDZ"],
  }));
  assert.equal(basic.credits, 24);
  assert.ok(advanced.credits > basic.credits);
  assert.equal(advanced.breakdown.variations, 2);
});

test("GoodScan generation quotes reject client-controlled unknown work", () => {
  assert.throws(
    () => credits.quoteGeneration(manifest({ operations: ["free-premium-operation"] })),
    error => error.statusCode === 400,
  );
  assert.throws(
    () => credits.quoteGeneration(manifest({ settings: { generationCount: 500 } })),
    error => error.statusCode === 400,
  );
});

test("GoodScan billing schema is an immutable ledger with idempotent fulfillment", () => {
  const migration = source("migrations/20260810_goodscan_credit_billing.sql");
  const service = source("src/services/goodscan-credits.service.js");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodscan_credit_ledger/);
  assert.match(migration, /idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(migration, /UNIQUE \(owner_user_id, idempotency_key\)/);
  assert.match(service, /stripe-checkout:/);
  assert.match(service, /payment_status === "unpaid"/);
  assert.match(service, /charge\.refunded/);
});

test("GoodScan Stripe webhook is public, signed, and mounted before application auth", () => {
  const routes = source("src/routes/goodscan.routes.js");
  const webhook = routes.indexOf('router.post("/credits/webhooks/stripe"');
  const auth = routes.indexOf("router.use(authRequired, requireGoodScanAccess)");
  assert.ok(webhook >= 0 && webhook < auth);
  assert.match(routes, /webhooks\.constructEvent/);
  assert.match(source("src/app.js"), /\/api\/goodscan\/v1\/credits\/webhooks\/stripe/);
});

test("GoodScan checkout accepts only a product SKU and server-loaded pricing", () => {
  const routes = source("src/routes/goodscan.routes.js");
  const service = source("src/services/goodscan-credits.service.js");
  assert.match(routes, /productSku: req\.body\?\.productSku/);
  assert.doesNotMatch(routes, /priceCents: req\.body/);
  assert.match(service, /SELECT \* FROM goodscan_credit_products WHERE sku=\$1 AND active=TRUE/);
  assert.match(service, /unit_amount: Number\(row\.price_cents\)/);
});
