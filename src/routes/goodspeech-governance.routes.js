"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { logAudit } = require("../services/audit.service");
const governance = require("../services/goodspeech-governance.service");
const quality = require("../services/goodspeech-quality.service");
const { requireGoodSpeechAccess } = require("./goodspeech-collaboration.routes");

const router = express.Router();
const writeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
const qualityLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `goodspeech-quality-user:${req.user.id}`,
  message: { success: false, code: "GOODSPEECH_QUALITY_RATE_LIMITED", message: "The private quality check can run five times per hour." },
});

function handle(res, label, operation, status = 200) {
  return Promise.resolve(operation).then((data) => res.status(status).json({ success: true, data })).catch((error) => {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error(`[GoodSpeech governance] ${label} failed:`, error.message);
    return res.status(statusCode).json({ success: false, code: error.code || "GOODSPEECH_GOVERNANCE_FAILED", message: error.statusCode ? error.message : "GoodSpeech could not complete the governance request." });
  });
}

router.use(authRequired, tenantContext, requireGoodSpeechAccess);

router.get("/privacy", (req, res) => handle(res, "privacy.get", governance.getPrivacySettings({ context: req.tenantContext, userId: req.user.id })));
router.patch("/privacy", writeLimiter, async (req, res) => {
  try {
    const result = await governance.updatePrivacySettings({ payload: req.body, context: req.tenantContext, userId: req.user.id });
    logAudit({ userId: req.user.id, action: "goodspeech.privacy.update", entityType: "goodspeech_privacy", entityId: req.user.id, ipAddress: req.ip, metadata: { zeroRetention: result.zeroRetention, generationRetentionDays: result.generationRetentionDays, agentRetentionDays: result.agentRetentionDays, residencyRegion: result.residency.region } }).catch(() => {});
    return res.json({ success: true, data: result });
  } catch (error) { return handle(res, "privacy.update", Promise.reject(error)); }
});
router.post("/privacy/purge", writeLimiter, async (req, res) => {
  try {
    const result = await governance.purgeUserContent({ context: req.tenantContext, userId: req.user.id });
    logAudit({ userId: req.user.id, action: "goodspeech.privacy.purge", entityType: "goodspeech_privacy", entityId: req.user.id, ipAddress: req.ip, metadata: result }).catch(() => {});
    return res.json({ success: true, data: result });
  } catch (error) { return handle(res, "privacy.purge", Promise.reject(error)); }
});
router.get("/quality", (req, res) => handle(res, "quality.get", governance.qualitySummary({ context: req.tenantContext, userId: req.user.id })));
router.post("/quality/benchmark", qualityLimiter, async (req, res) => {
  try {
    const result = await quality.run({ language: req.body?.language, context: req.tenantContext, userId: req.user.id, request: req });
    logAudit({ userId: req.user.id, action: "goodspeech.quality.benchmark", entityType: "goodspeech_quality_benchmark", entityId: result.id, ipAddress: req.ip, metadata: { language: result.language, status: result.status, metric: result.metric, errorRatePercent: result.errorRatePercent, qualityScore: result.qualityScore, audioRetained: false } }).catch(() => {});
    return res.status(201).json({ success: true, data: result });
  } catch (error) { return handle(res, "quality.benchmark", Promise.reject(error)); }
});

module.exports = router;
