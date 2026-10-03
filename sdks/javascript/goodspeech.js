"use strict";

const crypto = require("node:crypto");
const { GoodbaseClient, GoodbaseError } = require("./client");

const API_PREFIX = "/api/goodspeech/v1";

function joinUrl(baseUrl, path) {
  return `${String(baseUrl || "https://base.goodos.app").replace(/\/$/, "")}${path}`;
}

async function responseError(response) {
  const payload = await response.json().catch(() => ({}));
  return new GoodbaseError(payload.message || `GoodSpeech request failed with ${response.status}`, {
    status: response.status,
    code: payload.code,
    requestId: response.headers.get("x-request-id"),
  });
}

class GoodSpeechClient {
  constructor(options = {}) {
    this.client = options.client || new GoodbaseClient(options);
    this.baseUrl = this.client.baseUrl;
    this.fetch = this.client.fetch;
  }

  headers(extra = {}) {
    const headers = { Accept: "application/json", ...extra };
    if (this.client.accessToken) headers.Authorization = `Bearer ${this.client.accessToken}`;
    if (this.client.attestationToken) headers["X-Goodbase-Attestation"] = this.client.attestationToken;
    return headers;
  }

  request(path, options) {
    return this.client.request(`${API_PREFIX}${path}`, options);
  }

  health() { return this.request("/health"); }
  capabilities() { return this.request("/capabilities"); }
  usage() { return this.request("/usage"); }
  voices() { return this.request("/voices/"); }
  agents() { return this.request("/agents/bootstrap"); }
  analytics(agentId) {
    return this.request(`/agents/analytics${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`);
  }

  createDesignedVoice(payload) {
    return this.request("/voices/design", { method: "POST", body: payload });
  }

  createAgent(payload) {
    return this.request("/agents", { method: "POST", body: payload });
  }

  startAgentSession(agentId, payload = {}) {
    return this.request(`/agents/${encodeURIComponent(agentId)}/sessions`, { method: "POST", body: payload });
  }

  sendAgentTurn(sessionId, payload) {
    return this.request(`/agents/sessions/${encodeURIComponent(sessionId)}/turns`, { method: "POST", body: payload });
  }

  interruptAgentSession(sessionId) {
    return this.request(`/agents/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: "POST", body: {} });
  }

  completeAgentSession(sessionId, payload = {}) {
    return this.request(`/agents/sessions/${encodeURIComponent(sessionId)}/complete`, { method: "POST", body: payload });
  }

  listWebhooks() { return this.request("/webhooks"); }

  createWebhook(payload) {
    return this.request("/webhooks", { method: "POST", body: payload });
  }

  testWebhook(webhookId) {
    return this.request(`/webhooks/${encodeURIComponent(webhookId)}/test`, { method: "POST", body: {} });
  }

  deleteWebhook(webhookId) {
    return this.request(`/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" });
  }

  privacySettings() { return this.request("/governance/privacy"); }

  updatePrivacySettings(payload) {
    return this.request("/governance/privacy", { method: "PATCH", body: payload });
  }

  purgeRetainedContent() {
    return this.request("/governance/privacy/purge", { method: "POST", body: {} });
  }

  qualitySummary() { return this.request("/governance/quality"); }

  async synthesize(payload, options = {}) {
    const response = await this.fetch(joinUrl(this.baseUrl, `${API_PREFIX}/speech`), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", Accept: "audio/wav, application/json" }),
      body: JSON.stringify(payload),
      signal: options.signal,
    });
    if (!response.ok) throw await responseError(response);
    return {
      audio: await response.arrayBuffer(),
      contentType: response.headers.get("content-type") || "audio/wav",
      requestId: response.headers.get("x-request-id"),
    };
  }

  async stream(payload, options = {}) {
    const response = await this.fetch(joinUrl(this.baseUrl, `${API_PREFIX}/speech/stream`), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", Accept: "application/octet-stream" }),
      body: JSON.stringify(payload),
      signal: options.signal,
    });
    if (!response.ok) throw await responseError(response);
    return response;
  }

  async generateVoiceSpeech(voiceId, text, options = {}) {
    const response = await this.fetch(joinUrl(this.baseUrl, `${API_PREFIX}/voices/${encodeURIComponent(voiceId)}/speech`), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", Accept: "audio/wav, application/json" }),
      body: JSON.stringify({ text }),
      signal: options.signal,
    });
    if (!response.ok) throw await responseError(response);
    return {
      audio: await response.arrayBuffer(),
      contentType: response.headers.get("content-type") || "audio/wav",
      voiceId: response.headers.get("x-goodspeech-voice-id"),
      watermark: response.headers.get("x-goodspeech-watermark"),
    };
  }
}

function verifyGoodSpeechWebhook({ payload, signature, timestamp, secret, toleranceSeconds = 300, now = Date.now() }) {
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(now - timestampNumber * 1_000) > toleranceSeconds * 1_000) return false;
  const supplied = String(signature || "").replace(/^sha256=/i, "").trim();
  if (!/^[a-f0-9]{64}$/i.test(supplied) || !secret) return false;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const expected = crypto.createHmac("sha256", secret).update(`${timestampNumber}.`).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}

module.exports = { GoodSpeechClient, verifyGoodSpeechWebhook };
