"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const service = require("../src/services/goodswapz.service");

test("GoodSwapz generates ordered, platform-specific handoff steps", () => {
  for (const platform of ["youtube", "instagram", "tiktok", "twitter", "telegram"]) {
    const steps = service.platformSteps(platform);
    assert.ok(steps.length >= 8);
    assert.equal(steps[0].key, "policy_confirmation");
    assert.equal(steps[1].key, "deposit_verified");
    assert.equal(steps.at(-1).key, "final_access_review");
    assert.equal(new Set(steps.map((step) => step.key)).size, steps.length);
    assert.deepEqual(
      steps.map((step) => step.sequence),
      steps.map((_step, index) => index + 1)
    );
  }
});

test("GoodSwapz normalizes supported social platform aliases", () => {
  assert.equal(service.normalizePlatform("YouTube"), "youtube");
  assert.equal(service.normalizePlatform("Twitter/X"), "twitter");
  assert.equal(service.normalizePlatform("X"), "twitter");
  assert.throws(
    () => service.normalizePlatform("unsupported"),
    (error) => error.code === "UNSUPPORTED_PLATFORM"
  );
});

test("GoodSwapz validates listing URLs against the selected platform", () => {
  const base = {
    platform: "YouTube",
    title: "Verified creator channel",
    handle: "@creator",
    accountUrl: "https://www.youtube.com/@creator",
    subscribers: 1000,
    price: 500,
    monthlyRevenue: 50,
    description: "A verified creator channel with original content and current analytics available for buyer review.",
    category: "Education",
    engagementRate: 5,
    country: "United States",
    transferMethod: "Use native channel permissions, buyer inspection, and a final access review.",
  };
  const validated = service.validatedListingInput(base);
  assert.equal(validated.platform, "youtube");
  assert.equal(validated.priceCents, 50000);
  assert.throws(
    () => service.validatedListingInput({
      ...base,
      accountUrl: "https://instagram.com/creator",
    }),
    (error) => error.code === "PLATFORM_URL_MISMATCH"
  );
});

test("GoodSwapz rejects passwords, tokens, and recovery secrets", () => {
  for (const unsafe of [
    "password: hunter2",
    "recovery code: ABCD-1234",
    "session token=abc123456789012345",
    "Bearer abcdefghijklmnopqrstuvwxyz",
  ]) {
    assert.throws(
      () => service.assertNoSecrets(unsafe, "Test content"),
      (error) => error.code === "SECRET_CONTENT_REJECTED"
    );
  }
  assert.doesNotThrow(() => service.assertNoSecrets(
    "Use the platform's native role transfer and never share passwords."
  ));
});

test("GoodSwapz checks identity upload magic bytes", () => {
  assert.equal(
    service.detectContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])),
    "image/jpeg"
  );
  assert.equal(
    service.detectContentType(Buffer.from("%PDF-1.7 test content")),
    "application/pdf"
  );
  assert.equal(service.detectContentType(Buffer.from("not-an-image")), null);
});

test("GoodSwapz verifies signed GoodEscrow webhook events", () => {
  const previous = process.env.GOODESCROW_WEBHOOK_SECRET;
  process.env.GOODESCROW_WEBHOOK_SECRET = "a-secure-test-secret-that-is-longer-than-thirty-two-characters";
  try {
    const timestamp = Date.now();
    const payload = {
      eventId: "evt_test_001",
      transactionId: "86cff7d0-9f29-4c0d-a89c-900c9fc22aba",
      status: "funded",
      timestamp,
      externalReference: "provider_tx_001",
    };
    const canonical = [
      payload.eventId,
      payload.transactionId,
      payload.status,
      String(timestamp),
      payload.externalReference,
    ].join(".");
    const signature = crypto
      .createHmac("sha256", process.env.GOODESCROW_WEBHOOK_SECRET)
      .update(canonical)
      .digest("hex");
    assert.doesNotThrow(() => service.verifyEscrowWebhook({
      payload,
      signature,
      timestamp,
    }));
    assert.throws(
      () => service.verifyEscrowWebhook({ payload, signature: "0".repeat(64), timestamp }),
      (error) => error.code === "INVALID_WEBHOOK_SIGNATURE"
    );
  } finally {
    if (previous === undefined) delete process.env.GOODESCROW_WEBHOOK_SECRET;
    else process.env.GOODESCROW_WEBHOOK_SECRET = previous;
  }
});
