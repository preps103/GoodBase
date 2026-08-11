"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const social = require("../src/services/goodboost-social.service");
const database = require("../src/config/database");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

test("GoodBoost exposes major and federated provider capabilities honestly", () => {
  const providers = social.providers();
  const names = new Set(providers.map((provider) => provider.platform));
  for (const expected of ["Twitter","YouTube","Instagram","TikTok","Facebook","LinkedIn","Pinterest","Twitch","Reddit","Threads","Bluesky","Mastodon"]) {
    assert.equal(names.has(expected), true, `${expected} should be registered`);
  }
  assert.equal(providers.find((provider) => provider.platform === "Bluesky").available, false);
  assert.equal(providers.find((provider) => provider.platform === "Mastodon").available, false);
  assert.equal(providers.find((provider) => provider.platform === "Instagram").capabilities.unfollow, false);
  assert.equal(providers.every((provider) => provider.available === false), true);
  assert.deepEqual(social.publishingPlatforms(), []);
  assert.equal(social.publishingConfigured(), false);
});

test("GoodBoost OAuth state is persisted and can only be consumed once", () => {
  const migration = fs.readFileSync(path.join(root, "migrations/20260801_goodboost_social_connectors.sql"), "utf8");
  const service = fs.readFileSync(path.join(root, "src/services/goodboost-social.service.js"), "utf8");
  assert.match(migration, /goodboost_social_oauth_states/);
  assert.match(service, /consumed_at IS NULL/);
  assert.match(service, /GOODBOOST_OAUTH_STATE_REPLAYED/);
});

test("GoodBoost relationship actions require confirmation and transactional limits", () => {
  const routes = fs.readFileSync(path.join(root, "src/routes/goodboost.routes.js"), "utf8");
  const service = fs.readFileSync(path.join(root, "src/services/goodboost-social.service.js"), "utf8");
  assert.match(routes, /GOODBOOST_CONFIRMATION_REQUIRED/);
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /status IN \('processing','completed'\)/);
  assert.match(service, /actionUsage/);
  assert.doesNotMatch(routes, /req\.body\?\.dailyLimit/);
});

test("GoodBoost publishing is provider-specific and fails closed", async () => {
  const previous = {
    enabled: process.env.GOODBOOST_PUBLISHING_ENABLED,
    token: process.env.GOODBOOST_PROVIDER_ADAPTER_TOKEN,
    twitter: process.env.GOODBOOST_TWITTER_PUBLISH_URL,
  };
  const originalQuery = database.query;
  try {
    delete process.env.GOODBOOST_PUBLISHING_ENABLED;
    delete process.env.GOODBOOST_PROVIDER_ADAPTER_TOKEN;
    delete process.env.GOODBOOST_TWITTER_PUBLISH_URL;
    assert.deepEqual(social.publishingPlatforms(), []);
    assert.deepEqual(await social.processDuePublishingPosts(), {
      processed: 0, published: 0, retrying: 0, failed: 0, skipped: "publishing_disabled",
    });

    process.env.GOODBOOST_PUBLISHING_ENABLED = "true";
    process.env.GOODBOOST_PROVIDER_ADAPTER_TOKEN = "test-adapter-token";
    process.env.GOODBOOST_TWITTER_PUBLISH_URL = "https://provider.example/publish";
    assert.deepEqual(social.publishingPlatforms(), ["Twitter"]);
    assert.equal(social.publishingConfigured("Twitter"), true);
    assert.equal(social.publishingConfigured("YouTube"), false);
    database.query = async () => ({ rows: [] });
    assert.deepEqual(await social.publishingReadiness("Twitter"), {
      workerReady: false,
      publishingPlatforms: [],
      configured: false,
    });
    database.query = async () => ({ rows: [{ "?column?": 1 }] });
    assert.deepEqual(await social.publishingReadiness("Twitter"), {
      workerReady: true,
      publishingPlatforms: ["Twitter"],
      configured: true,
    });
  } finally {
    database.query = originalQuery;
    for (const [key, value] of Object.entries({
      GOODBOOST_PUBLISHING_ENABLED: previous.enabled,
      GOODBOOST_PROVIDER_ADAPTER_TOKEN: previous.token,
      GOODBOOST_TWITTER_PUBLISH_URL: previous.twitter,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
