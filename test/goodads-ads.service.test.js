"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ads = require("../src/services/goodads-ads.service");

test("GoodAds paid providers fail closed until server credentials are complete", () => {
  const saved = {
    googleId: process.env.GOODADS_GOOGLE_CLIENT_ID,
    googleSecret: process.env.GOODADS_GOOGLE_CLIENT_SECRET,
    developerToken: process.env.GOODADS_GOOGLE_ADS_DEVELOPER_TOKEN,
  };
  delete process.env.GOODADS_GOOGLE_CLIENT_ID;
  delete process.env.GOODADS_GOOGLE_CLIENT_SECRET;
  delete process.env.GOODADS_GOOGLE_ADS_DEVELOPER_TOKEN;
  assert.equal(ads._test.providerAvailability("google").available, false);
  Object.assign(process.env, {
    GOODADS_GOOGLE_CLIENT_ID: "test-client",
    GOODADS_GOOGLE_CLIENT_SECRET: "test-secret",
    GOODADS_GOOGLE_ADS_DEVELOPER_TOKEN: "test-developer-token",
  });
  assert.equal(ads._test.providerAvailability("google").available, true);
  for (const [key, value] of Object.entries(saved)) {
    const name = {
      googleId: "GOODADS_GOOGLE_CLIENT_ID",
      googleSecret: "GOODADS_GOOGLE_CLIENT_SECRET",
      developerToken: "GOODADS_GOOGLE_ADS_DEVELOPER_TOKEN",
    }[key];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("all major paid platforms are explicit and unfinished adapters cannot fall through", () => {
  assert.deepEqual(
    ads.publicProviders().map((provider) => provider.id),
    ["google", "meta", "youtube", "tiktok", "linkedin", "x", "pinterest", "snapchat"]
  );
  for (const provider of ["youtube", "tiktok", "x", "pinterest", "snapchat"]) {
    const availability = ads._test.providerAvailability(provider);
    assert.equal(availability.available, false);
    assert.equal(availability.adapterConfigured, false);
    assert.equal(availability.adapterType, "not_installed");
    assert.throws(
      () => ads._test.nativeAdapter(provider),
      (error) => error.code === "GOODADS_ADAPTER_NOT_INSTALLED"
    );
  }
});

test("LinkedIn delivery requires an approved OAuth app with advertising scopes", () => {
  const names = [
    "GOODADS_LINKEDIN_CLIENT_ID",
    "GOODADS_LINKEDIN_CLIENT_SECRET",
    "GOODADS_LINKEDIN_ADS_OAUTH_ENABLED",
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      GOODADS_LINKEDIN_CLIENT_ID: "test-client",
      GOODADS_LINKEDIN_CLIENT_SECRET: "test-secret",
      GOODADS_LINKEDIN_ADS_OAUTH_ENABLED: "false",
    });
    const withoutScopes = ads._test.providerAvailability("linkedin");
    assert.equal(withoutScopes.available, false);
    assert.deepEqual(withoutScopes.missingOAuthScopes, ["r_ads", "rw_ads"]);

    process.env.GOODADS_LINKEDIN_ADS_OAUTH_ENABLED = "true";
    const withScopes = ads._test.providerAvailability("linkedin");
    assert.equal(withScopes.available, true);
    assert.equal(withScopes.adapterConfigured, true);
    assert.equal(withScopes.adapterType, "native");
    assert.equal(withScopes.safePausedCreation, true);
    assert.equal(withScopes.activationSupported, false);
    assert.equal(typeof ads._test.nativeAdapter("linkedin").create, "function");
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("Meta account discovery exposes only provider-owned public account metadata", () => {
  assert.deepEqual(
    ads._test.normalizeMetaAccount({
      id: "act_12345",
      name: "GoodOS",
      account_status: 1,
      currency: "usd",
      timezone_name: "America/Los_Angeles",
    }),
    {
      providerAccountId: "12345",
      name: "GoodOS",
      currency: "USD",
      timezone: "America/Los_Angeles",
      eligible: true,
      status: "active",
    }
  );
});

test("Google account discovery preserves locale and excludes manager accounts", () => {
  assert.deepEqual(
    ads._test.normalizeGoogleCustomer("1234567890", {
      descriptiveName: "GoodOS Search",
      currencyCode: "usd",
      timeZone: "America/Los_Angeles",
      status: "ENABLED",
      manager: false,
    }),
    {
      providerAccountId: "1234567890",
      name: "GoodOS Search",
      currency: "USD",
      timezone: "America/Los_Angeles",
      eligible: true,
      status: "enabled",
    }
  );
  assert.equal(
    ads._test.normalizeGoogleCustomer("0987654321", { status: "ENABLED", manager: true }).eligible,
    false
  );
});

test("LinkedIn account discovery requires campaign access and an organization owner", () => {
  const eligible = ads._test.normalizeLinkedInAccount(
    {
      id: 518121035,
      name: "GoodOS LinkedIn",
      status: "ACTIVE",
      currency: "usd",
      reference: "urn:li:organization:5803528",
      test: false,
    },
    { account: "urn:li:sponsoredAccount:518121035", role: "CAMPAIGN_MANAGER" }
  );
  assert.deepEqual(eligible, {
    providerAccountId: "518121035",
    name: "GoodOS LinkedIn",
    currency: "USD",
    timezone: "UTC",
    eligible: true,
    status: "active",
    metadata: {
      organizationUrn: "urn:li:organization:5803528",
      role: "CAMPAIGN_MANAGER",
      test: false,
      deliveryReady: true,
      channelType: "SPONSORED_UPDATES",
    },
  });
  assert.equal(
    ads._test.normalizeLinkedInAccount(
      { id: 1, status: "ACTIVE", reference: "urn:li:organization:2" },
      { role: "VIEWER" }
    ).status,
    "insufficient_campaign_role"
  );
  assert.equal(
    ads._test.normalizeLinkedInAccount(
      { id: 1, status: "ACTIVE", reference: "urn:li:person:abc" },
      { role: "CAMPAIGN_MANAGER" }
    ).status,
    "organization_required"
  );
});

test("LinkedIn adapter builds a paused campaign and draft direct-sponsored creative", () => {
  const row = {
    provider_account_id: "518121035",
    account_currency: "USD",
    account_metadata: { organizationUrn: "urn:li:organization:5803528" },
    campaign_name: "GoodOS Launch",
    campaign_data: {
      objective: "traffic",
      dailyBudget: 25,
      maxCpc: 3.5,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      targetCountries: ["US"],
      language: "en",
      creative: {
        primaryText: "Run every part of your business from one place.",
        headline: "Meet GoodOS",
        description: "One operating system for growing businesses.",
        callToAction: "Learn More",
        destinationUrl: "https://goodos.app/",
      },
    },
  };
  const campaign = ads._test.linkedInCampaignPayload(row, {
    campaignGroupUrn: "urn:li:sponsoredCampaignGroup:635137195",
    locationUrns: ["urn:li:geo:103644278"],
  });
  assert.equal(campaign.status, "PAUSED");
  assert.equal(campaign.account, "urn:li:sponsoredAccount:518121035");
  assert.equal(campaign.associatedEntity, "urn:li:organization:5803528");
  assert.equal(campaign.objectiveType, "WEBSITE_VISITS");
  assert.equal(campaign.politicalIntent, "NOT_DECLARED");
  assert.deepEqual(
    campaign.targetingCriteria.include.and[0].or["urn:li:adTargetingFacet:locations"],
    ["urn:li:geo:103644278"]
  );

  const creative = ads._test.linkedInCreativePayload(row, {
    campaignUrn: "urn:li:sponsoredCampaign:360035215",
    imageUrn: "urn:li:image:C4E22AQF_example",
    organizationUrn: "urn:li:organization:5803528",
  });
  assert.equal(creative.creative.intendedStatus, "DRAFT");
  assert.equal(creative.creative.inlineContent.post.distribution.feedDistribution, "NONE");
  assert.equal(creative.creative.inlineContent.post.author, "urn:li:organization:5803528");
  assert.equal(
    creative.creative.inlineContent.post.content.article.thumbnail,
    "urn:li:image:C4E22AQF_example"
  );
});

test("paid campaign adapters map objectives and bind approvals to immutable snapshots", () => {
  assert.equal(ads._test.metaObjective("leads"), "OUTCOME_LEADS");
  assert.equal(ads._test.metaObjective("sales"), "OUTCOME_SALES");
  const snapshot = {
    id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    version: 3,
    name: "Launch",
    status: "ready",
    data: { dailyBudget: 25 },
  };
  assert.equal(ads._test.snapshotHash(snapshot), ads._test.snapshotHash(snapshot));
  assert.notEqual(ads._test.snapshotHash(snapshot), ads._test.snapshotHash({ ...snapshot, version: 4 }));
});

test("paid campaign migration installs verified accounts, durable operations, and worker dispatch", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "../migrations/20260729_goodads_paid_campaigns.sql"),
    "utf8"
  );
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  const jobs = fs.readFileSync(path.join(__dirname, "../src/services/job.service.js"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  const majorPlatformsMigration = fs.readFileSync(
    path.join(__dirname, "../migrations/20260930_goodads_major_ad_platforms.sql"),
    "utf8"
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_ad_accounts/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_provider_campaigns/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_ad_operations/);
  assert.match(migration, /activation_approval_id/);
  assert.match(migration, /'goodads\.ads\.dispatch'/);
  assert.match(jobs, /case "goodads\.ads\.dispatch"/);
  assert.match(routes, /ads\.requestActivationApproval/);
  assert.match(routes, /ads\.queueLifecycleOperation/);
  assert.match(routes, /ads\.retryOperation/);
  assert.match(packageJson.scripts.build, /apply-goodads-paid-campaigns-migration/);
  assert.match(packageJson.scripts.build, /apply-goodads-major-ad-platforms-migration/);
  for (const provider of ["youtube", "tiktok", "linkedin", "x", "pinterest", "snapchat"]) {
    assert.match(majorPlatformsMigration, new RegExp(`'${provider}'`));
  }
});

test("provider deliveries are created paused and activation is approval-gated", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/goodads-ads.service.js"),
    "utf8"
  );
  assert.match(source, /status: "PAUSED"/);
  assert.match(source, /GOODADS_AD_ACTIVATION_APPROVAL_REQUIRED/);
  assert.match(source, /GOODADS_AD_ACTIVATION_APPROVAL_MISMATCH/);
  assert.match(source, /GOODADS_AD_CAMPAIGN_VERSION_CHANGED/);
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /dead_letter/);
  assert.match(source, /GOODADS_ADAPTER_NOT_INSTALLED/);
  assert.match(source, /GOODADS_AD_ACTIVATION_NOT_SUPPORTED/);
  assert.match(source, /intendedStatus: "DRAFT"/);
  assert.match(source, /activationSupported: false/);
  assert.doesNotMatch(source, /row\.provider === "meta"[\s\S]{0,120}: createGoogleDelivery/);
});
