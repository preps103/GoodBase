"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs").promises;
const database = require("../config/database");
const speechRuntime = require("../routes/goodspeech.routes");
const library = require("./goodspeech-library.service");
const storage = require("./storage-v2.service");
const usage = require("./goodspeech-usage.service");
const webhooks = require("./goodspeech-webhook.service");

const MAX_CLIPS = 24;
const MAX_PROJECT_CHARACTERS = 18_000;
const PROVIDER_TIMEOUT_MS = 60_000;
const MAX_PART_BYTES = 24 * 1024 * 1024;
const MAX_MASTER_BYTES = library.MAX_ASSET_BYTES;

function studioError(message, statusCode = 400, code = "GOODSPEECH_STUDIO_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

function scope(context = {}) {
  return {
    organizationId: String(context.organizationId || "org_goodos"),
    projectId: context.projectId ? String(context.projectId) : null,
    environmentId: context.environmentId ? String(context.environmentId) : null,
  };
}

function uuid(value, label = "job ID") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw studioError(`A valid ${label} is required.`, 400, "GOODSPEECH_STUDIO_ID_INVALID");
  }
  return normalized;
}

function idempotencyKey(value) {
  const key = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw studioError("A stable 8-128 character idempotency key is required.", 400, "GOODSPEECH_STUDIO_IDEMPOTENCY_REQUIRED");
  }
  return key;
}

function safeFilename(value) {
  return String(value || "goodspeech-production")
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "goodspeech-production";
}

function validateProject(payload = {}) {
  const rawClips = Array.isArray(payload.clips) ? payload.clips : [];
  if (!rawClips.length || rawClips.length > MAX_CLIPS) {
    throw studioError(`Studio jobs require between 1 and ${MAX_CLIPS} clips.`);
  }
  const clips = rawClips.map((clip, index) => {
    const validation = speechRuntime.validatePayload({
      text: clip?.text,
      voice: { apiVoice: clip?.voice || clip?.apiVoice, category: "Standard" },
      language: clip?.language || "en-us",
      style: clip?.style,
      tone: clip?.tone,
      intensity: clip?.intensity,
      contextualExpressiveness: clip?.contextualExpressiveness,
    });
    if (validation.error) {
      throw studioError(`Clip ${index + 1}: ${validation.error}`, validation.status || 400, validation.code || "GOODSPEECH_STUDIO_CLIP_INVALID");
    }
    return {
      id: String(clip?.id || `clip-${index + 1}`).slice(0, 80),
      speaker: String(clip?.speaker || `Speaker ${index + 1}`).trim().slice(0, 60) || `Speaker ${index + 1}`,
      ...validation.value,
    };
  });
  const totalCharacters = clips.reduce((sum, clip) => sum + clip.text.length, 0);
  if (totalCharacters > MAX_PROJECT_CHARACTERS) {
    throw studioError(`Studio jobs are limited to ${MAX_PROJECT_CHARACTERS.toLocaleString()} characters.`, 413, "GOODSPEECH_STUDIO_PROJECT_TOO_LARGE");
  }
  return {
    projectName: String(payload.projectName || "Untitled production").trim().slice(0, 100) || "Untitled production",
    clips,
    totalCharacters,
  };
}

function requestHash(project) {
  return crypto.createHash("sha256").update(JSON.stringify(project)).digest("hex");
}

function publicJob(row, includeClips = false) {
  const result = {
    id: row.id,
    projectName: row.project_name,
    status: row.status,
    progress: Number(row.progress || 0),
    currentClip: Number(row.current_clip || 0),
    totalClips: Number(row.total_clips || 0),
    totalCharacters: Number(row.total_characters || 0),
    attempts: Number(row.attempts || 0),
    cancellationRequested: row.cancellation_requested === true,
    outputAssetId: row.output_asset_id || null,
    outputSizeBytes: row.output_size_bytes === null ? null : Number(row.output_size_bytes),
    outputDurationSeconds: row.output_duration_seconds === null ? null : Number(row.output_duration_seconds),
    downloadUrl: row.output_asset_id ? `/api/goodspeech/v1/library/assets/${row.output_asset_id}/content` : null,
    error: row.error_message ? { code: row.error_code || "GOODSPEECH_STUDIO_FAILED", message: row.error_message } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
  };
  if (includeClips) result.clips = Array.isArray(row.clips_json) ? row.clips_json : [];
  return result;
}

async function retentionAllowed(organizationId, userId) {
  const result = await database.query(
    `SELECT zero_retention, generation_retention_days FROM goodspeech_privacy_settings
     WHERE organization_id=$1 AND owner_user_id=$2::uuid LIMIT 1`,
    [organizationId, userId],
  );
  const row = result.rows[0];
  return !row || (row.zero_retention !== true && Number(row.generation_retention_days) > 0);
}

async function createJob({ payload, idempotency: rawIdempotency, context, userId }) {
  const current = scope(context);
  if (!await retentionAllowed(current.organizationId, userId)) {
    throw studioError("Durable Studio rendering requires retained output. Use the private in-browser renderer while zero retention is active.", 409, "GOODSPEECH_STUDIO_ZERO_RETENTION");
  }
  const project = validateProject(payload);
  const key = idempotencyKey(rawIdempotency || payload.idempotencyKey);
  const hash = requestHash(project);
  const active = await database.query(
    `SELECT COUNT(*)::int AS count FROM goodspeech_studio_jobs
     WHERE organization_id=$1 AND owner_user_id=$2::uuid AND status IN ('queued','retrying','processing')`,
    [current.organizationId, userId],
  );
  if (Number(active.rows[0]?.count || 0) >= 3) {
    throw studioError("Finish or cancel an active Studio render before starting another.", 409, "GOODSPEECH_STUDIO_CONCURRENCY_LIMIT");
  }
  const inserted = await database.query(
    `INSERT INTO goodspeech_studio_jobs (
       organization_id, project_id, environment_id, owner_user_id, idempotency_key,
       request_hash, project_name, clips_json, total_clips, total_characters
     ) VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8::jsonb,$9,$10)
     ON CONFLICT (organization_id, owner_user_id, idempotency_key) DO NOTHING RETURNING *`,
    [current.organizationId, current.projectId, current.environmentId, userId, key, hash,
      project.projectName, JSON.stringify(project.clips), project.clips.length, project.totalCharacters],
  );
  if (inserted.rows[0]) return publicJob(inserted.rows[0], true);
  const existing = await database.query(
    `SELECT * FROM goodspeech_studio_jobs WHERE organization_id=$1 AND owner_user_id=$2::uuid AND idempotency_key=$3 LIMIT 1`,
    [current.organizationId, userId, key],
  );
  if (!existing.rows[0] || existing.rows[0].request_hash !== hash) {
    throw studioError("That idempotency key was already used for different Studio content.", 409, "GOODSPEECH_STUDIO_IDEMPOTENCY_CONFLICT");
  }
  return publicJob(existing.rows[0], true);
}

async function listJobs({ context, userId, limit = 20 }) {
  const current = scope(context);
  const bounded = Math.max(1, Math.min(50, Number(limit) || 20));
  const result = await database.query(
    `SELECT * FROM goodspeech_studio_jobs
     WHERE organization_id=$1 AND owner_user_id=$2::uuid
     ORDER BY created_at DESC LIMIT $3`,
    [current.organizationId, userId, bounded],
  );
  return { jobs: result.rows.map((row) => publicJob(row, false)) };
}

async function getJob({ jobId, context, userId }) {
  const current = scope(context);
  const result = await database.query(
    `SELECT * FROM goodspeech_studio_jobs WHERE id=$1::uuid AND organization_id=$2 AND owner_user_id=$3::uuid LIMIT 1`,
    [uuid(jobId), current.organizationId, userId],
  );
  if (!result.rows[0]) throw studioError("Studio render not found.", 404, "GOODSPEECH_STUDIO_NOT_FOUND");
  return publicJob(result.rows[0], true);
}

async function cleanupParts(jobId, ownerUserId, reason = "GoodSpeech Studio render cleanup") {
  const result = await database.query(`SELECT storage_file_id FROM goodspeech_studio_job_parts WHERE job_id=$1::uuid`, [jobId]);
  for (const row of result.rows) {
    await storage.softDeleteObject({ fileId: row.storage_file_id, actorId: ownerUserId, createdBy: ownerUserId, reason }).catch((error) => {
      console.error("[GoodSpeech Studio] part cleanup failed:", error.message);
    });
  }
  await database.query(`DELETE FROM goodspeech_studio_job_parts WHERE job_id=$1::uuid`, [jobId]);
  return result.rowCount;
}

async function cancelJob({ jobId, context, userId }) {
  const current = scope(context);
  const result = await database.query(
    `UPDATE goodspeech_studio_jobs SET
       cancellation_requested=TRUE,
       status=CASE WHEN status IN ('queued','retrying') THEN 'cancelled' ELSE status END,
       completed_at=CASE WHEN status IN ('queued','retrying') THEN NOW() ELSE completed_at END,
       locked_by=CASE WHEN status IN ('queued','retrying') THEN NULL ELSE locked_by END,
       locked_until=CASE WHEN status IN ('queued','retrying') THEN NULL ELSE locked_until END,
       updated_at=NOW()
     WHERE id=$1::uuid AND organization_id=$2 AND owner_user_id=$3::uuid
       AND status IN ('queued','retrying','processing') RETURNING *`,
    [uuid(jobId), current.organizationId, userId],
  );
  if (!result.rows[0]) throw studioError("Only an active Studio render can be cancelled.", 409, "GOODSPEECH_STUDIO_NOT_ACTIVE");
  if (result.rows[0].status === "cancelled") await cleanupParts(result.rows[0].id, userId, "GoodSpeech Studio render cancelled");
  return publicJob(result.rows[0]);
}

async function retryJob({ jobId, context, userId }) {
  const current = scope(context);
  if (!await retentionAllowed(current.organizationId, userId)) {
    throw studioError("Durable Studio rendering is unavailable while zero retention is active.", 409, "GOODSPEECH_STUDIO_ZERO_RETENTION");
  }
  const result = await database.query(
    `UPDATE goodspeech_studio_jobs SET status='queued', attempts=0, cancellation_requested=FALSE,
       error_code=NULL, error_message=NULL, available_at=NOW(), completed_at=NULL, updated_at=NOW()
     WHERE id=$1::uuid AND organization_id=$2 AND owner_user_id=$3::uuid AND status='failed' RETURNING *`,
    [uuid(jobId), current.organizationId, userId],
  );
  if (!result.rows[0]) throw studioError("Only a failed Studio render can be retried.", 409, "GOODSPEECH_STUDIO_NOT_FAILED");
  return publicJob(result.rows[0]);
}

function wavDescriptor(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw studioError("The speech engine returned an invalid WAV part.", 502, "GOODSPEECH_STUDIO_AUDIO_INVALID");
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break;
    if (id === "fmt " && size >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    }
    if (id === "data") data = buffer.subarray(start, end);
    offset = end + (size % 2);
  }
  if (!format || !data || format.audioFormat !== 1 || format.bitsPerSample !== 16 || ![1, 2].includes(format.channels)) {
    throw studioError("Studio rendering requires 16-bit PCM WAV parts.", 502, "GOODSPEECH_STUDIO_AUDIO_FORMAT_UNSUPPORTED");
  }
  return { ...format, data };
}

function combineWavBuffers(buffers, pauseMilliseconds = 300) {
  if (!Array.isArray(buffers) || !buffers.length) throw studioError("Studio render has no audio parts.");
  const parts = buffers.map(wavDescriptor);
  const first = parts[0];
  if (parts.some((part) => part.channels !== first.channels || part.sampleRate !== first.sampleRate || part.bitsPerSample !== first.bitsPerSample)) {
    throw studioError("Studio audio parts use incompatible PCM formats.", 502, "GOODSPEECH_STUDIO_AUDIO_MISMATCH");
  }
  const blockAlign = first.channels * (first.bitsPerSample / 8);
  const pauseBytes = Math.round((first.sampleRate * pauseMilliseconds) / 1000) * blockAlign;
  const dataBytes = parts.reduce((sum, part) => sum + part.data.length, 0) + pauseBytes * Math.max(0, parts.length - 1);
  if (dataBytes + 44 > MAX_MASTER_BYTES) throw studioError("The rendered master is larger than the GoodSpeech asset limit.", 413, "GOODSPEECH_STUDIO_MASTER_TOO_LARGE");
  const output = Buffer.alloc(44 + dataBytes);
  output.write("RIFF", 0); output.writeUInt32LE(36 + dataBytes, 4); output.write("WAVE", 8);
  output.write("fmt ", 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20);
  output.writeUInt16LE(first.channels, 22); output.writeUInt32LE(first.sampleRate, 24);
  output.writeUInt32LE(first.sampleRate * blockAlign, 28); output.writeUInt16LE(blockAlign, 32);
  output.writeUInt16LE(first.bitsPerSample, 34); output.write("data", 36); output.writeUInt32LE(dataBytes, 40);
  let cursor = 44;
  parts.forEach((part, index) => {
    part.data.copy(output, cursor); cursor += part.data.length;
    if (index < parts.length - 1) cursor += pauseBytes;
  });
  return { buffer: output, durationSeconds: dataBytes / (first.sampleRate * blockAlign) };
}

async function readPart(row) {
  const file = await storage.getFileById(row.storage_file_id);
  const descriptor = await storage.resolveDownload(file, 300);
  let buffer;
  if (descriptor.type === "local") buffer = await fsp.readFile(descriptor.path);
  else {
    const response = await fetch(descriptor.url, { redirect: "error" });
    if (!response.ok) throw studioError("A Studio render part could not be loaded.", 502, "GOODSPEECH_STUDIO_PART_UNAVAILABLE");
    buffer = Buffer.from(await response.arrayBuffer());
  }
  if (!buffer.length || buffer.length > MAX_PART_BYTES) throw studioError("A Studio render part is invalid.", 502, "GOODSPEECH_STUDIO_PART_INVALID");
  return buffer;
}

async function recordPart({ job, clipIndex, audio, reservation }) {
  const descriptor = wavDescriptor(audio);
  const object = await storage.putObject({
    bucketId: library.BUCKET_ID,
    objectKey: `${job.organization_id}/${job.owner_user_id}/studio/${job.id}/clip-${clipIndex + 1}.wav`,
    originalFilename: `studio-${job.id}-clip-${clipIndex + 1}.wav`,
    mimeType: "audio/wav",
    buffer: audio,
    cacheControl: "private, no-store",
    contentDisposition: "attachment",
    displayName: `Studio render part ${clipIndex + 1}`,
    metadata: { application: "goodspeech", kind: "studio-render-part", jobId: job.id, clipIndex },
    createdBy: job.owner_user_id,
    organizationId: job.organization_id,
    projectId: job.project_id,
    environmentId: job.environment_id,
    actorType: "user",
    actorId: job.owner_user_id,
  });
  try {
    const result = await database.query(
      `INSERT INTO goodspeech_studio_job_parts
         (job_id,clip_index,storage_file_id,size_bytes,duration_seconds,reservation_json)
       VALUES ($1::uuid,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [job.id, clipIndex, object.id, audio.length,
        descriptor.data.length / (descriptor.sampleRate * descriptor.channels * (descriptor.bitsPerSample / 8)),
        JSON.stringify(reservation)],
    );
    return result.rows[0];
  } catch (error) {
    await storage.softDeleteObject({ fileId: object.id, actorId: job.owner_user_id, createdBy: job.owner_user_id, reason: "Studio part metadata failed" }).catch(() => {});
    throw error;
  }
}

async function finalizePartUsage(job, part) {
  if (part.usage_recorded === true) return part;
  const snapshot = await usage.finishUsage({
    userId: job.owner_user_id,
    reservation: part.reservation_json,
    audioBytes: Number(part.size_bytes),
    latencyMs: Number(part.reservation_json?.latencyMs || 0),
    firstByteMs: Number(part.reservation_json?.firstByteMs || part.reservation_json?.latencyMs || 0),
    success: true,
    request: { originalUrl: "/api/goodspeech/v1/studio/jobs" },
  });
  if (!snapshot) throw studioError("Studio usage metering could not be finalized.", 503, "GOODSPEECH_STUDIO_METERING_UNAVAILABLE");
  const updated = await database.query(
    `UPDATE goodspeech_studio_job_parts SET usage_recorded=TRUE WHERE id=$1::uuid RETURNING *`,
    [part.id],
  );
  return updated.rows[0];
}

async function synthesizePart(job, clip, clipIndex) {
  const provider = speechRuntime.configuredProvider();
  if (!provider) throw studioError("The GoodSpeech engine is not configured.", 503, "GOODSPEECH_NOT_CONFIGURED");
  const reservation = await usage.reserveUsage({
    userId: job.owner_user_id,
    context: { organizationId: job.organization_id, projectId: job.project_id, environmentId: job.environment_id },
    characters: clip.text.length,
  });
  const request = speechRuntime.kokoroRequest(clip);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  const started = Date.now();
  let partRecorded = false;
  try {
    const response = await fetch(provider.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { Accept: "audio/wav", Authorization: `Bearer ${provider.token}`, "Content-Type": "application/json", "X-GoodBase-Service": "GoodSpeech-Studio" },
      body: JSON.stringify(request.body),
    });
    if (!response.ok) {
      await response.arrayBuffer().catch(() => null);
      throw studioError("The speech engine rejected a Studio clip.", response.status >= 500 ? 502 : response.status, "GOODSPEECH_STUDIO_PROVIDER_ERROR");
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("audio/") && contentType !== "application/octet-stream") throw studioError("The speech engine returned invalid Studio audio.", 502, "GOODSPEECH_STUDIO_AUDIO_INVALID");
    const audio = await speechRuntime.readAudioBytes(response);
    const state = await database.query(
      `SELECT status,cancellation_requested FROM goodspeech_studio_jobs WHERE id=$1::uuid`,
      [job.id],
    );
    if (state.rows[0]?.status !== "processing" || state.rows[0]?.cancellation_requested || !await retentionAllowed(job.organization_id, job.owner_user_id)) {
      throw studioError("The Studio render was cancelled before this clip was retained.", 409, "GOODSPEECH_STUDIO_CANCELLED");
    }
    const latencyMs = Date.now() - started;
    const storedReservation = { ...reservation, latencyMs, firstByteMs: latencyMs };
    const part = await recordPart({ job, clipIndex, audio, reservation: storedReservation });
    partRecorded = true;
    await finalizePartUsage(job, part);
    return audio;
  } catch (error) {
    if (!partRecorded) {
      await usage.finishUsage({
        userId: job.owner_user_id,
        reservation,
        audioBytes: 0,
        latencyMs: Date.now() - started,
        success: false,
        request: { originalUrl: "/api/goodspeech/v1/studio/jobs" },
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function recoverExpiredJobs() {
  await database.query(
    `UPDATE goodspeech_studio_jobs SET status='retrying', locked_by=NULL, locked_until=NULL,
       available_at=NOW(), error_code='GOODSPEECH_STUDIO_WORKER_RECOVERED',
       error_message='The render resumed after its worker lease expired.', updated_at=NOW()
     WHERE status='processing' AND locked_until<NOW()`,
  );
}

async function claimJob(workerId) {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH selected AS (
         SELECT id FROM goodspeech_studio_jobs
         WHERE status IN ('queued','retrying') AND available_at<=NOW() AND cancellation_requested=FALSE
         ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE goodspeech_studio_jobs job SET status='processing', locked_by=$1,
         locked_until=NOW()+INTERVAL '2 minutes', started_at=COALESCE(started_at,NOW()), updated_at=NOW()
       FROM selected WHERE job.id=selected.id RETURNING job.*`,
      [workerId],
    );
    await client.query("COMMIT");
    return result.rows[0] || null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function markFailure(job, error) {
  const current = await database.query(
    `SELECT status,cancellation_requested FROM goodspeech_studio_jobs WHERE id=$1::uuid`,
    [job.id],
  );
  if (current.rows[0]?.status === "cancelled" || current.rows[0]?.cancellation_requested || error.code === "GOODSPEECH_STUDIO_CANCELLED") {
    await cleanupParts(job.id, job.owner_user_id, "GoodSpeech Studio render cancelled");
    const cancelled = await database.query(
      `UPDATE goodspeech_studio_jobs SET status='cancelled', cancellation_requested=TRUE,
       locked_by=NULL, locked_until=NULL, completed_at=COALESCE(completed_at,NOW()), updated_at=NOW()
       WHERE id=$1::uuid RETURNING *`, [job.id],
    );
    return publicJob(cancelled.rows[0]);
  }
  const attempts = Number(job.attempts || 0) + 1;
  const terminal = attempts >= Number(job.max_attempts || 3);
  const delay = Math.min(300, 15 * (2 ** Math.max(0, attempts - 1)));
  const result = await database.query(
    `UPDATE goodspeech_studio_jobs SET status=$2, attempts=$3, locked_by=NULL, locked_until=NULL,
       available_at=NOW()+($4::text||' seconds')::interval, error_code=$5, error_message=$6,
       completed_at=CASE WHEN $2='failed' THEN NOW() ELSE NULL END, updated_at=NOW()
     WHERE id=$1::uuid RETURNING *`,
    [job.id, terminal ? "failed" : "retrying", attempts, delay,
      String(error.code || "GOODSPEECH_STUDIO_RENDER_FAILED").slice(0, 120),
      String(error.statusCode && error.statusCode < 500 ? error.message : "Studio rendering is temporarily unavailable.").slice(0, 500)],
  );
  if (terminal) {
    await webhooks.emitEvent({
      type: "studio.job.failed",
      context: { organizationId: job.organization_id, projectId: job.project_id, environmentId: job.environment_id },
      userId: job.owner_user_id,
      data: { jobId: job.id, projectName: job.project_name, attempts },
    }).catch(() => {});
  }
  return publicJob(result.rows[0]);
}

async function processClaimedJob(job) {
  if (!await retentionAllowed(job.organization_id, job.owner_user_id)) {
    await cleanupParts(job.id, job.owner_user_id, "GoodSpeech zero-retention policy");
    const cancelled = await database.query(
      `UPDATE goodspeech_studio_jobs SET status='cancelled', cancellation_requested=TRUE, clips_json='[]'::jsonb,
       locked_by=NULL, locked_until=NULL, error_code='GOODSPEECH_STUDIO_ZERO_RETENTION',
       error_message='The render was cancelled because zero retention became active.', completed_at=NOW(), updated_at=NOW()
       WHERE id=$1::uuid RETURNING *`, [job.id],
    );
    return publicJob(cancelled.rows[0]);
  }
  const cancellation = await database.query(`SELECT cancellation_requested FROM goodspeech_studio_jobs WHERE id=$1::uuid`, [job.id]);
  if (cancellation.rows[0]?.cancellation_requested) {
    await cleanupParts(job.id, job.owner_user_id, "GoodSpeech Studio render cancelled");
    const cancelled = await database.query(
      `UPDATE goodspeech_studio_jobs SET status='cancelled', locked_by=NULL, locked_until=NULL, completed_at=NOW(), updated_at=NOW() WHERE id=$1::uuid RETURNING *`,
      [job.id],
    );
    return publicJob(cancelled.rows[0]);
  }

  const partsResult = await database.query(`SELECT * FROM goodspeech_studio_job_parts WHERE job_id=$1::uuid ORDER BY clip_index`, [job.id]);
  const parts = new Map(partsResult.rows.map((part) => [Number(part.clip_index), part]));
  for (const [index, part] of parts) {
    if (!part.usage_recorded) parts.set(index, await finalizePartUsage(job, part));
  }
  const clips = Array.isArray(job.clips_json) ? job.clips_json : [];
  const pendingIndex = clips.findIndex((_clip, index) => !parts.has(index));
  if (pendingIndex >= 0) {
    await synthesizePart(job, clips[pendingIndex], pendingIndex);
    const completedParts = parts.size + 1;
    const progress = Math.min(95, Math.round((completedParts / clips.length) * 90));
    if (completedParts < clips.length) {
      const queued = await database.query(
        `UPDATE goodspeech_studio_jobs SET status='queued', current_clip=$2, progress=$3,
         locked_by=NULL, locked_until=NULL, available_at=NOW(), error_code=NULL, error_message=NULL, updated_at=NOW()
         WHERE id=$1::uuid AND status='processing' AND cancellation_requested=FALSE RETURNING *`,
        [job.id, completedParts, progress],
      );
      if (!queued.rows[0]) {
        await cleanupParts(job.id, job.owner_user_id, "GoodSpeech Studio render cancelled");
        return getJob({ jobId: job.id, context: { organizationId: job.organization_id }, userId: job.owner_user_id });
      }
      return publicJob(queued.rows[0]);
    }
  }

  const finalParts = await database.query(`SELECT * FROM goodspeech_studio_job_parts WHERE job_id=$1::uuid ORDER BY clip_index`, [job.id]);
  const buffers = [];
  for (const part of finalParts.rows) buffers.push(await readPart(part));
  const master = combineWavBuffers(buffers);
  const readyToStore = await database.query(
    `SELECT status,cancellation_requested FROM goodspeech_studio_jobs WHERE id=$1::uuid`, [job.id],
  );
  if (readyToStore.rows[0]?.status !== "processing" || readyToStore.rows[0]?.cancellation_requested || !await retentionAllowed(job.organization_id, job.owner_user_id)) {
    throw studioError("The Studio render was cancelled before its master was retained.", 409, "GOODSPEECH_STUDIO_CANCELLED");
  }
  const filename = `${safeFilename(job.project_name)}.wav`;
  const asset = await library.uploadAsset({
    file: { buffer: master.buffer, originalname: filename, mimetype: "audio/wav" },
    source: "Long-form Studio",
    metadata: JSON.stringify({ kind: "studio-master", studioJobId: job.id, clips: clips.length }),
    context: { organizationId: job.organization_id, projectId: job.project_id, environmentId: job.environment_id },
    userId: job.owner_user_id,
  });
  const completed = await database.query(
    `UPDATE goodspeech_studio_jobs SET status='completed', progress=100, current_clip=total_clips,
       output_asset_id=$2::uuid, output_size_bytes=$3, output_duration_seconds=$4,
       locked_by=NULL, locked_until=NULL, error_code=NULL, error_message=NULL, completed_at=NOW(), updated_at=NOW()
     WHERE id=$1::uuid AND status='processing' AND cancellation_requested=FALSE RETURNING *`,
    [job.id, asset.id, master.buffer.length, master.durationSeconds],
  );
  if (!completed.rows[0]) {
    await library.deleteAsset({ assetId: asset.id, context: { organizationId: job.organization_id }, userId: job.owner_user_id }).catch(() => {});
    throw studioError("The Studio render was cancelled before completion.", 409, "GOODSPEECH_STUDIO_CANCELLED");
  }
  await cleanupParts(job.id, job.owner_user_id, "GoodSpeech Studio master completed");
  await webhooks.emitEvent({
    type: "studio.job.completed",
    context: { organizationId: job.organization_id, projectId: job.project_id, environmentId: job.environment_id },
    userId: job.owner_user_id,
    data: { jobId: job.id, projectName: job.project_name, assetId: asset.id, clips: clips.length, characters: Number(job.total_characters), audioBytes: master.buffer.length },
  }).catch((error) => console.error("[GoodSpeech Studio] completion webhook failed:", error.message));
  return publicJob(completed.rows[0]);
}

async function processDueJobs(limit = 1, workerId = `goodspeech-studio-${process.pid}`) {
  await recoverExpiredJobs();
  const results = [];
  const bounded = Math.max(1, Math.min(2, Number(limit) || 1));
  for (let index = 0; index < bounded; index += 1) {
    const job = await claimJob(workerId);
    if (!job) break;
    try { results.push(await processClaimedJob(job)); }
    catch (error) {
      console.error("[GoodSpeech Studio] worker job failed:", { jobId: job.id, code: error.code || null, message: error.message });
      results.push(await markFailure(job, error));
    }
  }
  return results;
}

module.exports = {
  MAX_CLIPS,
  MAX_PROJECT_CHARACTERS,
  idempotencyKey,
  validateProject,
  publicJob,
  createJob,
  listJobs,
  getJob,
  cancelJob,
  retryJob,
  cleanupParts,
  combineWavBuffers,
  processDueJobs,
};
