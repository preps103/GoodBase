"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const leads = require("../services/goodsure-leads.service");

const router = express.Router();
const APP_IDS = new Set([
  "goodsure",
  "good-sure",
  "sure.goodos.app",
  "insurance.goodos.app",
]);
const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const intakeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    code: "GOODSURE_LEAD_RATE_LIMITED",
    message: "Too many quote requests. Please try again later.",
  },
});
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

function identifiers(app) {
  return [app?.id, app?.appId, app?.slug, app?.name, app?.domain]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase().replace(/\s+/g, ""));
}

function requireGoodSureAdmin(req, res, next) {
  const platformRole = String(req.user?.platformRole || req.user?.role || "").toLowerCase();
  const membership = (req.apps || []).find((app) => {
    const membershipStatus = String(app.membershipStatus || app.membership_status || "active").toLowerCase();
    const appStatus = String(app.appStatus || app.status || "active").toLowerCase();
    return membershipStatus === "active"
      && appStatus === "active"
      && identifiers(app).some((identifier) => APP_IDS.has(identifier));
  });
  const membershipRole = String(
    membership?.role || membership?.membershipRole || membership?.membership_role || "",
  ).toLowerCase();
  if (!["owner", "admin"].includes(platformRole)
      && !["owner", "admin"].includes(membershipRole)) {
    return res.status(403).json({
      success: false,
      code: "GOODSURE_ADMIN_REQUIRED",
      message: "Your GoodOS account cannot administer GoodSure.",
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
      console.error(`GoodSure lead ${label} failed:`, error.code || error.message);
      const invalidDatabaseInput = error.code === "22P02";
      return res.status(invalidDatabaseInput ? 400 : error.statusCode || 500).json({
        success: false,
        code: invalidDatabaseInput
          ? "GOODSURE_LEAD_INVALID_INPUT"
          : error.code || "GOODSURE_LEAD_REQUEST_FAILED",
        message: invalidDatabaseInput
          ? "GoodSure received invalid lead data."
          : error.statusCode
            ? error.message
            : "The lead request could not be completed.",
      });
    });
}

router.get("/health", readLimiter, (_req, res) => handle(res, "health", leads.health()));

router.post("/", intakeLimiter, (req, res) => {
  if (String(req.body?.website || "").trim()) {
    return res.status(201).json({ success: true, data: { accepted: true } });
  }
  return handle(res, "create", leads.create(req.body || {}), 201);
});

router.use(authRequired, requireGoodSureAdmin);

router.get("/", readLimiter, (req, res) => handle(
  res,
  "list",
  leads.list({ status: req.query?.status, limit: req.query?.limit }),
));

router.patch("/:leadId", writeLimiter, (req, res) => {
  if (!validUuid(req.params.leadId)) {
    return res.status(400).json({
      success: false,
      code: "GOODSURE_LEAD_INVALID_ID",
      message: "GoodSure received an invalid lead identifier.",
    });
  }
  return handle(res, "update", leads.update({
    leadId: req.params.leadId,
    input: req.body || {},
  }));
});

module.exports = router;
