"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("../src/services/goodscan.service");

test("GoodScan accepts the canonical capture manifest", () => {
  const manifest = service.normalizeManifest({ schema: "goodscan.capture.v1", engine: "photo", quality: "High" });
  assert.equal(manifest.schema, "goodscan.capture.v1");
  assert.equal(manifest.engine, "photo");
});

test("GoodScan rejects unsupported capture manifests", () => {
  assert.throws(
    () => service.normalizeManifest({ schema: "unknown", engine: "photo" }),
    (error) => error.code === "GOODSCAN_REQUEST_INVALID" && error.statusCode === 400,
  );
});

test("GoodScan public asset contract does not expose private storage keys", () => {
  const asset = service.publicAsset({
    id: "asset-id",
    owner_user_id: "user-id",
    name: "Object scan",
    asset_type: "Photo Scan",
    status: "completed",
    visibility: "public",
    source_manifest: { source: "web", files: [{ storageKey: "private-key" }] },
    tags: ["object"],
    outputs: [],
    storage_bytes: 1024,
    views: 2,
    appreciations: 1,
  });
  assert.equal(asset.id, "asset-id");
  assert.equal(asset.source, "web");
  assert.equal(JSON.stringify(asset).includes("private-key"), false);
});

test("GoodScan pairing secrets use a pairing-bound one-way hash", () => {
  const secret = "a".repeat(43);
  const first = service.pairingSecretHash("123e4567-e89b-12d3-a456-426614174000", secret);
  const second = service.pairingSecretHash("123e4567-e89b-12d3-a456-426614174001", secret);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.equal(first.includes(secret), false);
  assert.equal(service.safeHashEqual(first, first), true);
  assert.equal(service.safeHashEqual(first, second), false);
});
