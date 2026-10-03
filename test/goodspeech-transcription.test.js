"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.MFA_ENCRYPTION_KEY ||= "0".repeat(64);

const transcription = require("../src/services/goodspeech-transcription.service");
const library = require("../src/services/goodspeech-library.service");

const root = path.join(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "services", "faster-whisper", "app", "main.py"), "utf8");
const routes = fs.readFileSync(path.join(root, "src", "routes", "goodspeech-transcription.routes.js"), "utf8");
const index = fs.readFileSync(path.join(root, "src", "routes", "index.js"), "utf8");

test("GoodSpeech managed transcription normalizes languages and bounds provider data", () => {
  assert.equal(transcription.normalizeLanguage("auto"), "");
  assert.equal(transcription.normalizeLanguage("pt-BR"), "pt");
  assert.throws(() => transcription.normalizeLanguage("not a language"), /ISO language code/);
  const result = transcription._internal.boundedResult({
    text: " Hello world ",
    language: "en",
    languageProbability: 4,
    durationSeconds: 2.5,
    segments: [{ id: 3, text: " Hello ", start: -1, end: 2, words: [{ word: " Hello", start: 0, end: 1, probability: 2 }] }],
  });
  assert.equal(result.text, "Hello world");
  assert.equal(result.languageProbability, 1);
  assert.equal(result.segments[0].start, 0);
  assert.equal(result.segments[0].words[0].probability, 1);
});

test("GoodSpeech accepts modern audio containers with signature validation", () => {
  const m4a = Buffer.from("00000000667479706d703432", "hex");
  const flac = Buffer.from("664c614300000000", "hex");
  const aac = Buffer.from([0xff, 0xf1, 0x50, 0x80]);
  assert.equal(library._internal.validateFile({ buffer: m4a, mimetype: "audio/mp4" }, 100), "audio/mp4");
  assert.equal(library._internal.validateFile({ buffer: flac, mimetype: "audio/flac" }, 100), "audio/flac");
  assert.equal(library._internal.validateFile({ buffer: aac, mimetype: "audio/aac" }, 100), "audio/aac");
  assert.throws(() => library._internal.validateFile({ buffer: Buffer.from("bad"), mimetype: "audio/flac" }, 100), /signature/i);
});

test("GoodSpeech transcription route is private, tenant-scoped, bounded, and audited", () => {
  assert.match(routes, /router\.use\(authRequired, tenantContext, requireGoodSpeechAccess\)/);
  assert.match(routes, /limit: 30/);
  assert.match(routes, /upload\.single\("file"\)/);
  assert.match(routes, /goodspeech\.transcribe/);
  assert.match(routes, /retainedAudio: false/);
  assert.match(index, /\/api\/goodspeech\/v1\/transcriptions/);
});

test("Faster-Whisper is revision-pinned, token-protected, timestamped, and ephemeral", () => {
  assert.match(worker, /MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120"/);
  assert.match(worker, /secrets\.compare_digest/);
  assert.match(worker, /word_timestamps=True/);
  assert.match(worker, /vad_filter=True/);
  assert.match(worker, /MAX_UPLOAD_BYTES = 50 \* 1024 \* 1024/);
  assert.match(worker, /path\.unlink\(missing_ok=True\)/);
});
