"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { logAudit } = require("../services/audit.service");
const service = require("../services/goodspeech-webhook.service");
const { requireGoodSpeechAccess } = require("./goodspeech-collaboration.routes");

const router = express.Router();
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `goodspeech-webhooks:${req.user.id}`,
});

function handle(res, label, operation, status = 200) {
  return Promise.resolve(operation).then((data) => res.status(status).json({ success: true, data })).catch((error) => {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error(`[GoodSpeech webhooks] ${label} failed:`, error.message);
    return res.status(statusCode).json({
      success: false,
      code: error.code || "GOODSPEECH_WEBHOOK_FAILED",
      message: error.statusCode ? error.message : "GoodSpeech could not complete the webhook request.",
    });
  });
}

router.use(authRequired, tenantContext, requireGoodSpeechAccess);

router.get("/", (req, res) => handle(res, "list", service.listWebhooks({ context: req.tenantContext, userId: req.user.id })));

router.post("/", writeLimiter, async (req, res) => {
  try {
    const webhook = await service.createWebhook({ payload: req.body, context: req.tenantContext, userId: req.user.id });
    logAudit({
      userId: req.user.id,
      action: "goodspeech.webhook.create",
      entityType: "goodspeech_webhook",
      entityId: webhook.id,
      ipAddress: req.ip,
      metadata: { endpointUrl: webhook.endpointUrl, events: webhook.events },
    }).catch(() => {});
    return res.status(201).json({ success: true, data: webhook });
  } catch (error) {
    return handle(res, "create", Promise.reject(error));
  }
});

router.post("/:webhookId/test", writeLimiter, async (req, res) => {
  try {
    const current = await service.listWebhooks({ context: req.tenantContext, userId: req.user.id });
    if (!current.webhooks.some((hook) => hook.id === req.params.webhookId)) {
      throw Object.assign(new Error("Webhook not found."), { statusCode: 404, code: "GOODSPEECH_WEBHOOK_NOT_FOUND" });
    }
    const event = await service.emitEvent({
      type: "webhook.test",
      data: { webhookId: req.params.webhookId, message: "GoodSpeech webhook verification event" },
      context: req.tenantContext,
      userId: req.user.id,
      webhookId: req.params.webhookId,
    });
    return res.status(202).json({ success: true, data: event });
  } catch (error) {
    return handle(res, "test", Promise.reject(error));
  }
});

router.delete("/:webhookId", writeLimiter, async (req, res) => {
  try {
    const result = await service.deleteWebhook({ webhookId: req.params.webhookId, context: req.tenantContext, userId: req.user.id });
    logAudit({
      userId: req.user.id,
      action: "goodspeech.webhook.delete",
      entityType: "goodspeech_webhook",
      entityId: result.id,
      ipAddress: req.ip,
      metadata: {},
    }).catch(() => {});
    return res.json({ success: true, data: result });
  } catch (error) {
    return handle(res, "delete", Promise.reject(error));
  }
});

module.exports = router;
