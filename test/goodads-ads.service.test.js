"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ads = require("../src/services/goodads-ads.service");

const TEST_OAUTH_ENCRYPTION_KEY = "test-goodads-oauth-encryption-key-32-bytes";
const ORIGINAL_OAUTH_ENCRYPTION_KEY = process.env.GOODADS_OAUTH_ENCRYPTION_KEY;

function withVerifiedAdConnection(account, connectionProvider = "facebook") {
  return {
    ...account,
    connection_provider: connectionProvider,
    connection_status: "connected",
    connection_scopes: ads._test.providerConnectionScopes(account.provider, connectionProvider),
    connection_metadata: {
      scopeVerification: { verifiedAt: "2026-10-01T00:00:00.000Z" },
    },
    connection_token_expires_at: null,
    connection_refreshable: false,
  };
}

test.before(() => {
  process.env.GOODADS_OAUTH_ENCRYPTION_KEY = TEST_OAUTH_ENCRYPTION_KEY;
});

test.after(() => {
  if (ORIGINAL_OAUTH_ENCRYPTION_KEY === undefined) delete process.env.GOODADS_OAUTH_ENCRYPTION_KEY;
  else process.env.GOODADS_OAUTH_ENCRYPTION_KEY = ORIGINAL_OAUTH_ENCRYPTION_KEY;
});

test("GoodAds paid providers fail closed until server credentials are complete", () => {
  const saved = {
    googleId: process.env.GOODADS_GOOGLE_CLIENT_ID,
    googleSecret: process.env.GOODADS_GOOGLE_CLIENT_SECRET,
    developerToken: process.env.GOODADS_GOOGLE_ADS_DEVELOPER_TOKEN,
    encryptionKey: process.env.GOODADS_OAUTH_ENCRYPTION_KEY,
  };
  delete process.env.GOODADS_GOOGLE_CLIENT_ID;
  delete process.env.GOODADS_GOOGLE_CLIENT_SECRET;
  delete process.env.GOODADS_GOOGLE_ADS_DEVELOPER_TOKEN;
  delete process.env.GOODADS_OAUTH_ENCRYPTION_KEY;
  const unavailable = ads._test.providerAvailability("google");
  assert.equal(unavailable.available, false);
  assert.deepEqual(unavailable.oauthSetup[0].credentialEnvironment, {
    clientId: "GOODADS_GOOGLE_CLIENT_ID",
    clientSecret: "GOODADS_GOOGLE_CLIENT_SECRET",
    advertisingOAuthEnabled: null,
  });
  assert.equal(unavailable.missingEnvironment.includes("GOODADS_OAUTH_ENCRYPTION_KEY"), true);
  assert.equal(unavailable.configurationErrors.includes("Secure OAuth token storage is not configured."), true);
  Object.assign(process.env, {
    GOODADS_GOOGLE_CLIENT_ID: "test-client",
    GOODADS_GOOGLE_CLIENT_SECRET: "test-secret",
    GOODADS_GOOGLE_ADS_DEVELOPER_TOKEN: "test-developer-token",
    GOODADS_OAUTH_ENCRYPTION_KEY: TEST_OAUTH_ENCRYPTION_KEY,
  });
  assert.equal(ads._test.providerAvailability("google").available, true);
  assert.equal(ads._test.providerAvailability("youtube").available, true);
  assert.equal(ads._test.providerAvailability("youtube").deliveryAdapter, "demand_gen_video");
  assert.equal(
    ads._test.providerAvailability("youtube").callbackUrls[0].url,
    "https://base.goodos.app/api/apps/goodads/v1/oauth/google/callback"
  );
  assert.equal(typeof ads._test.nativeAdapter("youtube").create, "function");
  for (const [key, value] of Object.entries(saved)) {
    const name = {
      googleId: "GOODADS_GOOGLE_CLIENT_ID",
      googleSecret: "GOODADS_GOOGLE_CLIENT_SECRET",
      developerToken: "GOODADS_GOOGLE_ADS_DEVELOPER_TOKEN",
      encryptionKey: "GOODADS_OAUTH_ENCRYPTION_KEY",
    }[key];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("all major paid platforms have explicit native delivery adapters", () => {
  assert.deepEqual(
    ads.publicProviders().map((provider) => provider.id),
    ["google", "meta", "youtube", "tiktok", "linkedin", "x", "pinterest", "snapchat"]
  );
  for (const provider of ["google", "meta", "youtube", "tiktok", "linkedin", "x", "pinterest", "snapchat"]) {
    const availability = ads._test.providerAvailability(provider);
    assert.equal(availability.adapterConfigured, true);
    assert.equal(availability.adapterType, "native");
    assert.equal(availability.supportedObjectives.includes("traffic"), true);
    assert.equal(typeof ads._test.nativeAdapter(provider).create, "function");
  }
});

test("provider objective contracts fail closed before an unsupported bidding path can be queued", () => {
  assert.equal(ads._test.validateProviderObjective("meta", "traffic"), "traffic");
  assert.equal(ads._test.validateProviderObjective("pinterest", "awareness"), "awareness");
  assert.equal(ads._test.validateProviderObjective("snapchat", "awareness"), "awareness");
  assert.throws(
    () => ads._test.validateProviderObjective("meta", "conversions"),
    (error) => error.code === "GOODADS_PROVIDER_EVENT_SOURCE_REQUIRED"
  );
  assert.throws(
    () => ads._test.validateProviderObjective("google", "awareness"),
    (error) => error.code === "GOODADS_PROVIDER_OBJECTIVE_UNSUPPORTED"
  );
});

test("queued paid activation revalidates the live snapshot, approval, account, and connection", () => {
  const names = ["GOODADS_FACEBOOK_CLIENT_ID", "GOODADS_FACEBOOK_CLIENT_SECRET"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      GOODADS_FACEBOOK_CLIENT_ID: "test-client",
      GOODADS_FACEBOOK_CLIENT_SECRET: "test-secret",
    });
    const snapshot = {
      id: "60fa3a7d-b4d5-4ff1-91f4-a5b4eaa72902",
      version: 3,
      name: "GoodOS launch",
      status: "ready",
      data: { objective: "traffic", dailyBudget: 25 },
    };
    const snapshotHash = ads._test.snapshotHash(snapshot);
    const row = {
      operation_type: "activate",
      operation_payload: { approvalId: "2ef6b324-78c5-46a2-a598-00920b1eb8a6" },
      ad_provider: "meta",
      connection_provider: "facebook",
      provider: "facebook",
      provider_campaign_record_id: "50f11ad4-5897-47b3-ab07-c1359989f379",
      campaign_id: snapshot.id,
      campaign_name: snapshot.name,
      campaign_status: snapshot.status,
      campaign_data: snapshot.data,
      current_version: snapshot.version,
      snapshot_hash: snapshotHash,
      status: "paused",
      account_status: "verified",
      connection_status: "connected",
      scopes: ads._test.providerConnectionScopes("meta", "facebook"),
      metadata: {
        scopeVerification: { verifiedAt: new Date().toISOString() },
      },
      approval_status: "approved",
      approval_data: {
        reviewType: "paid_campaign_activation",
        campaignId: snapshot.id,
        providerCampaignId: "50f11ad4-5897-47b3-ab07-c1359989f379",
        snapshotHash,
        requestedByUserId: "31b71666-f376-4233-be5e-8282a61c0d40",
        decidedByUserId: "41b71666-f376-4233-be5e-8282a61c0d40",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    };

    assert.doesNotThrow(() => ads._test.validateActivationExecution(row));
    assert.throws(
      () => ads._test.validateActivationExecution({ ...row, current_version: 4 }),
      (error) => error.code === "GOODADS_AD_CAMPAIGN_VERSION_CHANGED"
    );
    assert.throws(
      () => ads._test.validateActivationExecution({ ...row, approval_status: "rejected" }),
      (error) => error.code === "GOODADS_AD_ACTIVATION_APPROVAL_MISMATCH"
    );
    assert.throws(
      () => ads._test.validateActivationExecution({ ...row, connection_status: "expired" }),
      (error) => error.code === "GOODADS_CONNECTION_EXPIRED"
    );
    assert.throws(
      () => ads._test.validateActivationExecution({
        ...row,
        approval_data: { ...row.approval_data, expiresAt: "2020-01-01T00:00:00.000Z" },
      }),
      (error) => error.code === "GOODADS_AD_ACTIVATION_APPROVAL_EXPIRED"
    );
    assert.throws(
      () => ads._test.validateActivationExecution({
        ...row,
        approval_data: {
          ...row.approval_data,
          decidedByUserId: row.approval_data.requestedByUserId,
        },
      }),
      (error) => error.code === "GOODADS_AD_ACTIVATION_APPROVER_INVALID"
    );
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("paid activation approvals are system-generated and expire after a bounded window", () => {
  const previous = process.env.GOODADS_ACTIVATION_APPROVAL_VALID_MINUTES;
  process.env.GOODADS_ACTIVATION_APPROVAL_VALID_MINUTES = "1440";
  try {
    const timing = ads._test.activationApprovalTiming(new Date("2026-09-30T20:00:00.000Z"));
    assert.deepEqual(timing, {
      requestedAt: "2026-09-30T20:00:00.000Z",
      expiresAt: "2026-10-01T20:00:00.000Z",
    });
    assert.equal(ads._test.activationApprovalIsFresh(timing, new Date("2026-10-01T19:59:59.999Z")), true);
    assert.equal(ads._test.activationApprovalIsFresh(timing, new Date("2026-10-01T20:00:00.000Z")), false);
    assert.equal(ads._test.activationApprovalIsFresh({}, new Date("2026-09-30T20:00:00.000Z")), false);
    assert.equal(ads.capabilities().paidAdvertising.activationApprovalExpires, true);
    assert.equal(ads.capabilities().paidAdvertising.activationApprovalValidityMinutes, 1440);
    assert.equal(ads.capabilities().paidAdvertising.paidActivationApprovalsSystemGenerated, true);
    assert.equal(ads.capabilities().paidAdvertising.paidActivationApprovalsRequireIndependentReviewer, true);
    assert.equal(ads.capabilities().paidAdvertising.archivedActivationApprovalsRevoked, true);
    assert.match(
      fs.readFileSync(path.join(__dirname, "../src/services/goodads-ads.service.js"), "utf8"),
      /requestedByUserId: userId/
    );
    const source = fs.readFileSync(path.join(__dirname, "../src/services/goodads-ads.service.js"), "utf8");
    assert.match(source, /allowPaidCampaignActivation: true/);
    assert.equal((source.match(/GOODADS_AD_ACTIVATION_APPROVAL_EXPIRED/g) || []).length, 2);
    assert.equal((source.match(/approval\.archived_at IS NULL/g) || []).length, 3);
  } finally {
    if (previous === undefined) delete process.env.GOODADS_ACTIVATION_APPROVAL_VALID_MINUTES;
    else process.env.GOODADS_ACTIVATION_APPROVAL_VALID_MINUTES = previous;
  }
});

test("paid provider operations require provider-verified OAuth scope evidence", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/services/goodads-ads.service.js"), "utf8");
  assert.match(source, /metadata\?\.scopeVerification\?\.verifiedAt/);
  assert.match(source, /GOODADS_AD_CONNECTION_SCOPE_UNVERIFIED/);
});

test("paid worker preserves and validates separate ad-network and OAuth provider identities", () => {
  const requiredScopes = ads._test.providerConnectionScopes("meta", "facebook");
  assert.ok(requiredScopes.includes("ads_management"));
  assert.deepEqual(
    ads._test.operationProviderBindings({
      ad_provider: "meta",
      connection_provider: "facebook",
      provider: "facebook",
    }),
    { adProvider: "meta", connectionProvider: "facebook", requiredScopes }
  );
  assert.doesNotThrow(() => ads._test.validateOperationConnection({
    ad_provider: "meta",
    connection_provider: "facebook",
    provider: "facebook",
    connection_status: "connected",
    scopes: requiredScopes,
    metadata: { scopeVerification: { verifiedAt: "2026-10-01T00:00:00.000Z" } },
  }));
  assert.throws(
    () => ads._test.operationProviderBindings({
      ad_provider: "meta",
      connection_provider: "google",
      provider: "google",
    }),
    (error) => error.code === "GOODADS_AD_CONNECTION_PROVIDER_MISMATCH"
  );
  assert.throws(
    () => ads._test.validateOperationConnection({
      ad_provider: "meta",
      connection_provider: "facebook",
      provider: "facebook",
      connection_status: "connected",
      scopes: requiredScopes,
      metadata: {},
    }),
    (error) => error.code === "GOODADS_AD_CONNECTION_SCOPE_UNVERIFIED"
  );
});

test("campaign preflight rejects disconnected, expiring, and permission-unverified account connections", () => {
  const account = withVerifiedAdConnection({
    id: "a73b7d9f-292f-48b1-9557-3c02b185683c",
    provider: "meta",
  });
  assert.doesNotThrow(() => ads._test.validateAdAccountConnection(account));
  assert.throws(
    () => ads._test.validateAdAccountConnection({ ...account, connection_status: "disconnected" }),
    (error) => error.code === "GOODADS_CONNECTION_EXPIRED"
  );
  assert.throws(
    () => ads._test.validateAdAccountConnection({ ...account, connection_metadata: {} }),
    (error) => error.code === "GOODADS_AD_CONNECTION_SCOPE_UNVERIFIED"
  );
  assert.throws(
    () => ads._test.validateAdAccountConnection({
      ...account,
      connection_token_expires_at: "2026-10-01T00:03:00.000Z",
    }, new Date("2026-10-01T00:00:00.000Z")),
    (error) => error.code === "GOODADS_CONNECTION_EXPIRED"
  );
  assert.doesNotThrow(() => ads._test.validateAdAccountConnection({
    ...account,
    connection_token_expires_at: "2026-10-01T00:03:00.000Z",
    connection_refreshable: true,
  }, new Date("2026-10-01T00:00:00.000Z")));
});

test("campaign recovery selects only the newest failed create per provider delivery", () => {
  const candidates = ads._test.selectLatestFailedCreateOperations([
    { operation_record_id: "old", provider_campaign_record_id: "delivery-a", provider_campaign_status: "failed", provider_campaign_id: null, operation_type: "create", operation_status: "failed", operation_created_at: "2026-09-30T10:00:00.000Z" },
    { operation_record_id: "new", provider_campaign_record_id: "delivery-a", provider_campaign_status: "failed", provider_campaign_id: null, operation_type: "create", operation_status: "dead_letter", operation_created_at: "2026-09-30T11:00:00.000Z" },
    { operation_record_id: "pause", provider_campaign_record_id: "delivery-a", provider_campaign_status: "failed", provider_campaign_id: null, operation_type: "pause", operation_status: "failed", operation_created_at: "2026-09-30T12:00:00.000Z" },
    { operation_record_id: "complete", provider_campaign_record_id: "delivery-b", provider_campaign_status: "failed", provider_campaign_id: null, operation_type: "create", operation_status: "completed", operation_created_at: "2026-09-30T12:00:00.000Z" },
    { operation_record_id: "already-created", provider_campaign_record_id: "delivery-b", provider_campaign_status: "paused", provider_campaign_id: "provider-123", operation_type: "create", operation_status: "failed", operation_created_at: "2026-09-30T13:00:00.000Z" },
    { operation_record_id: "other", provider_campaign_record_id: "delivery-c", provider_campaign_status: "failed", provider_campaign_id: null, operation_type: "create", operation_status: "failed", operation_created_at: "2026-09-30T09:00:00.000Z" },
  ]);
  assert.deepEqual(candidates.map((candidate) => candidate.operation_record_id), ["new", "other"]);
  assert.equal(ads.capabilities().paidAdvertising.campaignRecoveryBatchRetry, true);
  const source = fs.readFileSync(path.join(__dirname, "../src/services/goodads-ads.service.js"), "utf8");
  assert.match(source, /provider_campaign\.status = 'failed' AND provider_campaign\.provider_campaign_id IS NULL/);
});

test("X Ads delivery requires its own approved OAuth 1.0a app", () => {
  const names = ["GOODADS_X_ADS_CONSUMER_KEY", "GOODADS_X_ADS_CONSUMER_SECRET"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    delete process.env.GOODADS_X_ADS_CONSUMER_KEY;
    delete process.env.GOODADS_X_ADS_CONSUMER_SECRET;
    assert.equal(ads._test.providerAvailability("x").available, false);
    Object.assign(process.env, {
      GOODADS_X_ADS_CONSUMER_KEY: "consumer-key",
      GOODADS_X_ADS_CONSUMER_SECRET: "consumer-secret",
    });
    const availability = ads._test.providerAvailability("x");
    assert.equal(availability.available, true);
    assert.deepEqual(availability.connectionProviders, ["x_ads"]);
    assert.equal(availability.safePausedCreation, true);
    assert.equal(availability.activationSupported, true);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
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
    assert.deepEqual(withoutScopes.missingOAuthScopes, ["r_ads", "r_ads_reporting", "rw_ads"]);

    process.env.GOODADS_LINKEDIN_ADS_OAUTH_ENABLED = "true";
    const withScopes = ads._test.providerAvailability("linkedin");
    assert.equal(withScopes.available, true);
    assert.equal(withScopes.adapterConfigured, true);
    assert.equal(withScopes.adapterType, "native");
    assert.equal(withScopes.safePausedCreation, true);
    assert.equal(withScopes.activationSupported, true);
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

test("Meta delivery enforces exact Facebook and Instagram placement intent", () => {
  assert.deepEqual(ads._test.metaPublisherPlatforms({ platforms: ["facebook"] }), ["facebook"]);
  assert.deepEqual(ads._test.metaPublisherPlatforms({ platforms: ["instagram"] }), ["instagram"]);
  assert.deepEqual(ads._test.metaPublisherPlatforms({ platforms: ["instagram", "facebook"] }), ["facebook", "instagram"]);
  assert.deepEqual(ads._test.metaPublisherPlatforms({ platforms: ["meta"] }), ["facebook", "instagram"]);

  const campaign = {
    status: "ready",
    data: {
      platforms: ["instagram"],
      objective: "traffic",
      dailyBudget: 25,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      targetCountries: ["US"],
      creative: {
        destinationUrl: "https://goodos.app/",
        imageUrl: "https://cdn.goodos.app/goodads/meta.png",
      },
    },
  };
  const account = {
    provider: "meta",
    currency: "USD",
    timezone: "America/Los_Angeles",
    metadata: { pageId: "12345" },
  };
  assert.throws(
    () => ads._test.validateCampaignForAccount(campaign, account),
    (error) => error.code === "GOODADS_META_INSTAGRAM_IDENTITY_REQUIRED"
  );
  assert.doesNotThrow(() => ads._test.validateCampaignForAccount(campaign, {
    ...account,
    metadata: { ...account.metadata, instagramActorId: "67890" },
  }));
  assert.doesNotThrow(() => ads._test.validateCampaignForAccount({
    ...campaign,
    data: { ...campaign.data, platforms: ["facebook"] },
  }, account));
  assert.throws(
    () => ads._test.validateCampaignForAccount({
      ...campaign,
      data: { ...campaign.data, platforms: ["facebook"], objective: "conversions" },
    }, account),
    (error) => error.code === "GOODADS_PROVIDER_EVENT_SOURCE_REQUIRED"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount({
      ...campaign,
      data: { ...campaign.data, platforms: ["facebook"] },
    }, { ...account, status: "disabled" }),
    (error) => error.code === "GOODADS_AD_ACCOUNT_NOT_VERIFIED"
  );
});

test("campaign preflight proves read-only paused exposure for the exact saved version", () => {
  const campaign = {
    id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    version: 7,
    status: "ready",
    data: {
      platforms: ["facebook"],
      objective: "traffic",
      dailyBudget: 25,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      targetCountries: ["US"],
      creative: {
        destinationUrl: "https://goodos.app/",
        imageUrl: "https://cdn.goodos.app/goodads/meta.png",
      },
    },
  };
  const accounts = [
    withVerifiedAdConnection({
      id: "a73b7d9f-292f-48b1-9557-3c02b185683c",
      provider: "meta",
      name: "GoodOS Main",
      status: "verified",
      currency: "USD",
      timezone: "America/Los_Angeles",
      metadata: { pageId: "12345" },
    }),
    withVerifiedAdConnection({
      id: "9660d441-897d-4464-b960-c92ded8a4f12",
      provider: "meta",
      name: "GoodOS West",
      status: "verified",
      currency: "USD",
      timezone: "America/Los_Angeles",
      metadata: { pageId: "67890" },
    }),
  ];
  const report = ads._test.campaignPreflightReport({
    campaign,
    requestedAccountIds: accounts.map((account) => account.id),
    accounts,
    providerCampaigns: [{
      id: "d5802d7f-0562-485c-b8f6-2bf662850e08",
      ad_account_id: accounts[0].id,
      status: "paused",
      provider_campaign_id: "provider-123",
    }],
    availabilityByProvider: { meta: { available: true, name: "Meta Ads" } },
    generatedAt: "2026-09-30T12:00:00.000Z",
  });

  assert.equal(report.ready, true);
  assert.equal(report.campaignVersion, 7);
  assert.equal(report.readOnly, true);
  assert.equal(report.providerNetworkCalls, 0);
  assert.equal(report.providerWrites, 0);
  assert.equal(report.activatesAdvertising, false);
  assert.equal(report.startsSpend, false);
  assert.equal(report.deliveryMode, "paused_only");
  assert.deepEqual(report.exposure, {
    accountCount: 2,
    deliveryDays: 8,
    dailyBudgetPerAccount: 25,
    combinedDailyBudget: 50,
    planningMaximum: 400,
    limits: ads._test.campaignExposurePolicy(),
    schedule: {
      timezone: "America/Los_Angeles",
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      startAt: "2026-10-05T07:00:00.000Z",
      endAt: "2026-10-13T07:00:00.000Z",
      endExclusive: true,
      deliveryDays: 8,
    },
    currency: "USD",
    timezone: "America/Los_Angeles",
  });
  assert.equal(report.existingDeliveries, 1);
  assert.equal(report.missingPausedDeliveries, 1);
  assert.equal(report.accountChecks[0].willCreatePausedDelivery, false);
  assert.equal(report.accountChecks[1].willCreatePausedDelivery, true);
});

test("campaign-wide exposure limits block multiplied spend across accounts and time", () => {
  const dailyExposure = ads._test.campaignExposure({
    dailyBudget: 400,
    startDate: "2026-10-05",
    endDate: "2026-10-12",
  }, 3, "America/Los_Angeles");
  assert.equal(dailyExposure.combinedDailyBudget, 1200);
  assert.equal(
    ads._test.campaignExposureIssues(dailyExposure).some((issue) => issue.code === "GOODADS_COMBINED_DAILY_BUDGET_EXCEEDED"),
    true
  );

  const planningExposure = ads._test.campaignExposure({
    dailyBudget: 100,
    startDate: "2026-10-01",
    endDate: "2026-11-09",
  }, 10, "America/Los_Angeles");
  assert.equal(planningExposure.combinedDailyBudget, 1000);
  assert.equal(planningExposure.planningMaximum, 40000);
  assert.equal(
    ads._test.campaignExposureIssues(planningExposure).some((issue) => issue.code === "GOODADS_PLANNING_BUDGET_EXCEEDED"),
    true
  );

  assert.throws(
    () => ads._test.validateCampaignExposure({
      dailyBudget: 25,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
    }, 11, "America/Los_Angeles"),
    (error) => error.code === "GOODADS_CAMPAIGN_ACCOUNT_LIMIT_EXCEEDED"
  );
  assert.equal(ads.capabilities().paidAdvertising.campaignWideExposureLimits, true);
  assert.deepEqual(ads.capabilities().paidAdvertising.exposureLimits, ads._test.campaignExposurePolicy());
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "goodads-ads.service.js"), "utf8");
  assert.match(source, /goodads:campaign-exposure:/);
  assert.match(source, /validateCampaignExposure\(campaign\.data, plannedAccounts\.size/);
  assert.equal((source.match(/await validateStoredCampaignExposure\(/g) || []).length, 2);

  const secondBatch = ads._test.campaignPreflightReport({
    campaign: {
      id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
      version: 1,
      status: "ready",
      data: {
        platforms: ["facebook"],
        objective: "traffic",
        dailyBudget: 25,
        startDate: "2026-10-05",
        endDate: "2026-10-12",
        targetCountries: ["US"],
        creative: {
          destinationUrl: "https://goodos.app/",
          imageUrl: "https://cdn.goodos.app/goodads/meta.png",
        },
      },
    },
    requestedAccountIds: ["new-account"],
    accounts: [withVerifiedAdConnection({
      id: "new-account",
      provider: "meta",
      name: "New account",
      status: "verified",
      currency: "USD",
      timezone: "America/Los_Angeles",
      metadata: { pageId: "12345" },
    })],
    providerCampaigns: Array.from({ length: 10 }, (_, index) => ({
      id: `delivery-${index}`,
      ad_account_id: `existing-account-${index}`,
      status: "paused",
      provider_campaign_id: `provider-${index}`,
      account_currency: "USD",
      account_timezone: "America/Los_Angeles",
    })),
    availabilityByProvider: { meta: { available: true, name: "Meta Ads" } },
  });
  assert.equal(secondBatch.exposure.accountCount, 11);
  assert.equal(secondBatch.ready, false);
  assert.equal(secondBatch.blockers.some((issue) => issue.code === "GOODADS_CAMPAIGN_ACCOUNT_LIMIT_EXCEEDED"), true);
});

test("approved activation provisions one deterministic protected campaign spend stop", () => {
  const campaignId = "89e0e5e1-ee43-4c9a-a41b-6b07bb920430";
  const otherCampaignId = "89e0e5e1-ee43-4c9a-a41b-6b07bb920431";
  const guardId = ads._test.automaticSpendGuardId(campaignId);
  assert.equal(guardId, ads._test.automaticSpendGuardId(campaignId));
  assert.notEqual(guardId, ads._test.automaticSpendGuardId(otherCampaignId));
  assert.match(guardId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const shortGuard = ads._test.automaticSpendGuardSpec({
    campaign: { campaign_id: campaignId, campaign_name: "Protected launch" },
    exposure: { combinedDailyBudget: 50, deliveryDays: 7, currency: "USD" },
    now: new Date("2026-09-30T20:00:00.000Z"),
  });
  assert.equal(shortGuard.data.maximumTrackedSpend, 350);
  assert.equal(shortGuard.data.intervalMinutes, 15);
  assert.equal(shortGuard.data.nextRunAt, "2026-09-30T20:20:00.000Z");
  assert.equal(shortGuard.data.pauseOnStaleMetrics, true);
  assert.equal(shortGuard.data.systemManaged, true);
  assert.equal(shortGuard.data.guardType, "automatic_campaign_budget");

  const boundedGuard = ads._test.automaticSpendGuardSpec({
    campaign: { campaign_id: campaignId, campaign_name: "Long launch" },
    exposure: { combinedDailyBudget: 25, deliveryDays: 90, currency: "EUR" },
    now: new Date("2026-09-30T20:00:00.000Z"),
  });
  assert.equal(boundedGuard.data.maximumTrackedSpend, 750);
  assert.equal(boundedGuard.data.maximumWindowDays, 30);

  const source = fs.readFileSync(path.join(__dirname, "../src/services/goodads-ads.service.js"), "utf8");
  assert.match(source, /INSERT INTO goodads_resources \(/);
  assert.match(source, /'automations'/);
  assert.match(source, /systemManaged: true/);
  assert.match(source, /actionType: "enforce_spend_guard"/);
  assert.match(source, /await client\.query\("BEGIN"\)/);
  assert.equal(ads.capabilities().paidAdvertising.automaticSpendGuards, true);
  assert.equal(ads.capabilities().paidAdvertising.spendGuardIntervalMinutes, 15);
  assert.equal(ads.capabilities().paidAdvertising.spendGuardReportingWindowDays, 30);
  assert.equal(ads.capabilities().paidAdvertising.spendGuardFailsClosedOnStaleMetrics, true);
});

test("campaign preflight and launch fail closed when account locale is incomplete", () => {
  const accountId = "a73b7d9f-292f-48b1-9557-3c02b185683c";
  const report = ads._test.campaignPreflightReport({
    campaign: {
      id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
      version: 2,
      status: "ready",
      data: {
        platforms: ["facebook"],
        objective: "traffic",
        dailyBudget: 25,
        startDate: "2026-10-05",
        endDate: "2026-10-12",
        targetCountries: ["US"],
        creative: {
          destinationUrl: "https://goodos.app/",
          imageUrl: "https://cdn.goodos.app/goodads/meta.png",
        },
      },
    },
    requestedAccountIds: [accountId],
    accounts: [withVerifiedAdConnection({
      id: accountId,
      provider: "meta",
      name: "Incomplete account",
      status: "verified",
      currency: "USD",
      timezone: "",
      metadata: { pageId: "12345" },
    })],
    availabilityByProvider: { meta: { available: false, name: "Meta Ads" } },
    generatedAt: "2026-09-30T12:00:00.000Z",
  });

  assert.equal(report.ready, false);
  assert.equal(report.exposure.currency, null);
  assert.equal(report.exposure.timezone, null);
  assert.equal(report.missingPausedDeliveries, 0);
  assert.equal(report.blockers.some((blocker) => blocker.code === "GOODADS_AD_ACCOUNT_LOCALE_MISMATCH"), true);
  assert.equal(report.blockers.some((blocker) => blocker.code === "GOODADS_AD_ACCOUNT_LOCALE_REQUIRED"), true);
  assert.equal(report.blockers.some((blocker) => blocker.code === "GOODADS_AD_PROVIDER_NOT_CONFIGURED"), true);

  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/goodads-ads.service.js"),
    "utf8"
  );
  assert.match(source, /const accountLocaleIncomplete = accountResult\.rows\.some/);
  assert.match(source, /if \(accountLocaleIncomplete \|\| accountLocales\.size !== 1\)/);
});

test("campaign schedule boundaries preserve account-local dates across daylight saving time", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/goodads-ads.service.js"),
    "utf8"
  );
  assert.match(source, /const schedule = campaignScheduleBounds\(data, row\.account_timezone\)/);
  assert.doesNotMatch(source, /new Date\(`\$\{value\}T00:00:00\.000Z`\)/);

  const pacific = ads._test.campaignScheduleBounds({
    startDate: "2026-10-31",
    endDate: "2026-11-02",
  }, "America/Los_Angeles");
  assert.equal(pacific.startAt, "2026-10-31T07:00:00.000Z");
  assert.equal(pacific.endAt, "2026-11-03T08:00:00.000Z");
  assert.equal(pacific.deliveryDays, 3);
  assert.equal((Date.parse(pacific.endAt) - Date.parse(pacific.startAt)) / 3600000, 73);

  const kathmandu = ads._test.campaignScheduleBounds({
    startDate: "2026-10-05",
    endDate: "2026-10-05",
  }, "Asia/Kathmandu");
  assert.equal(kathmandu.startAt, "2026-10-04T18:15:00.000Z");
  assert.equal(kathmandu.endAt, "2026-10-05T18:15:00.000Z");
  assert.throws(
    () => ads._test.campaignScheduleBounds({ startDate: "2026-02-30", endDate: "2026-03-01" }, "UTC"),
    (error) => error.code === "GOODADS_CAMPAIGN_DATES_INVALID"
  );
  assert.throws(
    () => ads._test.campaignScheduleBounds({ startDate: "2026-10-05", endDate: "2026-10-12" }, "Not/A_Timezone"),
    (error) => error.code === "GOODADS_AD_ACCOUNT_TIMEZONE_INVALID"
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
        videoUrl: "https://cdn.goodos.app/goodads/tiktok-launch.mp4",
        youtubeVideoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
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
    (error) => error.code === "GOODADS_PROVIDER_EVENT_SOURCE_REQUIRED"
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

test("one campaign resolves independent YouTube and TikTok video assets", () => {
  const campaign = {
    status: "ready",
    data: {
      platforms: ["youtube", "tiktok"],
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
        youtubeVideoUrl: "https://youtu.be/dQw4w9WgXcQ",
        tiktokVideoUrl: "https://cdn.goodos.app/goodads/launch.mp4",
        logoUrl: "https://cdn.goodos.app/goodads/logo.png",
      },
    },
  };
  const youtubeAccount = {
    provider: "youtube",
    currency: "USD",
    timezone: "America/Los_Angeles",
    metadata: { deliveryReady: true },
  };
  const tiktokAccount = {
    provider: "tiktok",
    currency: "USD",
    timezone: "America/Los_Angeles",
    metadata: {
      deliveryReady: true,
      identityId: "7422222222222222222",
      identityType: "TT_USER",
    },
  };

  assert.equal(ads._test.providerCreativeVideoUrl(campaign.data, "youtube"), campaign.data.creative.youtubeVideoUrl);
  assert.equal(ads._test.providerCreativeVideoUrl(campaign.data, "tiktok"), campaign.data.creative.tiktokVideoUrl);
  assert.doesNotThrow(() => ads._test.validateCampaignForAccount(campaign, youtubeAccount));
  assert.doesNotThrow(() => ads._test.validateCampaignForAccount(campaign, tiktokAccount));
  assert.equal(
    ads._test.providerCreativeVideoUrl({ creative: { videoUrl: "https://cdn.goodos.app/legacy.mp4" } }, "tiktok"),
    "https://cdn.goodos.app/legacy.mp4"
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
    account_timezone: "UTC",
    account_metadata: { organizationUrn: "urn:li:organization:5803528" },
    campaign_name: "GoodOS Launch",
    campaign_data: {
      objective: "traffic",
      linkedinPoliticalIntent: "NOT_POLITICAL",
      linkedinTargetingNoticeAcknowledged: true,
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
  assert.equal(campaign.politicalIntent, "NOT_POLITICAL");
  assert.deepEqual(campaign.runSchedule, {
    start: Date.parse("2026-10-05T00:00:00.000Z"),
    end: Date.parse("2026-10-13T00:00:00.000Z"),
  });
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
  assert.throws(
    () => ads._test.linkedInPolicyCompliance({ linkedinPoliticalIntent: "NOT_POLITICAL" }),
    (error) => error.code === "GOODADS_LINKEDIN_TARGETING_NOTICE_REQUIRED"
  );
});

test("LinkedIn activation enables the approved creative before the paused campaign", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  try {
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(null, { status: 204 });
    };
    const receipt = await ads._test.nativeAdapter("linkedin").updateStatus({
      provider_account_id: "518121035",
      provider_campaign_id: "360035215",
      campaign_data: {
        linkedinPoliticalIntent: "NOT_POLITICAL",
        linkedinTargetingNoticeAcknowledged: true,
      },
      receipt: { creativeUrn: "urn:li:sponsoredCreative:120491345", state: "PAUSED" },
    }, "access-token", "ACTIVE");

    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/creatives\/urn%3Ali%3AsponsoredCreative%3A120491345$/);
    assert.equal(calls[0].body.patch.$set.intendedStatus, "ACTIVE");
    assert.match(calls[1].url, /\/adCampaigns\/360035215$/);
    assert.equal(calls[1].body.patch.$set.status, "ACTIVE");
    assert.equal(receipt.creativeIntendedStatus, "ACTIVE");
    assert.equal(receipt.state, "ACTIVE");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Snapchat adapter builds a fully paused campaign stack with a shared Public Profile", () => {
  const row = {
    provider_account_id: "8b8e40af-fc64-455d-925b-ca80f7af6914",
    account_timezone: "America/Los_Angeles",
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
  assert.equal(campaign.start_time, "2026-10-05T07:00:00.000Z");
  assert.equal(campaign.end_time, "2026-10-13T07:00:00.000Z");

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

test("X Ads adapter builds a paused website-click stack and promoted-only post", () => {
  const row = {
    provider_campaign_record_id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    provider_account_id: "18ce54d4x5t",
    account_timezone: "America/Los_Angeles",
    account_metadata: {
      deliveryReady: true,
      fundingInstrumentId: "lygyi",
      advertiserUserId: "756201191646691328",
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
        destinationUrl: "https://goodos.app/?utm_source=x",
      },
    },
  };
  const budget = ads._test.xAdsBudget(row);
  assert.deepEqual(budget, { daily: 25000000, total: 200000000 });
  const campaign = ads._test.xCampaignParameters(row);
  assert.equal(campaign.entity_status, "PAUSED");
  assert.equal(campaign.budget_optimization, "LINE_ITEM");
  assert.equal(campaign.funding_instrument_id, "lygyi");
  const lineItem = ads._test.xLineItemParameters(row, "hwtbm");
  assert.equal(lineItem.entity_status, "PAUSED");
  assert.equal(lineItem.objective, "WEBSITE_CLICKS");
  assert.equal(lineItem.product_type, "PROMOTED_TWEETS");
  assert.equal(lineItem.placements, "ALL_ON_TWITTER");
  assert.equal(lineItem.bid_strategy, "AUTO");
  assert.equal(lineItem.goal, "LINK_CLICKS");
  assert.equal(lineItem.start_time, "2026-10-05T07:00:00.000Z");
  assert.equal(lineItem.end_time, "2026-10-13T07:00:00.000Z");
  const post = ads._test.xTweetParameters(row);
  assert.equal(post.as_user_id, "756201191646691328");
  assert.equal(post.nullcast, true);
  assert.match(post.text, /utm_source=x$/);
  assert.ok(post.name.length <= 80);
});

test("X Ads accounts fail closed without approval, funding, or a full promotable user", () => {
  const account = { id: "18ce54d4x5t", name: "GoodOS", approval_status: "ACCEPTED", timezone: "America/Los_Angeles" };
  const funding = { id: "lygyi", entity_status: "ACTIVE", able_to_fund: true, deleted: false, currency: "USD" };
  const user = { user_id: "756201191646691328", promotable_user_type: "FULL", deleted: false };
  const access = { permissions: ["AD_MANAGER", "TWEET_COMPOSER"] };
  const ready = ads._test.normalizeXAccount(account, funding, user, access);
  assert.equal(ready.eligible, true);
  assert.equal(ready.metadata.deliveryReady, true);
  assert.equal(ready.metadata.fundingInstrumentId, "lygyi");
  assert.equal(ready.metadata.advertiserUserId, "756201191646691328");
  assert.equal(ads._test.normalizeXAccount({ ...account, approval_status: "PENDING" }, funding, user, access).eligible, false);
  assert.equal(ads._test.normalizeXAccount(account, { ...funding, able_to_fund: false }, user, access).eligible, false);
  assert.equal(ads._test.normalizeXAccount(account, funding, { ...user, promotable_user_type: "RETWEETS_ONLY" }, access).eligible, false);
  assert.equal(ads._test.normalizeXAccount(account, funding, user, { permissions: ["CAMPAIGN_ANALYST"] }).eligible, false);
});

test("Pinterest adapter builds a paused CBO campaign, targeted ad group, ad-only Pin, and ad", () => {
  const row = {
    provider_account_id: "549755885175",
    account_timezone: "America/Los_Angeles",
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
  assert.equal(campaign.start_time, Date.parse("2026-10-05T07:00:00.000Z") / 1000);
  assert.equal(campaign.end_time, Date.parse("2026-10-13T07:00:00.000Z") / 1000);
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
    (error) => error.code === "GOODADS_PROVIDER_EVENT_SOURCE_REQUIRED"
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
    (error) => error.code === "GOODADS_PROVIDER_EVENT_SOURCE_REQUIRED"
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
    (error) => error.code === "GOODADS_PROVIDER_EVENT_SOURCE_REQUIRED"
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

test("X Ads setup fails closed on objectives, funding prerequisites, and oversized post copy", () => {
  const campaign = {
    status: "ready",
    data: {
      platforms: ["x"],
      objective: "traffic",
      dailyBudget: 5,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      targetCountries: ["US"],
      creative: {
        primaryText: "Run your business in one governed workspace.",
        destinationUrl: "https://goodos.app/?utm_source=x",
      },
    },
  };
  const account = {
    provider: "x",
    currency: "USD",
    timezone: "America/Los_Angeles",
    metadata: {
      deliveryReady: true,
      fundingInstrumentId: "lygyi",
      advertiserUserId: "756201191646691328",
    },
  };
  assert.doesNotThrow(() => ads._test.validateCampaignForAccount(campaign, account));
  assert.throws(
    () => ads._test.validateCampaignForAccount({ ...campaign, data: { ...campaign.data, objective: "sales" } }, account),
    (error) => error.code === "GOODADS_PROVIDER_EVENT_SOURCE_REQUIRED"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount(campaign, { ...account, metadata: {} }),
    (error) => error.code === "GOODADS_X_DELIVERY_PREREQUISITES_REQUIRED"
  );
  assert.throws(
    () => ads._test.validateCampaignForAccount({
      ...campaign,
      data: {
        ...campaign.data,
        creative: { ...campaign.data.creative, primaryText: "x".repeat(260) },
      },
    }, account),
    (error) => error.code === "GOODADS_X_COPY_INVALID"
  );
});

test("paid campaign adapters bind approvals to immutable snapshots", () => {
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

test("provider creation executes the immutable launch snapshot instead of later campaign edits", () => {
  const snapshot = {
    id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    version: 3,
    name: "Approved launch",
    status: "ready",
    data: { dailyBudget: 25, creative: { headline: "Approved copy" } },
  };
  const hash = ads._test.snapshotHash(snapshot);
  const bound = ads._test.bindCreateOperationSnapshot({
    operation_type: "create",
    operation_payload: { snapshot, snapshotHash: hash },
    snapshot_hash: hash,
    campaign_name: "Later edit",
    campaign_data: { dailyBudget: 5000, creative: { headline: "Unreviewed copy" } },
  });

  assert.equal(bound.campaign_name, "Approved launch");
  assert.equal(bound.campaign_status, "ready");
  assert.equal(bound.campaign_version, 3);
  assert.deepEqual(bound.campaign_data, snapshot.data);
  assert.throws(
    () => ads._test.bindCreateOperationSnapshot({
      operation_type: "create",
      operation_payload: { snapshot: { ...snapshot, version: 4 }, snapshotHash: hash },
      snapshot_hash: hash,
    }),
    /immutable campaign snapshot/
  );
  assert.equal(ads.capabilities().paidAdvertising.immutableLaunchSnapshots, true);
  assert.equal(ads.capabilities().paidAdvertising.executionTimeRevalidation, true);
  assert.equal(ads.capabilities().paidAdvertising.objectiveContracts, true);
  assert.equal(ads.capabilities().paidAdvertising.oneOpenMutationPerProviderCampaign, true);
});

test("workspace emergency pause blocks activation and durably queues provider pauses", () => {
  const marker = {
    active: true,
    requestKey: "goodads:emergency-pause:test",
    requestedAt: "2026-10-01T00:00:00.000Z",
    requestedByUserId: "31b71666-f376-4233-be5e-8282a61c0d40",
  };
  assert.deepEqual(ads._test.emergencyPauseMarker({ emergencyPause: marker }), marker);
  assert.equal(ads._test.emergencyPauseMarker({}), null);
  assert.throws(
    () => ads._test.validateActivationExecution({ operation_type: "activate", receipt: { emergencyPause: marker } }),
    (error) => error.code === "GOODADS_EMERGENCY_PAUSE_ACTIVE"
  );

  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/goodads-ads.service.js"),
    "utf8"
  );
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  assert.match(source, /EMERGENCY_PAUSE_CONFIRMATION = "PAUSE ALL CAMPAIGNS"/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /Cancelled by the workspace emergency pause/);
  assert.match(source, /inFlightActivationsIntercepted/);
  assert.match(routes, /router\.post\("\/ads\/emergency-pause"/);
  assert.match(routes, /ads\.emergencyPauseAll/);
  assert.equal(ads.capabilities().paidAdvertising.emergencyPauseAll, true);
});

test("automatic provider reconciliation pauses unexpected activation drift", () => {
  assert.equal(ads._test.shouldPauseUnexpectedActivation({
    operationType: "sync",
    providerStatus: "active",
    storedStatus: "paused",
  }), true);
  assert.equal(ads._test.shouldPauseUnexpectedActivation({
    operationType: "sync",
    providerStatus: "active",
    storedStatus: "active",
  }), false);
  assert.equal(ads._test.shouldPauseUnexpectedActivation({
    operationType: "sync",
    providerStatus: "active",
    storedStatus: "paused",
    activationPending: true,
  }), false);
  assert.equal(ads._test.shouldPauseUnexpectedActivation({
    operationType: "pause",
    providerStatus: "active",
    storedStatus: "paused",
  }), false);

  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/goodads-ads.service.js"),
    "utf8"
  );
  assert.match(source, /automatic-reconcile:/);
  assert.match(source, /\$2::integer \* 60/);
  assert.match(source, /unexpected_provider_activation/);
  assert.match(source, /automatic-drift-pause:/);
  assert.match(source, /row\.operation_type === "sync" \|\| retry \? row\.status : "failed"/);
  assert.equal(ads.capabilities().paidAdvertising.automaticStateReconciliation, true);
  assert.equal(ads.capabilities().paidAdvertising.unexpectedActivationAutoPause, true);
  assert.equal(ads.capabilities().paidAdvertising.providerReconciliationMinutes, 5);
});

test("paid campaign migration installs verified accounts, durable operations, and worker dispatch", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "../migrations/20260729_goodads_paid_campaigns.sql"),
    "utf8"
  );
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  const jobs = fs.readFileSync(path.join(__dirname, "../src/services/job.service.js"), "utf8");
  const runner = fs.readFileSync(
    path.join(__dirname, "../scripts/apply-goodads-paid-campaigns-migration.js"),
    "utf8"
  );
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  const majorPlatformsMigration = fs.readFileSync(
    path.join(__dirname, "../migrations/20260930_goodads_major_ad_platforms.sql"),
    "utf8"
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_ad_accounts/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_provider_campaigns/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_ad_operations/);
  assert.match(migration, /idx_goodads_ad_operations_open_mutation/);
  assert.match(migration, /operation_type IN \('create', 'pause', 'activate', 'archive'\)/);
  assert.match(runner, /OPEN_MUTATION_INDEX_SQL/);
  assert.match(runner, /"\/usr\/sbin\/runuser"/);
  assert.match(runner, /"-u", "postgres"/);
  assert.match(runner, /process\.getuid\(\) !== 0/);
  assert.match(migration, /activation_approval_id/);
  assert.match(migration, /'goodads\.ads\.dispatch'/);
  assert.match(jobs, /case "goodads\.ads\.dispatch"/);
  assert.match(routes, /ads\.preflightCampaign/);
  assert.match(routes, /ads\.requestActivationApproval/);
  assert.match(routes, /ads\.queueLifecycleOperation/);
  assert.match(routes, /ads\.retryOperation/);
  assert.match(routes, /ads\.retryFailedCampaignCreates/);
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
  assert.match(source, /account\.status AS account_status/);
  assert.match(source, /provider_campaign\.provider AS ad_provider/);
  assert.match(source, /connection\.provider AS connection_provider/);
  const createValidationIndex = source.indexOf("validateCreateExecution(executionRow);");
  const providerTokenIndex = source.indexOf("social.accessTokenForConnection(connection)", createValidationIndex);
  assert.ok(createValidationIndex >= 0 && providerTokenIndex > createValidationIndex);
  assert.match(source, /GOODADS_PROVIDER_EVENT_SOURCE_REQUIRED/);
  assert.match(source, /ON CONFLICT DO NOTHING/);
  assert.match(source, /active_operation\.operation_type IN \('create','pause','activate','archive'\)/);
  assert.match(source, /intendedStatus: "DRAFT"/);
  assert.match(source, /creativeIntendedStatus/);
  assert.match(source, /GOODADS_LINKEDIN_POLITICAL_CONFIRMATION_REQUIRED/);
  assert.match(source, /GOODADS_LINKEDIN_TARGETING_NOTICE_REQUIRED/);
  assert.doesNotMatch(source, /row\.provider === "meta"[\s\S]{0,120}: createGoogleDelivery/);
});
