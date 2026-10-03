"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const governance = require("../src/services/goodspeech-governance.service");
const quality = require("../src/services/goodspeech-quality.service");

test("GoodSpeech privacy settings expose enforced residency, training opt-out, and bounded retention", () => {
  assert.deepEqual(governance.RETENTION_OPTIONS, [0, 7, 30, 90, 365]);
  assert.equal(governance.retentionDays(7), 7);
  assert.throws(() => governance.retentionDays(14), /Retention must be/);
  const settings = governance.publicSettings({
    zero_retention: true,
    generation_retention_days: 0,
    agent_retention_days: 0,
    residency_region: "us-west",
    model_training_opt_out: true,
  });
  assert.equal(settings.zeroRetention, true);
  assert.equal(settings.retainedData, "none_after_request");
  assert.equal(settings.residency.status, "enforced");
  assert.equal(settings.modelTraining.enabled, false);
  assert.equal(settings.modelTraining.optOutEnforced, true);
});

test("GoodSpeech governance is migrated, authenticated, audited, and processed by the worker", () => {
  const root = path.join(__dirname, "..");
  const migration = fs.readFileSync(path.join(root, "migrations", "20261003_goodspeech_governance.sql"), "utf8");
  const runtime = fs.readFileSync(path.join(root, "src", "runtime", "goodspeech-migrations.js"), "utf8");
  const routes = fs.readFileSync(path.join(root, "src", "routes", "goodspeech-governance.routes.js"), "utf8");
  const index = fs.readFileSync(path.join(root, "src", "routes", "index.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "src", "workers", "goodapp-worker-v3.js"), "utf8");
  const library = fs.readFileSync(path.join(root, "src", "services", "goodspeech-library.service.js"), "utf8");
  const agentRoutes = fs.readFileSync(path.join(root, "src", "routes", "goodspeech-agent.routes.js"), "utf8");

  assert.match(migration, /goodspeech_zero_retention_enforced/);
  assert.match(migration, /model_training_opt_out BOOLEAN NOT NULL DEFAULT TRUE CHECK/);
  assert.match(runtime, /apply-goodspeech-governance-migration\.js/);
  assert.match(routes, /authRequired, tenantContext, requireGoodSpeechAccess/);
  assert.match(routes, /goodspeech\.privacy\.update/);
  assert.match(routes, /goodspeech\.privacy\.purge/);
  assert.match(index, /\/api\/goodspeech\/v1\/governance/);
  assert.match(worker, /purgeExpiredContent/);
  assert.match(library, /shouldRetainGeneratedContent/);
  assert.match(agentRoutes, /enforceSessionRetention/);
  assert.match(fs.readFileSync(path.join(root, "src", "services", "goodspeech-governance.service.js"), "utf8"), /while \(true\)[\s\S]*LIMIT 250/);
});

test("GoodSpeech quality telemetry records first-audio timing and publishes p50 and p95 objectives", () => {
  const root = path.join(__dirname, "..");
  const usage = fs.readFileSync(path.join(root, "src", "services", "goodspeech-usage.service.js"), "utf8");
  const governanceSource = fs.readFileSync(path.join(root, "src", "services", "goodspeech-governance.service.js"), "utf8");
  const speech = fs.readFileSync(path.join(root, "src", "routes", "goodspeech.routes.js"), "utf8");
  assert.match(usage, /firstByteMs: firstAudio/);
  assert.match(speech, /const firstByteMs = Date\.now\(\) - started/);
  assert.match(governanceSource, /percentile_cont\(0\.5\)/);
  assert.match(governanceSource, /percentile_cont\(0\.95\)/);
  assert.match(governanceSource, /p95FirstAudioMs: 1000/);
  assert.match(governanceSource, /failureRatePercent: 1/);
});

test("GoodSpeech persists private round-trip TTS to STT quality benchmarks without retaining audio", () => {
  const root = path.join(__dirname, "..");
  const migration = fs.readFileSync(path.join(root, "migrations", "20261003_goodspeech_quality_benchmarks.sql"), "utf8");
  const runtime = fs.readFileSync(path.join(root, "src", "runtime", "goodspeech-migrations.js"), "utf8");
  const routes = fs.readFileSync(path.join(root, "src", "routes", "goodspeech-governance.routes.js"), "utf8");
  assert.equal(Object.keys(quality.QUALITY_BENCHMARKS).length, 9);
  assert.deepEqual(quality.benchmarkMetric("Clear natural speech", "clear natural speech", "en-us"), {
    metric: "word_error_rate", errorCount: 0, referenceUnits: 3, hypothesisUnits: 3,
    errorRatePercent: 0, qualityScore: 100, status: "passed",
  });
  const attention = quality.benchmarkMetric("one two three four five", "one wrong", "en-us");
  assert.equal(attention.status, "needs_attention");
  assert.equal(quality.benchmarkMetric("自然な音声", "自然な音声", "ja-jp").metric, "character_error_rate");
  assert.match(migration, /goodspeech_quality_benchmarks/);
  assert.doesNotMatch(migration, /audio_(?:data|buffer|content|blob)/i);
  assert.match(runtime, /apply-goodspeech-quality-benchmarks-migration\.js/);
  assert.match(routes, /\/quality\/benchmark/);
  assert.match(routes, /goodspeech\.quality\.benchmark/);
  assert.match(routes, /audioRetained: false/);
});
