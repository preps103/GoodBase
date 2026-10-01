"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const social = require("../src/services/goodads-social.service");

test("GoodAds social registry includes major publishing networks", () => {
  for (const provider of ["google", "facebook", "instagram", "threads", "linkedin", "x", "x_ads", "tiktok", "tiktok_ads", "pinterest", "snapchat", "reddit"]) {
    assert.ok(social.PROVIDERS[provider]);
    assert.ok(social.PROVIDERS[provider].authUrl.startsWith("https://"));
    assert.ok(social.PROVIDERS[provider].tokenUrl.startsWith("https://"));
  }
});

test("social tokens are authenticated-encrypted at rest", () => {
  process.env.GOODADS_OAUTH_ENCRYPTION_KEY = "test-only-key";
  const encrypted = social.encrypt("provider-token");
  assert.notEqual(encrypted.ciphertext, "provider-token");
  assert.equal(social.decrypt(encrypted.ciphertext, encrypted.iv, encrypted.tag), "provider-token");
});

test("unconfigured providers are reported without fabricated success", () => {
  delete process.env.GOODADS_X_CLIENT_ID;
  delete process.env.GOODADS_X_CLIENT_SECRET;
  assert.equal(social.providerConfig("x").configured, false);
  assert.throws(() => social.providerConfig("unknown"), /Unsupported social provider/);
});

test("provider diagnostics expose standardized credential names without secret values", () => {
  const names = ["GOODADS_LINKEDIN_CLIENT_ID", "GOODADS_LINKEDIN_CLIENT_SECRET"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      GOODADS_LINKEDIN_CLIENT_ID: "configured-linkedin-client",
      GOODADS_LINKEDIN_CLIENT_SECRET: "never-return-this-secret",
    });
    const xAds = social.providerConfig("x_ads");
    assert.deepEqual(xAds.credentialEnvironment, {
      clientId: "GOODADS_X_ADS_CONSUMER_KEY",
      clientSecret: "GOODADS_X_ADS_CONSUMER_SECRET",
      advertisingOAuthEnabled: null,
    });
    const linkedin = social.publicProviders().find((provider) => provider.id === "linkedin");
    assert.deepEqual(linkedin.credentialEnvironment, {
      clientId: "GOODADS_LINKEDIN_CLIENT_ID",
      clientSecret: "GOODADS_LINKEDIN_CLIENT_SECRET",
      advertisingOAuthEnabled: "GOODADS_LINKEDIN_ADS_OAUTH_ENABLED",
    });
    assert.equal(linkedin.configured, true);
    assert.equal(JSON.stringify(linkedin).includes("never-return-this-secret"), false);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("provider capability registry reports only installed publishing adapters", () => {
  for (const provider of ["x", "linkedin", "threads", "reddit"]) {
    assert.equal(social.PROVIDER_PUBLISH_CAPABILITIES[provider].text, true);
    assert.equal(social.PROVIDER_PUBLISH_CAPABILITIES[provider].immediate, true);
  }
  for (const provider of ["google", "facebook", "instagram", "x_ads", "tiktok", "tiktok_ads", "pinterest"]) {
    assert.equal(social.PROVIDER_PUBLISH_CAPABILITIES[provider].text, false);
    assert.equal(social.PROVIDER_PUBLISH_CAPABILITIES[provider].immediate, false);
  }
  for (const capabilities of Object.values(social.PROVIDER_PUBLISH_CAPABILITIES)) {
    assert.equal(capabilities.media, false);
    assert.equal(capabilities.scheduling, false);
    assert.equal(capabilities.paidAds, false);
  }
});

test("connection diagnostics expose safe callback, scope, and token-health metadata", () => {
  const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = "https://base.goodos.app/";
  try {
    const google = social.publicProviders().find((provider) => provider.id === "google");
    assert.equal(google.callbackUrl, "https://base.goodos.app/api/apps/goodads/v1/oauth/google/callback");
    const healthy = social._test.publicConnection({
      id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
      provider: "google",
      provider_account_id: "provider-1",
      account_name: "GoodOS",
      scopes: social.providerConfig("google").scopes,
      token_expires_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      refresh_token_ciphertext: "encrypted",
      status: "connected",
    });
    assert.equal(healthy.tokenHealth.status, "healthy");
    assert.equal(healthy.tokenHealth.refreshable, true);
    assert.deepEqual(healthy.missingScopes, []);
    const expired = social._test.connectionHealth({
      status: "connected",
      token_expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(expired.status, "expired");
    assert.equal(expired.refreshable, false);
  } finally {
    if (originalPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
  }
});

test("X Ads uses a separate OAuth 1.0a business authorization", () => {
  const names = ["GOODADS_X_ADS_CONSUMER_KEY", "GOODADS_X_ADS_CONSUMER_SECRET"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      GOODADS_X_ADS_CONSUMER_KEY: "consumer-key",
      GOODADS_X_ADS_CONSUMER_SECRET: "consumer-secret",
    });
    const config = social.providerConfig("x_ads");
    assert.equal(config.oauthStyle, "oauth1");
    assert.equal(config.configured, true);
    assert.deepEqual(config.scopes, ["ads.read", "ads.write"]);
    const header = social.oauth1AuthorizationHeader(
      config,
      "https://ads-api.x.com/12/accounts?count=1000",
      "GET",
      "access-token",
      "token-secret"
    );
    assert.match(header, /^OAuth /);
    assert.match(header, /oauth_signature_method="HMAC-SHA1"/);
    assert.match(header, /oauth_token="access-token"/);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("OAuth refresh serializes token rotation and reuses the refreshed credential", async () => {
  const envNames = ["GOODADS_OAUTH_ENCRYPTION_KEY", "GOODADS_GOOGLE_CLIENT_ID", "GOODADS_GOOGLE_CLIENT_SECRET"];
  const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const originalConnect = database.pool.connect;
  const originalFetch = global.fetch;
  const queries = [];
  let fetches = 0;
  try {
    Object.assign(process.env, {
      GOODADS_OAUTH_ENCRYPTION_KEY: "refresh-test-encryption-key",
      GOODADS_GOOGLE_CLIENT_ID: "google-client",
      GOODADS_GOOGLE_CLIENT_SECRET: "google-secret",
    });
    const oldAccess = social.encrypt("old-access");
    const oldRefresh = social.encrypt("old-refresh");
    const current = {
      id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
      provider: "google",
      status: "connected",
      access_token_ciphertext: oldAccess.ciphertext,
      access_token_iv: oldAccess.iv,
      access_token_tag: oldAccess.tag,
      refresh_token_ciphertext: oldRefresh.ciphertext,
      refresh_token_iv: oldRefresh.iv,
      refresh_token_tag: oldRefresh.tag,
      token_expires_at: new Date(Date.now() - 1000),
    };
    const stale = { ...current };
    database.pool.connect = async () => ({
      async query(sql, params = []) {
        queries.push(sql);
        if (/SELECT \* FROM goodads_social_connections/.test(sql)) return { rows: [{ ...current }] };
        if (/access_token_ciphertext = \$2/.test(sql)) {
          Object.assign(current, {
            access_token_ciphertext: params[1],
            access_token_iv: params[2],
            access_token_tag: params[3],
            refresh_token_ciphertext: params[4] || current.refresh_token_ciphertext,
            refresh_token_iv: params[5] || current.refresh_token_iv,
            refresh_token_tag: params[6] || current.refresh_token_tag,
            token_expires_at: params[7],
            status: "connected",
          });
        }
        return { rows: [] };
      },
      release() {},
    });
    global.fetch = async () => {
      fetches += 1;
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    };

    assert.equal(await social.accessTokenForConnection(stale), "new-access");
    assert.equal(await social.accessTokenForConnection(stale), "new-access");
    assert.equal(fetches, 1);
    assert.equal(current.status, "connected");
    assert.equal(
      social.decrypt(current.refresh_token_ciphertext, current.refresh_token_iv, current.refresh_token_tag),
      "new-refresh"
    );
    assert.equal(queries.filter((sql) => /pg_advisory_lock/.test(sql)).length, 2);
    assert.equal(queries.filter((sql) => /pg_advisory_unlock/.test(sql)).length, 2);
  } finally {
    database.pool.connect = originalConnect;
    global.fetch = originalFetch;
    for (const name of envNames) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  }
});

test("temporary OAuth refresh failures preserve the authorized connection", async () => {
  const envNames = ["GOODADS_OAUTH_ENCRYPTION_KEY", "GOODADS_GOOGLE_CLIENT_ID", "GOODADS_GOOGLE_CLIENT_SECRET"];
  const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const originalConnect = database.pool.connect;
  const originalFetch = global.fetch;
  const queries = [];
  try {
    Object.assign(process.env, {
      GOODADS_OAUTH_ENCRYPTION_KEY: "refresh-test-encryption-key",
      GOODADS_GOOGLE_CLIENT_ID: "google-client",
      GOODADS_GOOGLE_CLIENT_SECRET: "google-secret",
    });
    const access = social.encrypt("access");
    const refresh = social.encrypt("refresh");
    const current = {
      id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
      provider: "google",
      status: "connected",
      access_token_ciphertext: access.ciphertext,
      access_token_iv: access.iv,
      access_token_tag: access.tag,
      refresh_token_ciphertext: refresh.ciphertext,
      refresh_token_iv: refresh.iv,
      refresh_token_tag: refresh.tag,
      token_expires_at: new Date(Date.now() - 1000),
    };
    database.pool.connect = async () => ({
      async query(sql) {
        queries.push(sql);
        if (/SELECT \* FROM goodads_social_connections/.test(sql)) return { rows: [{ ...current }] };
        return { rows: [] };
      },
      release() {},
    });
    global.fetch = async () => Response.json({ error: "temporarily_unavailable" }, { status: 503 });

    await assert.rejects(
      social.accessTokenForConnection(current),
      (error) => error.code === "GOODADS_TOKEN_REFRESH_TEMPORARY"
        && error.statusCode === 503
        && error.retryable === true
    );
    assert.equal(current.status, "connected");
    assert.equal(queries.some((sql) => /status = 'expired'/.test(sql)), false);
    assert.equal(social._test.refreshFailureDetails({ status: 400 }, { error: "invalid_grant" }).terminal, true);
    assert.equal(social._test.refreshFailureDetails({ status: 401 }, { error: "invalid_client" }).terminal, false);
  } finally {
    database.pool.connect = originalConnect;
    global.fetch = originalFetch;
    for (const name of envNames) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  }
});

test("GoodAds routes expose capability truth and durable publishing history", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  assert.match(routes, /router\.get\("\/capabilities"/);
  assert.match(routes, /router\.get\("\/publishing\/jobs"/);
  assert.match(routes, /router\.get\("\/publishing\/jobs\/:id"/);
  assert.match(routes, /router\.post\("\/publishing\/jobs\/:id\/cancel"/);
  assert.match(routes, /router\.post\("\/publishing\/jobs\/:id\/retry"/);
  assert.match(routes, /router\.delete\("\/connections\/account\/:id"/);
  assert.match(routes, /router\.post\("\/connections\/account\/:id\/verify"/);
  assert.match(routes, /ads\.launchCampaign\(/);
  assert.match(routes, /\/ads\/accounts\/discover/);
  assert.match(routes, /\/activation-approval/);
  assert.doesNotMatch(routes, /campaigns\.launched/);
});

test("publishing input is bounded and scheduling is timezone aware", () => {
  assert.deepEqual(
    social.normalizePublishContent({ text: "  Hello world  ", title: " Launch " }),
    { text: "Hello world", title: "Launch" }
  );
  assert.throws(() => social.normalizePublishContent({ text: "" }), /Post text/);
  assert.throws(() => social.normalizePublishContent({ text: "x".repeat(5001) }), /5,000/);
  const schedule = social.normalizeSchedule(new Date(Date.now() + 60000).toISOString(), "America/Los_Angeles");
  assert.equal(schedule.timezone, "America/Los_Angeles");
  assert.equal(schedule.scheduled, true);
  assert.throws(() => social.normalizeSchedule(new Date().toISOString(), "Not/A_Zone"), /IANA timezone/);
});

test("publishing targets require opaque UUID account identifiers", () => {
  assert.deepEqual(
    social.normalizeConnectionIds([
      "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
      "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    ]),
    ["89e0e5e1-ee43-4c9a-a41b-6b07bb920430"]
  );
  assert.throws(() => social.normalizeConnectionIds(["facebook"]), /identifier is invalid/);
});

test("publishing migration installs account targets, scheduling, retries, and worker dispatch", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../migrations/20260729_goodads_publishing_queue.sql"), "utf8");
  const jobs = fs.readFileSync(path.join(__dirname, "../src/services/job.service.js"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_publish_targets/);
  assert.match(migration, /scheduled_for TIMESTAMPTZ/);
  assert.match(migration, /'dead_letter'/);
  assert.match(migration, /'goodads\.social\.publish'/);
  assert.match(jobs, /case "goodads\.social\.publish"/);
  assert.match(packageJson.scripts.build, /apply-goodads-publishing-migration/);
});

test("publishing workers recover abandoned locks and disconnects erase exact-account tokens", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/services/goodads-social.service.js"), "utf8");
  assert.match(source, /status = 'processing' AND locked_until < NOW\(\)/);
  assert.match(source, /Recovered after an interrupted publishing worker/);
  assert.match(source, /access_token_ciphertext = ''/);
  assert.match(source, /disconnectConnection\(\{ context, userId, id: row\.id \}\)/);
  assert.doesNotMatch(source, /response\.status === 401 \|\| response\.status === 429/);
});
