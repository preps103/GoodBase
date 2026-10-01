"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflows = require("../src/services/goodads-workflows.service");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("GoodAds verifies signed normalized engagement payloads", () => {
  const previous = process.env.GOODADS_ENGAGEMENT_WEBHOOK_SECRET;
  process.env.GOODADS_ENGAGEMENT_WEBHOOK_SECRET = "goodads-test-engagement-secret-with-at-least-32-chars";
  try {
    const timestamp = 1770000000;
    const rawBody = Buffer.from(JSON.stringify({ event: { id: "comment-1" } }));
    const signature = crypto
      .createHmac("sha256", process.env.GOODADS_ENGAGEMENT_WEBHOOK_SECRET)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest("hex");
    assert.equal(workflows._test.verifyEngagementSignature(rawBody, {
      "x-goodads-timestamp": String(timestamp),
      "x-goodads-signature": `sha256=${signature}`,
    }, timestamp), true);
    assert.throws(
      () => workflows._test.verifyEngagementSignature(rawBody, {
        "x-goodads-timestamp": String(timestamp),
        "x-goodads-signature": `sha256=${"0".repeat(64)}`,
      }, timestamp),
      /signature is invalid/
    );
  } finally {
    if (previous === undefined) delete process.env.GOODADS_ENGAGEMENT_WEBHOOK_SECRET;
    else process.env.GOODADS_ENGAGEMENT_WEBHOOK_SECRET = previous;
  }
});

test("GoodAds bounds engagement, approval, and automation inputs", () => {
  const event = workflows._test.normalizeEngagementEvent({
    id: "mention-1",
    type: "mention",
    body: "A real customer message",
    url: "https://example.com/post/1",
    sentiment: "positive",
  }, "instagram");
  assert.equal(event.provider, "instagram");
  assert.equal(event.itemType, "mention");
  assert.equal(event.sentiment, "positive");
  assert.throws(
    () => workflows._test.normalizeEngagementEvent({
      id: "bad",
      type: "mention",
      body: "bad URL",
      url: "http://localhost/private",
    }, "instagram"),
    /must use HTTPS/
  );

  const approval = workflows._test.normalizeApprovalPayload({
    name: "Spring launch review",
    reviewType: "publishing",
    publication: {
      content: { text: "Approved copy", title: " Launch title ", subreddit: "r/GoodAds" },
      connectionIds: ["11111111-1111-4111-8111-111111111111"],
    },
  });
  assert.equal(approval.status, "pending");
  assert.equal(approval.publication.content.text, "Approved copy");
  assert.equal(approval.publication.content.title, "Launch title");
  assert.equal(approval.publication.content.subreddit, "GoodAds");
  assert.throws(
    () => workflows._test.normalizeApprovalPayload({
      name: "Wrong review type",
      reviewType: "creative",
      publication: {
        content: { text: "Do not publish" },
        connectionIds: ["11111111-1111-4111-8111-111111111111"],
      },
    }),
    /Only publishing reviews/
  );

  const paidActivationApproval = workflows._test.normalizeApprovalPayload({
    name: "Activate protected campaign",
    reviewType: "paid_campaign_activation",
    campaignId: "11111111-1111-4111-8111-111111111111",
    providerCampaignId: "22222222-2222-4222-8222-222222222222",
    snapshotHash: "snapshot-hash",
  });
  assert.equal(paidActivationApproval.reviewType, "paid_campaign_activation");
  assert.equal(paidActivationApproval.status, "pending");
  assert.equal(workflows._test.paidActivationApprovalIsFresh({
    expiresAt: "2026-10-02T00:00:00.000Z",
  }, new Date("2026-10-01T00:00:00.000Z")), true);
  assert.equal(workflows._test.paidActivationApprovalIsFresh({
    expiresAt: "2026-10-01T00:00:00.000Z",
  }, new Date("2026-10-01T00:00:00.000Z")), false);
  assert.equal(workflows._test.paidActivationApprovalCanBeApprovedBy({
    requestedByUserId: "11111111-1111-4111-8111-111111111111",
  }, "22222222-2222-4222-8222-222222222222"), true);
  assert.equal(workflows._test.paidActivationApprovalCanBeApprovedBy({
    requestedByUserId: "11111111-1111-4111-8111-111111111111",
  }, "11111111-1111-4111-8111-111111111111"), false);
  assert.equal(workflows._test.paidActivationApprovalCanBeApprovedBy({},
    "22222222-2222-4222-8222-222222222222"), false);

  const publishingTiming = workflows._test.publishingApprovalTiming(new Date("2026-10-01T00:00:00.000Z"));
  assert.equal(publishingTiming.requestedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(publishingTiming.expiresAt, "2026-10-08T00:00:00.000Z");
  assert.equal(workflows._test.publishingApprovalIsFresh(
    publishingTiming,
    new Date("2026-10-07T23:59:59.000Z")
  ), true);
  assert.equal(workflows._test.publishingApprovalIsFresh(
    publishingTiming,
    new Date("2026-10-08T00:00:00.000Z")
  ), false);
  assert.equal(workflows._test.publishingApprovalCanBeApprovedBy({
    requestedByUserId: "11111111-1111-4111-8111-111111111111",
  }, "22222222-2222-4222-8222-222222222222"), true);
  assert.equal(workflows._test.publishingApprovalCanBeApprovedBy({
    requestedByUserId: "11111111-1111-4111-8111-111111111111",
  }, "11111111-1111-4111-8111-111111111111"), false);

  const automation = workflows._test.normalizeAutomationPayload({
    name: "Weekly draft",
    triggerType: "schedule",
    actionType: "create_draft",
    intervalMinutes: 1,
  });
  assert.equal(automation.intervalMinutes, 5);
  assert.throws(
    () => workflows._test.normalizeAutomationPayload({
      name: "Unsafe automation",
      triggerType: "lead_captured",
      actionType: "send_email",
    }),
    /manual and scheduled/
  );

  const spendGuard = workflows._test.normalizeAutomationPayload({
    name: "Protect launch budget",
    triggerType: "schedule",
    actionType: "enforce_spend_guard",
    campaignId: "11111111-1111-4111-8111-111111111111",
    currency: "usd",
    maximumTrackedSpend: 500,
    maximumCostPerConversion: 75,
    minimumTrackedSpend: 100,
    minimumConversions: 3,
    staleAfterMinutes: 30,
  });
  assert.equal(spendGuard.currency, "USD");
  assert.equal(spendGuard.maximumTrackedSpend, 500);
  assert.equal(spendGuard.pauseOnStaleMetrics, true);
  assert.throws(
    () => workflows._test.normalizeAutomationPayload({
      name: "Unbounded spend guard",
      triggerType: "schedule",
      actionType: "enforce_spend_guard",
      campaignId: "11111111-1111-4111-8111-111111111111",
      currency: "USD",
    }),
    /maximum tracked spend or maximum cost per conversion/
  );
});

test("GoodAds spend guards pause on verified thresholds and stale telemetry", () => {
  const now = new Date("2026-09-30T22:00:00.000Z");
  const guard = {
    currency: "USD",
    maximumTrackedSpend: 100,
    maximumCostPerConversion: 40,
    minimumTrackedSpend: 25,
    minimumConversions: 2,
    staleAfterMinutes: 45,
    pauseOnStaleMetrics: true,
  };
  const rows = [
    {
      currency: "USD",
      period_start: "2026-09-01",
      period_end: "2026-09-30",
      spend_micros: 60000000,
      conversions: 1,
      captured_at: "2026-09-30T21:45:00.000Z",
    },
    {
      currency: "USD",
      period_start: "2026-09-01",
      period_end: "2026-09-30",
      spend_micros: 50000000,
      conversions: 1,
      captured_at: "2026-09-30T21:50:00.000Z",
    },
  ];
  const threshold = workflows._test.spendGuardDecision(rows, guard, now);
  assert.equal(threshold.triggered, true);
  assert.equal(threshold.spendMicros, 110000000);
  assert.equal(threshold.costPerConversionMicros, 55000000);
  assert.equal(threshold.reasons.includes("maximum_spend_reached"), true);
  assert.equal(threshold.reasons.includes("maximum_cost_per_conversion_reached"), true);

  const healthy = workflows._test.spendGuardDecision([
    { ...rows[0], spend_micros: 20000000, conversions: 2 },
  ], guard, now);
  assert.equal(healthy.triggered, false);

  const stale = workflows._test.spendGuardDecision([
    { ...rows[0], captured_at: "2026-09-30T20:00:00.000Z" },
  ], guard, now);
  assert.equal(stale.triggered, true);
  assert.equal(stale.reasons.includes("stale_metrics"), true);
});

test("GoodAds workflow migration installs durable governed operations", () => {
  const migration = read("migrations/20260729_goodads_governed_workflows.sql");
  const runner = read("scripts/apply-goodads-governed-workflows-migration.js");
  const packageJson = JSON.parse(read("package.json"));
  const jobs = read("src/services/job.service.js");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_engagement_items/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_automation_runs/);
  assert.match(migration, /idx_goodads_automation_run_idempotency/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS approval_id UUID/);
  assert.match(migration, /idx_goodads_approval_request_key/);
  assert.match(migration, /goodads\.automations\.dispatch/);
  assert.match(runner, /20260729_goodads_governed_workflows\.sql/);
  assert.match(packageJson.scripts.build, /apply-goodads-governed-workflows-migration/);
  assert.match(jobs, /goodads\.automations\.dispatch/);
  const workflows = read("src/services/goodads-workflows.service.js");
  assert.match(workflows, /INSERT INTO goodads_ad_operations/);
  assert.match(workflows, /operation_type, idempotency_key, payload/);
  assert.match(workflows, /providerPauseDelivery: true/);
  assert.match(workflows, /failClosedOnStaleMetrics: true/);
  assert.match(workflows, /GOODADS_SYSTEM_AUTOMATION_PROTECTED/);
  assert.match(workflows, /automaticCampaignBudgetGuard: true/);
  assert.match(workflows, /systemManagedGuardsProtected: true/);
  assert.match(workflows, /GOODADS_PAID_ACTIVATION_APPROVAL_PROTECTED/);
  assert.match(workflows, /GOODADS_PAID_ACTIVATION_APPROVAL_REQUIRED/);
  assert.match(workflows, /GOODADS_APPROVAL_EXPIRED/);
  assert.match(workflows, /GOODADS_APPROVAL_SEPARATION_REQUIRED/);
  assert.match(workflows, /GOODADS_PUBLISH_APPROVAL_EXPIRED/);
  assert.match(workflows, /GOODADS_PUBLISH_APPROVAL_SEPARATION_REQUIRED/);
  assert.match(workflows, /revokedPublishingApprovalsStopQueuedDelivery: true/);
  const resources = read("src/services/goodads.service.js");
  assert.match(resources, /type === "automations" && current\.systemManaged === true/);
  assert.match(resources, /GOODADS_SYSTEM_AUTOMATION_PROTECTED/);
});

test("GoodAds routes separate public signed ingestion from protected workflow operations", () => {
  const routes = read("src/routes/goodads.routes.js");
  const authBoundary = routes.indexOf("router.use(authRequired");
  assert.ok(routes.indexOf('router.post("/public/engagement-webhooks/:provider"') < authBoundary);
  assert.ok(routes.indexOf('router.get("/engagement"') > authBoundary);
  assert.match(routes, /router\.post\("\/approvals\/:id\/decision"/);
  assert.match(routes, /router\.post\("\/automations\/:id\/run"/);
  assert.match(routes, /approvalId: req\.body\?\.approvalId/);
});

test("GoodAds production publishing enforces approved copy for non-management roles", () => {
  const social = read("src/services/goodads-social.service.js");
  assert.match(social, /GOODADS_PUBLISH_APPROVAL_REQUIRED/);
  assert.match(social, /GOODADS_PUBLISH_APPROVAL_MISMATCH/);
  assert.match(social, /GOODADS_PUBLISH_APPROVAL_EXPIRED/);
  assert.match(social, /GOODADS_PUBLISH_APPROVAL_SEPARATION_REQUIRED/);
  assert.match(social, /GOODADS_PUBLISH_APPROVAL_REVOKED/);
  assert.match(social, /validateQueuedPublishingApproval\(job\)/);
  assert.match(social, /resource_type = 'approvals'/);
  assert.match(social, /approval_id/);
});
