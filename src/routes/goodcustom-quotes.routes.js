"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const quotes = require("../services/goodcustom-quotes.service");

const router = express.Router();
const APP_IDS = new Set([
  "goodcustom",
  "good-custom",
  "goodloecustom",
  "custom.goodos.app",
]);
const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    code: "GOODCUSTOM_QUOTE_RATE_LIMITED",
    message: "Too many quote requests. Please wait and try again.",
  },
});

function identifiers(app) {
  return [app?.id, app?.appId, app?.slug, app?.name, app?.domain]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase().replace(/\s+/g, ""));
}

function requireGoodCustomAccess(req, res, next) {
  const role = String(req.user?.platformRole || req.user?.role || "").toLowerCase();
  const entitled = (req.apps || []).some((app) => {
    const membership = String(app.membershipStatus || app.membership_status || "active").toLowerCase();
    const status = String(app.appStatus || app.status || "active").toLowerCase();
    return membership === "active"
      && status === "active"
      && identifiers(app).some((identifier) => APP_IDS.has(identifier));
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || ""));
}

function handle(res, label, operation, statusCode = 200) {
  return Promise.resolve(operation)
    .then((data) => res.status(statusCode).json({ success: true, data }))
    .catch((error) => {
      console.error(`GoodCustom quote ${label} failed:`, error.code || error.message);
      const invalidDatabaseInput = error.code === "22P02";
      return res.status(invalidDatabaseInput ? 400 : error.statusCode || 500).json({
        success: false,
        code: invalidDatabaseInput
          ? "GOODCUSTOM_QUOTE_INVALID_INPUT"
          : error.code || "GOODCUSTOM_QUOTE_REQUEST_FAILED",
        message: invalidDatabaseInput
          ? "GoodCustom received invalid quote data."
          : error.statusCode
            ? error.message
            : "The quote request could not be completed.",
      });
    });
}

router.get("/health", readLimiter, (_req, res) => handle(res, "health", quotes.health()));

router.use(authRequired, requireGoodCustomAccess);

router.post("/", writeLimiter, (req, res) => handle(
  res,
  "create",
  quotes.create({
    user: req.user,
    input: req.body || {},
    requestKey: req.get("Idempotency-Key") || req.body?.requestKey,
  }),
  201,
));

router.get("/", readLimiter, (req, res) => handle(
  res,
  "list",
  quotes.list({
    user: req.user,
    status: req.query?.status,
    limit: req.query?.limit,
  }),
));

router.delete("/:quoteId", writeLimiter, (req, res) => {
  if (!validUuid(req.params.quoteId)) {
    return res.status(400).json({
      success: false,
      code: "GOODCUSTOM_QUOTE_INVALID_ID",
      message: "GoodCustom received an invalid quote identifier.",
    });
  }
  return handle(res, "delete", quotes.remove({
    user: req.user,
    quoteId: req.params.quoteId,
  }));
});

module.exports = router;
