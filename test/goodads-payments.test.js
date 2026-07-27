"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  PAYMENT_PROVIDERS,
  formatMinorAmount,
  normalizeCredentials,
  normalizeEnvironment,
  normalizeOffer,
  normalizeProvider,
  validateCredentials,
  verifySquareSignature,
  verifyStripeSignature,
  webhookSessionIdentity,
} = require("../src/services/goodads-payments.service");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function response(payload, ok = true) {
  return { ok, json: async () => payload };
}

test("GoodAds registers Stripe, PayPal, and Square behind one provider contract", () => {
  assert.deepEqual(Object.keys(PAYMENT_PROVIDERS), ["stripe", "paypal", "square"]);
  assert.equal(normalizeProvider(" Stripe "), "stripe");
  assert.equal(normalizeEnvironment("LIVE"), "live");
  assert.throws(() => normalizeProvider("unknown"), /unsupported payment provider/i);
  assert.throws(() => normalizeEnvironment("production"), /sandbox or live/i);
});

test("payment credentials support secure two-step webhook activation", () => {
  assert.deepEqual(
    normalizeCredentials("stripe", { secretKey: "sk_test_example", webhookSecret: "whsec_example" }),
    { secretKey: "sk_test_example", webhookSecret: "whsec_example" }
  );
  assert.deepEqual(
    normalizeCredentials("stripe", { secretKey: "sk_test_example" }),
    { secretKey: "sk_test_example", webhookSecret: "" }
  );
  assert.deepEqual(
    normalizeCredentials("paypal", { clientId: "id", clientSecret: "secret" }),
    { clientId: "id", clientSecret: "secret", webhookId: "" }
  );
  assert.deepEqual(
    normalizeCredentials("square", { accessToken: "token", locationId: "location" }),
    { accessToken: "token", locationId: "location", signatureKey: "" }
  );
});

test("payment offers use integer minor units and bounded provider choices", () => {
  const offer = normalizeOffer({
    name: "Launch consultation",
    publicSlug: "launch-consultation",
    amountMinor: 12500,
    currency: "usd",
    enabledProviders: ["stripe", "paypal", "stripe"],
    status: "active",
  });
  assert.equal(offer.amountMinor, 12500);
  assert.equal(offer.currency, "USD");
  assert.deepEqual(offer.enabledProviders, ["stripe", "paypal"]);
  assert.throws(() => normalizeOffer({ ...offer, amountMinor: 12.5 }), /smallest unit/i);
  assert.throws(() => normalizeOffer({ ...offer, publicSlug: "../checkout" }), /public payment address/i);
});

test("PayPal money formatting respects currency minor-unit exponents", () => {
  assert.equal(formatMinorAmount(1250, "USD"), "12.50");
  assert.equal(formatMinorAmount(1250, "JPY"), "1250");
  assert.equal(formatMinorAmount(1250, "KWD"), "1.250");
});

test("Stripe and Square webhook verification uses timestamp bounds and constant-time signatures", () => {
  const body = Buffer.from('{"id":"event_1"}');
  const now = 1_800_000_000;
  const stripeSecret = "whsec_example";
  const stripeSignature = crypto
    .createHmac("sha256", stripeSecret)
    .update(`${now}.${body.toString("utf8")}`)
    .digest("hex");
  assert.equal(verifyStripeSignature(body, `t=${now},v1=${stripeSignature}`, stripeSecret, now), true);
  assert.equal(verifyStripeSignature(body, `t=${now - 301},v1=${stripeSignature}`, stripeSecret, now), false);
  assert.equal(verifyStripeSignature(body, `t=${now},v1=bad`, stripeSecret, now), false);

  const squareUrl = "https://base.goodos.app/api/apps/goodads/v1/public/payment-webhooks/square/example";
  const squareSecret = "square-signature-key";
  const squareSignature = crypto
    .createHmac("sha256", squareSecret)
    .update(`${squareUrl}${body.toString("utf8")}`)
    .digest("base64");
  assert.equal(verifySquareSignature(body, squareSignature, squareSecret, squareUrl), true);
  assert.equal(verifySquareSignature(body, "bad", squareSecret, squareUrl), false);
});

test("provider webhooks map only authoritative completion states", () => {
  assert.deepEqual(
    webhookSessionIdentity("stripe", {
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", payment_status: "paid", metadata: { goodads_session_id: "session-1" } } },
    }),
    { sessionId: "session-1", providerReference: "cs_1", status: "completed" }
  );
  assert.equal(
    webhookSessionIdentity("paypal", {
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { supplementary_data: { related_ids: { order_id: "order-1" } } },
    }).status,
    "completed"
  );
  assert.equal(
    webhookSessionIdentity("square", {
      data: { object: { payment: { order_id: "order-2", status: "COMPLETED" } } },
    }).status,
    "completed"
  );
});

test("provider credential validation calls official account boundaries", async () => {
  const stripe = await validateCredentials(
    "stripe",
    "sandbox",
    { secretKey: "sk_test_example", webhookSecret: "whsec_example" },
    async (url) => {
      assert.equal(url, "https://api.stripe.com/v1/account");
      return response({ id: "acct_1", charges_enabled: true, payouts_enabled: true });
    }
  );
  assert.equal(stripe.accountReference, "acct_1");

  const paypal = await validateCredentials(
    "paypal",
    "sandbox",
    { clientId: "client", clientSecret: "secret", webhookId: "webhook" },
    async (url) => {
      assert.equal(url, "https://api-m.sandbox.paypal.com/v1/oauth2/token");
      return response({ access_token: "token" });
    }
  );
  assert.equal(paypal.capabilities.capture, true);

  const square = await validateCredentials(
    "square",
    "sandbox",
    { accessToken: "token", locationId: "loc_1", signatureKey: "signature" },
    async (url) => {
      assert.equal(url, "https://connect.squareupsandbox.com/v2/locations");
      return response({ locations: [{ id: "loc_1", name: "Main store", currency: "USD", status: "ACTIVE" }] });
    }
  );
  assert.equal(square.accountLabel, "Main store");
});

test("GoodAds payment routes preserve raw webhook bodies and separate public and authenticated operations", () => {
  const app = read("src/app.js");
  const routes = read("src/routes/goodads.routes.js");
  assert.match(app, /req\.rawBody = Buffer\.from\(buffer\)/);
  assert.match(routes, /\/public\/payment-webhooks\/:provider\/:connectionId/);
  assert.match(routes, /\/public\/payment-offers\/:slug\/checkout/);
  assert.match(routes, /router\.use\(authRequired, tenantContext, requireGoodAdsAccess\)/);
  assert.ok(
    routes.indexOf('router.post("/public/payment-webhooks/:provider/:connectionId"')
      < routes.indexOf("router.use(authRequired, tenantContext, requireGoodAdsAccess)"),
    "verified provider webhooks must be mounted before browser authentication"
  );
  assert.ok(
    routes.indexOf('router.put("/payments/providers/:provider"')
      > routes.indexOf("router.use(authRequired, tenantContext, requireGoodAdsAccess)"),
    "credential management must require authenticated GoodAds access"
  );
});
