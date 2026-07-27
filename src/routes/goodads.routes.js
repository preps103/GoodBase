"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { success, error } = require("../utils/response");
const service = require("../services/goodads.service");
const social = require("../services/goodads-social.service");
const payments = require("../services/goodads-payments.service");

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
const generationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const publicCheckoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const paymentWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

router.get("/oauth/:platform/callback", (req, res) => {
  if (req.query.error) {
    return res.status(400).type("html").send("<!doctype html><title>Connection cancelled</title><p>The social account connection was cancelled.</p><script>window.close()</script>");
  }
  return social.completeAuthorization({
    provider: req.params.platform,
    code: req.query.code,
    state: req.query.state,
  }).then(({ connection, returnOrigin }) => {
    const targetOrigin = returnOrigin === "https://ads.goodos.app" ? returnOrigin : "https://ads.goodos.app";
    const payload = JSON.stringify({ type: "goodads-oauth-complete", provider: connection.provider, success: true });
    res.set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
    return res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Account connected</title><style>body{font-family:system-ui;padding:40px;text-align:center}p{color:#475569}</style><h1>Account connected</h1><p>You can return to GoodAds.</p><script>if(window.opener){window.opener.postMessage(${payload},${JSON.stringify(targetOrigin)})}window.close()</script>`);
  }).catch((requestError) => {
    console.error("GoodAds OAuth callback failed:", requestError.message);
    return res.status(requestError.statusCode || 500).type("html").send("<!doctype html><title>Connection failed</title><p>The social account could not be connected. Return to GoodAds and try again.</p>");
  });
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
      const statusCode = requestError.statusCode || 500;
      const operational = Number.isInteger(requestError.statusCode);
      return res.status(statusCode).json({
        success: false,
        code: requestError.code || "GOODADS_REQUEST_FAILED",
        message: operational
          ? requestError.message
          : "The GoodAds request could not be completed.",
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
router.get("/public/payment-offers/:slug", publicFormReadLimiter, (req, res) => (
  handle(res, "payment-offer.public", payments.getPublicOffer(req.params.slug))
));
router.post("/public/payment-offers/:slug/checkout", publicCheckoutLimiter, (req, res) => (
  handle(res, "payment.checkout", payments.createCheckout({
    slug: req.params.slug,
    payload: req.body,
    idempotencyKey: req.get("Idempotency-Key"),
  }))
));
router.get("/public/payment-sessions/:id", publicFormReadLimiter, (req, res) => (
  handle(res, "payment-session.public", payments.getPublicSession({
    id: req.params.id,
    accessToken: req.query.access,
  }))
));
router.post("/public/payment-sessions/:id/paypal/capture", publicCheckoutLimiter, (req, res) => (
  handle(res, "payment.paypal.capture", payments.capturePayPal({
    id: req.params.id,
    accessToken: req.body?.accessToken,
    orderId: req.body?.orderId,
    idempotencyKey: req.get("Idempotency-Key"),
  }))
));
router.post("/public/payment-webhooks/:provider/:connectionId", paymentWebhookLimiter, (req, res) => (
  handle(res, "payment.webhook", payments.handleWebhook({
    provider: req.params.provider,
    connectionId: req.params.connectionId,
    rawBody: req.rawBody,
    headers: req.headers,
    payload: req.body,
  }))
));

router.use(authRequired, tenantContext, requireGoodAdsAccess);

router.get("/dashboard", (req, res) => handle(res, "dashboard", service.dashboard(req.tenantContext)));
router.get("/workspace", (req, res) => handle(res, "workspace", service.workspace(req.tenantContext)));
router.get("/workspace/brand", (req, res) => handle(res, "brand", service.listResources({ type: "brand", context: req.tenantContext, limit: 1 })));
router.get("/connections/providers", (_req, res) => success(res, { data: social.publicProviders() }));
router.get("/connections", (req, res) => handle(res, "connections.list", social.listConnections({
  context: req.tenantContext,
  userId: req.user.id,
})));
router.get("/connections/:platform/authorize", (req, res) => social.beginAuthorization({
  provider: req.params.platform,
  context: req.tenantContext,
  userId: req.user.id,
  returnOrigin: "https://ads.goodos.app",
}).then((url) => res.redirect(302, url)).catch((requestError) => {
  console.error("GoodAds OAuth start failed:", requestError.message);
  return res.status(requestError.statusCode || 500).json({
    success: false,
    code: requestError.code || "GOODADS_OAUTH_START_FAILED",
    message: requestError.message,
  });
}));
router.delete("/connections/:platform", (req, res) => handle(res, "connections.disconnect", social.disconnect({
  context: req.tenantContext,
  userId: req.user.id,
  provider: req.params.platform,
})));
router.delete("/connections/provider/:platform", (req, res) => handle(res, "connections.disconnect", social.disconnect({
  context: req.tenantContext,
  userId: req.user.id,
  provider: req.params.platform,
})));
router.post("/generation/content", generationLimiter, (req, res) => handle(res, "generation.content", service.generateContent({
  payload: req.body,
  context: req.tenantContext,
})));
router.post("/publishing/jobs", (req, res) => handle(res, "publishing.create", social.publish({
  context: req.tenantContext,
  userId: req.user.id,
  idempotencyKey: req.get("Idempotency-Key"),
  providers: req.body?.providers,
  content: req.body?.content,
})));
router.get("/payments/providers", (req, res) => handle(res, "payments.providers", payments.listProviders({
  context: req.tenantContext,
})));
router.put("/payments/providers/:provider", (req, res) => handle(res, "payments.provider.configure", payments.configureProvider({
  provider: req.params.provider,
  environment: req.body?.environment,
  credentials: req.body?.credentials,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.delete("/payments/providers/:provider", (req, res) => handle(res, "payments.provider.disconnect", payments.disconnectProvider({
  provider: req.params.provider,
  context: req.tenantContext,
})));
router.get("/payments/preferences", (req, res) => handle(res, "payments.preferences", payments.getPreferences({
  context: req.tenantContext,
})));
router.patch("/payments/preferences", (req, res) => handle(res, "payments.preferences.update", payments.updatePreferences({
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.get("/payments/offers", (req, res) => handle(res, "payments.offers.list", payments.listOffers({
  context: req.tenantContext,
})));
router.post("/payments/offers", (req, res) => handle(res, "payments.offers.create", payments.saveOffer({
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.put("/payments/offers/:id", (req, res) => handle(res, "payments.offers.update", payments.saveOffer({
  id: req.params.id,
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.delete("/payments/offers/:id", (req, res) => handle(res, "payments.offers.archive", payments.archiveOffer({
  id: req.params.id,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.get("/payments/sessions", (req, res) => handle(res, "payments.sessions", payments.listSessions({
  context: req.tenantContext,
  limit: req.query.limit,
})));

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
  ["brand", "brand"],
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
