"use strict";

const crypto = require("node:crypto");
const { query } = require("../config/database");
const designer = require("./gooddesigner.service");
const storage = require("./storage-v2.service");

const CREATIVE_BUCKET_ID = "bucket_goodads_creative_assets";
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "video/mp4"]);
const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
};

function creativeError(message, statusCode = 400, code = "GOODADS_CREATIVE_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function goodAdsProviderError(error) {
  if (error?.code === "GOODDESIGNER_PROVIDER_NOT_CONFIGURED") {
    return creativeError(
      "GoodAds creative generation is not configured in GoodBase.",
      503,
      "GOODADS_CREATIVE_PROVIDER_NOT_CONFIGURED"
    );
  }
  return error;
}

function boundedText(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function safeSegment(value) {
  return boundedText(value, 160).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function validUuid(value, label = "ID") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw creativeError(`A valid ${label} is required.`, 400, "GOODADS_CREATIVE_ID_INVALID");
  }
  return normalized;
}

function assertFileSignature(buffer, mimeType) {
  if (mimeType === "image/png" && buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw creativeError("The uploaded PNG signature is invalid.", 415, "GOODADS_CREATIVE_FILE_INVALID");
  }
  if (mimeType === "image/jpeg" && buffer.subarray(0, 3).toString("hex") !== "ffd8ff") {
    throw creativeError("The uploaded JPEG signature is invalid.", 415, "GOODADS_CREATIVE_FILE_INVALID");
  }
  if (mimeType === "image/webp"
      && !(buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP")) {
    throw creativeError("The uploaded WebP signature is invalid.", 415, "GOODADS_CREATIVE_FILE_INVALID");
  }
  if (mimeType === "video/mp4" && buffer.subarray(4, 8).toString() !== "ftyp") {
    throw creativeError("The uploaded MP4 signature is invalid.", 415, "GOODADS_CREATIVE_FILE_INVALID");
  }
}

async function storeBuffer({ buffer, mimeType, filename, purpose, context, userId }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw creativeError("A creative asset file is required.", 400, "GOODADS_CREATIVE_FILE_REQUIRED");
  }
  if (!ALLOWED_TYPES.has(mimeType)) {
    throw creativeError("Creative assets must be PNG, JPEG, WebP, or MP4.", 415, "GOODADS_CREATIVE_FILE_TYPE");
  }
  assertFileSignature(buffer, mimeType);
  const extension = EXTENSIONS[mimeType];
  const objectKey = [
    safeSegment(context.organizationId),
    safeSegment(purpose || "creative"),
    `${crypto.randomUUID()}.${extension}`,
  ].join("/");
  const object = await storage.putObject({
    bucketId: CREATIVE_BUCKET_ID,
    objectKey,
    originalFilename: boundedText(filename, 240) || `goodads-${purpose}.${extension}`,
    mimeType,
    buffer,
    cacheControl: "public, max-age=31536000, immutable",
    contentDisposition: "inline",
    displayName: boundedText(filename, 240) || `GoodAds ${purpose}`,
    metadata: {
      application: "goodads",
      purpose: boundedText(purpose, 80),
    },
    createdBy: userId,
    organizationId: context.organizationId,
    projectId: context.projectId,
    environmentId: context.environmentId,
    actorType: "user",
    actorId: userId,
  });
  const url = object.cdn_url || object.public_url || object.cdnUrl || object.publicUrl;
  if (!url) {
    throw creativeError("GoodBase did not produce a public creative asset address.", 500, "GOODADS_CREATIVE_URL_MISSING");
  }
  return {
    id: object.id,
    url,
    mimeType: object.mime_type,
    sizeBytes: Number(object.size_bytes || buffer.length),
    checksumSha256: object.checksum_sha256,
    objectKey: object.objectKey,
  };
}

async function uploadAsset({ file, purpose, context, userId }) {
  if (!file) {
    throw creativeError("Choose an image or MP4 file to upload.", 400, "GOODADS_CREATIVE_FILE_REQUIRED");
  }
  return storeBuffer({
    buffer: file.buffer,
    mimeType: String(file.mimetype || "").toLowerCase(),
    filename: file.originalname,
    purpose,
    context,
    userId,
  });
}

async function storeGeneratedImage(result, purpose, context, userId) {
  const parsed = designer._internal.parseDataImage(result.imageUrl);
  return storeBuffer({
    buffer: parsed.buffer,
    mimeType: parsed.mimeType,
    filename: `goodads-${purpose}.${parsed.extension}`,
    purpose,
    context,
    userId,
  });
}

async function generateImage({ payload, context, userId }) {
  try {
    const generated = await designer.generateAdCreative({ ...payload, appId: "goodads" });
    return storeGeneratedImage(generated, "generated-image", context, userId);
  } catch (error) {
    throw goodAdsProviderError(error);
  }
}

async function generateVariation({ payload, context, userId }) {
  try {
    const generated = await designer.generateAdVariation({ ...payload, appId: "goodads" });
    return storeGeneratedImage(generated, "creative-variation", context, userId);
  } catch (error) {
    throw goodAdsProviderError(error);
  }
}

async function startVideo({ payload, context, userId, idempotencyKey }) {
  const prompt = boundedText(payload?.prompt, 3000);
  if (!prompt) {
    throw creativeError("Enter a clear video direction before rendering.", 400, "GOODADS_VIDEO_PROMPT_REQUIRED");
  }
  const requestKey = boundedText(idempotencyKey, 180);
  if (!requestKey) {
    throw creativeError("An Idempotency-Key header is required.", 400, "GOODADS_VIDEO_IDEMPOTENCY_REQUIRED");
  }
  const existing = await query(
    `SELECT * FROM goodads_creative_jobs
     WHERE organization_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [context.organizationId, requestKey]
  );
  if (existing.rows[0]) return jobRecord(existing.rows[0]);

  let generated;
  try {
    generated = await designer.generateAdVideo({ ...payload, prompt, appId: "goodads" });
  } catch (error) {
    throw goodAdsProviderError(error);
  }
  const result = await query(
    `INSERT INTO goodads_creative_jobs (
       organization_id, project_id, environment_id, owner_user_id,
       provider_job_id, idempotency_key, status, prompt, input
     ) VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9::jsonb)
     RETURNING *`,
    [
      context.organizationId,
      context.projectId,
      context.environmentId,
      userId,
      generated.jobId,
      requestKey,
      generated.status === "in_progress" ? "processing" : generated.status,
      prompt,
      JSON.stringify({
        imageUrl: boundedText(payload?.imageUrl, 2000),
        format: boundedText(payload?.format, 80),
        seconds: Number(payload?.seconds) || 8,
      }),
    ]
  );
  return jobRecord(result.rows[0]);
}

function jobRecord(row) {
  return {
    id: row.id,
    status: row.status,
    progress: Number(row.progress || 0),
    prompt: row.prompt,
    input: row.input || {},
    url: row.asset_url || null,
    error: row.error_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
  };
}

async function loadJob(id, context) {
  const jobId = validUuid(id, "video render job ID");
  const result = await query(
    `SELECT * FROM goodads_creative_jobs
     WHERE id = $1::uuid AND organization_id = $2
     LIMIT 1`,
    [jobId, context.organizationId]
  );
  if (!result.rows[0]) {
    throw creativeError("Video render job not found.", 404, "GOODADS_VIDEO_JOB_NOT_FOUND");
  }
  return result.rows[0];
}

async function videoStatus({ id, context, userId }) {
  const current = await loadJob(id, context);
  if (["completed", "failed", "cancelled"].includes(current.status)) return jobRecord(current);

  const provider = await designer.animationStatus(current.provider_job_id);
  let status = provider.status === "in_progress" ? "processing" : provider.status;
  if (!["queued", "processing", "completed", "failed", "cancelled"].includes(status)) status = "processing";
  let asset = null;
  let errorMessage = provider.message || null;

  if (status === "completed" && !current.asset_url) {
    const response = await designer.animationContent(current.provider_job_id);
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = String(response.headers.get("content-type") || "video/mp4").split(";")[0].toLowerCase();
    asset = await storeBuffer({
      buffer,
      mimeType,
      filename: `goodads-video-${id}.mp4`,
      purpose: "generated-video",
      context,
      userId,
    });
  }

  const result = await query(
    `UPDATE goodads_creative_jobs
     SET status = $1,
         progress = $2,
         asset_file_id = COALESCE($3, asset_file_id),
         asset_url = COALESCE($4, asset_url),
         error_message = $5,
         completed_at = CASE WHEN $1 = 'completed' THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
         updated_at = NOW()
     WHERE id = $6::uuid AND organization_id = $7
     RETURNING *`,
    [
      status,
      status === "completed" ? 100 : Math.max(0, Math.min(Number(provider.progress) || 0, 99)),
      asset?.id || null,
      asset?.url || null,
      errorMessage,
      current.id,
      context.organizationId,
    ]
  );
  return jobRecord(result.rows[0]);
}

module.exports = {
  uploadAsset,
  generateImage,
  generateVariation,
  startVideo,
  videoStatus,
  _internal: {
    assertFileSignature,
    goodAdsProviderError,
    jobRecord,
    validUuid,
  },
};
