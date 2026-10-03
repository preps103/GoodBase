"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const multer = require("multer");
const goodspeechAccess = require("../middleware/goodspeechAccess");
const { logAudit } = require("../services/audit.service");
const service = require("../services/goodspeech-transcription.service");

const router = express.Router();
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `goodspeech-transcription-user:${req.user.id}`,
  message: { success: false, code: "GOODSPEECH_TRANSCRIPTION_RATE_LIMITED", message: "Too many transcription requests. Try again later." },
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: service.MAX_AUDIO_BYTES, files: 1, fields: 5 },
});
const liveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 240,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `goodspeech-live-transcription-user:${req.user.id}`,
  message: { success: false, code: "GOODSPEECH_LIVE_TRANSCRIPTION_RATE_LIMITED", message: "Live transcription has reached its hourly safety limit." },
});
const liveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 8 },
});

function liveChunkMetadata(body = {}) {
  const sessionId = String(body.sessionId || "").trim();
  const sequence = Number(body.sequence);
  const isFinal = String(body.final || "").toLowerCase() === "true";
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) {
    throw Object.assign(new Error("Live transcription requires a valid session identifier."), { statusCode: 400, code: "GOODSPEECH_LIVE_SESSION_INVALID" });
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 10_000) {
    throw Object.assign(new Error("Live transcription sequence is invalid."), { statusCode: 400, code: "GOODSPEECH_LIVE_SEQUENCE_INVALID" });
  }
  return { sessionId, sequence, isFinal };
}

router.get("/health", goodspeechAccess("read:goodspeech"), async (_req, res) => {
  res.set("Cache-Control", "private, no-store, max-age=0");
  const health = await service.checkHealth();
  return res.status(health.ready ? 200 : 503).json({ success: health.ready, data: health });
});

router.post("/", goodspeechAccess("write:goodspeech"), limiter, upload.single("file"), async (req, res) => {
  res.set("Cache-Control", "private, no-store, max-age=0");
  try {
    const result = await service.transcribe({
      file: req.file,
      language: req.body?.language,
      context: req.tenantContext,
      userId: req.user.id,
      request: req,
    });
    logAudit({
      userId: req.user.id,
      action: "goodspeech.transcribe",
      entityType: "goodspeech_transcription",
      ipAddress: req.ip,
      metadata: {
        model: result.model,
        modelRevision: result.modelRevision,
        language: result.language,
        durationSeconds: result.durationSeconds,
        latencyMs: result.latencyMs,
        retainedAudio: false,
      },
    }).catch(() => {});
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    const status = error.statusCode || (error.code === "LIMIT_FILE_SIZE" ? 413 : 500);
    if (status >= 500) console.error("[GoodSpeech transcription] request failed:", error.message);
    return res.status(status).json({
      success: false,
      code: error.code || "GOODSPEECH_TRANSCRIPTION_FAILED",
      message: Number.isInteger(error.statusCode) ? error.message : "GoodSpeech could not transcribe this file.",
    });
  }
});

router.post("/live", goodspeechAccess("write:goodspeech"), liveLimiter, liveUpload.single("file"), async (req, res) => {
  res.set("Cache-Control", "private, no-store, max-age=0");
  try {
    const live = liveChunkMetadata(req.body);
    const result = await service.transcribe({
      file: req.file,
      language: req.body?.language,
      context: req.tenantContext,
      userId: req.user.id,
      request: req,
    });
    const data = { ...result, ...live, partial: !live.isFinal };
    logAudit({
      userId: req.user.id,
      action: "goodspeech.transcribe.live",
      entityType: "goodspeech_live_transcription",
      entityId: live.sessionId,
      ipAddress: req.ip,
      metadata: {
        sequence: live.sequence,
        final: live.isFinal,
        model: result.model,
        language: result.language,
        durationSeconds: result.durationSeconds,
        latencyMs: result.latencyMs,
        retainedAudio: false,
      },
    }).catch(() => {});
    return res.status(201).json({ success: true, data });
  } catch (error) {
    const status = error.statusCode || (error.code === "LIMIT_FILE_SIZE" ? 413 : 500);
    if (status >= 500) console.error("[GoodSpeech live transcription] chunk failed:", error.message);
    return res.status(status).json({
      success: false,
      code: error.code || "GOODSPEECH_LIVE_TRANSCRIPTION_FAILED",
      message: Number.isInteger(error.statusCode) ? error.message : "GoodSpeech could not transcribe this live audio chunk.",
    });
  }
});

module.exports = router;
module.exports.liveChunkMetadata = liveChunkMetadata;
