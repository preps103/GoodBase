"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeLeadSubmission,
  normalizePayload,
  requirePublicSlug,
  requireUuid,
  RESOURCE_TYPES,
} = require("../src/services/goodads.service");

test("GoodAds exposes every production resource family", () => {
  for (const type of ["campaigns", "content", "approvals", "calendar", "connections", "publishing_jobs", "analytics", "media", "link_hubs", "automations"]) {
    assert.equal(RESOURCE_TYPES.has(type), true);
  }
  for (const type of ["funnels", "lead_forms", "leads"]) {
    assert.equal(RESOURCE_TYPES.has(type), true);
  }
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
      utm: { source: "instagram", medium: "", campaign: "", content: "", term: "" },
    }
  );
  assert.throws(() => normalizeLeadSubmission({ firstName: "No contact" }), /email address or phone/);
  assert.throws(() => normalizeLeadSubmission({ email: "invalid" }), /valid email/);
  assert.throws(() => normalizeLeadSubmission({ email: "person@example.com", website: "spam" }), /rejected/);
});
