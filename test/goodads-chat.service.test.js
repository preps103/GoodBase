"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _test } = require("../src/services/goodads-chat.service");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

test("GoodAds chat validates and bounds message bodies", () => {
  assert.equal(_test.requireMessageBody("  Campaign is ready  "), "Campaign is ready");
  assert.throws(() => _test.requireMessageBody("   "), /Enter a message/);
  assert.throws(() => _test.requireMessageBody("x".repeat(4001)), /4,000 characters/);
});

test("GoodAds chat channel names produce safe tenant-local slugs", () => {
  assert.equal(_test.slugifyChannel("  Paid Social — West Coast  "), "paid-social-west-coast");
  assert.throws(() => _test.slugifyChannel("✨"), /channel name/);
  assert.equal(_test.normalizeChannelType(" MANAGEMENT "), "management");
  assert.throws(() => _test.normalizeChannelType("direct"), /visibility/);
});

test("GoodAds direct channel identity is order independent", () => {
  const first = "89e0e5e1-ee43-4c9a-a41b-6b07bb920430";
  const second = "7135a22c-2bed-4ebc-8d3d-0a30455e5d89";
  assert.equal(_test.directSlug([first, second]), _test.directSlug([second, first]));
});

test("GoodAds chat accepts bounded retry-safe message keys", () => {
  const key = "89e0e5e1-ee43-4c9a-a41b-6b07bb920430";
  assert.equal(_test.normalizeClientMessageKey(key), key);
  assert.equal(_test.normalizeClientMessageKey(""), null);
  assert.throws(() => _test.normalizeClientMessageKey("bad key"), /idempotency key/);
});

test("GoodAds chat migration persists tenant scope and bounded content", () => {
  const migration = read("migrations/20260728_goodads_internal_chat.sql");
  assert.match(migration, /organization_id TEXT NOT NULL/);
  assert.match(migration, /char_length\(body\) BETWEEN 1 AND 4000/);
  assert.match(migration, /PRIMARY KEY \(channel_id, user_id\)/);
  assert.match(migration, /idx_goodads_chat_message_idempotency/);
  assert.match(migration, /WHERE archived_at IS NULL/);
});

test("GoodAds chat routes run behind authentication, tenant context, and app entitlement", () => {
  const routes = read("src/routes/goodads.routes.js");
  const securityBoundary = routes.indexOf("router.use(authRequired, tenantContext, requireGoodAdsAccess)");
  const channelRoute = routes.indexOf('router.get("/chat/channels"');
  assert.ok(securityBoundary >= 0);
  assert.ok(channelRoute > securityBoundary);
  assert.match(routes, /chatMessageLimiter/);
});

test("GoodBase deployment applies and verifies the GoodAds chat migration", () => {
  const packageJson = JSON.parse(read("package.json"));
  const runner = read("scripts/apply-goodads-chat-migration.js");
  assert.match(packageJson.scripts.build, /node scripts\/apply-goodads-chat-migration\.js/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /DATABASE_URL is required/);
  assert.match(runner, /20260728_goodads_internal_chat\.sql/);
  assert.match(runner, /goodads_chat_channels/);
  assert.match(runner, /goodads_chat_channel_members/);
  assert.match(runner, /goodads_chat_messages/);
});
