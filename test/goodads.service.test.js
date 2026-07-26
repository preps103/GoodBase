"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeLeadSubmission,
  normalizeGenerationInput,
  normalizePayload,
  requirePublicSlug,
  requireUuid,
  requireResourceStatus,
  rowToResource,
  RESOURCE_TYPES,
  RESOURCE_STATUSES,
} = require("../src/services/goodads.service");

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
