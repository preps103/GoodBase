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
    if (url.endsWith("/speech")) return response(new Uint8Array([82, 73, 70, 70]), { headers: { "content-type": "audio/wav" } });
    return response(JSON.stringify({ success: true, data: {} }), { headers: { "content-type": "application/json" } });
  };
  const client = new GoodSpeechClient({ baseUrl: "https://base.example", accessToken: "test-token", fetch });

  await client.capabilities();
  await client.createDesignedVoice({ name: "Calm", prompt: "A calm narrator" });
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

  assert.equal(audio.audio.byteLength, 4);
  assert.equal(stream.headers.get("content-type"), "application/octet-stream");
  assert.ok(requests.every((entry) => entry.options.headers?.Authorization === "Bearer test-token"));
  assert.deepEqual(requests.map((entry) => new URL(entry.url).pathname), [
    "/api/goodspeech/v1/capabilities",
    "/api/goodspeech/v1/voices/design",
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
  ]);
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

test("GoodSpeech Python SDK ships audio, agent, voice, and webhook helpers", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "sdks", "python", "goodbase", "goodspeech.py"), "utf8");
  assert.match(source, /class GoodSpeechClient/);
  assert.match(source, /def synthesize/);
  assert.match(source, /def create_designed_voice/);
  assert.match(source, /def send_agent_turn/);
  assert.match(source, /def create_webhook/);
  assert.match(source, /def test_webhook/);
  assert.match(source, /def update_privacy_settings/);
  assert.match(source, /def quality_summary/);
  assert.match(source, /def verify_goodspeech_webhook/);
  assert.match(source, /hmac\.compare_digest/);
});
