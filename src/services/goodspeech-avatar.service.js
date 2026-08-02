"use strict";

const MAX_PORTRAIT_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const ALLOWED_PORTRAIT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/webm", "audio/mp4"]);

function serviceError(message, statusCode = 400, code = "GOODSPEECH_AVATAR_INVALID_REQUEST") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function workerConfig() {
  const rawUrl = String(process.env.GOODAVATAR_LIVE_URL || "").trim();
  const token = String(process.env.GOODAVATAR_LIVE_TOKEN || "").trim();
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

async function checkHealth({ fetchFn = global.fetch, timeoutMs = 5_000 } = {}) {
  const config = workerConfig();
  if (!config) {
    return {
      ready: false,
      code: "GOODSPEECH_AVATAR_NOT_CONFIGURED",
      message: "Private browser live mode is ready. Connect the open avatar worker for high-fidelity lip sync.",
      engine: "browser-live",
      model: null,
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
      code: "GOODSPEECH_AVATAR_READY",
      message: "The private open avatar renderer is ready.",
      engine: payload.engine || "liveavatar-open",
      model: payload.model || "LiveAvatar",
    };
  } catch {
    return {
      ready: false,
      code: "GOODSPEECH_AVATAR_PROVIDER_UNAVAILABLE",
      message: "Private browser live mode is ready while the high-fidelity avatar worker starts.",
      engine: "browser-live",
      model: null,
    };
  }
}

function validateFile(file, allowedTypes, maximumBytes, label) {
  if (!file?.buffer?.length || !allowedTypes.has(String(file.mimetype || "").toLowerCase())) {
    throw serviceError(`${label} has an unsupported file format.`);
  }
  if (file.buffer.length > maximumBytes) {
    throw serviceError(`${label} is too large.`, 413, "GOODSPEECH_AVATAR_UPLOAD_TOO_LARGE");
  }
  return file;
}

function validateRender(body = {}, files = {}) {
  const portrait = validateFile(files.portrait?.[0], ALLOWED_PORTRAIT_TYPES, MAX_PORTRAIT_BYTES, "Portrait");
  const audio = validateFile(files.audio?.[0], ALLOWED_AUDIO_TYPES, MAX_AUDIO_BYTES, "Narration");
  const name = String(body.name || "My avatar").trim().slice(0, 80) || "My avatar";
  if (body.consent !== "self") {
    throw serviceError(
      "Confirm that the portrait is you or an adult who authorized this avatar.",
      422,
      "GOODSPEECH_AVATAR_CONSENT_REQUIRED",
    );
  }
  return { portrait, audio, name };
}

function appendFile(form, name, file) {
  const fallback = name === "portrait" ? "jpg" : "wav";
  const extension = file.originalname?.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 8) || fallback;
  form.append(name, new Blob([file.buffer], { type: file.mimetype }), `${name}.${extension}`);
}

async function renderAvatar(body, files, { fetchFn = global.fetch } = {}) {
  const config = workerConfig();
  if (!config) {
    throw serviceError(
      "The high-fidelity avatar worker is not configured. Private browser live mode remains available.",
      503,
      "GOODSPEECH_AVATAR_NOT_CONFIGURED",
    );
  }
  const input = validateRender(body, files);
  const form = new FormData();
  appendFile(form, "portrait", input.portrait);
  appendFile(form, "audio", input.audio);
  form.set("name", input.name);
  form.set("consent", "self");
  form.set("watermark", "AI avatar · GoodSpeech");
  form.set("output_format", "mp4");

  let response;
  try {
    response = await fetchFn(workerEndpoint(config, "/v1/avatar/render"), {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "X-GoodBase-Service": "GoodSpeech" },
      body: form,
      signal: AbortSignal.timeout(10 * 60 * 1_000),
      redirect: "error",
    });
  } catch {
    throw serviceError("The open avatar worker could not be reached.", 502, "GOODSPEECH_AVATAR_PROVIDER_UNAVAILABLE");
  }
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw serviceError(
      payload?.message || "The open avatar worker rejected the performance.",
      response.status === 429 ? 429 : 502,
      response.status === 429 ? "GOODSPEECH_AVATAR_RATE_LIMITED" : "GOODSPEECH_AVATAR_PROVIDER_ERROR",
    );
  }
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (!contentType.startsWith("video/") || contentLength > MAX_VIDEO_BYTES) {
    await response.body.cancel().catch(() => {});
    throw serviceError("The avatar worker returned an invalid video.", 502, "GOODSPEECH_AVATAR_CONTENT_INVALID");
  }
  return response;
}

module.exports = {
  checkHealth,
  renderAvatar,
  serviceError,
  validateRender,
  workerConfig,
};
