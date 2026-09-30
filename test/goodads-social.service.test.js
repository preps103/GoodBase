"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const social = require("../src/services/goodads-social.service");

test("GoodAds social registry includes major publishing networks", () => {
  for (const provider of ["google", "facebook", "instagram", "threads", "linkedin", "x", "x_ads", "tiktok", "tiktok_ads", "pinterest", "snapchat", "reddit"]) {
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
  for (const provider of ["x", "linkedin", "threads", "reddit"]) {
    assert.equal(social.PROVIDER_PUBLISH_CAPABILITIES[provider].text, true);
    assert.equal(social.PROVIDER_PUBLISH_CAPABILITIES[provider].immediate, true);
  }
  for (const provider of ["google", "facebook", "instagram", "x_ads", "tiktok", "tiktok_ads", "pinterest"]) {
    assert.equal(social.PROVIDER_PUBLISH_CAPABILITIES[provider].text, false);
    assert.equal(social.PROVIDER_PUBLISH_CAPABILITIES[provider].immediate, false);
  }
  for (const capabilities of Object.values(social.PROVIDER_PUBLISH_CAPABILITIES)) {
    assert.equal(capabilities.media, false);
    assert.equal(capabilities.scheduling, false);
    assert.equal(capabilities.paidAds, false);
  }
});

test("X Ads uses a separate OAuth 1.0a business authorization", () => {
  const names = ["GOODADS_X_ADS_CONSUMER_KEY", "GOODADS_X_ADS_CONSUMER_SECRET"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      GOODADS_X_ADS_CONSUMER_KEY: "consumer-key",
      GOODADS_X_ADS_CONSUMER_SECRET: "consumer-secret",
    });
    const config = social.providerConfig("x_ads");
    assert.equal(config.oauthStyle, "oauth1");
    assert.equal(config.configured, true);
    assert.deepEqual(config.scopes, ["ads.read", "ads.write"]);
    const header = social.oauth1AuthorizationHeader(
      config,
      "https://ads-api.x.com/12/accounts?count=1000",
      "GET",
      "access-token",
      "token-secret"
    );
    assert.match(header, /^OAuth /);
    assert.match(header, /oauth_signature_method="HMAC-SHA1"/);
    assert.match(header, /oauth_token="access-token"/);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("GoodAds routes expose capability truth and durable publishing history", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  assert.match(routes, /router\.get\("\/capabilities"/);
  assert.match(routes, /router\.get\("\/publishing\/jobs"/);
  assert.match(routes, /router\.get\("\/publishing\/jobs\/:id"/);
  assert.match(routes, /router\.post\("\/publishing\/jobs\/:id\/cancel"/);
  assert.match(routes, /router\.post\("\/publishing\/jobs\/:id\/retry"/);
  assert.match(routes, /router\.delete\("\/connections\/account\/:id"/);
  assert.match(routes, /ads\.launchCampaign\(/);
  assert.match(routes, /\/ads\/accounts\/discover/);
  assert.match(routes, /\/activation-approval/);
  assert.doesNotMatch(routes, /campaigns\.launched/);
});

test("publishing input is bounded and scheduling is timezone aware", () => {
  assert.deepEqual(
    social.normalizePublishContent({ text: "  Hello world  ", title: " Launch " }),
    { text: "Hello world", title: "Launch" }
  );
  assert.throws(() => social.normalizePublishContent({ text: "" }), /Post text/);
  assert.throws(() => social.normalizePublishContent({ text: "x".repeat(5001) }), /5,000/);
  const schedule = social.normalizeSchedule(new Date(Date.now() + 60000).toISOString(), "America/Los_Angeles");
  assert.equal(schedule.timezone, "America/Los_Angeles");
  assert.equal(schedule.scheduled, true);
  assert.throws(() => social.normalizeSchedule(new Date().toISOString(), "Not/A_Zone"), /IANA timezone/);
});

test("publishing targets require opaque UUID account identifiers", () => {
  assert.deepEqual(
    social.normalizeConnectionIds([
      "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
      "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    ]),
    ["89e0e5e1-ee43-4c9a-a41b-6b07bb920430"]
  );
  assert.throws(() => social.normalizeConnectionIds(["facebook"]), /identifier is invalid/);
});

test("publishing migration installs account targets, scheduling, retries, and worker dispatch", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../migrations/20260729_goodads_publishing_queue.sql"), "utf8");
  const jobs = fs.readFileSync(path.join(__dirname, "../src/services/job.service.js"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_publish_targets/);
  assert.match(migration, /scheduled_for TIMESTAMPTZ/);
  assert.match(migration, /'dead_letter'/);
  assert.match(migration, /'goodads\.social\.publish'/);
  assert.match(jobs, /case "goodads\.social\.publish"/);
  assert.match(packageJson.scripts.build, /apply-goodads-publishing-migration/);
});

test("publishing workers recover abandoned locks and disconnects erase exact-account tokens", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/services/goodads-social.service.js"), "utf8");
  assert.match(source, /status = 'processing' AND locked_until < NOW\(\)/);
  assert.match(source, /Recovered after an interrupted publishing worker/);
  assert.match(source, /access_token_ciphertext = ''/);
  assert.match(source, /disconnectConnection\(\{ context, userId, id: row\.id \}\)/);
  assert.doesNotMatch(source, /response\.status === 401 \|\| response\.status === 429/);
});
