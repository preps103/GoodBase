"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const service = require("../src/services/goodads.service");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

test("GoodAds RSS fetch boundaries reject local and non-HTTPS destinations", () => {
  assert.equal(service.blockedIp("127.0.0.1"), true);
  assert.equal(service.blockedIp("10.20.30.40"), true);
  assert.equal(service.blockedIp("169.254.169.254"), true);
  assert.equal(service.blockedIp("::1"), true);
  assert.equal(service.blockedIp("2606:4700:4700::1111"), false);
  assert.equal(service.blockedIp("1.1.1.1"), false);
  assert.throws(() => service.requireHttpsUrl("http://example.com/feed.xml", "Feed URL"), /HTTPS/);
  assert.throws(() => service.requireHttpsUrl("https://user:pass@example.com/feed.xml", "Feed URL"), /embedded credentials/);
  const source = read("src/services/goodads.service.js");
  assert.match(source, /lookup: pinnedLookup\(resolved\.addresses\)/);
  assert.match(source, /servername: resolved\.url\.hostname/);
});

test("GoodAds parses bounded RSS and Atom items into safe content candidates", () => {
  const rss = service.parseFeedXml(`<?xml version="1.0"?>
    <rss version="2.0"><channel><title>Company News</title>
      <item><guid>article-1</guid><title>Launch &amp; Learn</title>
        <link>https://example.com/launch</link>
        <description><![CDATA[<p>A practical launch story.</p>]]></description>
        <pubDate>Wed, 29 Jul 2026 10:00:00 GMT</pubDate>
      </item>
    </channel></rss>`);
  assert.equal(rss.title, "Company News");
  assert.equal(rss.items.length, 1);
  assert.equal(rss.items[0].title, "Launch & Learn");
  assert.equal(rss.items[0].url, "https://example.com/launch");
  assert.equal(rss.items[0].summary, "A practical launch story.");
  assert.match(rss.items[0].publishedAt, /^2026-07-29T10:00:00/);
});

test("content distribution migration adds RSS sources and public link-hub uniqueness", () => {
  const migration = read("migrations/20260729_goodads_content_distribution.sql");
  const runner = read("scripts/apply-goodads-content-distribution-migration.js");
  const packageJson = JSON.parse(read("package.json"));
  assert.match(migration, /'rss_feeds'/);
  assert.match(migration, /idx_goodads_link_hubs_public_slug/);
  assert.match(migration, /idx_goodads_calendar_schedule/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(packageJson.scripts.build, /apply-goodads-content-distribution-migration/);
});

test("GoodAds exposes public link hubs, RSS sync, repurposing, and bulk publishing", () => {
  const routes = read("src/routes/goodads.routes.js");
  const social = read("src/services/goodads-social.service.js");
  assert.match(routes, /router\.get\("\/public\/link-hubs\/:slug"/);
  assert.match(routes, /router\.post\("\/public\/link-hubs\/:slug\/clicks"/);
  assert.match(routes, /router\.post\("\/rss-feeds\/:id\/sync"/);
  assert.match(routes, /router\.post\("\/rss-feeds\/:id\/items\/:itemId\/repurpose"/);
  assert.match(routes, /router\.post\("\/publishing\/batches"/);
  assert.match(social, /items\.length > 25/);
  assert.match(social, /publishBatch/);
});
