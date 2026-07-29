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
      content: { text: "Approved copy" },
      connectionIds: ["11111111-1111-4111-8111-111111111111"],
    },
  });
  assert.equal(approval.status, "pending");
  assert.equal(approval.publication.content.text, "Approved copy");

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
  assert.match(social, /resource_type = 'approvals'/);
  assert.match(social, /approval_id/);
});
