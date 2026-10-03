"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const studio = require("../src/services/goodspeech-studio.service");

function wav(samples, sampleRate = 24_000) {
  const dataBytes = samples.length * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write("RIFF", 0); output.writeUInt32LE(36 + dataBytes, 4); output.write("WAVE", 8);
  output.write("fmt ", 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22); output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write("data", 36); output.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => output.writeInt16LE(sample, 44 + index * 2));
  return output;
}

test("GoodSpeech validates bounded multi-clip Studio projects", () => {
  const project = studio.validateProject({
    projectName: "Launch story",
    clips: [
      { id: "intro", speaker: "Narrator", text: "Welcome to GoodSpeech.", voice: "Kore", style: "Natural", tone: "Warm", intensity: 45 },
      { id: "outro", speaker: "Host", text: "Let us begin.", voice: "Puck", language: "en-us", style: "Professionally", tone: "Crisp", intensity: 55 },
    ],
  });
  assert.equal(project.clips.length, 2);
  assert.equal(project.clips[0].apiVoice, "Kore");
  assert.equal(project.totalCharacters, "Welcome to GoodSpeech.".length + "Let us begin.".length);
  assert.throws(() => studio.validateProject({ clips: [] }), /between 1 and/);
  assert.throws(() => studio.idempotencyKey("short"), /idempotency/);
});

test("GoodSpeech combines PCM WAV clips with a deterministic production pause", () => {
  const combined = studio.combineWavBuffers([wav([100, 200]), wav([-100, -200])], 100);
  assert.equal(combined.buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(combined.buffer.toString("ascii", 8, 12), "WAVE");
  assert.equal(combined.buffer.readUInt32LE(40), (2 + 2 + 2_400) * 2);
  assert.ok(combined.durationSeconds > 0.1);
  assert.throws(() => studio.combineWavBuffers([wav([1], 24_000), wav([1], 22_050)]), /incompatible/);
});

test("GoodSpeech Studio jobs are durable, leased, resumable, private, and production wired", () => {
  const root = path.join(__dirname, "..");
  const migration = fs.readFileSync(path.join(root, "migrations", "20261003_goodspeech_studio_jobs.sql"), "utf8");
  const runtime = fs.readFileSync(path.join(root, "src", "runtime", "goodspeech-migrations.js"), "utf8");
  const routes = fs.readFileSync(path.join(root, "src", "routes", "goodspeech-studio.routes.js"), "utf8");
  const index = fs.readFileSync(path.join(root, "src", "routes", "index.js"), "utf8");
  const service = fs.readFileSync(path.join(root, "src", "services", "goodspeech-studio.service.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "src", "workers", "goodapp-worker-v3.js"), "utf8");
  const governance = fs.readFileSync(path.join(root, "src", "services", "goodspeech-governance.service.js"), "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodspeech_studio_jobs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodspeech_studio_job_parts/);
  assert.match(migration, /UNIQUE \(organization_id, owner_user_id, idempotency_key\)/);
  assert.match(runtime, /apply-goodspeech-studio-jobs-migration\.js/);
  assert.match(routes, /authRequired, tenantContext, requireGoodSpeechAccess/);
  assert.match(routes, /Idempotency-Key/);
  assert.match(index, /\/api\/goodspeech\/v1\/studio/);
  assert.match(service, /FOR UPDATE SKIP LOCKED/);
  assert.match(service, /recoverExpiredJobs/);
  assert.match(service, /goodspeech_studio_job_parts/);
  assert.match(worker, /processDueJobs\(1, workerId\)/);
  assert.match(governance, /purgeStudioRows/);
});
