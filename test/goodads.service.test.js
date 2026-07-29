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
