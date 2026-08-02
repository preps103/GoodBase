"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const social = require("../src/services/goodboost-social.service");

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
