"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const intelligence = require("../src/services/goodads-competitor-intelligence.service");

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
    ppcSpend: { data: [{ spend: 1200, currency: "USD" }] },
    paidCompetitors: { competitors: [{ domain: "competitor.test", score: 0.82, shared_keywords: 420 }] },
    publishers: { publishers: [{ domain: "publisher.test", share: 0.4 }] },
    adNetworks: { networks: [{ name: "Network A", share: 0.6 }] },
  });
  assert.equal(metrics.ppcSpend.total, 1200);
  assert.equal(metrics.paidCompetitors[0].sharedKeywords, 420);
  assert.match(metrics.methodology, /estimates/);
});

test("competitor intelligence migration, routes, and scheduled sync are installed", () => {
  const root = path.join(__dirname, "..");
  const migration = fs.readFileSync(path.join(root, "migrations/20260729_goodads_competitor_intelligence.sql"), "utf8");
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
  assert.match(routes, /competitor-intelligence\/creatives/);
  assert.match(jobs, /case "goodads\.competitors\.sync"/);
  assert.match(packageJson.scripts.build, /apply-goodads-competitor-intelligence-migration/);
});
