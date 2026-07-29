"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const service = require("../services/goodspeech-collaboration.service");

const router = express.Router();
const messageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 240,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

function requireGoodSpeechAccess(req, res, next) {
  const role = String(req.user?.platformRole || req.user?.role || "").toLowerCase();
  const entitled = (req.apps || []).some((app) => {
    const id = String(app.id || app.appId || app.slug || "").toLowerCase();
    const domain = String(app.domain || "").toLowerCase();
    const membership = String(app.membershipStatus || app.membership_status || "active").toLowerCase();
    const status = String(app.appStatus || app.status || "active").toLowerCase();
    return (
      ["goodspeech", "good-speech", "speech"].includes(id) ||
      domain === "speech.goodos.app"
    ) && membership === "active" && status === "active";
  });
  if (!entitled && !["owner", "admin"].includes(role)) {
    return res.status(403).json({
      success: false,
      code: "GOODSPEECH_ACCESS_REQUIRED",
      message: "Active GoodSpeech access is required.",
    });
  }
  return next();
}

function handle(res, label, operation, status = 200) {
  return Promise.resolve(operation)
    .then((data) => res.status(status).json({ success: true, data }))
    .catch((requestError) => {
      console.error(`[GoodSpeech collaboration] ${label} failed:`, requestError.message);
      const statusCode = requestError.statusCode || 500;
      return res.status(statusCode).json({
        success: false,
        code: requestError.code || "GOODSPEECH_COLLABORATION_FAILED",
        message: Number.isInteger(requestError.statusCode)
          ? requestError.message
          : "GoodSpeech collaboration could not complete the request.",
      });
    });
}

router.use(authRequired, tenantContext, requireGoodSpeechAccess);

router.get("/bootstrap", (req, res) => handle(res, "bootstrap", service.bootstrap({
  context: req.tenantContext,
  userId: req.user.id,
})));
router.get("/teams", (req, res) => handle(res, "teams", service.listTeams({
  context: req.tenantContext,
  userId: req.user.id,
})));
router.get("/members", (req, res) => handle(res, "members", service.listMembers({
  context: req.tenantContext,
  userId: req.user.id,
  teamId: req.query.teamId || null,
})));
router.get("/projects", (req, res) => handle(res, "projects", service.listProjects({
  context: req.tenantContext,
  userId: req.user.id,
  teamId: req.query.teamId || null,
})));
router.post("/projects", (req, res) => handle(res, "project.create", service.createProject({
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
}), 201));
router.get("/projects/:projectId", (req, res) => handle(res, "project.get", service.getProject({
  projectId: req.params.projectId,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.patch("/projects/:projectId", (req, res) => handle(res, "project.update", service.updateProject({
  projectId: req.params.projectId,
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.post("/projects/:projectId/tasks", (req, res) => handle(res, "task.create", service.createTask({
  projectId: req.params.projectId,
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
}), 201));
router.patch("/projects/:projectId/tasks/:taskId", (req, res) => handle(res, "task.update", service.updateTask({
  projectId: req.params.projectId,
  taskId: req.params.taskId,
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.get("/channels", (req, res) => handle(res, "channels", service.listChannels({
  context: req.tenantContext,
  userId: req.user.id,
})));
router.post("/channels", (req, res) => handle(res, "channel.create", service.createChannel({
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
}), 201));
router.post("/channels/direct", (req, res) => handle(res, "channel.direct", service.openDirectChannel({
  participantUserId: req.body?.participantUserId,
  context: req.tenantContext,
  userId: req.user.id,
}), 201));
router.get("/channels/:channelId/messages", (req, res) => handle(res, "messages", service.listMessages({
  channelId: req.params.channelId,
  context: req.tenantContext,
  userId: req.user.id,
  limit: req.query.limit,
  before: req.query.before,
})));
router.post("/channels/:channelId/messages", messageLimiter, (req, res) => handle(res, "message.send", service.sendMessage({
  channelId: req.params.channelId,
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
  idempotencyKey: req.get("Idempotency-Key"),
}), 201));
router.patch("/channels/:channelId/messages/:messageId", (req, res) => handle(res, "message.edit", service.editMessage({
  channelId: req.params.channelId,
  messageId: req.params.messageId,
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.delete("/channels/:channelId/messages/:messageId", (req, res) => handle(res, "message.delete", service.deleteMessage({
  channelId: req.params.channelId,
  messageId: req.params.messageId,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.post("/channels/:channelId/read", (req, res) => handle(res, "channel.read", service.markRead({
  channelId: req.params.channelId,
  context: req.tenantContext,
  userId: req.user.id,
})));

module.exports = router;
module.exports.requireGoodSpeechAccess = requireGoodSpeechAccess;
