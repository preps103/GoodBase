"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { GoodSpeechClient, verifyGoodSpeechWebhook } = require("../sdks/javascript/goodspeech");

function response(body, options = {}) {
  return new Response(body, { status: options.status || 200, headers: options.headers || {} });
}

test("GoodSpeech JavaScript SDK exposes JSON, binary, streaming, voice, and agent APIs", async () => {
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/speech/stream")) return response(new Uint8Array([1, 0, 2, 0]), { headers: { "content-type": "application/octet-stream" } });
    if (url.endsWith("/speech") || url.endsWith("/design/preview")) return response(new Uint8Array([82, 73, 70, 70]), { headers: { "content-type": "audio/wav" } });
    return response(JSON.stringify({ success: true, data: {} }), { headers: { "content-type": "application/json" } });
  };
  const client = new GoodSpeechClient({ baseUrl: "https://base.example", accessToken: "test-token", fetch });

  await client.capabilities();
  await client.usagePreferences();
  await client.updateUsagePreferences({ requestBudget: 500, characterBudget: 100000, warningPercent: 75 });
  await client.createDesignedVoice({ name: "Calm", prompt: "A calm narrator" });
  await client.designVoiceCandidates({ prompt: "A calm narrator", language: "en-us" });
  const candidate = await client.previewDesignedVoice({ prompt: "A calm narrator", language: "en-us", candidateId: "candidate-1", text: "Hello" });
  const audio = await client.synthesize({ text: "Hello" });
  const stream = await client.stream({ text: "Hello" });
  await client.startAgentSession("agent-1");
  await client.sendAgentTurn("session-1", { text: "Hello" });
  await client.completeAgentSession("session-1", { outcome: "resolved" });
  await client.createWebhook({ endpointUrl: "https://hooks.example.test/goodspeech", events: ["speech.completed"] });
  await client.testWebhook("hook-1");
  await client.deleteWebhook("hook-1");
  await client.updatePrivacySettings({ zeroRetention: true });
  await client.qualitySummary();
  await client.createStudioJob({ projectName: "Launch", clips: [{ text: "Hello" }] }, "studio-test-001");
  await client.getStudioJob("job-1");
  await client.cancelStudioJob("job-1");
  await client.retryStudioJob("job-1");
  await client.transcriptionHealth();
  await client.transcribe(new Blob([new Uint8Array([82, 73, 70, 70])], { type: "audio/wav" }), "en", { filename: "sample.wav" });

  assert.equal(audio.audio.byteLength, 4);
  assert.equal(candidate.audio.byteLength, 4);
  assert.equal(stream.headers.get("content-type"), "application/octet-stream");
  assert.ok(requests.every((entry) => entry.options.headers?.Authorization === "Bearer test-token"));
  assert.deepEqual(requests.map((entry) => new URL(entry.url).pathname), [
    "/api/goodspeech/v1/capabilities",
    "/api/goodspeech/v1/usage/preferences",
    "/api/goodspeech/v1/usage/preferences",
    "/api/goodspeech/v1/voices/design",
    "/api/goodspeech/v1/voices/design/candidates",
    "/api/goodspeech/v1/voices/design/preview",
    "/api/goodspeech/v1/speech",
    "/api/goodspeech/v1/speech/stream",
    "/api/goodspeech/v1/agents/agent-1/sessions",
    "/api/goodspeech/v1/agents/sessions/session-1/turns",
    "/api/goodspeech/v1/agents/sessions/session-1/complete",
    "/api/goodspeech/v1/webhooks",
    "/api/goodspeech/v1/webhooks/hook-1/test",
    "/api/goodspeech/v1/webhooks/hook-1",
    "/api/goodspeech/v1/governance/privacy",
    "/api/goodspeech/v1/governance/quality",
    "/api/goodspeech/v1/studio/jobs",
    "/api/goodspeech/v1/studio/jobs/job-1",
    "/api/goodspeech/v1/studio/jobs/job-1/cancel",
    "/api/goodspeech/v1/studio/jobs/job-1/retry",
    "/api/goodspeech/v1/transcriptions/health",
    "/api/goodspeech/v1/transcriptions",
  ]);
  const transcriptionRequest = requests.at(-1);
  assert.ok(transcriptionRequest.options.body instanceof FormData);
  assert.equal(transcriptionRequest.options.headers["Content-Type"], undefined);
});

test("GoodSpeech SDK verifies signed webhook bodies with timestamp replay protection", () => {
  const payload = JSON.stringify({ id: "evt_test", type: "speech.completed" });
  const secret = "whsec_goodspeech_test_secret";
  const timestamp = 1_800_000_000;
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  assert.equal(verifyGoodSpeechWebhook({ payload, signature: `sha256=${signature}`, timestamp, secret, now: timestamp * 1_000 }), true);
  assert.equal(verifyGoodSpeechWebhook({ payload: `${payload}x`, signature, timestamp, secret, now: timestamp * 1_000 }), false);
  assert.equal(verifyGoodSpeechWebhook({ payload, signature, timestamp, secret, now: (timestamp + 301) * 1_000 }), false);
});

test("GoodSpeech JavaScript SDK sends a scoped API key without browser session credentials", async () => {
  const requests = [];
  const client = new GoodSpeechClient({
    baseUrl: "https://base.example",
    apiKey: "gos_live_test_key",
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return response(JSON.stringify({ success: true, data: {} }), { headers: { "content-type": "application/json" } });
    },
  });
  await client.capabilities();
  await client.transcriptionHealth();
  assert.ok(requests.every((entry) => entry.options.headers["X-Goodbase-API-Key"] === "gos_live_test_key"));
  assert.ok(requests.every((entry) => entry.options.headers.Authorization === undefined));
});

test("GoodSpeech Python SDK ships audio, agent, voice, and webhook helpers", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "sdks", "python", "goodbase", "goodspeech.py"), "utf8");
  assert.match(source, /class GoodSpeechClient/);
  assert.match(source, /def synthesize/);
  assert.match(source, /def create_designed_voice/);
  assert.match(source, /def design_voice_candidates/);
  assert.match(source, /def preview_designed_voice/);
  assert.match(source, /def send_agent_turn/);
  assert.match(source, /def create_webhook/);
  assert.match(source, /def test_webhook/);
  assert.match(source, /def update_privacy_settings/);
  assert.match(source, /def usage_preferences/);
  assert.match(source, /def update_usage_preferences/);
  assert.match(source, /def quality_summary/);
  assert.match(source, /def create_studio_job/);
  assert.match(source, /def cancel_studio_job/);
  assert.match(source, /def transcription_health/);
  assert.match(source, /def transcribe/);
  assert.match(source, /def verify_goodspeech_webhook/);
  assert.match(source, /hmac\.compare_digest/);
});
