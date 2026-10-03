"use strict";

const crypto = require("node:crypto");
const { query } = require("../config/database");
const storage = require("./storage-v2.service");
const governance = require("./goodspeech-governance.service");

const BUCKET_ID = "bucket_goodspeech_user_assets";
const MAX_STATE_BYTES = 262144;
const MAX_ASSET_BYTES = 104857600;
const MAX_HISTORY_AUDIO_BYTES = 25165824;
const ALLOWED_MIME_TYPES = new Set([
  "audio/wav", "audio/x-wav", "audio/mpeg", "audio/ogg", "audio/webm",
  "audio/mp4", "audio/aac", "audio/flac",
  "video/mp4", "video/webm",
  "image/png", "image/jpeg", "image/webp",
  "text/plain", "application/json", "application/x-subrip", "text/vtt",
]);
const EXTENSIONS = {
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3",
  "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "m4a",
  "audio/aac": "aac", "audio/flac": "flac", "video/mp4": "mp4",
  "video/webm": "webm", "image/png": "png", "image/jpeg": "jpg",
  "image/webp": "webp", "text/plain": "txt", "application/json": "json",
  "application/x-subrip": "srt", "text/vtt": "vtt",
};

function libraryError(message, statusCode = 400, code = "GOODSPEECH_LIBRARY_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function boundedText(value, maximum, fallback = "") {
  return String(value || "").trim().slice(0, maximum) || fallback;
}

function safeSegment(value) {
  return boundedText(value, 180, "workspace")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
}

function validUuid(value, label = "ID") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw libraryError(`A valid ${label} is required.`, 400, "GOODSPEECH_LIBRARY_ID_INVALID");
  }
  return normalized;
}

function normalizedMimeType(file) {
  const mimeType = String(file?.mimetype || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw libraryError("This file type is not supported by GoodSpeech Assets.", 415, "GOODSPEECH_ASSET_TYPE_UNSUPPORTED");
  }
  return mimeType;
}

function assertFileSignature(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw libraryError("Choose a non-empty file to save.", 400, "GOODSPEECH_ASSET_FILE_REQUIRED");
  }
  const ascii = (start, end) => buffer.subarray(start, end).toString("ascii");
  const hex = (start, end) => buffer.subarray(start, end).toString("hex");
  const valid = {
    "audio/wav": ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE",
    "audio/x-wav": ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE",
    "audio/mpeg": hex(0, 3) === "494433" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0),
    "audio/ogg": ascii(0, 4) === "OggS",
    "audio/webm": hex(0, 4) === "1a45dfa3",
    "audio/mp4": ascii(4, 8) === "ftyp",
    "audio/aac": buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0,
    "audio/flac": ascii(0, 4) === "fLaC",
    "video/webm": hex(0, 4) === "1a45dfa3",
    "video/mp4": ascii(4, 8) === "ftyp",
    "image/png": hex(0, 8) === "89504e470d0a1a0a",
    "image/jpeg": hex(0, 3) === "ffd8ff",
    "image/webp": ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP",
  }[mimeType];
  if (valid === false) {
    throw libraryError("The uploaded file signature does not match its declared type.", 415, "GOODSPEECH_ASSET_SIGNATURE_INVALID");
  }
}

function validateFile(file, maximumBytes = MAX_ASSET_BYTES) {
  if (!file?.buffer) throw libraryError("A multipart file field named file is required.", 400, "GOODSPEECH_ASSET_FILE_REQUIRED");
  if (file.buffer.length > maximumBytes) {
    throw libraryError("The file is larger than the allowed GoodSpeech limit.", 413, "GOODSPEECH_ASSET_TOO_LARGE");
  }
  const mimeType = normalizedMimeType(file);
  assertFileSignature(file.buffer, mimeType);
  return mimeType;
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw libraryError("Asset metadata must be valid JSON.", 400, "GOODSPEECH_ASSET_METADATA_INVALID");
  }
}

function validateState(value) {
  const state = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!state) throw libraryError("Workspace state must be a JSON object.", 400, "GOODSPEECH_STATE_INVALID");
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
    throw libraryError("Workspace state is too large to save.", 413, "GOODSPEECH_STATE_TOO_LARGE");
  }
  return JSON.parse(serialized);
}

function assetRecord(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.mime_type,
    size: Number(row.size_bytes || 0),
    source: row.source,
    createdAt: new Date(row.created_at).getTime(),
    metadata: row.metadata_json || {},
  };
}

function historyRecord(row) {
  return {
    id: row.id,
    assetId: row.asset_id,
    text: row.script_text,
    voice: row.voice,
    voiceLabel: row.voice_label,
    style: row.style,
    tone: row.tone,
    intensity: Number(row.intensity || 50),
    generationSource: row.generation_source,
    duration: row.duration_seconds === null ? null : Number(row.duration_seconds),
    timestamp: new Date(row.created_at).getTime(),
  };
}

async function bootstrap({ context, userId }) {
  const [stateResult, assetResult, historyResult] = await Promise.all([
    query(`SELECT state_json, revision, updated_at FROM goodspeech_user_state
           WHERE organization_id = $1 AND user_id = $2::uuid LIMIT 1`, [context.organizationId, userId]),
    query(`SELECT * FROM goodspeech_assets
           WHERE organization_id = $1 AND owner_user_id = $2::uuid AND deleted_at IS NULL
           ORDER BY created_at DESC LIMIT 250`, [context.organizationId, userId]),
    query(`SELECT * FROM goodspeech_generation_history
           WHERE organization_id = $1 AND owner_user_id = $2::uuid
           ORDER BY created_at DESC LIMIT 50`, [context.organizationId, userId]),
  ]);
  const state = stateResult.rows[0];
  return {
    state: state?.state_json || {},
    revision: Number(state?.revision || 0),
    stateUpdatedAt: state?.updated_at || null,
    assets: assetResult.rows.map(assetRecord),
    history: historyResult.rows.map(historyRecord),
  };
}

async function saveState({ payload, context, userId }) {
  const state = validateState(payload?.state);
  const result = await query(
    `INSERT INTO goodspeech_user_state (organization_id, user_id, state_json)
     VALUES ($1, $2::uuid, $3::jsonb)
     ON CONFLICT (organization_id, user_id) DO UPDATE
     SET state_json = EXCLUDED.state_json,
         revision = goodspeech_user_state.revision + 1,
         updated_at = NOW()
     RETURNING revision, updated_at`,
    [context.organizationId, userId, JSON.stringify(state)]
  );
  return { revision: Number(result.rows[0].revision), updatedAt: result.rows[0].updated_at };
}

async function storeAsset({ file, source, metadata, context, userId }) {
  const mimeType = validateFile(file);
  const extension = EXTENSIONS[mimeType];
  const name = boundedText(file.originalname, 180, `goodspeech-asset.${extension}`);
  const safeSource = boundedText(source, 80, "Upload");
  const objectKey = `${safeSegment(context.organizationId)}/${userId}/${crypto.randomUUID()}.${extension}`;
  const object = await storage.putObject({
    bucketId: BUCKET_ID,
    objectKey,
    originalFilename: name,
    mimeType,
    buffer: file.buffer,
    cacheControl: "private, no-store",
    contentDisposition: `attachment; filename="${name.replace(/[\r\n"]/g, "")}"`,
    displayName: name,
    metadata: { application: "goodspeech", source: safeSource, ...parseMetadata(metadata) },
    createdBy: userId,
    organizationId: context.organizationId,
    projectId: context.projectId,
    environmentId: context.environmentId,
    actorType: "user",
    actorId: userId,
  });
  try {
    const result = await query(
      `INSERT INTO goodspeech_assets (
         organization_id, project_id, environment_id, owner_user_id,
         storage_file_id, name, mime_type, size_bytes, source, metadata_json
       ) VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING *`,
      [context.organizationId, context.projectId, context.environmentId, userId,
        object.id, name, mimeType, object.size_bytes || file.buffer.length, safeSource,
        JSON.stringify(parseMetadata(metadata))]
    );
    return { row: result.rows[0], asset: assetRecord(result.rows[0]) };
  } catch (error) {
    await storage.softDeleteObject({ fileId: object.id, actorId: userId, createdBy: userId, reason: "GoodSpeech metadata write failed" }).catch(() => {});
    throw error;
  }
}

async function uploadAsset(input) {
  return (await storeAsset(input)).asset;
}

async function getAsset({ assetId, context, userId }) {
  const result = await query(
    `SELECT * FROM goodspeech_assets
     WHERE id = $1::uuid AND organization_id = $2 AND owner_user_id = $3::uuid AND deleted_at IS NULL
     LIMIT 1`,
    [validUuid(assetId, "asset ID"), context.organizationId, userId]
  );
  if (!result.rows[0]) throw libraryError("Asset not found.", 404, "GOODSPEECH_ASSET_NOT_FOUND");
  return result.rows[0];
}

async function deleteAsset({ assetId, context, userId }) {
  const asset = await getAsset({ assetId, context, userId });
  await query(`UPDATE goodspeech_assets SET deleted_at = NOW()
               WHERE id = $1::uuid AND organization_id = $2 AND owner_user_id = $3::uuid`,
    [asset.id, context.organizationId, userId]);
  await storage.softDeleteObject({ fileId: asset.storage_file_id, actorId: userId, createdBy: userId, reason: "Deleted from GoodSpeech Assets" });
  return { id: asset.id };
}

async function createHistory({ file, payload, context, userId }) {
  if (!await governance.shouldRetainGeneratedContent({ context, userId })) {
    return { retained: false, policy: "zero_retention" };
  }
  validateFile(file, MAX_HISTORY_AUDIO_BYTES);
  const text = boundedText(payload?.text, 2000);
  if (!text) throw libraryError("Generation history requires the source script.", 400, "GOODSPEECH_HISTORY_SCRIPT_REQUIRED");
  const stored = await storeAsset({
    file,
    source: "Text to Speech",
    metadata: { kind: "generation-history" },
    context,
    userId,
  });
  try {
    const result = await query(
      `INSERT INTO goodspeech_generation_history (
         organization_id, project_id, environment_id, owner_user_id, asset_id,
         script_text, voice, voice_label, style, tone, intensity,
         generation_source, duration_seconds
       ) VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [context.organizationId, context.projectId, context.environmentId, userId, stored.row.id,
        text, boundedText(payload?.voice, 80, "Kore"), boundedText(payload?.voiceLabel, 80, "Kore"),
        boundedText(payload?.style, 40, "Natural"), boundedText(payload?.tone, 40, "Standard"),
        Math.max(0, Math.min(100, Number(payload?.intensity) || 50)),
        payload?.generationSource === "local" ? "local" : "goodbase",
        Number.isFinite(Number(payload?.duration)) ? Math.max(0, Number(payload.duration)) : null]
    );
    return { ...historyRecord(result.rows[0]), asset: stored.asset };
  } catch (error) {
    await deleteAsset({ assetId: stored.row.id, context, userId }).catch(() => {});
    throw error;
  }
}

async function deleteHistory({ historyId, context, userId }) {
  const result = await query(
    `DELETE FROM goodspeech_generation_history
     WHERE id = $1::uuid AND organization_id = $2 AND owner_user_id = $3::uuid
     RETURNING id, asset_id`,
    [validUuid(historyId, "history ID"), context.organizationId, userId]
  );
  if (!result.rows[0]) throw libraryError("History item not found.", 404, "GOODSPEECH_HISTORY_NOT_FOUND");
  if (result.rows[0].asset_id) {
    await deleteAsset({ assetId: result.rows[0].asset_id, context, userId }).catch(() => {});
  }
  return { id: result.rows[0].id };
}

module.exports = {
  BUCKET_ID,
  MAX_STATE_BYTES,
  MAX_ASSET_BYTES,
  MAX_HISTORY_AUDIO_BYTES,
  bootstrap,
  saveState,
  uploadAsset,
  getAsset,
  deleteAsset,
  createHistory,
  deleteHistory,
  _internal: { assertFileSignature, assetRecord, historyRecord, parseMetadata, validUuid, validateFile, validateState },
};
