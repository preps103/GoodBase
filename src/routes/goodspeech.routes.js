"use strict";

const { Readable } = require("node:stream");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const multer = require("multer");
const authRequired = require("../middleware/authRequired");
const { logAudit } = require("../services/audit.service");
const videoService = require("../services/goodspeech-video.service");

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
  Amara: "af_heart",
  Celeste: "af_bella",
  Bennett: "bm_george",
  Ellis: "am_michael",
});
const KOKORO_SPEED_BIAS = Object.freeze({
  Kore: 0.98,
  Puck: 1.01,
  Charon: 0.95,
  Fenrir: 0.98,
  Zephyr: 0.96,
  Amara: 0.97,
  Celeste: 1,
  Bennett: 0.94,
  Ellis: 0.99,
});
const KOKORO_TOOL_IDS = Object.freeze(["speech", "studio", "dubbing", "audiobooks"]);
const BROWSER_TOOL_IDS = Object.freeze([
  "image",
  "sound-effects",
  "music",
  "voice-changer",
  "voice-isolator",
  "upscale",
  "speech-to-text",
  "flows",
  "templates",
  "assets",
]);
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
const videoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `goodspeech-video-user:${req.user.id}`,
  message: {
    success: false,
    code: "GOODSPEECH_VIDEO_RATE_LIMITED",
    message: "Too many AI video requests. Try again later.",
  },
});
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 2,
    fields: 20,
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
  const voiceBias = KOKORO_SPEED_BIAS[input.apiVoice] || 1;
  return Math.min(1.2, Math.max(0.8, Number(((styleSpeed + toneAdjustment + intensityAdjustment) * voiceBias).toFixed(3))));
}

function buildCapabilities(health, videoHealth = {
  ready: false,
  message: "Open AI video generation needs a connected GoodMotion GPU worker. Motion Canvas remains available.",
}) {
  const kokoroStatus = health.ready ? "ready" : "unavailable";
  const kokoroIssue = health.ready ? null : health.message;
  const videoStatus = videoHealth.ready ? "ready" : "unavailable";
  return [
    ...KOKORO_TOOL_IDS.map((id) => ({
      id,
      execution: "goodbase",
      engine: "kokoro",
      status: kokoroStatus,
      issue: kokoroIssue,
    })),
    {
      id: "video",
      execution: "goodbase",
      engine: "goodmotion-open",
      status: videoStatus,
      issue: videoHealth.ready ? null : videoHealth.message,
    },
    ...BROWSER_TOOL_IDS.map((id) => ({
      id,
      execution: "browser",
      engine: "native-media",
      status: "ready",
      issue: null,
    })),
  ];
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

router.get("/capabilities", authRequired, async (_req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  const [health, videoHealth] = await Promise.all([
    checkKokoroHealth(),
    videoService.checkHealth(),
  ]);
  return res.json({
    success: true,
    service: "GoodSpeech",
    provider: "kokoro",
    degraded: !health.ready || !videoHealth.ready,
    engine: health,
    engines: {
      speech: health,
      video: videoHealth,
    },
    voices: Object.keys(KOKORO_VOICES),
    capabilities: buildCapabilities(health, videoHealth),
  });
});

function sendVideoError(res, error) {
  const status = error?.statusCode || 500;
  console.error("[GoodSpeech Video] request failed", {
    status,
    code: error?.code || "GOODSPEECH_VIDEO_ERROR",
  });
  return res.status(status).json({
    success: false,
    code: error?.code || "GOODSPEECH_VIDEO_ERROR",
    message: status >= 500 && !String(error?.code || "").startsWith("GOODSPEECH_VIDEO_")
      ? "The AI video request could not be completed."
      : error?.message || "The AI video request could not be completed.",
  });
}

router.get("/video/models", authRequired, async (_req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  const health = await videoService.checkHealth();
  return res.json({
    success: true,
    health,
    models: videoService.VIDEO_MODELS.map((model) => ({
      ...model,
      available: health.ready,
    })),
  });
});

router.post(
  "/video/jobs",
  authRequired,
  videoLimiter,
  videoUpload.fields([
    { name: "startFrame", maxCount: 1 },
    { name: "endFrame", maxCount: 1 },
  ]),
  async (req, res) => {
    res.set("Cache-Control", "no-store, max-age=0");
    try {
      const job = await videoService.createJob(req.body, req.files || {}, req.user.id);
      logAudit({
        userId: req.user.id,
        action: "goodspeech.video.generate",
        entityType: "goodspeech_video_job",
        entityId: job.jobId.slice(0, 80),
        ipAddress: req.ip,
        metadata: {
          model: job.model,
          mode: req.body.mode,
          duration: Number(req.body.duration),
          aspect: req.body.aspect,
        },
      }).catch(() => {});
      return res.status(202).json({ success: true, ...job });
    } catch (error) {
      return sendVideoError(res, error);
    }
  },
);

router.get("/video/jobs/:jobId", authRequired, async (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  try {
    return res.json({
      success: true,
      ...(await videoService.getJob(req.params.jobId, req.user.id)),
    });
  } catch (error) {
    return sendVideoError(res, error);
  }
});

router.get("/video/jobs/:jobId/content", authRequired, async (req, res) => {
  res.set("Cache-Control", "private, no-store, max-age=0");
  try {
    const upstream = await videoService.getContent(req.params.jobId, req.user.id);
    res.status(200);
    res.set("Content-Type", upstream.headers.get("content-type") || "video/mp4");
    const length = upstream.headers.get("content-length");
    if (length) res.set("Content-Length", length);
    return Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    return sendVideoError(res, error);
  }
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
module.exports.buildCapabilities = buildCapabilities;
module.exports.kokoroEndpoint = kokoroEndpoint;
module.exports.kokoroHealthEndpoint = kokoroHealthEndpoint;
module.exports.configuredProvider = configuredProvider;
module.exports.checkKokoroHealth = checkKokoroHealth;
module.exports.readAudioBytes = readAudioBytes;
