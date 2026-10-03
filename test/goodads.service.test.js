"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeLeadSubmission,
  normalizeGenerationInput,
  normalizeGrowthResource,
  validateLeadFormSubmission,
  publicFormFromRow,
  normalizePayload,
  requirePublicSlug,
  requireUuid,
  requireResourceStatus,
  rowToResource,
  RESOURCE_TYPES,
  RESOURCE_STATUSES,
  deterministicCampaignImportId,
  deterministicAiAdDraftId,
  requireAiAdDraftIdempotencyKey,
  aiAdDraftRequestHash,
  normalizeCampaignImport,
  rowToResourceActivity,
} = require("../src/services/goodads.service");
const fs = require("node:fs");
const path = require("node:path");

test("GoodBase CORS permits GoodAds idempotent browser writes", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
  assert.match(appSource, /"Idempotency-Key"/);
});

test("GoodAds exposes every production resource family", () => {
  for (const type of ["campaigns", "content", "approvals", "calendar", "connections", "publishing_jobs", "analytics", "media", "link_hubs", "automations"]) {
    assert.equal(RESOURCE_TYPES.has(type), true);
  }
  for (const type of ["funnels", "lead_forms", "leads"]) {
    assert.equal(RESOURCE_TYPES.has(type), true);
  }
});

test("GoodAds only accepts database-supported resource statuses", () => {
  assert.equal(RESOURCE_STATUSES.has("processing"), true);
  assert.equal(requireResourceStatus(" Active "), "active");
  assert.throws(() => requireResourceStatus("launching"), /resource status/i);
});

test("GoodAds never lets JSON payloads override tenant or lifecycle fields", () => {
  const resource = rowToResource({
    id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    resource_type: "campaigns",
    organization_id: "organization-live",
    project_id: "project-live",
    environment_id: "environment-live",
    owner_user_id: "owner-live",
    name: "Verified campaign",
    status: "active",
    version: 3,
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T01:00:00.000Z",
    data: {
      id: "spoofed",
      organizationId: "other-tenant",
      status: "completed",
      name: "Spoofed campaign",
      customField: "preserved",
    },
  });
  assert.equal(resource.id, "89e0e5e1-ee43-4c9a-a41b-6b07bb920430");
  assert.equal(resource.organizationId, "organization-live");
  assert.equal(resource.status, "active");
  assert.equal(resource.name, "Verified campaign");
  assert.equal(resource.customField, "preserved");
});

test("GoodAds validates and bounds authenticated generation input", () => {
  const input = normalizeGenerationInput({
    businessName: " GoodOS ",
    type: "social_post",
    audience: "Workspace owners",
    additionalInfo: "x".repeat(4000),
  });
  assert.equal(input.businessName, "GoodOS");
  assert.equal(input.audience, "Workspace owners");
  assert.equal(input.additionalInfo.length, 3000);
  assert.throws(() => normalizeGenerationInput({ businessName: "" }), /business name/i);
});

test("GoodAds AI ad drafts have stable retry identity and reject ambiguous keys", () => {
  const first = deterministicAiAdDraftId("organization-live", "draft-attempt-123");
  const replay = deterministicAiAdDraftId("organization-live", "draft-attempt-123");
  const next = deterministicAiAdDraftId("organization-live", "draft-attempt-124");
  assert.equal(first, replay);
  assert.notEqual(first, next);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(requireAiAdDraftIdempotencyKey("draft-attempt-123"), "draft-attempt-123");
  assert.throws(() => requireAiAdDraftIdempotencyKey("short"), /Idempotency-Key/i);
  assert.throws(() => requireAiAdDraftIdempotencyKey("unsafe key"), /Idempotency-Key/i);
});

test("GoodAds AI ad draft retries bind to the exact instructions", () => {
  const original = aiAdDraftRequestHash({ businessName: "GoodOS", brief: "Launch the workspace" });
  const replay = aiAdDraftRequestHash({ businessName: "GoodOS", brief: "Launch the workspace" });
  const changed = aiAdDraftRequestHash({ businessName: "GoodOS", brief: "Promote the workspace" });
  assert.equal(original, replay);
  assert.notEqual(original, changed);
});

test("GoodAds exposes one atomic AI generation and draft-save route", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  const automated = source.indexOf('router.post("/generation/ad-draft"');
  const generic = source.indexOf('router.post("/generation/content"');
  assert.ok(automated >= 0 && automated < generic);
  assert.match(source.slice(automated, generic), /Idempotency-Key/);
  assert.match(source.slice(automated, generic), /generateAndSaveAiAdDraft/);
});

test("GoodAds payloads require bounded JSON objects", () => {
  assert.deepEqual(normalizePayload({ name: "Launch", nested: { ready: true } }), { name: "Launch", nested: { ready: true } });
  assert.throws(() => normalizePayload(null), /JSON object/);
  assert.throws(() => normalizePayload([]), /JSON object/);
  assert.throws(() => normalizePayload({ value: "x".repeat(270000) }), /256 KB/);
});

test("GoodAds IDs must be UUIDs", () => {
  assert.equal(requireUuid("89e0e5e1-ee43-4c9a-a41b-6b07bb920430"), "89e0e5e1-ee43-4c9a-a41b-6b07bb920430");
  assert.throws(() => requireUuid("campaign-1"), /valid resource ID/);
});

test("GoodAds validates public lead form addresses", () => {
  assert.equal(requirePublicSlug("Summer-Offer"), "summer-offer");
  assert.throws(() => requirePublicSlug("../offer"), /valid lead form address/);
});

test("GoodAds normalizes lead submissions without accepting invalid contacts", () => {
  assert.deepEqual(
    normalizeLeadSubmission({
      firstName: "  Maurice ",
      email: "MAURICE@GOODOS.APP",
      consent: true,
      utm: { source: "instagram" },
    }),
    {
      firstName: "Maurice",
      lastName: "",
      email: "maurice@goodos.app",
      phone: "",
      company: "",
      message: "",
      consent: true,
      source: "lead-form",
      pageUrl: "",
      utm: {
        source: "instagram",
        medium: "",
        campaign: "",
        content: "",
        term: "",
      },
    }
  );
  assert.throws(
    () => normalizeLeadSubmission({ firstName: "No contact" }),
    /email address or phone/
  );
  assert.throws(() => normalizeLeadSubmission({ email: "invalid" }), /valid email/);
  assert.throws(
    () => normalizeLeadSubmission({ email: "person@example.com", website: "spam" }),
    /rejected/
  );
});

test("GoodAds validates complete funnel records before publication", () => {
  const funnel = normalizeGrowthResource("funnels", {
    name: "Consultation",
    objective: "Generate leads",
    audience: "Local operators",
    steps: [
      { id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430", name: "Landing", type: "landing" },
      { id: "7dd4298a-fdc3-4b59-ac4b-123b542f1f37", name: "Capture", type: "form" },
    ],
  }, { forPublish: true });
  assert.equal(funnel.steps.length, 2);
  assert.equal(funnel.steps[1].type, "form");
  assert.throws(
    () => normalizeGrowthResource("funnels", { name: "Incomplete", steps: [] }, { forPublish: true }),
    /objective.*audience/i
  );
});

test("GoodAds validates secure lead forms and normalizes their public data", () => {
  const form = normalizeGrowthResource("lead_forms", {
    name: "Consultation",
    publicSlug: "Consultation-2026",
    headline: "Talk to our team",
    fields: [{ id: "email", label: "Work email", type: "text", required: true }],
    requireConsent: true,
    consentText: "I agree to be contacted.",
    theme: { accentColor: "#ABCDEF" },
  }, { forPublish: true });
  assert.equal(form.publicSlug, "consultation-2026");
  assert.equal(form.fields[0].type, "email");
  assert.equal(form.theme.accentColor, "#abcdef");
  assert.throws(
    () => normalizeGrowthResource("lead_forms", {
      name: "No contact",
      publicSlug: "no-contact",
      headline: "Missing contact field",
      fields: [{ id: "firstName", label: "Name", required: true }],
    }, { forPublish: true }),
    /email or phone/i
  );
});

test("GoodAds validates required public form fields server-side", () => {
  assert.throws(
    () => validateLeadFormSubmission(
      { fields: [{ id: "firstName", label: "First name", required: true }] },
      { firstName: "", email: "person@example.com", consent: false }
    ),
    /First name is required/
  );
  assert.throws(
    () => validateLeadFormSubmission(
      { fields: [{ id: "email", required: true }], requireConsent: true },
      { email: "person@example.com", consent: false }
    ),
    /Consent is required/
  );
});

test("GoodAds bounds manual lead workflow data", () => {
  const lead = normalizeGrowthResource("leads", {
    email: "OWNER@GOODOS.APP",
    stage: "qualified",
    score: 87.4,
    tags: ["priority", "priority", "enterprise"],
  });
  assert.equal(lead.email, "owner@goodos.app");
  assert.equal(lead.score, 87);
  assert.deepEqual(lead.tags, ["priority", "enterprise"]);
  assert.throws(
    () => normalizeGrowthResource("leads", { email: "person@example.com", stage: "unknown", score: 50 }),
    /pipeline stage/
  );
});

test("GoodAds public lead forms preserve the connected checkout", () => {
  const form = publicFormFromRow({
    id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    name: "Paid consultation",
    data: {
      publicSlug: "paid-consultation",
      headline: "Book now",
      fields: [{ id: "email", label: "Email", required: true }],
      paymentOfferSlug: "consultation-checkout",
    },
  });
  assert.equal(form.paymentOfferSlug, "consultation-checkout");
  assert.equal(form.fields[0].type, "email");
});

test("GoodAds exposes publish and pause lifecycle routes for funnels and forms", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  for (const route of [
    "/funnels/:id/publish",
    "/funnels/:id/pause",
    "/lead-forms/:id/publish",
    "/lead-forms/:id/pause",
  ]) {
    assert.match(routes, new RegExp(route.replace(/[/:]/g, "\\$&")));
  }
  assert.match(routes, /lead_forms\.paused/);
});

test("GoodAds analytics overview routes precede generic analytics record routes", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  const overview = routes.indexOf('router.get("/analytics/overview"');
  const generic = routes.indexOf('registerResource("analytics", "analytics")');
  assert.ok(overview >= 0);
  assert.ok(generic > overview);
});

test("GoodAds exposes authenticated durable creative studio operations", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  for (const route of [
    "/creative-assets",
    "/creative/generate-image",
    "/creative/generate-variation",
    "/creative/video-jobs",
    "/creative/video-jobs/:id",
  ]) {
    assert.match(routes, new RegExp(route.replace(/[/:]/g, "\\$&")));
  }
  assert.ok(routes.indexOf("router.use(authRequired") < routes.indexOf('router.post("/creative-assets"'));
  assert.match(routes, /router\.post\("\/creative-assets", creativeUploadLimiter, uploadCreativeAsset/);
});

test("GoodAds bulk campaign imports are bounded and forced to no-spend drafts", () => {
  const normalized = normalizeCampaignImport({
    campaigns: [{
      id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
      name: " Fall acquisition ",
      objective: "traffic",
      audience: "Growing business owners in the United States",
      locations: "United States",
      targetCountries: ["us"],
      platforms: ["facebook", "instagram"],
      dailyBudget: 25,
      startDate: "2026-10-05",
      endDate: "2026-10-12",
      status: "active",
      creative: {
        headline: "Meet GoodOS",
        primaryText: "Run your business from one governed workspace.",
        callToAction: "Learn More",
        destinationUrl: "https://goodos.app/",
        imageUrl: "https://cdn.goodos.app/goodads/fall.png",
      },
    }],
  });

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].name, "Fall acquisition");
  assert.equal(normalized[0].status, "draft");
  assert.equal(normalized[0].id, undefined);
  assert.deepEqual(normalized[0].targetCountries, ["US"]);
  assert.equal(normalized[0].creative.destinationUrl, "https://goodos.app/");
  assert.equal(normalized[0].bulkImport, undefined);
  assert.throws(() => normalizeCampaignImport({ campaigns: [] }), /between 1 and 50/i);
  assert.throws(() => normalizeCampaignImport({ campaigns: Array.from({ length: 51 }, () => normalized[0]) }), /between 1 and 50/i);
  assert.throws(() => normalizeCampaignImport({ campaigns: [{ ...normalized[0], endDate: "2026-10-01" }] }), /end date/i);
  assert.throws(() => normalizeCampaignImport({ campaigns: [{ ...normalized[0], platforms: ["unknown"] }] }), /platform/i);
});

test("GoodAds derives stable tenant-scoped import IDs without accepting client identity", () => {
  const first = deterministicCampaignImportId("org-live", "batch-live", 0);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(first, deterministicCampaignImportId("org-live", "batch-live", 0));
  assert.notEqual(first, deterministicCampaignImportId("org-live", "batch-live", 1));
  assert.notEqual(first, deterministicCampaignImportId("org-other", "batch-live", 0));
});

test("GoodAds exposes a rate-limited idempotent campaign draft import before generic campaign routes", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  const bulkImport = routes.indexOf('router.post("/campaigns/bulk-import"');
  const genericCampaigns = routes.indexOf('[\n  ["campaigns", "campaigns"]');
  assert.ok(bulkImport >= 0);
  assert.ok(genericCampaigns > bulkImport);
  assert.match(routes, /bulkCampaignImport[\s\S]*Idempotency-Key/);
});

test("GoodAds returns a bounded campaign activity record without exposing account email", () => {
  assert.deepEqual(rowToResourceActivity({
    id: "8c171ea0-3604-460e-a631-7e6a82000819",
    resource_id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    actor_user_id: "34a3b013-9032-4b7f-8a21-28fa563d386a",
    actor_name: "Maurice Goodloe",
    event_type: "campaigns.updated",
    previous_status: "draft",
    next_status: "ready",
    metadata: { version: 4 },
    created_at: "2026-10-02T05:00:00.000Z",
  }), {
    id: "8c171ea0-3604-460e-a631-7e6a82000819",
    resourceId: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    eventType: "campaigns.updated",
    previousStatus: "draft",
    nextStatus: "ready",
    metadata: { version: 4 },
    actor: { id: "34a3b013-9032-4b7f-8a21-28fa563d386a", name: "Maurice Goodloe" },
    createdAt: "2026-10-02T05:00:00.000Z",
  });
});

test("GoodAds exposes tenant-scoped campaign activity before the generic campaign record route", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/goodads.routes.js"), "utf8");
  const activity = routes.indexOf('router.get("/campaigns/:id/activity"');
  const genericCampaigns = routes.indexOf('[\n  ["campaigns", "campaigns"]');
  assert.ok(activity >= 0);
  assert.ok(genericCampaigns > activity);
  const serviceSource = fs.readFileSync(path.join(__dirname, "../src/services/goodads.service.js"), "utf8");
  assert.match(serviceSource, /resource_id = \$1::uuid AND event\.organization_id = \$2/);
  assert.match(serviceSource, /was_inserted \? `\$\{type\}\.created` : `\$\{type\}\.updated`/);
});
