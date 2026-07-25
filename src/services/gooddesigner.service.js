"use strict";

const OPENAI_API_BASE = "https://api.openai.com/v1";
const MAX_PROMPT_LENGTH = 6000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_REMOTE_HOSTS = new Set([
  "base.goodos.app",
  "designer.goodos.app",
]);

function serviceError(message, statusCode = 400, code = "GOODDESIGNER_INVALID_REQUEST") {
  const requestError = new Error(message);
  requestError.statusCode = statusCode;
  requestError.code = code;
  return requestError;
}

function requireProvider() {
  if (!process.env.OPENAI_API_KEY) {
    throw serviceError(
      "GoodDesigner AI is not configured in GoodBase.",
      503,
      "GOODDESIGNER_PROVIDER_NOT_CONFIGURED"
    );
  }
}

function boundedString(value, label, maxLength = MAX_PROMPT_LENGTH, required = true) {
  const result = String(value || "").trim();
  if (required && !result) throw serviceError(`${label} is required.`);
  if (result.length > maxLength) throw serviceError(`${label} is too long.`);
  return result;
}

function cleanList(value, maxItems, maxItemLength) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => boundedString(item, "List value", maxItemLength, false)).filter(Boolean);
}

function assertDesignerPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw serviceError("A JSON request body is required.");
  }
  if (payload.appId && !["designer", "gooddesigner", "good-designer"].includes(String(payload.appId).toLowerCase())) {
    throw serviceError("The request is not scoped to GoodDesigner.", 403, "GOODDESIGNER_APP_SCOPE_INVALID");
  }
}

function imageSizeForAspectRatio(aspectRatio) {
  if (aspectRatio === "16:9") return "1536x1024";
  if (aspectRatio === "9:16") return "1024x1536";
  return "1024x1024";
}

function imageQuality(value) {
  return String(value).toLowerCase().includes("high") ? "high" : "medium";
}

function parseDataImage(value) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\r\n]+)$/i.exec(String(value || ""));
  if (!match || !ALLOWED_IMAGE_MIME_TYPES.has(match[1].toLowerCase())) {
    throw serviceError("Images must be PNG, JPEG, or WebP data.");
  }
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    throw serviceError("Each image must be 10 MB or smaller.");
  }
  return {
    buffer,
    mimeType: match[1].toLowerCase(),
    extension: match[1].toLowerCase() === "image/jpeg" ? "jpg" : match[1].split("/")[1],
  };
}

async function loadImageAsset(value) {
  if (String(value || "").startsWith("data:")) return parseDataImage(value);

  let url;
  try {
    url = new URL(value);
  } catch {
    throw serviceError("The image address is invalid.");
  }
  if (url.protocol !== "https:" || (!ALLOWED_REMOTE_HOSTS.has(url.hostname) && !url.hostname.endsWith(".goodos.app"))) {
    throw serviceError("Remote images must be served from GoodOS.");
  }

  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw serviceError("The source image could not be downloaded.", 422, "GOODDESIGNER_IMAGE_DOWNLOAD_FAILED");
  const mimeType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) throw serviceError("The remote file is not a supported image.");
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_IMAGE_BYTES) throw serviceError("The remote image is too large.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw serviceError("The remote image is too large.");
  return {
    buffer,
    mimeType,
    extension: mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1],
  };
}

function providerMessage(payload, fallback) {
  return payload?.error?.message || payload?.message || fallback;
}

async function openAiRequest(path, options) {
  requireProvider();
  let response;
  try {
    response = await fetch(`${OPENAI_API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...(options.headers || {}),
      },
      signal: options.signal || AbortSignal.timeout(120_000),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw serviceError("The design provider timed out. Please try again.", 504, "GOODDESIGNER_PROVIDER_TIMEOUT");
    }
    throw serviceError("The design provider could not be reached.", 502, "GOODDESIGNER_PROVIDER_UNAVAILABLE");
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw serviceError(
      providerMessage(payload, "The design provider rejected the request."),
      response.status === 429 ? 429 : 502,
      response.status === 429 ? "GOODDESIGNER_RATE_LIMITED" : "GOODDESIGNER_PROVIDER_ERROR"
    );
  }
  return payload;
}

function imageResult(payload) {
  const item = payload?.data?.[0];
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (typeof item?.url === "string" && item.url.startsWith("https:")) return item.url;
  throw serviceError("The design provider did not return an image.", 502, "GOODDESIGNER_IMAGE_MISSING");
}

async function generateImage({ prompt, images = [], size = "1024x1024", quality = "medium", background = "opaque" }) {
  if (!images.length) {
    const payload = await openAiRequest("/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
        prompt,
        n: 1,
        size,
        quality,
        background,
        output_format: "png",
      }),
    });
    return imageResult(payload);
  }

  const form = new FormData();
  form.set("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-1");
  form.set("prompt", prompt);
  form.set("size", size);
  form.set("quality", quality);
  form.set("background", background);
  form.set("output_format", "png");
  const loaded = await Promise.all(images.slice(0, 4).map(loadImageAsset));
  loaded.forEach((image, index) => {
    form.append(
      loaded.length === 1 ? "image" : "image[]",
      new Blob([image.buffer], { type: image.mimeType }),
      `reference-${index + 1}.${image.extension}`
    );
  });

  return imageResult(await openAiRequest("/images/edits", {
    method: "POST",
    body: form,
  }));
}

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text.trim();
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if ((content?.type === "output_text" || content?.type === "text") && typeof content.text === "string") {
        return content.text.trim();
      }
    }
  }
  throw serviceError("The design provider did not return usable text.", 502, "GOODDESIGNER_TEXT_MISSING");
}

async function generateText(prompt, imageUrl) {
  const content = [{ type: "input_text", text: prompt }];
  if (imageUrl) content.push({ type: "input_image", image_url: imageUrl });
  const payload = await openAiRequest("/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_RESPONSES_MODEL || "gpt-5-mini",
      input: [{ role: "user", content }],
      max_output_tokens: 8000,
    }),
  });
  return responseText(payload);
}

function validatedSvg(value) {
  const stripped = String(value || "")
    .replace(/^```(?:svg|xml)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!/^<svg[\s>]/i.test(stripped) || stripped.length > 2_000_000) {
    throw serviceError("The provider did not return valid SVG.", 502, "GOODDESIGNER_VECTOR_INVALID");
  }
  if (/<script|<foreignObject|\son[a-z]+\s*=|javascript:/i.test(stripped)) {
    throw serviceError("The generated SVG contained unsafe content.", 502, "GOODDESIGNER_VECTOR_UNSAFE");
  }
  return stripped;
}

function designPrompt(payload, purpose) {
  const palette = cleanList(payload.colorPalette, 12, 32).join(", ") || "a commercially coherent palette";
  const negative = boundedString(payload.negativePrompt, "Negative prompt", 2000, false);
  const features = boundedString(payload.keyFeatures, "Key features", 3000, false);
  const refinement = boundedString(payload.refinementInstruction, "Refinement instruction", 3000, false);
  return [
    "Create an original, production-aware apparel design for GoodDesigner.",
    `Output purpose: ${purpose}.`,
    `Garment: ${boundedString(payload.clothingType, "Clothing type", 100, false) || "apparel"}.`,
    `Style: ${boundedString(payload.style, "Style", 100, false) || "contemporary"}.`,
    `Material: ${boundedString(payload.material, "Material", 100, false) || "appropriate apparel fabric"}.`,
    `Creative direction: ${boundedString(payload.prompt, "Prompt", MAX_PROMPT_LENGTH, false) || "develop the supplied reference image"}.`,
    `Palette: ${palette}.`,
    features ? `Required features: ${features}.` : "",
    refinement ? `Revision instruction: ${refinement}.` : "",
    negative ? `Avoid: ${negative}.` : "",
    payload.generationMode === "Technical Sketch"
      ? "Use a clean fashion technical-drawing presentation with clear construction details."
      : "Use professional fashion campaign lighting and accurate garment construction.",
    "Do not include trademarks, watermarks, labels, UI, explanatory text, or extra garments.",
  ].filter(Boolean).join("\n");
}

async function generateDesign(payload) {
  assertDesignerPayload(payload);
  const images = Array.isArray(payload.images) ? payload.images.slice(0, 4) : [];
  images.forEach(parseDataImage);
  const settings = {
    images,
    size: imageSizeForAspectRatio(payload.aspectRatio),
    quality: imageQuality(payload.imageQuality),
  };
  const [mockupUrl, graphicUrl] = await Promise.all([
    generateImage({
      ...settings,
      background: "opaque",
      prompt: designPrompt(payload, "a full apparel mockup showing the complete garment, front-biased three-quarter view"),
    }),
    generateImage({
      ...settings,
      background: "transparent",
      prompt: designPrompt(payload, "an isolated print-ready artwork or surface-design asset only, centered with a transparent background"),
    }),
  ]);
  return { mockupUrl, graphicUrl };
}

async function generateVector(payload) {
  assertDesignerPayload(payload);
  const prompt = boundedString(payload.prompt, "Vector prompt");
  const text = await generateText(
    `Return only one self-contained SVG document for this apparel graphic: ${prompt}.
Use viewBox="0 0 1000 1000", vector paths and shapes, a transparent background, and no external resources, scripts, event handlers, foreignObject, data URLs, or raster images.`
  );
  return { svg: validatedSvg(text) };
}

async function traceVector(payload) {
  assertDesignerPayload(payload);
  const image = parseDataImage(payload.imageUrl);
  const svg = await generateText(
    "Trace the main artwork in this image as a clean print-ready vector. Return only a self-contained SVG with viewBox=\"0 0 1000 1000\", a transparent background, and no scripts, event handlers, foreignObject, external resources, data URLs, or raster images.",
    `data:${image.mimeType};base64,${image.buffer.toString("base64")}`
  );
  return { svg: validatedSvg(svg) };
}

async function explodeDesign(payload) {
  assertDesignerPayload(payload);
  const source = parseDataImage(payload.imageUrl);
  const imageUrl = `data:${source.mimeType};base64,${source.buffer.toString("base64")}`;
  const purposes = [
    "Isolate the base garment silhouette and main fabric body. Remove artwork, trims, labels, and background. Center it on transparency.",
    "Isolate construction panels, seams, ribbing, pockets, closures, and garment structure. Remove the model and background. Center on transparency.",
    "Isolate artwork, prints, embroidery, trims, hardware, labels, and embellishments. Remove the garment body and background. Center on transparency.",
  ];
  const layers = await Promise.all(purposes.map((prompt) => generateImage({
    prompt: `${prompt}\nPreserve the design geometry and placement from the supplied reference.`,
    images: [imageUrl],
    background: "transparent",
    quality: "medium",
  })));
  return { layers };
}

async function generateMockup(payload) {
  assertDesignerPayload(payload);
  const source = parseDataImage(payload.designTextureUrl);
  const clothingType = boundedString(payload.clothingType, "Clothing type", 100, false) || "garment";
  const imageUrl = await generateImage({
    prompt: `Apply the supplied artwork faithfully to a photorealistic premium ${clothingType}. Show one complete garment on a neutral studio background. Preserve artwork colors, proportions, and placement. No extra text, labels, watermarks, or duplicate garments.`,
    images: [`data:${source.mimeType};base64,${source.buffer.toString("base64")}`],
    background: "opaque",
    quality: "high",
  });
  return { imageUrl };
}

async function generatePhotoshoot(payload) {
  assertDesignerPayload(payload);
  const source = parseDataImage(payload.clothingImageUrl);
  const options = payload.options && typeof payload.options === "object" ? payload.options : {};
  const imageUrl = await generateImage({
    prompt: [
      "Create a professional fashion editorial photograph using the supplied garment design.",
      `Model: ${boundedString(options.gender, "Model", 80, false) || "adult fashion model"}.`,
      `Appearance: ${boundedString(options.appearance, "Appearance", 200, false) || "editorial casting"}.`,
      `Pose: ${boundedString(options.pose, "Pose", 200, false) || "natural full-body pose"}.`,
      `Setting: ${boundedString(options.setting, "Setting", 200, false) || "professional studio"}.`,
      "Preserve the garment artwork, cut, colors, and material. Show one adult model, one complete outfit, realistic anatomy, no trademarks, labels, text, or watermarks.",
    ].join("\n"),
    images: [`data:${source.mimeType};base64,${source.buffer.toString("base64")}`],
    size: "1024x1536",
    background: "opaque",
    quality: "high",
  });
  return { imageUrl };
}

function validVideoJobId(value) {
  const jobId = String(value || "");
  if (!/^[a-zA-Z0-9_-]{1,180}$/.test(jobId)) throw serviceError("The animation job ID is invalid.");
  return jobId;
}

async function generateAnimation(payload) {
  assertDesignerPayload(payload);
  const source = parseDataImage(payload.imageUrl);
  const requestedMotion = boundedString(payload.prompt, "Animation prompt", 3000);
  const imageUrl = `data:${source.mimeType};base64,${source.buffer.toString("base64")}`;
  const description = await generateText(
    "Describe this garment precisely for a video-generation model. Cover silhouette, fabric, color, print placement, construction, and styling in under 220 words. Do not add unsupported details.",
    imageUrl
  );
  const form = new FormData();
  form.set("model", process.env.OPENAI_VIDEO_MODEL || "sora-2");
  form.set("prompt", `${requestedMotion}\nGarment continuity reference: ${description}\nShow one adult fashion model or one garment only. Preserve the described design. No text, logos, labels, watermarks, cuts, or scene changes.`);
  form.set("seconds", "8");
  form.set("size", "720x1280");
  const job = await openAiRequest("/videos", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  return {
    jobId: validVideoJobId(job.id),
    status: job.status || "queued",
  };
}

async function animationStatus(jobId) {
  const id = validVideoJobId(jobId);
  const job = await openAiRequest(`/videos/${encodeURIComponent(id)}`, {
    method: "GET",
    signal: AbortSignal.timeout(30_000),
  });
  const result = {
    jobId: id,
    status: job.status || "queued",
    progress: Number(job.progress || 0),
  };
  if (job.status === "completed") {
    result.videoUrl = `https://base.goodos.app/api/gooddesigner/v1/animations/${encodeURIComponent(id)}/content`;
  }
  if (job.status === "failed" || job.status === "cancelled") {
    result.message = job.error?.message || "The animation provider could not complete the video.";
  }
  return result;
}

async function animationContent(jobId) {
  requireProvider();
  const id = validVideoJobId(jobId);
  const response = await fetch(`${OPENAI_API_BASE}/videos/${encodeURIComponent(id)}/content`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw serviceError(providerMessage(payload, "The animation file is not available."), response.status === 404 ? 404 : 502, "GOODDESIGNER_VIDEO_UNAVAILABLE");
  }
  return response;
}

module.exports = {
  generateDesign,
  generateVector,
  traceVector,
  explodeDesign,
  generateMockup,
  generatePhotoshoot,
  generateAnimation,
  animationStatus,
  animationContent,
  _internal: {
    validatedSvg,
    parseDataImage,
    imageSizeForAspectRatio,
  },
};
