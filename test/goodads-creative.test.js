"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const creative = require("../src/services/goodads-creative.service");

test("GoodAds creative uploads verify real image and video signatures", () => {
  assert.doesNotThrow(() => creative._internal.assertFileSignature(
    Buffer.from("89504e470d0a1a0a0000", "hex"),
    "image/png"
  ));
  assert.doesNotThrow(() => creative._internal.assertFileSignature(
    Buffer.from("ffd8ff0000", "hex"),
    "image/jpeg"
  ));
  assert.doesNotThrow(() => creative._internal.assertFileSignature(
    Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]),
    "image/webp"
  ));
  assert.doesNotThrow(() => creative._internal.assertFileSignature(
    Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(4)]),
    "video/mp4"
  ));
  assert.throws(
    () => creative._internal.assertFileSignature(Buffer.from("not-an-image"), "image/png"),
    /PNG signature/
  );
});

test("GoodAds creative job records expose only application-safe fields", () => {
  const record = creative._internal.jobRecord({
    id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
    status: "processing",
    progress: 42,
    prompt: "Controlled product motion",
    input: { format: "vertical_9_16" },
    provider_job_id: "provider-secret-id",
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:01:00.000Z",
  });
  assert.equal(record.progress, 42);
  assert.equal(record.input.format, "vertical_9_16");
  assert.equal("providerJobId" in record, false);
});

test("GoodAds creative jobs reject malformed database identifiers before querying", () => {
  assert.throws(
    () => creative._internal.validUuid("overview", "video render job ID"),
    /valid video render job ID/
  );
  assert.equal(
    creative._internal.validUuid("89e0e5e1-ee43-4c9a-a41b-6b07bb920430"),
    "89e0e5e1-ee43-4c9a-a41b-6b07bb920430"
  );
});

test("GoodAds creative routes translate shared engine errors into GoodAds language", () => {
  const sharedError = new Error("GoodDesigner AI is not configured in GoodBase.");
  sharedError.code = "GOODDESIGNER_PROVIDER_NOT_CONFIGURED";
  sharedError.statusCode = 503;
  const translated = creative._internal.goodAdsProviderError(sharedError);
  assert.equal(translated.statusCode, 503);
  assert.equal(translated.code, "GOODADS_CREATIVE_PROVIDER_NOT_CONFIGURED");
  assert.equal(translated.message, "GoodAds creative generation is not configured in GoodBase.");
  assert.equal(translated.message.includes("GoodDesigner"), false);
});

test("GoodBase deployment installs and verifies the GoodAds creative studio schema", () => {
  const root = path.join(__dirname, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const runner = fs.readFileSync(path.join(root, "scripts", "apply-goodads-creative-studios-migration.js"), "utf8");
  const migration = fs.readFileSync(path.join(root, "migrations", "20260729_goodads_creative_studios.sql"), "utf8");
  assert.match(packageJson.scripts.build, /apply-goodads-creative-studios-migration\.js/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /idx_goodads_creative_jobs_idempotency/);
  assert.match(migration, /bucket_goodads_creative_assets/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodads_creative_jobs/);
  assert.match(migration, /UNIQUE INDEX IF NOT EXISTS idx_goodads_creative_jobs_idempotency/);
});
