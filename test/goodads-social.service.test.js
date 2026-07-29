"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const social = require("../src/services/goodads-social.service");

test("GoodAds social registry includes major publishing networks", () => {
  for (const provider of ["google", "facebook", "instagram", "threads", "linkedin", "x", "tiktok", "pinterest", "reddit"]) {
    assert.ok(social.PROVIDERS[provider]);
    assert.ok(social.PROVIDERS[provider].authUrl.startsWith("https://"));
    assert.ok(social.PROVIDERS[provider].tokenUrl.startsWith("https://"));
  }
});

test("social tokens are authenticated-encrypted at rest", () => {
  process.env.GOODADS_OAUTH_ENCRYPTION_KEY = "test-only-key";
  const encrypted = social.encrypt("provider-token");
  assert.notEqual(encrypted.ciphertext, "provider-token");
  assert.equal(social.decrypt(encrypted.ciphertext, encrypted.iv, encrypted.tag), "provider-token");
});

test("unconfigured providers are reported without fabricated success", () => {
  delete process.env.GOODADS_X_CLIENT_ID;
  delete process.env.GOODADS_X_CLIENT_SECRET;
  assert.equal(social.providerConfig("x").configured, false);
  assert.throws(() => social.providerConfig("unknown"), /Unsupported social provider/);
});

test("provider capability registry reports only installed publishing adapters", () => {
  for (const provider of ["x", "linkedin", "facebook", "reddit"]) {
    assert.equal(social.PROVIDER_PUBLISH_CAPABILITIES[provider].text, true);
    assert.equal(social.PROVIDER_PUBLISH_CAPABILITIES[provider].immediate, true);
  }
  for (const provider of ["google", "instagram", "threads", "tiktok", "pinterest"]) {
    assert.equal(social.PROVIDER_PUBLISH_CAPABILITIES[provider].text, false);
    assert.equal(social.PROVIDER_PUBLISH_CAPABILITIES[provider].immediate, false);
  }
  for (const capabilities of Object.values(social.PROVIDER_PUBLISH_CAPABILITIES)) {
    assert.equal(capabilities.media, false);
    assert.equal(capabilities.scheduling, false);
    assert.equal(capabilities.paidAds, false);
  }
});

test("paid campaigns fail closed until real provider adapters are installed", () => {
  assert.throws(
    () => social.rejectPaidCampaignLaunch(),
    (error) => (
      error.statusCode === 503
      && error.code === "GOODADS_AD_PROVIDER_NOT_READY"
      && /remains saved and ready/i.test(error.message)
    )
  );
});

test("GoodAds routes expose capability truth and durable publishing history", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  assert.match(routes, /router\.get\("\/capabilities"/);
  assert.match(routes, /router\.get\("\/publishing\/jobs"/);
  assert.match(routes, /router\.get\("\/publishing\/jobs\/:id"/);
  assert.match(routes, /social\.rejectPaidCampaignLaunch\(\)/);
  assert.doesNotMatch(routes, /campaigns\.launched/);
});
