"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const intelligence = require("../src/services/goodads-competitor-intelligence.service");
const scanner = require("../src/services/goodads-competitor-scanner.service");

test("competitor intelligence normalizes public domains and rejects unsafe URLs", () => {
  assert.equal(intelligence._test.normalizeDomain("https://www.Example.com/products"), "example.com");
  assert.equal(intelligence._test.normalizeDomain("example.com"), "example.com");
  assert.throws(() => intelligence._test.normalizeDomain("localhost"), /valid public website domain/);
  assert.throws(() => intelligence._test.optionalHttpsUrl("http://example.com"), /must use HTTPS/);
  assert.throws(() => intelligence._test.optionalHttpsUrl("https://user:pass@example.com"), /without embedded credentials/);
});

test("creative capture requires explicit provenance and bounded values", () => {
  const creative = intelligence._test.normalizeCreativePayload({
    sourceProvider: "meta_library",
    provenance: "public_library",
    channel: "social",
    adFormat: "video",
    headline: "Observed launch creative",
    sourceUrl: "https://www.facebook.com/ads/library/",
    keywords: ["launch", "launch", "offer"],
  });
  assert.deepEqual(creative.keywords, ["launch", "offer"]);
  assert.equal(creative.provenance, "public_library");
  assert.throws(
    () => intelligence._test.normalizeCreativePayload({
      sourceProvider: "similarweb",
      provenance: "public_library",
      channel: "search",
      adFormat: "text",
    }),
    /licensed API data/
  );
});

test("licensed provider metrics are normalized and marked as estimates", () => {
  const metrics = intelligence._test.normalizeProviderMetrics({
    visits: { visits: [{ date: "2026-07", visits: 50000 }] },
    marketingChannels: { data: [{ channel: "Paid Search", share: 0.31 }] },
    geography: { records: [{ country: "US", share: 0.72 }] },
    keywords: { results: [{ keyword: "ad intelligence", clicks: 900, cpc: 4.2 }] },
    technologies: { data: [{ technology: "HubSpot", category: "Marketing automation" }] },
    ppcSpend: { data: [{ spend: 1200, currency: "USD" }] },
    paidCompetitors: { competitors: [{ domain: "competitor.test", score: 0.82, shared_keywords: 420 }] },
    publishers: { publishers: [{ domain: "publisher.test", share: 0.4 }] },
    adNetworks: { networks: [{ name: "Network A", share: 0.6 }] },
  }, { visits: { status: "completed" } });
  assert.equal(metrics.ppcSpend.total, 1200);
  assert.equal(metrics.engagement.visits, 50000);
  assert.equal(metrics.marketingChannels[0].channel, "Paid Search");
  assert.equal(metrics.countries[0].country, "US");
  assert.equal(metrics.keywords[0].keyword, "ad intelligence");
  assert.equal(metrics.technologies[0].name, "HubSpot");
  assert.equal(metrics.source.confidence, "estimated");
  assert.equal(metrics.paidCompetitors[0].sharedKeywords, 420);
  assert.match(metrics.methodology, /estimates/);
});

test("public scanner extracts sourced positioning, offers, CTAs, technology, and social profiles", () => {
  const page = scanner._test.parsePage(`
    <!doctype html><html><head>
      <title>Acme Growth Platform</title>
      <meta name="description" content="Grow your pipeline with Acme.">
      <meta property="og:image" content="/social-card.png">
      <script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC"></script>
      <script type="application/ld+json">{"@type":"SoftwareApplication","name":"Acme"}</script>
    </head><body>
      <h1>Turn every campaign into revenue</h1>
      <a href="/pricing">See pricing</a>
      <button>Start free</button>
      <p>Get a 14-day free trial. Plans starting at $29 per month.</p>
      <a href="https://www.linkedin.com/company/acme">LinkedIn</a>
      <form><input name="email"></form>
    </body></html>
  `, "https://acme.example/");
  assert.equal(page.title, "Acme Growth Platform");
  assert.match(page.description, /Grow your pipeline/);
  assert.deepEqual(page.callsToAction, ["See pricing", "Start free"]);
  assert.match(page.offers.join(" "), /free trial/i);
  assert.ok(page.technologies.includes("Google Tag Manager"));
  assert.ok(page.structuredDataTypes.includes("SoftwareApplication"));
  assert.equal(page.socialProfiles.linkedin, "https://www.linkedin.com/company/acme");
  assert.equal(page.forms, 1);
});

test("public scanner honors robots rules and blocks private network destinations", () => {
  const robots = scanner._test.parseRobots(`
    User-agent: *
    Disallow: /private
    Allow: /private/press
  `);
  assert.equal(robots.allowed("/"), true);
  assert.equal(robots.allowed("/private/account"), false);
  assert.equal(robots.allowed("/private/press"), true);
  assert.equal(scanner._test.blockedIp("127.0.0.1"), true);
  assert.equal(scanner._test.blockedIp("10.2.3.4"), true);
  assert.equal(scanner._test.blockedIp("8.8.8.8"), false);
});

test("competitor intelligence migration, routes, and scheduled sync are installed", () => {
  const root = path.join(__dirname, "..");
  const migration = fs.readFileSync(path.join(root, "migrations/20260729_goodads_competitor_intelligence.sql"), "utf8");
  const migrationV2 = fs.readFileSync(path.join(root, "migrations/20260729_goodads_competitor_intelligence_v2.sql"), "utf8");
  const routes = fs.readFileSync(path.join(root, "src/routes/goodads.routes.js"), "utf8");
  const jobs = fs.readFileSync(path.join(root, "src/services/job.service.js"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_competitors/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_competitor_creatives/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_competitor_snapshots/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_competitor_alerts/);
  assert.match(migration, /goodads\.competitors\.sync/);
  assert.match(routes, /competitor-intelligence\/overview/);
  assert.match(routes, /competitor-intelligence\/competitors/);
  assert.match(routes, /competitor-intelligence\/competitors\/:id\/intelligence/);
  assert.match(routes, /competitor-intelligence\/creatives/);
  assert.match(migrationV2, /public_web/);
  assert.match(migrationV2, /partial/);
  assert.match(migrationV2, /site_change/);
  assert.match(jobs, /case "goodads\.competitors\.sync"/);
  assert.match(packageJson.scripts.build, /apply-goodads-competitor-intelligence-v2-migration/);
});
