"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { success, error } = require("../utils/response");
const service = require("../services/goodads.service");

const router = express.Router();
const publicFormReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 240,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const publicFormWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

function requireGoodAdsAccess(req, res, next) {
  const role = String(req.user?.platformRole || req.user?.role || "").toLowerCase();
  const entitled = (req.apps || []).some((app) => {
    const id = String(app.id || app.appId || app.slug || "").toLowerCase();
    const domain = String(app.domain || "").toLowerCase();
    const membership = String(app.membershipStatus || app.membership_status || "active").toLowerCase();
    const status = String(app.appStatus || app.status || "active").toLowerCase();
    return (id === "goodads" || id === "ads" || domain === "ads.goodos.app") && membership === "active" && status === "active";
  });
  if (!entitled && role !== "owner" && role !== "admin") {
    return error(res, "Active GoodAds access is required.", 403);
  }
  return next();
}

function handle(res, label, operation) {
  return Promise.resolve(operation)
    .then((data) => success(res, { data }))
    .catch((requestError) => {
      console.error(`GoodAds ${label} failed:`, requestError.message);
      return res.status(requestError.statusCode || 500).json({
        success: false,
        code: requestError.code || "GOODADS_REQUEST_FAILED",
        message: requestError.message || "The GoodAds request could not be completed.",
      });
    });
}

router.get("/public/forms/:slug", publicFormReadLimiter, (req, res) => (
  handle(res, "lead-form.public", service.getPublicLeadForm(req.params.slug))
));
router.post("/public/forms/:slug/views", publicFormReadLimiter, (req, res) => (
  handle(res, "lead-form.view", service.recordLeadFormView(req.params.slug))
));
router.post("/public/forms/:slug/submissions", publicFormWriteLimiter, (req, res) => (
  handle(res, "lead.capture", service.captureLead({
    slug: req.params.slug,
    payload: req.body,
    idempotencyKey: req.get("Idempotency-Key"),
    userAgent: req.get("User-Agent"),
  }))
));

router.use(authRequired, tenantContext, requireGoodAdsAccess);

router.get("/dashboard", (req, res) => handle(res, "dashboard", service.dashboard(req.tenantContext)));
router.get("/workspace", (req, res) => handle(res, "workspace", service.workspace(req.tenantContext)));
router.get("/workspace/brand", (req, res) => handle(res, "brand", service.listResources({ type: "brand", context: req.tenantContext, limit: 1 })));
router.get("/connections/:platform/authorize", (req, res) => res.status(501).json({
  success: false,
  code: "GOODADS_PROVIDER_NOT_CONFIGURED",
  message: `${req.params.platform} OAuth credentials are not configured in GoodBase.`,
}));

function registerResource(path, type) {
  router.get(`/${path}`, (req, res) => handle(res, `${type}.list`, service.listResources({
    type,
    context: req.tenantContext,
    limit: req.query.limit,
    offset: req.query.offset,
    status: req.query.status,
  })));
  router.post(`/${path}`, (req, res) => handle(res, `${type}.create`, service.upsertResource({
    type,
    payload: req.body,
    context: req.tenantContext,
    userId: req.user.id,
  })));
  router.get(`/${path}/:id`, (req, res) => handle(res, `${type}.get`, service.getResource({
    type,
    id: req.params.id,
    context: req.tenantContext,
  })));
  router.put(`/${path}/:id`, (req, res) => handle(res, `${type}.update`, service.upsertResource({
    type,
    id: req.params.id,
    payload: req.body,
    context: req.tenantContext,
    userId: req.user.id,
  })));
  router.patch(`/${path}/:id`, (req, res) => handle(res, `${type}.patch`, service.upsertResource({
    type,
    id: req.params.id,
    payload: req.body,
    context: req.tenantContext,
    userId: req.user.id,
  })));
  router.delete(`/${path}/:id`, (req, res) => handle(res, `${type}.archive`, service.archiveResource({
    type,
    id: req.params.id,
    context: req.tenantContext,
    userId: req.user.id,
  })));
}

[
  ["campaigns", "campaigns"],
  ["content", "content"],
  ["approvals", "approvals"],
  ["calendar", "calendar"],
  ["connections", "connections"],
  ["publishing/jobs", "publishing_jobs"],
  ["analytics", "analytics"],
  ["media", "media"],
  ["link-hubs", "link_hubs"],
  ["automations", "automations"],
  ["notifications", "notifications"],
  ["email-campaigns", "email_campaigns"],
  ["designs", "designs"],
  ["flyers", "flyers"],
  ["business-cards", "business_cards"],
  ["qr-codes", "qr_codes"],
  ["videos", "videos"],
  ["audit-events", "audit_events"],
  ["funnels", "funnels"],
  ["lead-forms", "lead_forms"],
  ["leads", "leads"],
].forEach(([path, type]) => registerResource(path, type));

router.post("/campaigns/:id/launch", (req, res) => handle(res, "campaign.launch", service.transitionResource({
  type: "campaigns",
  id: req.params.id,
  nextStatus: "active",
  context: req.tenantContext,
  userId: req.user.id,
  eventType: "campaigns.launched",
})));

router.post("/funnels/:id/publish", (req, res) => handle(res, "funnel.publish", service.transitionResource({
  type: "funnels",
  id: req.params.id,
  nextStatus: "active",
  context: req.tenantContext,
  userId: req.user.id,
  eventType: "funnels.published",
})));

router.post("/funnels/:id/pause", (req, res) => handle(res, "funnel.pause", service.transitionResource({
  type: "funnels",
  id: req.params.id,
  nextStatus: "paused",
  context: req.tenantContext,
  userId: req.user.id,
  eventType: "funnels.paused",
})));

router.post("/lead-forms/:id/publish", (req, res) => handle(res, "lead-form.publish", service.transitionResource({
  type: "lead_forms",
  id: req.params.id,
  nextStatus: "active",
  context: req.tenantContext,
  userId: req.user.id,
  eventType: "lead_forms.published",
})));

module.exports = router;
