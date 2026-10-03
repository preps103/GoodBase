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

module.exports = router;
