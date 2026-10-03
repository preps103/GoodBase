"use strict";

const express = require("express");
const multer = require("multer");
const { rateLimit } = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { logAudit } = require("../services/audit.service");
const usageService = require("../services/goodspeech-usage.service");
const voiceService = require("../services/goodspeech-voice.service");
const { requireGoodSpeechAccess } = require("./goodspeech-collaboration.routes");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fields: 20, fileSize: voiceService.MAX_REFERENCE_BYTES },
});
const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `goodspeech-voice-write:${req.user.id}`,
});
const generationLimiter = rateLimit({
  windowMs: 60 * 1_000,
  limit: 6,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `goodspeech-voice-generate:${req.user.id}`,
});

function sendError(res, error, label) {
  const status = error?.statusCode || (error?.code === "LIMIT_FILE_SIZE" ? 413 : 500);
  if (status >= 500) console.error(`[GoodSpeech voices] ${label} failed:`, error?.message);
  return res.status(status).json({
    success: false,
    code: error?.code || "GOODSPEECH_VOICE_FAILED",
    message: status >= 500 && !String(error?.code || "").startsWith("GOODSPEECH_VOICE_")
      ? "GoodSpeech could not complete the voice request."
      : error?.message || "GoodSpeech could not complete the voice request.",
  });
}

router.use(authRequired, tenantContext, requireGoodSpeechAccess);

router.get("/", async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    return res.json({
      success: true,
      data: {
        voices: await voiceService.listVoices({ context: req.tenantContext, userId: req.user.id }),
        consentStatement: voiceService.CONSENT_STATEMENT,
        consentVersion: voiceService.CONSENT_VERSION,
      },
    });
  } catch (error) {
    return sendError(res, error, "list");
  }
});

router.get("/status", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const health = await voiceService.checkHealth();
  return res.status(health.ready ? 200 : 503).json({ success: health.ready, ...health });
});

router.post("/clone", writeLimiter, upload.single("reference"), async (req, res) => {
  try {
    const voice = await voiceService.createClonedVoice({
      file: req.file,
      payload: req.body,
      context: req.tenantContext,
      userId: req.user.id,
    });
    logAudit({
      userId: req.user.id,
      action: "goodspeech.voice.enroll",
      entityType: "goodspeech_voice_profile",
      entityId: voice.id,
      ipAddress: req.ip,
      metadata: { model: voice.model, consentVersion: voice.consentVersion, sampleDurationSeconds: voice.sampleDurationSeconds },
    }).catch(() => {});
    return res.status(201).json({ success: true, data: voice });
  } catch (error) {
    return sendError(res, error, "clone");
  }
});

router.post("/design", writeLimiter, async (req, res) => {
  try {
    const voice = await voiceService.createDesignedVoice({ payload: req.body, context: req.tenantContext, userId: req.user.id });
    logAudit({
      userId: req.user.id,
      action: "goodspeech.voice.design",
      entityType: "goodspeech_voice_profile",
      entityId: voice.id,
      ipAddress: req.ip,
      metadata: { model: voice.model, language: voice.language },
    }).catch(() => {});
    return res.status(201).json({ success: true, data: voice });
  } catch (error) {
    return sendError(res, error, "design");
  }
});

router.post("/:voiceId/speech", generationLimiter, async (req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  let reservation;
  const started = Date.now();
  try {
    const script = String(req.body?.text || "").trim();
    reservation = await usageService.reserveUsage({
      userId: req.user.id,
      context: req.tenantContext,
      characters: script.length,
    });
    const result = await voiceService.generateSpeech({
      voiceId: req.params.voiceId,
      script,
      context: req.tenantContext,
      userId: req.user.id,
      signal: controller.signal,
    });
    await usageService.finishUsage({
      userId: req.user.id,
      reservation,
      audioBytes: result.bytes.length,
      latencyMs: Date.now() - started,
      success: true,
      request: req,
    });
    logAudit({
      userId: req.user.id,
      action: "goodspeech.voice.generate",
      entityType: "goodspeech_voice_profile",
      entityId: result.profile.id,
      ipAddress: req.ip,
      metadata: { model: result.profile.model, voiceKind: result.profile.kind, characters: script.length, durationMs: Date.now() - started },
    }).catch(() => {});
    res.set("Cache-Control", "private, no-store");
    res.set("Content-Type", result.contentType);
    res.set("Content-Length", String(result.bytes.length));
    res.set("X-GoodSpeech-Voice-Id", result.profile.id);
    res.set("X-GoodSpeech-Watermark", result.profile.watermark);
    return res.send(result.bytes);
  } catch (error) {
    if (reservation) {
      await usageService.finishUsage({
        userId: req.user.id,
        reservation,
        audioBytes: 0,
        latencyMs: Date.now() - started,
        success: false,
        request: req,
      }).catch(() => {});
    }
    if (error?.name === "AbortError") {
      error.statusCode = 504;
      error.code = "GOODSPEECH_VOICE_TIMEOUT";
      error.message = "Voice generation timed out. Try a shorter script.";
    }
    return sendError(res, error, "generate");
  } finally {
    clearTimeout(timeout);
  }
});

router.delete("/:voiceId", writeLimiter, async (req, res) => {
  try {
    const voice = await voiceService.revokeVoice({ voiceId: req.params.voiceId, context: req.tenantContext, userId: req.user.id });
    logAudit({
      userId: req.user.id,
      action: "goodspeech.voice.revoke",
      entityType: "goodspeech_voice_profile",
      entityId: voice.id,
      ipAddress: req.ip,
      metadata: { referenceDeleted: voice.kind === "cloned" },
    }).catch(() => {});
    return res.json({ success: true, data: voice });
  } catch (error) {
    return sendError(res, error, "revoke");
  }
});

module.exports = router;
