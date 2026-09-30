"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const assistant = require("../services/goodescrow-assistant.service");

const router = express.Router();
const APP_IDS = new Set(["goodescrow", "good-escrow", "escrow", "escrow.goodos.app"]);
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    code: "GOODESCROW_ASSISTANT_RATE_LIMITED",
    message: "Too many assistant requests. Please wait and try again.",
  },
});

function identifiers(app) {
  return [app?.id, app?.appId, app?.slug, app?.name, app?.domain]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase().replace(/\s+/g, ""));
}

function requireGoodEscrowAccess(req, res, next) {
  const role = String(req.user?.platformRole || req.user?.role || "").toLowerCase();
  const entitled = (req.apps || []).some((app) => {
    const membership = String(app.membershipStatus || app.membership_status || "active").toLowerCase();
    const status = String(app.appStatus || app.status || "active").toLowerCase();
    return membership === "active"
      && status === "active"
      && identifiers(app).some((identifier) => APP_IDS.has(identifier));
  });
  if (!entitled && !["owner", "admin"].includes(role)) {
    return res.status(403).json({
      success: false,
      code: "GOODESCROW_ACCESS_REQUIRED",
      message: "Your GoodOS account does not have access to GoodEscrow.",
    });
  }
  return next();
}

function handle(res, label, operation) {
  try {
    return res.json({ success: true, data: operation() });
  } catch (error) {
    console.error(`GoodEscrow assistant ${label} failed:`, error.code || error.message);
    return res.status(error.statusCode || 500).json({
      success: false,
      code: error.code || "GOODESCROW_ASSISTANT_REQUEST_FAILED",
      message: error.statusCode ? error.message : "The assistant request could not be completed.",
    });
  }
}

router.get("/health", (_req, res) => res.json({ success: true, data: assistant.health() }));
router.use(authRequired, requireGoodEscrowAccess, limiter);
router.post("/advice", (req, res) => handle(res, "advice", () => assistant.advice(req.body || {})));
router.post("/draft-terms", (req, res) => handle(res, "draft terms", () => assistant.draftTerms(req.body || {})));

module.exports = router;
