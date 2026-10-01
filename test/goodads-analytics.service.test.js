"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const analytics = require("../src/services/goodads-analytics.service");

test("GoodAds analytics accepts bounded provider reporting periods", () => {
  assert.deepEqual(
    analytics._test.normalizePeriod("2026-07-01", "2026-07-29"),
    { start: "2026-07-01", end: "2026-07-29" }
  );
  assert.throws(
    () => analytics._test.normalizePeriod("2026-01-01", "2026-07-29"),
    /cannot exceed 93 days/
  );
  assert.throws(
    () => analytics._test.normalizePeriod("2026-07-30", "2026-07-29"),
    /valid analytics date range/
  );
});

test("first-party attribution tokens are signed, origin-bound, and event allowlisted", () => {
  const key = "test-attribution-signing-key-with-at-least-32-characters";
  const payload = {
    campaignId: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    organizationId: "org_goodos",
  };
  const token = analytics._test.encodeAttributionToken(payload, key);
  assert.deepEqual(analytics._test.decodeAttributionToken(token, key), payload);
  assert.throws(
    () => analytics._test.decodeAttributionToken(`${token.slice(0, -1)}x`, key),
    /invalid/
  );
  assert.equal(analytics._test.normalizedPageOrigin("https://goodos.app/checkout?secret=no"), "https://goodos.app");
  assert.equal(analytics._test.normalizedAttributionEvent("purchase"), "purchase");
  assert.throws(() => analytics._test.normalizedAttributionEvent("arbitrary_event"), /not supported/);
  const script = analytics._test.attributionScript(token);
  assert.match(script, /globalThis\.goodAdsTrack=send/);
  assert.match(script, /send\("page_view"\)/);
  assert.match(script, /page_origin/);
});

test("Meta conversion parsing counts only explicit result actions", () => {
  const actions = [
    { action_type: "lead", value: "3" },
    { action_type: "purchase", value: "2" },
    { action_type: "page_engagement", value: "99" },
  ];
  assert.equal(analytics._test.actionTotal(actions, new Set(["lead", "purchase"])), 5);
  assert.equal(analytics._test.actionTotal(actions, new Set(["purchase"])), 2);
});

test("X Ads analytics sums only verified campaign metrics and keeps money in micros", () => {
  const metrics = analytics._test.xMetricsFromPayload({
    data: [{
      id: "x-campaign",
      id_data: [{
        segment: null,
        metrics: {
          impressions: ["110", null, "40"],
          clicks: ["9", "3"],
          billed_charge_local_micro: ["1250000", "750000"],
          conversion_purchases: ["2"],
          conversion_sign_ups: ["3"],
          conversion_site_visits: ["4"],
          conversion_custom: ["1"],
          conversion_purchases_sale_amount_local_micro: ["9000000"],
          follows: ["999"],
        },
      }],
    }],
  }, { start: "2026-09-01", end: "2026-09-30" });

  assert.deepEqual(metrics, {
    impressions: 150,
    clicks: 12,
    conversions: 10,
    spendMicros: 2000000,
    conversionValueMicros: 9000000,
    raw: {
      dateStart: "2026-09-01",
      dateEnd: "2026-09-30",
      entity: "CAMPAIGN",
      granularity: "TOTAL",
      recordCount: 1,
    },
  });
});

test("analytics capabilities include native X Ads reporting", () => {
  assert.deepEqual(
    analytics.capabilities().providerAnalytics.supportedProviders,
    ["google", "linkedin", "meta", "pinterest", "snapchat", "tiktok", "x", "youtube"]
  );
  assert.equal(analytics.capabilities().providerAnalytics.crossChannelBudgetRecommendations, true);
  assert.equal(analytics.capabilities().providerAnalytics.budgetRecommendationsAdvisoryOnly, true);
  assert.equal(analytics.capabilities().providerAnalytics.firstPartyWebsitePixel, true);
  assert.equal(analytics.capabilities().providerAnalytics.attributionReplayDeduplication, true);
});

test("cross-channel budget recommendations preserve the total and never execute automatically", () => {
  const now = Date.parse("2026-09-30T23:00:00.000Z");
  const result = analytics._test.budgetRecommendations([
    {
      provider_campaign_record_id: "meta-delivery",
      campaign_id: "campaign-meta",
      campaign_name: "Meta prospecting",
      provider: "meta",
      currency: "USD",
      status: "active",
      daily_budget: "100",
      spend_micros: 80000000,
      conversions: 8,
      conversion_value_micros: 160000000,
      captured_at: "2026-09-30T22:40:00.000Z",
      period_start: "2026-09-01",
      period_end: "2026-09-30",
    },
    {
      provider_campaign_record_id: "google-delivery",
      campaign_id: "campaign-google",
      campaign_name: "Google demand",
      provider: "google",
      currency: "USD",
      status: "active",
      daily_budget: "100",
      spend_micros: 70000000,
      conversions: 21,
      conversion_value_micros: 420000000,
      captured_at: "2026-09-30T22:45:00.000Z",
      period_start: "2026-09-01",
      period_end: "2026-09-30",
    },
  ], { now });
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.automaticExecution, false);
  assert.equal(result.recommendations.length, 1);
  const recommendation = result.recommendations[0];
  assert.equal(recommendation.source.provider, "meta");
  assert.equal(recommendation.destination.provider, "google");
  assert.equal(recommendation.shiftMicros, 20000000);
  assert.equal(recommendation.totalDailyBudgetBeforeMicros, recommendation.totalDailyBudgetAfterMicros);
  assert.equal(recommendation.source.recommendedDailyBudgetMicros, 80000000);
  assert.equal(recommendation.destination.recommendedDailyBudgetMicros, 120000000);
});

test("budget recommendations exclude stale and cross-currency evidence", () => {
  const result = analytics._test.budgetRecommendations([
    { providerCampaignRecordId: "one", provider: "meta", currency: "USD", status: "active", dailyBudget: 50, spendMicros: 10000000, conversions: 5, capturedAt: "2026-09-30T20:00:00.000Z" },
    { providerCampaignRecordId: "two", provider: "google", currency: "EUR", status: "active", dailyBudget: 50, spendMicros: 10000000, conversions: 10, capturedAt: "2026-09-30T22:50:00.000Z" },
  ], { now: Date.parse("2026-09-30T23:00:00.000Z") });
  assert.equal(result.excluded.stale, 1);
  assert.deepEqual(result.recommendations, []);
});

test("YouTube campaigns use the verified Google Ads reporting adapter", () => {
  const googleAdapter = analytics._test.providerMetricsAdapter("google");
  assert.equal(typeof googleAdapter, "function");
  assert.equal(analytics._test.providerMetricsAdapter("youtube"), googleAdapter);
});

test("LinkedIn analytics maps campaign performance and preserves local-currency micros", () => {
  assert.equal(typeof analytics._test.providerMetricsAdapter("linkedin"), "function");
  const metrics = analytics._test.linkedInMetricsFromPayload({
    elements: [
      {
        pivotValues: ["urn:li:sponsoredCampaign:12345"],
        impressions: 1500,
        clicks: 75,
        externalWebsiteConversions: 4,
        costInLocalCurrency: "19.91833",
        conversionValueInLocalCurrency: "125.500001",
      },
      {
        pivotValues: ["urn:li:sponsoredCampaign:12345"],
        impressions: 500,
        clicks: 25,
        externalWebsiteConversions: 2,
        costInLocalCurrency: "5.08167",
        conversionValueInLocalCurrency: "24.499999",
      },
    ],
  }, { start: "2026-09-01", end: "2026-09-30" });

  assert.deepEqual(metrics, {
    impressions: 2000,
    clicks: 100,
    conversions: 6,
    spendMicros: 25000000,
    conversionValueMicros: 150000000,
    raw: {
      dateStart: "2026-09-01",
      dateEnd: "2026-09-30",
      entity: "CAMPAIGN",
      granularity: "ALL",
      recordCount: 2,
    },
  });
});

test("Snapchat analytics maps swipe and conversion metrics without changing microcurrency", () => {
  const metrics = analytics._test.snapchatMetricsFromPayload({
    request_status: "SUCCESS",
    request_id: "snap-report-1",
    total_stats: [{
      sub_request_status: "SUCCESS",
      total_stat: {
        stats: {
          impressions: 2500,
          swipes: 125,
          spend: 4200000,
          conversion_purchases: 7,
          conversion_sign_ups: 3,
          conversion_purchases_value: 21000000,
          video_views: 999,
        },
      },
    }],
  }, { start: "2026-09-01", end: "2026-09-30" });

  assert.deepEqual(metrics, {
    impressions: 2500,
    clicks: 125,
    conversions: 10,
    spendMicros: 4200000,
    conversionValueMicros: 21000000,
    raw: {
      dateStart: "2026-09-01",
      dateEnd: "2026-09-30",
      entity: "CAMPAIGN",
      granularity: "TOTAL",
      recordCount: 1,
      requestId: "snap-report-1",
    },
  });
});

test("Snapchat analytics fails closed on a rejected provider sub-request", () => {
  assert.throws(
    () => analytics._test.snapchatMetricsFromPayload({
      request_status: "SUCCESS",
      total_stats: [{ sub_request_status: "ERROR" }],
    }, { start: "2026-09-01", end: "2026-09-30" }),
    /could not produce verified metrics/
  );
});

test("Pinterest analytics preserves microcurrency and ignores unrelated engagement", () => {
  const metrics = analytics._test.pinterestMetricsFromPayload([{
    CAMPAIGN_ID: "pin-campaign",
    IMPRESSION_1: 7500,
    CLICKTHROUGH_1: 320,
    SPEND_IN_MICRO_DOLLAR: 8800000,
    TOTAL_CONVERSIONS: 12,
    TOTAL_CONVERSIONS_VALUE_IN_MICRO_DOLLAR: 42000000,
    SAVE_1: 999,
  }], { start: "2026-09-01", end: "2026-09-30" });

  assert.deepEqual(metrics, {
    impressions: 7500,
    clicks: 320,
    conversions: 12,
    spendMicros: 8800000,
    conversionValueMicros: 42000000,
    raw: {
      dateStart: "2026-09-01",
      dateEnd: "2026-09-30",
      entity: "CAMPAIGN",
      granularity: "TOTAL",
      recordCount: 1,
    },
  });
});

test("Pinterest analytics splits the global reporting window at its 90-day boundary", () => {
  assert.deepEqual(
    analytics._test.splitPeriod({ start: "2026-06-30", end: "2026-09-30" }, 90),
    [
      { start: "2026-06-30", end: "2026-09-27" },
      { start: "2026-09-28", end: "2026-09-30" },
    ]
  );
});

test("TikTok analytics maps verified auction metrics and converts decimal spend to micros", () => {
  const metrics = analytics._test.tiktokMetricsFromPayload({
    code: 0,
    message: "OK",
    request_id: "tiktok-report-1",
    data: {
      list: [{
        dimensions: { campaign_id: "tt-campaign" },
        metrics: {
          spend: "12.345678",
          impressions: "9000",
          clicks: "450",
          conversion: "18",
          likes: "999",
        },
      }],
    },
  }, { start: "2026-09-01", end: "2026-09-30" });

  assert.deepEqual(metrics, {
    impressions: 9000,
    clicks: 450,
    conversions: 18,
    spendMicros: 12345678,
    conversionValueMicros: 0,
    raw: {
      dateStart: "2026-09-01",
      dateEnd: "2026-09-30",
      entity: "AUCTION_CAMPAIGN",
      granularity: "TOTAL",
      recordCount: 1,
      requestId: "tiktok-report-1",
    },
  });
});

test("TikTok analytics rejects provider-level errors instead of storing empty snapshots", () => {
  assert.throws(
    () => analytics._test.tiktokMetricsFromPayload({ code: 40002, message: "Invalid advertiser" }, {
      start: "2026-09-01",
      end: "2026-09-30",
    }),
    /Invalid advertiser/
  );
});

test("analytics migration persists provider snapshots and automatic sync", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "../migrations/20260729_goodads_analytics.sql"),
    "utf8"
  );
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  const attributionMigration = fs.readFileSync(
    path.join(__dirname, "../migrations/20261001_goodads_first_party_attribution.sql"),
    "utf8"
  );
  const jobs = fs.readFileSync(path.join(__dirname, "../src/services/job.service.js"), "utf8");
  const migrationRunner = fs.readFileSync(
    path.join(__dirname, "../scripts/apply-goodads-analytics-migration.js"),
    "utf8"
  );
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_analytics_snapshots/);
  assert.match(migration, /spend_micros BIGINT/);
  assert.match(migration, /conversion_value_micros BIGINT/);
  assert.match(migration, /'goodads\.analytics\.sync'/);
  assert.match(routes, /\/analytics\/overview/);
  assert.match(routes, /\/analytics\/provider-sync/);
  assert.match(routes, /\/public\/attribution\/:token\/tracker\.js/);
  assert.match(routes, /\/public\/attribution\/:token\/pixel\.gif/);
  assert.match(routes, /\/campaigns\/:id\/attribution/);
  assert.match(attributionMigration, /uq_goodads_attribution_event_id/);
  assert.match(attributionMigration, /idx_goodads_attribution_reporting/);
  assert.match(migrationRunner, /function coreReady/);
  assert.match(migrationRunner, /function attributionReady/);
  assert.match(migrationRunner, /applyOwnerMigration/);
  assert.match(migrationRunner, /runuser/);
  assert.match(jobs, /case "goodads\.analytics\.sync"/);
  assert.match(packageJson.scripts.build, /apply-goodads-analytics-migration/);
});

test("analytics reports verified provider values and keeps revenue separated by currency", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/goodads-analytics.service.js"),
    "utf8"
  );
  assert.match(source, /DISTINCT ON \(snapshot\.provider_campaign_id\)/);
  assert.match(source, /GROUP BY provider, COALESCE/);
  assert.match(source, /GROUP BY currency/);
  assert.match(source, /resource_type = 'leads'/);
  assert.match(source, /link_hubs\.clicked/);
  assert.match(source, /attribution\.page_view/);
  assert.match(source, /websiteConversions/);
  assert.doesNotMatch(source, /sample/i);
});
