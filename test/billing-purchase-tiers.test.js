const test = require("node:test");
const assert = require("node:assert/strict");

const billing = require("../src/services/billing.service")._test;

test("normalizes the four supported GoodOS purchase tiers", () => {
  for (const tier of ["single", "five", "ten", "suite"]) {
    assert.equal(billing.normalizePurchaseTier(tier), tier);
  }
  assert.throws(() => billing.normalizePurchaseTier("unlimited"), /valid GoodOS purchase tier/);
});

test("matches plans to tiers using canonical metadata", () => {
  assert.equal(billing.planMatchesTier({ metadata: { purchaseTier: "five" } }, "five"), true);
  assert.equal(billing.planMatchesTier({ name: "goodos-suite" }, "suite"), true);
  assert.equal(billing.planMatchesTier({ name: "single-app" }, "ten"), false);
});

test("accepts only card and PayPal payment methods", () => {
  assert.equal(billing.normalizePaymentMethod("card"), "card");
  assert.equal(billing.normalizePaymentMethod("paypal"), "paypal");
  assert.throws(() => billing.normalizePaymentMethod("cash"), /card or PayPal/);
});

test("reports both checkout methods unavailable without provider configuration", () => {
  const plans = [{ metadata: { purchaseTier: "single" } }];
  const methods = billing.checkoutMethods(plans);
  assert.deepEqual(methods.map(method => method.id), ["card", "paypal"]);
  assert.equal(methods.every(method => method.available === false), true);
});
