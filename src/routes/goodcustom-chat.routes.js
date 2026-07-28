"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const chat = require("../services/goodcustom-chat.service");

const router = express.Router();
const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 900,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    code: "GOODCUSTOM_CHAT_RATE_LIMITED",
    message: "GoodCustom chat is receiving too many requests. Please wait and try again.",
  },
});
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 240,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    code: "GOODCUSTOM_CHAT_WRITE_RATE_LIMITED",
    message: "GoodCustom chat is receiving too many updates. Please wait and try again.",
  },
});

const APP_IDS = new Set([
  "goodcustom",
  "good-custom",
  "goodloecustom",
  "custom.goodos.app",
]);

function normalizedIdentifiers(app) {
  return [app?.id, app?.appId, app?.slug, app?.name, app?.domain]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase().replace(/\s+/g, ""));
}

function requireGoodCustomAccess(req, res, next) {
  const role = String(req.user?.platformRole || req.user?.role || "").toLowerCase();
  const entitled = (req.apps || []).some((app) => {
    const membership = String(app.membershipStatus || app.membership_status || "active").toLowerCase();
    const status = String(app.appStatus || app.status || "active").toLowerCase();
    return (
      membership === "active"
      && status === "active"
      && normalizedIdentifiers(app).some((identifier) => APP_IDS.has(identifier))
    );
  });
  if (!entitled && role !== "owner" && role !== "admin") {
    return res.status(403).json({
      success: false,
      code: "GOODCUSTOM_ACCESS_REQUIRED",
      message: "Your GoodOS account does not have access to GoodCustom.",
    });
  }
  return next();
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

function requireUuidParam(name) {
  return (req, res, next) => {
    if (!validUuid(req.params[name])) {
      return res.status(400).json({
        success: false,
        code: "GOODCUSTOM_CHAT_INVALID_ID",
        message: "GoodCustom chat received an invalid identifier.",
      });
    }
    return next();
  };
}

function handle(res, label, operation, statusCode = 200) {
  return Promise.resolve(operation)
    .then((data) => res.status(statusCode).json({ success: true, data }))
    .catch((error) => {
      console.error(`GoodCustom chat ${label} failed:`, error.code || error.message);
      const databaseInputError = error.code === "22P02";
      return res.status(databaseInputError ? 400 : error.statusCode || 500).json({
        success: false,
        code: databaseInputError
          ? "GOODCUSTOM_CHAT_INVALID_INPUT"
          : error.code || "GOODCUSTOM_CHAT_REQUEST_FAILED",
        message: databaseInputError
          ? "GoodCustom chat received invalid input."
          : error.statusCode
            ? error.message
            : "GoodCustom chat could not complete the request.",
      });
    });
}

router.get(
  "/health",
  readLimiter,
  (req, res) => handle(res, "health", chat.health()),
);

router.use(authRequired, requireGoodCustomAccess);

router.get(
  "/bootstrap",
  readLimiter,
  (req, res) => handle(res, "bootstrap", chat.bootstrap(req.user)),
);

router.get(
  "/unread",
  readLimiter,
  (req, res) => handle(res, "unread", chat.unread(req.user)),
);

router.post(
  "/rooms",
  writeLimiter,
  (req, res) => {
    const kind = String(req.body?.kind || "direct").toLowerCase();
    if (kind === "channel") {
      return handle(res, "room.channel.create", chat.createChannel({
        user: req.user,
        name: req.body?.name,
        description: req.body?.description,
        memberUserIds: req.body?.memberUserIds,
      }), 201);
    }
    if (kind !== "direct") {
      return res.status(400).json({
        success: false,
        code: "GOODCUSTOM_CHAT_INVALID_ROOM_KIND",
        message: "Choose a direct message or team channel.",
      });
    }
    return handle(res, "room.direct.create", chat.createDirectRoom({
      user: req.user,
      targetUserId: req.body?.targetUserId,
    }), 201);
  },
);

router.get(
  "/rooms/:roomId/messages",
  readLimiter,
  requireUuidParam("roomId"),
  (req, res) => handle(res, "messages.list", chat.getMessages({
    user: req.user,
    roomId: req.params.roomId,
    before: req.query.before,
    after: req.query.after,
    limit: req.query.limit,
  })),
);

router.post(
  "/rooms/:roomId/messages",
  writeLimiter,
  requireUuidParam("roomId"),
  (req, res) => handle(res, "message.create", chat.sendMessage({
    user: req.user,
    roomId: req.params.roomId,
    body: req.body?.body,
    replyToMessageId: req.body?.replyToMessageId,
  }), 201),
);

router.post(
  "/rooms/:roomId/read",
  writeLimiter,
  requireUuidParam("roomId"),
  (req, res) => handle(res, "room.read", chat.markRead({
    user: req.user,
    roomId: req.params.roomId,
  })),
);

router.patch(
  "/messages/:messageId",
  writeLimiter,
  requireUuidParam("messageId"),
  (req, res) => handle(res, "message.edit", chat.editMessage({
    user: req.user,
    messageId: req.params.messageId,
    body: req.body?.body,
  })),
);

router.delete(
  "/messages/:messageId",
  writeLimiter,
  requireUuidParam("messageId"),
  (req, res) => handle(res, "message.delete", chat.deleteMessage({
    user: req.user,
    messageId: req.params.messageId,
  })),
);

router.post(
  "/staff",
  writeLimiter,
  (req, res) => handle(res, "staff.add", chat.addStaff({
    actor: req.user,
    email: req.body?.email,
    role: req.body?.role,
  }), 201),
);

router.patch(
  "/staff/:userId",
  writeLimiter,
  requireUuidParam("userId"),
  (req, res) => handle(res, "staff.update", chat.updateStaff({
    actor: req.user,
    userId: req.params.userId,
    role: req.body?.role,
    status: req.body?.status,
  })),
);

module.exports = router;
