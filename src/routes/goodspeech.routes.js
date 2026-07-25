"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const { logAudit } = require("../services/audit.service");

const router = express.Router();
const MAX_TEXT_LENGTH = 2000;
const PROVIDER_TIMEOUT_MS = 55_000;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const KOKORO_MODEL = "hexgrad/Kokoro-82M";
const KOKORO_HEALTH_TIMEOUT_MS = 4_000;
const KOKORO_VOICES = Object.freeze({
  Kore: "af_kore",
  Puck: "am_puck",
  Charon: "am_onyx",
  Fenrir: "am_fenrir",
  Zephyr: "af_sky",
});
const ALLOWED_VOICES = new Set(Object.keys(KOKORO_VOICES));
const ALLOWED_STYLES = new Set(["Natural", "Cheerfully", "Sadly", "Angrily", "Professionally", "Whispering", "Excitedly"]);
const ALLOWED_TONES = new Set(["Standard", "Warm", "Bright", "Airy", "Deep", "Gritty", "Crisp", "Soft"]);

const speechLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `goodspeech-user:${req.user.id}`,
  message: {
    success: false,
    code: "GOODSPEECH_RATE_LIMITED",
    message: "Too many speech requests. Try again shortly.",
  },
});

function cleanEnum(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function validatePayload(body = {}) {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return { error: "Text is required." };
  if (text.length > MAX_TEXT_LENGTH) return { error: `Text is limited to ${MAX_TEXT_LENGTH} characters.`, status: 413 };

  const voice = body.voice && typeof body.voice === "object" ? body.voice : {};
  const apiVoice = cleanEnum(voice.apiVoice, ALLOWED_VOICES, "Kore");
  const isCloned = voice.category === "Cloned";
  if (isCloned) {
    return {
      error: "Voice cloning is not available with the current GoodSpeech engine.",
      status: 422,
      code: "GOODSPEECH_CLONING_UNAVAILABLE",
    };
  }

  return {
    value: {
      text,
      apiVoice,
      style: cleanEnum(body.style, ALLOWED_STYLES, "Natural"),
      tone: cleanEnum(body.tone, ALLOWED_TONES, "Standard"),
      intensity: Math.min(100, Math.max(0, Number.isFinite(body.intensity) ? Math.round(body.intensity) : 50)),
      contextualExpressiveness: body.contextualExpressiveness !== false,
    },
  };
}

function kokoroSpeed(input) {
  const styleSpeed = {
    Cheerfully: 1.05,
    Sadly: 0.91,
    Angrily: 1.04,
    Professionally: 0.96,
    Whispering: 0.88,
    Excitedly: 1.1,
  }[input.style] || 1;
  const toneAdjustment = {
    Warm: -0.02,
    Airy: -0.03,
    Deep: -0.04,
    Gritty: -0.02,
    Bright: 0.03,
    Crisp: 0.02,
    Soft: -0.03,
  }[input.tone] || 0;
  const intensityAdjustment = ((input.intensity - 50) / 50) * 0.025;
  return Math.min(1.2, Math.max(0.8, Number((styleSpeed + toneAdjustment + intensityAdjustment).toFixed(3))));
}

function kokoroEndpoint() {
  const configured = String(process.env.KOKORO_TTS_URL || "").trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/audio/speech`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function kokoroHealthEndpoint() {
  const configured = String(process.env.KOKORO_TTS_URL || "").trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/health/ready`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function kokoroRequest(input) {
  return {
    model: KOKORO_MODEL,
    voice: KOKORO_VOICES[input.apiVoice] || KOKORO_VOICES.Kore,
    body: {
      model: KOKORO_MODEL,
      input: input.text,
      voice: KOKORO_VOICES[input.apiVoice] || KOKORO_VOICES.Kore,
      speed: kokoroSpeed(input),
      response_format: "wav",
    },
  };
}

function configuredProvider() {
  const endpoint = kokoroEndpoint();
  const token = String(process.env.KOKORO_TTS_TOKEN || "").trim();
  if (!endpoint || token.length < 32) return null;
  return { endpoint, token };
}

async function checkKokoroHealth({
  fetchFn = global.fetch,
  timeoutMs = KOKORO_HEALTH_TIMEOUT_MS,
} = {}) {
  const provider = configuredProvider();
  const endpoint = kokoroHealthEndpoint();
  if (!provider || !endpoint) {
    return {
      ready: false,
      code: "GOODSPEECH_NOT_CONFIGURED",
      message: "GoodSpeech's Kokoro engine is not configured.",
    };
  }
  if (typeof fetchFn !== "function") {
    return {
      ready: false,
      code: "GOODSPEECH_PROVIDER_UNAVAILABLE",
      message: "GoodSpeech's Kokoro engine is unavailable.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(endpoint, {
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "X-GoodBase-Service": "GoodSpeech",
      },
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      return {
        ready: false,
        code: "GOODSPEECH_PROVIDER_UNAVAILABLE",
        message: "GoodSpeech's Kokoro engine is still starting or unavailable.",
      };
    }

    const payload = await response.json().catch(() => null);
    return {
      ready: true,
      code: "GOODSPEECH_READY",
      message: "GoodSpeech's Kokoro engine is ready.",
      model: payload?.model || KOKORO_MODEL,
    };
  } catch {
    return {
      ready: false,
      code: "GOODSPEECH_PROVIDER_UNAVAILABLE",
      message: "GoodSpeech's Kokoro engine is unavailable.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readAudioBytes(response) {
  if (!response.body) {
    throw Object.assign(new Error("Speech provider returned no audio."), { status: 502 });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_AUDIO_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error("Speech provider returned oversized audio."), { status: 502 });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) {
    throw Object.assign(new Error("Speech provider returned empty audio."), { status: 502 });
  }
  return Buffer.concat(chunks, total);
}

router.get("/health", authRequired, async (_req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  const health = await checkKokoroHealth();
  return res.status(health.ready ? 200 : 503).json({
    success: health.ready,
    service: "GoodSpeech",
    provider: "kokoro",
    ...health,
  });
});

router.post("/speech", authRequired, speechLimiter, async (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  res.set("Pragma", "no-cache");

  const validation = validatePayload(req.body);
  if (validation.error) {
    return res.status(validation.status || 400).json({
      success: false,
      code: validation.code || "GOODSPEECH_INVALID_REQUEST",
      message: validation.error,
    });
  }

  const provider = configuredProvider();
  if (!provider) {
    return res.status(503).json({
      success: false,
      code: "GOODSPEECH_NOT_CONFIGURED",
      message: "GoodSpeech's Kokoro engine is not configured.",
    });
  }

  const request = kokoroRequest(validation.value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetch(provider.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "audio/wav",
        Authorization: `Bearer ${provider.token}`,
        "Content-Type": "application/json",
        "X-GoodBase-Service": "GoodSpeech",
      },
      body: JSON.stringify(request.body),
    });

    if (!response.ok) {
      await response.arrayBuffer().catch(() => null);
      throw Object.assign(new Error("Speech provider rejected the request."), { status: response.status });
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
      throw new Error("Speech provider returned an invalid content type.");
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_AUDIO_BYTES) {
      throw Object.assign(new Error("Speech provider returned oversized audio."), { status: 502 });
    }
    const audioBytes = await readAudioBytes(response);

    logAudit({
      userId: req.user.id,
      action: "goodspeech.generate",
      entityType: "goodspeech_request",
      ipAddress: req.ip,
      metadata: {
        model: request.model,
        provider: "kokoro",
        voice: request.voice,
        textLength: validation.value.text.length,
        durationMs: Date.now() - started,
      },
    }).catch(() => {});

    return res.json({
      success: true,
      data: {
        audioBase64: audioBytes.toString("base64"),
        mimeType: contentType.startsWith("audio/") ? contentType.split(";")[0] : "audio/wav",
        sampleRate: 24000,
        channels: 1,
      },
    });
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    console.error("[GoodSpeech] generation failed", {
      status: error?.status || 0,
      timedOut,
      durationMs: Date.now() - started,
    });
    return res.status(timedOut ? 504 : 502).json({
      success: false,
      code: timedOut ? "GOODSPEECH_TIMEOUT" : "GOODSPEECH_PROVIDER_ERROR",
      message: timedOut
        ? "Speech generation timed out. Try again."
        : "Speech generation is temporarily unavailable.",
    });
  } finally {
    clearTimeout(timeout);
  }
});

module.exports = router;
module.exports.validatePayload = validatePayload;
module.exports.kokoroRequest = kokoroRequest;
module.exports.kokoroSpeed = kokoroSpeed;
module.exports.kokoroEndpoint = kokoroEndpoint;
module.exports.kokoroHealthEndpoint = kokoroHealthEndpoint;
module.exports.configuredProvider = configuredProvider;
module.exports.checkKokoroHealth = checkKokoroHealth;
module.exports.readAudioBytes = readAudioBytes;
