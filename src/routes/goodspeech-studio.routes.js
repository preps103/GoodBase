"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { logAudit } = require("../services/audit.service");
const studio = require("../services/goodspeech-studio.service");
const { requireGoodSpeechAccess } = require("./goodspeech-collaboration.routes");

const router = express.Router();
const createLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });

function respond(res, label, operation, status = 200) {
  return Promise.resolve(operation).then((data) => res.status(status).json({ success: true, data })).catch((error) => {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error(`[GoodSpeech Studio] ${label} failed:`, error.message);
    return res.status(statusCode).json({
      success: false,
      code: error.code || "GOODSPEECH_STUDIO_FAILED",
      message: error.statusCode ? error.message : "GoodSpeech could not complete the Studio request.",
    });
  });
}

router.use(authRequired, tenantContext, requireGoodSpeechAccess);

router.get("/jobs", (req, res) => respond(res, "jobs.list", studio.listJobs({
  context: req.tenantContext,
  userId: req.user.id,
  limit: req.query.limit,
})));

router.post("/jobs", createLimiter, async (req, res) => {
  try {
    const job = await studio.createJob({
      payload: req.body,
      idempotency: req.get("Idempotency-Key"),
      context: req.tenantContext,
      userId: req.user.id,
    });
    logAudit({
      userId: req.user.id,
      action: "goodspeech.studio.job.create",
      entityType: "goodspeech_studio_job",
      entityId: job.id,
      ipAddress: req.ip,
      metadata: { clips: job.totalClips, characters: job.totalCharacters },
    }).catch(() => {});
    return res.status(202).json({ success: true, data: job });
  } catch (error) { return respond(res, "jobs.create", Promise.reject(error)); }
});

router.get("/jobs/:jobId", (req, res) => respond(res, "jobs.get", studio.getJob({
  jobId: req.params.jobId,
  context: req.tenantContext,
  userId: req.user.id,
})));

router.post("/jobs/:jobId/cancel", writeLimiter, async (req, res) => {
  try {
    const job = await studio.cancelJob({ jobId: req.params.jobId, context: req.tenantContext, userId: req.user.id });
    logAudit({ userId: req.user.id, action: "goodspeech.studio.job.cancel", entityType: "goodspeech_studio_job", entityId: job.id, ipAddress: req.ip }).catch(() => {});
    return res.json({ success: true, data: job });
  } catch (error) { return respond(res, "jobs.cancel", Promise.reject(error)); }
});

router.post("/jobs/:jobId/retry", writeLimiter, async (req, res) => {
  try {
    const job = await studio.retryJob({ jobId: req.params.jobId, context: req.tenantContext, userId: req.user.id });
    logAudit({ userId: req.user.id, action: "goodspeech.studio.job.retry", entityType: "goodspeech_studio_job", entityId: job.id, ipAddress: req.ip }).catch(() => {});
    return res.json({ success: true, data: job });
  } catch (error) { return respond(res, "jobs.retry", Promise.reject(error)); }
});

module.exports = router;
