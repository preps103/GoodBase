"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

process.env.JWT_SECRET ||= "goodspeech-webhook-test-secret-that-is-long-enough";

const webhookService = require("../src/services/goodspeech-webhook.service");

test("GoodSpeech webhooks accept public HTTPS endpoints and block SSRF destinations", () => {
  assert.equal(webhookService.normalizeEndpoint("https://hooks.example.com/goodspeech#fragment"), "https://hooks.example.com/goodspeech");
  for (const endpoint of [
    "http://hooks.example.com/goodspeech",
    "https://user:password@hooks.example.com/goodspeech",
    "https://hooks.example.com:8443/goodspeech",
    "https://localhost/goodspeech",
    "https://127.0.0.1/goodspeech",
    "https://10.0.0.1/goodspeech",
    "https://169.254.169.254/latest/meta-data",
    "https://192.0.2.10/goodspeech",
    "https://198.51.100.10/goodspeech",
    "https://203.0.113.10/goodspeech",
    "https://[::1]/goodspeech",
    "https://[2001:db8::1]/goodspeech",
  ]) {
    assert.throws(() => webhookService.normalizeEndpoint(endpoint), /HTTPS|public Internet/);
  }
});

test("GoodSpeech webhook secrets are encrypted at rest and identifiers and events are validated", () => {
  const secret = "whsec_gs_test_secret";
  const encrypted = webhookService.encryptSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(webhookService.decryptSecret(encrypted), secret);
  assert.deepEqual(webhookService.normalizeEvents(["speech.completed", "speech.completed", "voice.created"]), ["speech.completed", "voice.created"]);
  assert.deepEqual(webhookService.normalizeEvents(["studio.job.completed", "studio.job.failed"]), ["studio.job.completed", "studio.job.failed"]);
  assert.throws(() => webhookService.normalizeEvents(["unknown.event"]), /supported/);
  assert.equal(webhookService.normalizeWebhookId("1f07be72-2e66-4f2b-bc7d-83822e854c4a"), "1f07be72-2e66-4f2b-bc7d-83822e854c4a");
  assert.throws(() => webhookService.normalizeWebhookId("not-an-id"), /invalid/);
});

test("GoodSpeech webhook delivery is mounted, migrated, retried, signed, and processed by the worker", () => {
  const root = path.join(__dirname, "..");
  const routes = fs.readFileSync(path.join(root, "src", "routes", "index.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "src", "workers", "goodapp-worker-v3.js"), "utf8");
  const runtimeMigrations = fs.readFileSync(path.join(root, "src", "runtime", "goodspeech-migrations.js"), "utf8");
  const service = fs.readFileSync(path.join(root, "src", "services", "goodspeech-webhook.service.js"), "utf8");
  const migration = fs.readFileSync(path.join(root, "migrations", "20261003_goodspeech_webhooks.sql"), "utf8");

  assert.match(routes, /\/api\/goodspeech\/v1\/webhooks/);
  assert.match(worker, /processDueDeliveries/);
  assert.match(runtimeMigrations, /apply-goodspeech-webhooks-migration\.js/);
  assert.match(service, /FOR UPDATE OF delivery SKIP LOCKED/);
  assert.match(service, /X-GoodSpeech-Signature/);
  assert.match(service, /timingSafeEqual|createHmac/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodspeech_webhooks/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodspeech_webhook_deliveries/);
});
