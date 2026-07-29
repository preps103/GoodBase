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
});
