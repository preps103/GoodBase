"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const social = require("../src/services/goodboost-social.service");
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
});
