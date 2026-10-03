"use strict";

const crypto = require("node:crypto");
const database = require("../config/database");
const library = require("./goodspeech-library.service");

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 15 * 60 * 1000;
const MODEL_ID = "Systran/faster-whisper-small";
const MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120";

function transcriptionError(message, statusCode = 400, code = "GOODSPEECH_TRANSCRIPTION_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

function provider() {
  const base = String(process.env.FASTER_WHISPER_URL || "").trim();
  const token = String(process.env.FASTER_WHISPER_TOKEN || "").trim();
  if (!/^https?:\/\//.test(base) || token.length < 32) return null;
  return {
    endpoint: `${base.replace(/\/+$/, "")}/v1/audio/transcriptions`,
    health: `${base.replace(/\/+$/, "")}/health/ready`,
    token,
  };
}

function normalizeLanguage(value) {
  const language = String(value || "").trim().toLowerCase();
  if (!language || language === "auto") return "";
  if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(language)) {
    throw transcriptionError("Language must be automatic or a valid ISO language code.");
  }
  return language.split("-")[0];
}

function validateAudio(file) {
  library._internal.validateFile(file, MAX_AUDIO_BYTES);
  const type = String(file.mimetype || "").toLowerCase();
  if (!type.startsWith("audio/") && !["video/mp4", "video/webm"].includes(type)) {
    throw transcriptionError("Choose an audio file or a video with audio.", 415, "GOODSPEECH_TRANSCRIPTION_TYPE_UNSUPPORTED");
  }
}

function boundedResult(payload) {
  if (!payload || typeof payload !== "object") {
    throw transcriptionError("The transcription engine returned an invalid response.", 502, "GOODSPEECH_TRANSCRIPTION_PROVIDER_INVALID");
  }
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) {
    throw transcriptionError("The transcription result is too large.", 502, "GOODSPEECH_TRANSCRIPTION_RESULT_TOO_LARGE");
  }
  const segments = Array.isArray(payload.segments) ? payload.segments.slice(0, 20_000).map((segment, index) => ({
    id: Number.isInteger(segment?.id) ? segment.id : index,
    text: String(segment?.text || "").trim().slice(0, 12_000),
    start: Math.max(0, Number(segment?.start) || 0),
    end: Math.max(0, Number(segment?.end) || 0),
    words: Array.isArray(segment?.words) ? segment.words.slice(0, 2_000).map((word) => ({
      word: String(word?.word || "").trim().slice(0, 200),
      start: Math.max(0, Number(word?.start) || 0),
      end: Math.max(0, Number(word?.end) || 0),
      probability: Math.min(1, Math.max(0, Number(word?.probability) || 0)),
    })).filter((word) => word.word) : [],
  })).filter((segment) => segment.text) : [];
  return {
    text: String(payload.text || "").trim().slice(0, 1_000_000),
    language: String(payload.language || "unknown").slice(0, 20),
    languageProbability: Math.min(1, Math.max(0, Number(payload.languageProbability) || 0)),
    durationSeconds: Math.max(0, Number(payload.durationSeconds) || 0),
    durationAfterVadSeconds: Math.max(0, Number(payload.durationAfterVadSeconds) || 0),
    segments,
    model: String(payload.model || MODEL_ID).slice(0, 200),
    modelRevision: String(payload.modelRevision || MODEL_REVISION).slice(0, 64),
  };
}

async function recordUsage({ result, context, userId, request, latencyMs }) {
  const eventId = `usageevt_${crypto.randomUUID().replace(/-/g, "")}`;
  const route = String(request?.originalUrl || "/api/goodspeech/v1/transcriptions").split("?")[0].slice(0, 500);
  const seconds = Math.max(1, Math.ceil(result.durationSeconds));
  const metadata = JSON.stringify({
    model: result.model,
    modelRevision: result.modelRevision,
    language: result.language,
    segments: result.segments.length,
    latencyMs,
  });
  await database.query(
    `INSERT INTO backend_usage_events (
       id, metric_key, category, source, quantity, unit, user_id,
       organization_id, project_id, environment_id, route, method, status_code, metadata_json
     ) VALUES ($1,'goodspeech.transcription.seconds','ai-speech','goodspeech',$2,'seconds',$3::uuid,$4,$5,$6,$7,'POST',200,$8::jsonb)`,
    [eventId, seconds, userId, context.organizationId, context.projectId, context.environmentId, route, metadata],
  );
  await database.query(
    `INSERT INTO backend_meter_events (
       id, metric_key, meter_name, quantity, unit, billable,
       organization_id, project_id, environment_id, usage_event_id, metadata_json
     ) VALUES ($1,'goodspeech.transcription.seconds','goodspeech_transcription_seconds',$2,'seconds',false,$3,$4,$5,$6,$7::jsonb)`,
    [`meter_${crypto.randomUUID().replace(/-/g, "")}`, seconds, context.organizationId,
      context.projectId, context.environmentId, eventId, metadata],
  );
}

async function transcribe({ file, language, context, userId, request, fetchFn = global.fetch }) {
  validateAudio(file);
  const configured = provider();
  if (!configured) {
    throw transcriptionError("GoodBase managed transcription is not configured.", 503, "GOODSPEECH_TRANSCRIPTION_NOT_CONFIGURED");
  }
  const form = new FormData();
  form.append("file", new Blob([file.buffer], { type: file.mimetype }), String(file.originalname || "audio.wav").slice(0, 180));
  form.append("language", normalizeLanguage(language));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetchFn(configured.endpoint, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${configured.token}`, "X-GoodBase-Service": "GoodSpeech Transcription" },
      body: form,
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw transcriptionError("The managed transcription engine rejected this file.", 502, "GOODSPEECH_TRANSCRIPTION_PROVIDER_REJECTED");
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_RESULT_BYTES) {
      await response.body?.cancel?.().catch(() => {});
      throw transcriptionError("The transcription result is too large.", 502, "GOODSPEECH_TRANSCRIPTION_RESULT_TOO_LARGE");
    }
    const result = boundedResult(await response.json());
    const latencyMs = Date.now() - started;
    await recordUsage({ result, context, userId, request, latencyMs });
    return { ...result, latencyMs, retention: "transient_audio" };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw transcriptionError("Managed transcription timed out.", 504, "GOODSPEECH_TRANSCRIPTION_TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkHealth({ fetchFn = global.fetch, timeoutMs = 4_000 } = {}) {
  const configured = provider();
  if (!configured || typeof fetchFn !== "function") {
    return { ready: false, code: "GOODSPEECH_TRANSCRIPTION_NOT_CONFIGURED", message: "Managed transcription is not configured." };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(configured.health, { cache: "no-store", redirect: "error", signal: controller.signal });
    if (!response.ok) return { ready: false, code: "GOODSPEECH_TRANSCRIPTION_LOADING", message: "Managed transcription is loading." };
    const data = await response.json();
    return { ready: true, code: "GOODSPEECH_TRANSCRIPTION_READY", message: "Private managed transcription is ready.", ...data };
  } catch {
    return { ready: false, code: "GOODSPEECH_TRANSCRIPTION_UNAVAILABLE", message: "Managed transcription is unavailable." };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  MAX_AUDIO_BYTES,
  MODEL_ID,
  MODEL_REVISION,
  checkHealth,
  normalizeLanguage,
  transcribe,
  _internal: { boundedResult, provider, validateAudio },
};
