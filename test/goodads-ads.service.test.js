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
  assert.equal(ads._test.providerAvailability("youtube").available, true);
  assert.equal(ads._test.providerAvailability("youtube").deliveryAdapter, "demand_gen_video");
  assert.equal(typeof ads._test.nativeAdapter("youtube").create, "function");
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
  for (const provider of ["x"]) {
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

test("TikTok Ads delivery requires an approved Business API OAuth app", () => {
  const names = ["GOODADS_TIKTOK_ADS_APP_ID", "GOODADS_TIKTOK_ADS_CLIENT_SECRET"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    delete process.env.GOODADS_TIKTOK_ADS_APP_ID;
    delete process.env.GOODADS_TIKTOK_ADS_CLIENT_SECRET;
    assert.equal(ads._test.providerAvailability("tiktok").available, false);

    Object.assign(process.env, {
      GOODADS_TIKTOK_ADS_APP_ID: "test-app",
      GOODADS_TIKTOK_ADS_CLIENT_SECRET: "test-secret",
    });
    const availability = ads._test.providerAvailability("tiktok");
    assert.equal(availability.available, true);
    assert.equal(availability.adapterConfigured, true);
    assert.equal(availability.adapterType, "native");
    assert.equal(availability.safePausedCreation, true);
    assert.equal(availability.activationSupported, true);
    assert.equal(typeof ads._test.nativeAdapter("tiktok").create, "function");
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("Snapchat delivery requires an approved Marketing API OAuth app", () => {
  const names = ["GOODADS_SNAPCHAT_CLIENT_ID", "GOODADS_SNAPCHAT_CLIENT_SECRET"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    delete process.env.GOODADS_SNAPCHAT_CLIENT_ID;
    delete process.env.GOODADS_SNAPCHAT_CLIENT_SECRET;
    assert.equal(ads._test.providerAvailability("snapchat").available, false);

    Object.assign(process.env, {
      GOODADS_SNAPCHAT_CLIENT_ID: "test-client",
      GOODADS_SNAPCHAT_CLIENT_SECRET: "test-secret",
    });
    const availability = ads._test.providerAvailability("snapchat");
    assert.equal(availability.available, true);
    assert.equal(availability.adapterConfigured, true);
    assert.equal(availability.adapterType, "native");
    assert.equal(availability.safePausedCreation, true);
    assert.equal(availability.activationSupported, true);
    assert.equal(typeof ads._test.nativeAdapter("snapchat").create, "function");
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
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

test("Pinterest delivery requires an approved OAuth app with advertising scopes", () => {
  const names = [
    "GOODADS_PINTEREST_CLIENT_ID",
    "GOODADS_PINTEREST_CLIENT_SECRET",
    "GOODADS_PINTEREST_ADS_OAUTH_ENABLED",
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      GOODADS_PINTEREST_CLIENT_ID: "test-client",
      GOODADS_PINTEREST_CLIENT_SECRET: "test-secret",
      GOODADS_PINTEREST_ADS_OAUTH_ENABLED: "false",
    });
    const withoutScopes = ads._test.providerAvailability("pinterest");
    assert.equal(withoutScopes.available, false);
    assert.deepEqual(withoutScopes.missingOAuthScopes, ["ads:read", "ads:write"]);

    process.env.GOODADS_PINTEREST_ADS_OAUTH_ENABLED = "true";
    const withScopes = ads._test.providerAvailability("pinterest");
    assert.equal(withScopes.available, true);
    assert.equal(withScopes.adapterConfigured, true);
    assert.equal(withScopes.adapterType, "native");
    assert.equal(withScopes.safePausedCreation, true);
    assert.equal(withScopes.activationSupported, true);
    assert.equal(typeof ads._test.nativeAdapter("pinterest").create, "function");
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

test("YouTube adapter builds one atomic paused Demand Gen stack with YouTube-only channels", () => {
  const pngLogo = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(pngLogo);
  pngLogo.writeUInt32BE(1200, 16);
  pngLogo.writeUInt32BE(1200, 20);
  assert.deepEqual(ads._test.googleLogoDimensions(pngLogo, "image/png"), { width: 1200, height: 1200 });

  const row = {
    provider_campaign_record_id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    provider_account_id: "123-456-7890",
    campaign_name: "GoodOS Launch",
    campaign_data: {
      objective: "traffic",
      dailyBudget: 25,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      targetCountries: ["US", "CA"],
      containsEuPoliticalAdvertising: false,
      creative: {
        businessName: "GoodOS",
        headline: "Run your business in one place",
        primaryText: "Plan, approve, publish, and measure every campaign from one governed workspace.",
        destinationUrl: "https://goodos.app/",
        videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        logoUrl: "https://cdn.goodos.app/goodads/logo.png",
      },
    },
  };
  const operations = ads._test.googleDemandGenOperations(row, {
    logoBase64: "aW1hZ2U=",
    geoTargetResources: ["geoTargetConstants/2840", "geoTargetConstants/2124"],
  });
  const created = (key) => operations.find((operation) => operation[key])?.[key]?.create;
  const campaign = created("campaignOperation");
  const adGroup = created("adGroupOperation");
  const assets = operations.filter((operation) => operation.assetOperation).map((operation) => operation.assetOperation.create);
  const ad = created("adGroupAdOperation");

  assert.equal(campaign.status, "PAUSED");
  assert.equal(campaign.advertisingChannelType, "DEMAND_GEN");
  assert.equal(campaign.containsEuPoliticalAdvertising, "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING");
  assert.equal(campaign.startDateTime, "2026-10-05 00:00:00");
  assert.equal(campaign.endDateTime, "2026-10-12 23:59:59");
  assert.deepEqual(adGroup.demandGenAdGroupSettings.channelControls.selectedChannels, {
    gmail: false,
    discover: false,
    display: false,
    youtubeInFeed: true,
    youtubeInStream: true,
    youtubeShorts: true,
  });
  assert.equal(operations.filter((operation) => operation.adGroupCriterionOperation).length, 2);
  assert.equal(assets.find((asset) => asset.youtubeVideoAsset).youtubeVideoAsset.youtubeVideoId, "dQw4w9WgXcQ");
  assert.equal(assets.find((asset) => asset.imageAsset).imageAsset.data, "aW1hZ2U=");
  assert.equal(ad.ad.demandGenVideoResponsiveAd.businessName.text, "GoodOS");
  assert.equal(ad.adGroup, "customers/1234567890/adGroups/-3");
  assert.equal(ads._test.youtubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=1"), "dQw4w9WgXcQ");
  assert.equal(ads._test.youtubeVideoId("https://youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(ads._test.youtubeVideoId("https://example.com/video.mp4"), "");
});

test("YouTube setup fails closed on compliance, objective, asset, and copy gaps", () => {
  const campaign = {
    status: "ready",
    data: {
      platforms: ["youtube"],
      objective: "traffic",
      dailyBudget: 25,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      targetCountries: ["US"],
      containsEuPoliticalAdvertising: false,
      creative: {
        businessName: "GoodOS",
        headline: "Meet GoodOS",
        primaryText: "Run your business from one governed workspace.",
        destinationUrl: "https://goodos.app/",
        videoUrl: "https://youtu.be/dQw4w9WgXcQ",
        logoUrl: "https://cdn.goodos.app/goodads/logo.png",
      },
    },
  };
  const account = {
    provider: "youtube",
    currency: "USD",
    timezone: "America/Los_Angeles",
    metadata: { deliveryReady: true },
  };
  assert.doesNotThrow(() => ads._test.validateCampaignForAccount(campaign, account));
  assert.throws(
    () => ads._test.validateCampaignForAccount({
      ...campaign,
      data: { ...campaign.data, containsEuPoliticalAdvertising: null },
    }, account),
    (error) => error.code === "GOODADS_GOOGLE_POLITICAL_DECLARATION_REQUIRED"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount({
      ...campaign,
      data: { ...campaign.data, objective: "conversions" },
    }, account),
    (error) => error.code === "GOODADS_YOUTUBE_CONVERSION_ACTION_REQUIRED"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount({
      ...campaign,
      data: { ...campaign.data, creative: { ...campaign.data.creative, videoUrl: "https://example.com/ad.mp4" } },
    }, account),
    (error) => error.code === "GOODADS_YOUTUBE_VIDEO_URL_INVALID"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount({
      ...campaign,
      data: { ...campaign.data, creative: { ...campaign.data.creative, businessName: "x".repeat(26) } },
    }, account),
    (error) => error.code === "GOODADS_YOUTUBE_COPY_TOO_LONG"
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

test("Pinterest account discovery requires campaign access and a complete locale", () => {
  const eligible = ads._test.normalizePinterestAccount({
    id: "549755885175",
    name: "GoodOS Pinterest",
    country: "us",
    currency: "usd",
    time_zone: "America/Los_Angeles",
    permissions: ["ANALYST", "CAMPAIGN_MANAGER"],
    owner: { username: "goodos" },
  });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.status, "active");
  assert.equal(eligible.currency, "USD");
  assert.equal(eligible.timezone, "America/Los_Angeles");
  assert.equal(eligible.metadata.deliveryReady, true);
  assert.deepEqual(eligible.metadata.permissions, ["ANALYST", "CAMPAIGN_MANAGER"]);

  const readOnly = ads._test.normalizePinterestAccount({
    id: "549755885175",
    currency: "USD",
    time_zone: "America/Los_Angeles",
    permissions: ["ANALYST"],
  });
  assert.equal(readOnly.eligible, false);
  assert.equal(readOnly.status, "campaign_manager_role_required");
});

test("Snapchat account discovery requires campaign write access and funding", () => {
  const eligible = ads._test.normalizeSnapchatAccount(
    {
      id: "8b8e40af-fc64-455d-925b-ca80f7af6914",
      name: "GoodOS Snapchat",
      status: "ACTIVE",
      currency: "usd",
      timezone: "America/Los_Angeles",
      roles: ["admin"],
      funding_source_ids: ["6ca1687a-f2b4-437d-8554-a85403a714c5"],
      test: false,
    },
    { id: "40d6719b-da09-410b-9185-0cc9c0dfed1d", name: "GoodOS" }
  );
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.status, "active");
  assert.equal(eligible.metadata.organizationName, "GoodOS");
  assert.deepEqual(eligible.metadata.roles, ["admin"]);
  assert.equal(eligible.metadata.deliveryReady, false);

  const readOnly = ads._test.normalizeSnapchatAccount(
    { ...eligible, id: eligible.providerAccountId, status: "ACTIVE", roles: ["reports"] },
    {}
  );
  assert.equal(readOnly.eligible, false);
  assert.equal(readOnly.status, "campaign_write_role_required");
});

test("TikTok Ads discovery requires an enabled localized account and advertising identity", () => {
  const account = ads._test.normalizeTikTokAccount({
    advertiser_id: "7491234567890123456",
    advertiser_name: "GoodOS TikTok",
    status: "STATUS_ENABLE",
    currency: "usd",
    timezone: "America/Los_Angeles",
    country: "us",
    role: "ADMIN",
  });
  assert.equal(account.eligible, true);
  assert.equal(account.status, "status_enable");
  assert.equal(account.currency, "USD");
  assert.equal(account.timezone, "America/Los_Angeles");
  assert.equal(account.metadata.deliveryReady, false);

  assert.deepEqual(
    ads._test.normalizeTikTokIdentity({
      identity_id: "7422222222222222222",
      identity_type: "TT_USER",
      available_status: "AVAILABLE",
      display_name: "GoodOS",
      username: "goodos",
    }, account.providerAccountId),
    {
      id: "7422222222222222222",
      name: "GoodOS · @goodos",
      providerAccountId: "7491234567890123456",
      identityType: "TT_USER",
      identityAuthorizedBcId: null,
    }
  );
  assert.equal(
    ads._test.normalizeTikTokIdentity({
      identity_id: "7422222222222222222",
      identity_type: "TT_USER",
      available_status: "UNAVAILABLE",
    }, account.providerAccountId),
    null
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

test("Snapchat adapter builds a fully paused campaign stack with a shared Public Profile", () => {
  const row = {
    provider_account_id: "8b8e40af-fc64-455d-925b-ca80f7af6914",
    account_metadata: {
      profileId: "c0ea278b-0449-4369-88d6-636e5d925f70",
      profileName: "GoodOS",
    },
    campaign_name: "GoodOS Launch",
    campaign_data: {
      objective: "traffic",
      dailyBudget: 25,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      targetCountries: ["US", "CA"],
      creative: {
        headline: "Run your business in one place",
        callToAction: "Learn More",
        destinationUrl: "https://goodos.app/",
      },
    },
  };
  const campaign = ads._test.snapchatCampaignPayload(row);
  assert.equal(campaign.status, "PAUSED");
  assert.equal(campaign.buy_model, "AUCTION");
  assert.equal(campaign.objective_v2_properties.objective_v2_type, "TRAFFIC");

  const adSquad = ads._test.snapchatAdSquadPayload(row, "4813d068-370b-45f6-a8d6-e01de878f1b5");
  assert.equal(adSquad.status, "PAUSED");
  assert.equal(adSquad.bid_strategy, "AUTO_BID");
  assert.equal(adSquad.daily_budget_micro, 25000000);
  assert.equal(adSquad.optimization_goal, "SWIPES");
  assert.equal(adSquad.conversion_window, "SWIPE_28DAY_VIEW_1DAY");
  assert.deepEqual(adSquad.targeting.geos, [{ country_code: "us" }, { country_code: "ca" }]);

  const creative = ads._test.snapchatCreativePayload(row, "c9889dc4-7777-495a-b67a-737dd2fd22c4");
  assert.equal(creative.type, "WEB_VIEW");
  assert.equal(creative.profile_properties.profile_id, row.account_metadata.profileId);
  assert.equal(creative.web_view_properties.url, "https://goodos.app/");

  const ad = ads._test.snapchatAdPayload(
    row,
    "9077bb86-fb9a-4ded-9da9-67bc2e1dd6c5",
    "c1e6e929-acec-466f-b023-852b8cacc18f"
  );
  assert.equal(ad.type, "REMOTE_WEBPAGE");
  assert.equal(ad.status, "PAUSED");
});

test("TikTok adapter builds a fully disabled traffic campaign stack", () => {
  const row = {
    provider_campaign_record_id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    provider_account_id: "7491234567890123456",
    account_metadata: {
      deliveryReady: true,
      identityId: "7422222222222222222",
      identityType: "TT_USER",
    },
    campaign_name: "GoodOS Launch",
    campaign_data: {
      objective: "traffic",
      dailyBudget: 25,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      targetCountries: ["US", "CA"],
      creative: {
        primaryText: "Run your business in one governed workspace.",
        headline: "Meet GoodOS",
        callToAction: "Learn More",
        destinationUrl: "https://goodos.app/?utm_source=tiktok",
        videoUrl: "https://cdn.goodos.app/goodads/launch.mp4",
      },
    },
  };
  const campaign = ads._test.tiktokCampaignPayload(row);
  assert.equal(campaign.objective_type, "TRAFFIC");
  assert.equal(campaign.operation_status, "DISABLE");
  assert.equal(campaign.budget_mode, "BUDGET_MODE_INFINITE");

  const locationIds = ads._test.tiktokCountryLocationIds({
    data: {
      list: [
        { location_id: "6252001", region_code: "US", level: "COUNTRY" },
        { location_id: "6251999", region_code: "CA", level: "COUNTRY" },
      ],
    },
  }, row.campaign_data.targetCountries);
  assert.deepEqual(locationIds, ["6252001", "6251999"]);

  const adGroup = ads._test.tiktokAdGroupPayload(row, "1850000000000001", locationIds);
  assert.equal(adGroup.operation_status, "DISABLE");
  assert.equal(adGroup.budget_mode, "BUDGET_MODE_TOTAL");
  assert.equal(adGroup.budget, 200);
  assert.deepEqual(adGroup.placements, ["PLACEMENT_TIKTOK"]);
  assert.equal(adGroup.schedule_end_time, "2026-10-12 23:59:59");
  assert.equal(adGroup.identity_id, row.account_metadata.identityId);

  const ad = ads._test.tiktokAdPayload(row, "1850000000000002", "v10044g50000ct2lj6bc77u74fl8vlt0");
  assert.equal(ad.creatives[0].operation_status, "DISABLE");
  assert.equal(ad.creatives[0].video_id, "v10044g50000ct2lj6bc77u74fl8vlt0");
  assert.equal(ad.creatives[0].identity_id, row.account_metadata.identityId);
  assert.equal(ad.creatives[0].call_to_action, "LEARN_MORE");
  assert.equal(ad.creatives[0].creative_authorized, false);
});

test("Pinterest adapter builds a paused CBO campaign, targeted ad group, ad-only Pin, and ad", () => {
  const row = {
    provider_account_id: "549755885175",
    campaign_name: "GoodOS Launch",
    campaign_data: {
      objective: "traffic",
      dailyBudget: 25,
      maxCpc: 2.5,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      targetCountries: ["US", "CA"],
      creative: {
        primaryText: "Run every part of your business from one place.",
        headline: "Meet GoodOS",
        description: "One operating system for growing businesses.",
        callToAction: "Learn More",
        destinationUrl: "https://goodos.app/",
        imageUrl: "https://cdn.goodos.app/goodads/launch.png",
      },
    },
  };
  const campaign = ads._test.pinterestCampaignPayload(row);
  assert.equal(campaign.status, "PAUSED");
  assert.equal(campaign.objective_type, "CONSIDERATION");
  assert.equal(campaign.daily_spend_cap, 25000000);
  assert.equal(campaign.is_campaign_budget_optimization, true);
  assert.equal(campaign.end_time - campaign.start_time, 8 * 24 * 60 * 60);

  const adGroup = ads._test.pinterestAdGroupPayload(row, "626747269410");
  assert.equal(adGroup.status, "PAUSED");
  assert.equal(adGroup.billable_event, "CLICKTHROUGH");
  assert.equal(adGroup.bid_in_micro_currency, 2500000);
  assert.deepEqual(adGroup.targeting_spec.LOCATION, ["US", "CA"]);

  const pin = ads._test.pinterestPinPayload(row);
  assert.equal(pin.is_removable, true);
  assert.equal(pin.media_source.source_type, "image_url");
  assert.equal(pin.media_source.url, "https://cdn.goodos.app/goodads/launch.png");

  const ad = ads._test.pinterestAdPayload(row, "2680086898355", "687195905986");
  assert.equal(ad.status, "PAUSED");
  assert.equal(ad.creative_type, "REGULAR");
  assert.equal(ad.pin_id, "687195905986");
  assert.equal(ads._test.pinterestObjective("awareness").billableEvent, "IMPRESSION");
});

test("Pinterest setup fails closed on missing campaign access, event sources, and invalid copy", () => {
  const campaign = {
    status: "ready",
    data: {
      platforms: ["pinterest"],
      objective: "traffic",
      dailyBudget: 25,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      targetCountries: ["US"],
      creative: {
        headline: "Meet GoodOS",
        primaryText: "Run your business in one place.",
        destinationUrl: "https://goodos.app/",
        imageUrl: "https://cdn.goodos.app/goodads/launch.png",
      },
    },
  };
  const account = {
    provider: "pinterest",
    currency: "USD",
    timezone: "America/Los_Angeles",
    metadata: { deliveryReady: true },
  };
  assert.doesNotThrow(() => ads._test.validateCampaignForAccount(campaign, account));
  assert.throws(
    () => ads._test.validateCampaignForAccount(campaign, { ...account, metadata: {} }),
    (error) => error.code === "GOODADS_PINTEREST_CAMPAIGN_ACCESS_REQUIRED"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount({ ...campaign, data: { ...campaign.data, objective: "sales" } }, account),
    (error) => error.code === "GOODADS_PINTEREST_EVENT_SOURCE_REQUIRED"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount({
      ...campaign,
      data: {
        ...campaign.data,
        creative: { ...campaign.data.creative, headline: "x".repeat(101) },
      },
    }, account),
    (error) => error.code === "GOODADS_PINTEREST_COPY_TOO_LONG"
  );
});

test("Snapchat setup fails closed on unsafe budgets, objectives, profiles, and media hosts", () => {
  const campaign = {
    status: "ready",
    data: {
      platforms: ["snapchat"],
      objective: "traffic",
      dailyBudget: 5,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      targetCountries: ["US"],
      creative: {
        headline: "Meet GoodOS",
        destinationUrl: "https://goodos.app/",
        videoUrl: "https://cdn.goodos.app/goodads/launch.mp4",
      },
    },
  };
  const account = {
    provider: "snapchat",
    currency: "USD",
    timezone: "America/Los_Angeles",
    metadata: {
      deliveryReady: true,
      profileId: "c0ea278b-0449-4369-88d6-636e5d925f70",
    },
  };
  assert.doesNotThrow(() => ads._test.validateCampaignForAccount(campaign, account));
  assert.throws(
    () => ads._test.validateCampaignForAccount({ ...campaign, data: { ...campaign.data, dailyBudget: 4.99 } }, account),
    (error) => error.code === "GOODADS_SNAPCHAT_BUDGET_MINIMUM"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount({ ...campaign, data: { ...campaign.data, objective: "sales" } }, account),
    (error) => error.code === "GOODADS_SNAPCHAT_EVENT_SOURCE_REQUIRED"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount(campaign, { ...account, metadata: {} }),
    (error) => error.code === "GOODADS_SNAPCHAT_PROFILE_REQUIRED"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount({
      ...campaign,
      data: { ...campaign.data, creative: { ...campaign.data.creative, videoUrl: "https://example.com/ad.mp4" } },
    }, account),
    (error) => error.code === "GOODADS_SNAPCHAT_MEDIA_HOST_INVALID"
  );
});

test("TikTok setup fails closed on unsafe budgets, objectives, identities, media hosts, and copy", () => {
  const campaign = {
    status: "ready",
    data: {
      platforms: ["tiktok"],
      objective: "traffic",
      dailyBudget: 20,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      targetCountries: ["US"],
      creative: {
        headline: "Meet GoodOS",
        primaryText: "Run your business in one governed workspace.",
        destinationUrl: "https://goodos.app/",
        videoUrl: "https://cdn.goodos.app/goodads/launch.mp4",
      },
    },
  };
  const account = {
    provider: "tiktok",
    currency: "USD",
    timezone: "America/Los_Angeles",
    metadata: {
      deliveryReady: true,
      identityId: "7422222222222222222",
      identityType: "TT_USER",
    },
  };
  assert.doesNotThrow(() => ads._test.validateCampaignForAccount(campaign, account));
  assert.throws(
    () => ads._test.validateCampaignForAccount({ ...campaign, data: { ...campaign.data, dailyBudget: 19.99 } }, account),
    (error) => error.code === "GOODADS_TIKTOK_BUDGET_MINIMUM"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount({ ...campaign, data: { ...campaign.data, objective: "sales" } }, account),
    (error) => error.code === "GOODADS_TIKTOK_EVENT_SOURCE_REQUIRED"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount(campaign, { ...account, metadata: {} }),
    (error) => error.code === "GOODADS_TIKTOK_IDENTITY_REQUIRED"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount({
      ...campaign,
      data: { ...campaign.data, creative: { ...campaign.data.creative, videoUrl: "https://example.com/ad.mp4" } },
    }, account),
    (error) => error.code === "GOODADS_TIKTOK_VIDEO_HOST_INVALID"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount({
      ...campaign,
      data: { ...campaign.data, creative: { ...campaign.data.creative, primaryText: "x".repeat(101) } },
    }, account),
    (error) => error.code === "GOODADS_TIKTOK_COPY_INVALID"
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
