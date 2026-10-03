"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { logAudit } = require("../services/audit.service");
const governance = require("../services/goodspeech-governance.service");
const { requireGoodSpeechAccess } = require("./goodspeech-collaboration.routes");

const router = express.Router();
const writeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });

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

module.exports = router;
