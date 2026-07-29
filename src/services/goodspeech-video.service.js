"use strict";

const crypto = require("node:crypto");

const MAX_PROMPT_LENGTH = 3_000;
const MAX_NEGATIVE_PROMPT_LENGTH = 1_500;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const JOB_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;
const ALLOWED_MODES = new Set(["text-to-video", "image-to-video"]);
const ALLOWED_ASPECTS = new Set(["16:9", "9:16", "1:1"]);
const ALLOWED_RESOLUTIONS = new Set(["480p", "720p"]);
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_CAMERAS = new Set(["auto", "dolly-in", "pull-out", "pan-left", "pan-right", "orbit", "handheld"]);

const VIDEO_MODELS = Object.freeze([
  {
    id: "wan-2.1-t2v-1.3b",
    label: "GoodMotion Open Draft",
    description: "Fast open-model text-to-video for concepts, storyboards, and social drafts.",
    engine: "Wan 2.1 · Apache 2.0",
    modes: ["text-to-video"],
    durations: [4, 5],
    resolutions: ["480p"],
    aspects: ["16:9", "9:16", "1:1"],
  },
  {
    id: "wan-2.1-i2v-14b",
    label: "GoodMotion Open Director",
    description: "Reference-led image animation with stronger character and scene continuity.",
    engine: "Wan 2.1 I2V · Apache 2.0",
    modes: ["image-to-video"],
    durations: [4, 5, 8],
    resolutions: ["480p", "720p"],
    aspects: ["16:9", "9:16", "1:1"],
  },
]);

function serviceError(message, statusCode = 400, code = "GOODSPEECH_VIDEO_INVALID_REQUEST") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanString(value, label, maxLength, required = true) {
  const result = String(value || "").trim();
  if (required && !result) throw serviceError(`${label} is required.`);
  if (result.length > maxLength) throw serviceError(`${label} is too long.`);
  return result;
}

function workerConfig() {
  const rawUrl = String(process.env.GOODMOTION_VIDEO_URL || "").trim();
  const token = String(process.env.GOODMOTION_VIDEO_TOKEN || "").trim();
  if (!rawUrl || token.length < 32) return null;
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.search = "";
    url.hash = "";
    return { url, token };
  } catch {
    return null;
  }
}

function workerEndpoint(config, pathname) {
  const url = new URL(config.url.toString());
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function signingKey() {
  const secret = String(
    process.env.GOODMOTION_JOB_SIGNING_SECRET ||
    process.env.KOKORO_TTS_TOKEN ||
    "",
  ).trim();
  if (secret.length < 32) {
    throw serviceError(
      "GoodMotion job signing is not configured.",
      503,
      "GOODSPEECH_VIDEO_NOT_CONFIGURED",
    );
  }
  return crypto.createHash("sha256").update(`goodspeech-video:${secret}`).digest();
}

function signJobId(providerJobId, userId) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    job: providerJobId,
    user: String(userId),
    exp: Date.now() + JOB_TOKEN_TTL_MS,
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyJobId(token, userId) {
  const [payload, signature, extra] = String(token || "").split(".");
  if (!payload || !signature || extra || payload.length > 1_000 || signature.length > 100) {
    throw serviceError("The video job ID is invalid.", 404, "GOODSPEECH_VIDEO_JOB_NOT_FOUND");
  }
  const expected = crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");
  const suppliedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !crypto.timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw serviceError("The video job ID is invalid.", 404, "GOODSPEECH_VIDEO_JOB_NOT_FOUND");
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw serviceError("The video job ID is invalid.", 404, "GOODSPEECH_VIDEO_JOB_NOT_FOUND");
  }
  if (
    decoded?.v !== 1 ||
    decoded.user !== String(userId) ||
    !/^[a-zA-Z0-9_-]{1,180}$/.test(String(decoded.job || "")) ||
    !Number.isFinite(decoded.exp) ||
    decoded.exp < Date.now()
  ) {
    throw serviceError("The video job is unavailable or has expired.", 404, "GOODSPEECH_VIDEO_JOB_NOT_FOUND");
  }
  return decoded.job;
}

async function providerJson(response, fallback) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw serviceError(
      payload?.message || payload?.detail || fallback,
      response.status === 429 ? 429 : response.status >= 500 ? 502 : response.status,
      response.status === 429 ? "GOODSPEECH_VIDEO_RATE_LIMITED" : "GOODSPEECH_VIDEO_PROVIDER_ERROR",
    );
  }
  return payload;
}

async function checkHealth({ fetchFn = global.fetch, timeoutMs = 5_000 } = {}) {
  const config = workerConfig();
  if (!config) {
    return {
      ready: false,
      code: "GOODSPEECH_VIDEO_NOT_CONFIGURED",
      message: "Open AI video generation needs a connected GoodMotion GPU worker. Motion Canvas remains available.",
    };
  }
  if (typeof fetchFn !== "function") {
    return {
      ready: false,
      code: "GOODSPEECH_VIDEO_PROVIDER_UNAVAILABLE",
      message: "The GoodMotion video worker is unavailable.",
    };
  }
  try {
    const response = await fetchFn(workerEndpoint(config, "/health/ready"), {
      headers: { Authorization: `Bearer ${config.token}`, "X-GoodBase-Service": "GoodSpeech" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error("not ready");
    }
    const payload = await response.json().catch(() => ({}));
    return {
      ready: true,
      code: "GOODSPEECH_VIDEO_READY",
      message: "GoodMotion open video generation is ready.",
      engine: payload.engine || "goodmotion-open",
      model: payload.model || null,
    };
  } catch {
    return {
      ready: false,
      code: "GOODSPEECH_VIDEO_PROVIDER_UNAVAILABLE",
      message: "The GoodMotion GPU worker is starting or unavailable. Motion Canvas remains available.",
    };
  }
}

function validateImage(file, label) {
  if (!file) return null;
  if (!ALLOWED_IMAGE_TYPES.has(file.mimetype) || !file.buffer?.length) {
    throw serviceError(`${label} must be a PNG, JPEG, or WebP image.`);
  }
  if (file.buffer.length > 10 * 1024 * 1024) {
    throw serviceError(`${label} must be 10 MB or smaller.`, 413, "GOODSPEECH_VIDEO_UPLOAD_TOO_LARGE");
  }
  return file;
}

function validateJob(body, files = {}) {
  const mode = cleanString(body.mode, "Generation mode", 40);
  if (!ALLOWED_MODES.has(mode)) throw serviceError("The selected video mode is unsupported.");
  const model = cleanString(body.model, "Video model", 80);
  const modelDefinition = VIDEO_MODELS.find((item) => item.id === model);
  if (!modelDefinition || !modelDefinition.modes.includes(mode)) {
    throw serviceError("The selected open video model does not support this workflow.");
  }
  const prompt = cleanString(body.prompt, "Creative direction", MAX_PROMPT_LENGTH);
  const negativePrompt = cleanString(body.negativePrompt, "Negative prompt", MAX_NEGATIVE_PROMPT_LENGTH, false);
  const aspect = cleanString(body.aspect, "Aspect ratio", 10);
  const resolution = cleanString(body.resolution, "Resolution", 10);
  const camera = cleanString(body.camera || "auto", "Camera movement", 30);
  if (!ALLOWED_ASPECTS.has(aspect) || !modelDefinition.aspects.includes(aspect)) {
    throw serviceError("The selected aspect ratio is unsupported.");
  }
  if (!ALLOWED_RESOLUTIONS.has(resolution) || !modelDefinition.resolutions.includes(resolution)) {
    throw serviceError("The selected resolution is unsupported.");
  }
  if (!ALLOWED_CAMERAS.has(camera)) throw serviceError("The selected camera movement is unsupported.");
  const duration = Number(body.duration);
  if (!modelDefinition.durations.includes(duration)) throw serviceError("The selected duration is unsupported.");
  const seed = Math.max(0, Math.min(2_147_483_647, Math.round(Number(body.seed) || 0)));
  const startFrame = validateImage(files.startFrame?.[0], "Start frame");
  const endFrame = validateImage(files.endFrame?.[0], "End frame");
  if (mode !== "text-to-video" && !startFrame) {
    throw serviceError("A start frame is required for this video workflow.");
  }
  return {
    mode,
    model,
    prompt,
    negativePrompt,
    aspect,
    resolution,
    duration,
    camera,
    seed,
    startFrame,
    endFrame,
  };
}

function appendImage(form, name, file) {
  if (!file) return;
  const extension = file.mimetype === "image/jpeg" ? "jpg" : file.mimetype.split("/")[1];
  form.append(name, new Blob([file.buffer], { type: file.mimetype }), `${name}.${extension}`);
}

async function createJob(body, files, userId, { fetchFn = global.fetch } = {}) {
  const config = workerConfig();
  if (!config) {
    throw serviceError(
      "Open AI video generation needs a connected GoodMotion GPU worker. Use Motion Canvas until the worker is available.",
      503,
      "GOODSPEECH_VIDEO_NOT_CONFIGURED",
    );
  }
  const input = validateJob(body, files);
  const form = new FormData();
  for (const key of ["mode", "model", "prompt", "negativePrompt", "aspect", "resolution", "duration", "camera", "seed"]) {
    form.set(key, String(input[key]));
  }
  appendImage(form, "startFrame", input.startFrame);
  appendImage(form, "endFrame", input.endFrame);
  let response;
  try {
    response = await fetchFn(workerEndpoint(config, "/v1/video/jobs"), {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "X-GoodBase-Service": "GoodSpeech" },
      body: form,
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
  } catch {
    throw serviceError("The GoodMotion worker could not be reached.", 502, "GOODSPEECH_VIDEO_PROVIDER_UNAVAILABLE");
  }
  const payload = await providerJson(response, "The GoodMotion worker rejected the video job.");
  const providerJobId = String(payload.jobId || payload.id || "");
  if (!/^[a-zA-Z0-9_-]{1,180}$/.test(providerJobId)) {
    throw serviceError("The GoodMotion worker returned an invalid job.", 502, "GOODSPEECH_VIDEO_PROVIDER_ERROR");
  }
  return {
    jobId: signJobId(providerJobId, userId),
    status: payload.status || "queued",
    progress: Number(payload.progress || 0),
    model: input.model,
  };
}

async function getJob(jobToken, userId, { fetchFn = global.fetch } = {}) {
  const config = workerConfig();
  if (!config) throw serviceError("The GoodMotion worker is not configured.", 503, "GOODSPEECH_VIDEO_NOT_CONFIGURED");
  const providerJobId = verifyJobId(jobToken, userId);
  let response;
  try {
    response = await fetchFn(workerEndpoint(config, `/v1/video/jobs/${encodeURIComponent(providerJobId)}`), {
      headers: { Authorization: `Bearer ${config.token}`, "X-GoodBase-Service": "GoodSpeech" },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw serviceError("The GoodMotion worker could not be reached.", 502, "GOODSPEECH_VIDEO_PROVIDER_UNAVAILABLE");
  }
  const payload = await providerJson(response, "The video job status is unavailable.");
  return {
    jobId: jobToken,
    status: payload.status || "queued",
    progress: Math.max(0, Math.min(100, Number(payload.progress || 0))),
    message: payload.message || null,
  };
}

async function getContent(jobToken, userId, { fetchFn = global.fetch } = {}) {
  const config = workerConfig();
  if (!config) throw serviceError("The GoodMotion worker is not configured.", 503, "GOODSPEECH_VIDEO_NOT_CONFIGURED");
  const providerJobId = verifyJobId(jobToken, userId);
  let response;
  try {
    response = await fetchFn(workerEndpoint(config, `/v1/video/jobs/${encodeURIComponent(providerJobId)}/content`), {
      headers: { Authorization: `Bearer ${config.token}`, "X-GoodBase-Service": "GoodSpeech" },
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw serviceError("The generated video could not be downloaded.", 502, "GOODSPEECH_VIDEO_PROVIDER_UNAVAILABLE");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel?.().catch(() => {});
    throw serviceError("The generated video is not available.", response.status === 404 ? 404 : 502, "GOODSPEECH_VIDEO_CONTENT_UNAVAILABLE");
  }
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (!contentType.startsWith("video/") || contentLength > MAX_VIDEO_BYTES) {
    await response.body.cancel().catch(() => {});
    throw serviceError("The video worker returned an invalid file.", 502, "GOODSPEECH_VIDEO_CONTENT_INVALID");
  }
  return response;
}

module.exports = {
  VIDEO_MODELS,
  checkHealth,
  createJob,
  getJob,
  getContent,
  serviceError,
  validateJob,
  signJobId,
  verifyJobId,
  workerConfig,
};
