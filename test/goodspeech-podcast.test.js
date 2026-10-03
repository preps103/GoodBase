"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.MFA_ENCRYPTION_KEY ||= "0".repeat(64);

const podcast = require("../src/services/goodspeech-podcast.service");

test("GoodSpeech podcast RSS escapes untrusted metadata and publishes bounded enclosures", () => {
  const xml = podcast.rssXml({
    origin: "https://base.goodos.app",
    feed: {
      public_token: "a".repeat(43),
      title: "Good <Speech> & friends",
      description: "Audio > text",
      author: 'A "Creator"',
      language: "en-us",
    },
    episodes: [{
      id: "9c42d40d-4a90-4a9a-8e23-29e18d8973bb",
      title: "Episode <one>",
      description: "Safe & published",
      published_at: "2026-10-03T12:00:00.000Z",
      size_bytes: 1200,
      mime_type: "audio/wav",
      duration_seconds: 65,
      episode_number: 1,
    }],
  });
  assert.match(xml, /^<\?xml version="1\.0"/);
  assert.match(xml, /Good &lt;Speech&gt; &amp; friends/);
  assert.match(xml, /A &quot;Creator&quot;/);
  assert.match(xml, /<enclosure url="https:\/\/base\.goodos\.app\/api\/goodspeech\/v1\/podcasts\/public\/a{43}\/episodes\//);
  assert.match(xml, /<itunes:duration>0:01:05<\/itunes:duration>/);
  assert.doesNotMatch(xml, /<title>Good <Speech>/);
});

test("GoodSpeech podcast public identifiers reject malformed capabilities", () => {
  assert.equal(podcast._internal.token("b".repeat(43)), "b".repeat(43));
  assert.throws(() => podcast._internal.token("too-short"), /not found/i);
  assert.throws(() => podcast._internal.uuid("not-a-uuid"), /valid ID/i);
});

test("GoodSpeech podcast contract keeps public reads ahead of authentication and owner scopes writes", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "goodspeech-podcast.routes.js"), "utf8");
  const service = fs.readFileSync(path.join(__dirname, "..", "src", "services", "goodspeech-podcast.service.js"), "utf8");
  assert.ok(routes.indexOf('router.get("/public/:token/feed.xml"') < routes.indexOf("router.use(authRequired"));
  assert.match(routes, /requireGoodSpeechAccess/);
  assert.match(routes, /goodspeech\.podcast\.publish/);
  assert.match(service, /owner_user_id = \$3::uuid/);
  assert.match(service, /f\.status = 'active'/);
  assert.match(service, /AUDIO_TYPES\.has\(asset\.mime_type\)/);
});
