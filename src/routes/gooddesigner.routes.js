"use strict";

const { Readable } = require("node:stream");
const express = require("express");
const rateLimit = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const service = require("../services/gooddesigner.service");

const router = express.Router();
const generationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    code: "GOODDESIGNER_RATE_LIMITED",
    message: "GoodDesigner has reached its generation limit. Please wait and try again.",
  },
});

function requireGoodDesignerAccess(req, res, next) {
  const role = String(req.user?.platformRole || req.user?.role || "").toLowerCase();
  const entitled = (req.apps || []).some((app) => {
    const id = String(app.id || app.appId || app.slug || "").toLowerCase();
    const domain = String(app.domain || "").toLowerCase();
    const membership = String(app.membershipStatus || app.membership_status || "active").toLowerCase();
    const status = String(app.appStatus || app.status || "active").toLowerCase();
    return (
      ["designer", "gooddesigner", "good-designer", "goodaidesigner"].includes(id)
      || domain === "designer.goodos.app"
    ) && membership === "active" && status === "active";
  });
  if (!entitled && role !== "owner" && role !== "admin") {
    return res.status(403).json({
      success: false,
      code: "GOODDESIGNER_ACCESS_REQUIRED",
      message: "Your GoodOS account does not have access to GoodDesigner.",
    });
  }
  return next();
}

function handle(res, label, operation) {
  return Promise.resolve(operation)
    .then((data) => res.json({ success: true, ...data }))
    .catch((requestError) => {
      console.error(`GoodDesigner ${label} failed:`, requestError.code || requestError.message);
      return res.status(requestError.statusCode || 500).json({
        success: false,
        code: requestError.code || "GOODDESIGNER_REQUEST_FAILED",
        message: requestError.message || "The GoodDesigner request could not be completed.",
      });
    });
}

router.use(authRequired, requireGoodDesignerAccess);

router.post("/designs/generate", generationLimiter, (req, res) => handle(res, "design.generate", service.generateDesign(req.body)));
router.post("/designs/explode", generationLimiter, (req, res) => handle(res, "design.explode", service.explodeDesign(req.body)));
router.post("/vectors/generate", generationLimiter, (req, res) => handle(res, "vector.generate", service.generateVector(req.body)));
router.post("/vectors/trace", generationLimiter, (req, res) => handle(res, "vector.trace", service.traceVector(req.body)));
router.post("/mockups/generate", generationLimiter, (req, res) => handle(res, "mockup.generate", service.generateMockup(req.body)));
router.post("/photoshoots/generate", generationLimiter, (req, res) => handle(res, "photoshoot.generate", service.generatePhotoshoot(req.body)));
router.post("/animations/generate", generationLimiter, (req, res) => handle(res, "animation.generate", service.generateAnimation(req.body)));
router.get("/animations/:jobId", (req, res) => handle(res, "animation.status", service.animationStatus(req.params.jobId)));
router.get("/animations/:jobId/content", async (req, res) => {
  try {
    const upstream = await service.animationContent(req.params.jobId);
    res.status(200);
    res.set("Content-Type", upstream.headers.get("content-type") || "video/mp4");
    const length = upstream.headers.get("content-length");
    if (length) res.set("Content-Length", length);
    res.set("Cache-Control", "private, no-store");
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (requestError) {
    console.error("GoodDesigner animation.content failed:", requestError.code || requestError.message);
    res.status(requestError.statusCode || 500).json({
      success: false,
      code: requestError.code || "GOODDESIGNER_VIDEO_UNAVAILABLE",
      message: requestError.message || "The animation file is not available.",
    });
  }
});

module.exports = router;
