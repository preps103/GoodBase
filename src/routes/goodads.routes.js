"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { success, error } = require("../utils/response");
const service = require("../services/goodads.service");
const chatService = require("../services/goodads-chat.service");
const social = require("../services/goodads-social.service");
const payments = require("../services/goodads-payments.service");
const workflows = require("../services/goodads-workflows.service");
const ads = require("../services/goodads-ads.service");
const analytics = require("../services/goodads-analytics.service");
const competitorIntelligence = require("../services/goodads-competitor-intelligence.service");

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
const publishingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const bulkPublishingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const publicLinkClickLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const chatMessageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 240,
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
router.get("/public/link-hubs/:slug", publicFormReadLimiter, (req, res) => (
  handle(res, "link-hub.public", service.getPublicLinkHub(req.params.slug))
));
router.post("/public/link-hubs/:slug/clicks", publicLinkClickLimiter, (req, res) => (
  handle(res, "link-hub.click", service.recordLinkHubClick({
    slug: req.params.slug,
    linkId: req.body?.linkId,
    userAgent: req.get("User-Agent"),
    referrer: req.get("Referer"),
  }))
));
router.post("/public/engagement-webhooks/:provider", paymentWebhookLimiter, (req, res) => (
  handle(res, "engagement.ingest", workflows.ingestEngagement({
    provider: req.params.provider,
    payload: req.body,
    rawBody: req.rawBody,
    headers: req.headers,
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

router.get("/chat/channels", (req, res) => handle(res, "chat.channels", chatService.listChannels({
  context: req.tenantContext,
  userId: req.user.id,
})));
router.post("/chat/channels", (req, res) => handle(res, "chat.channel.create", chatService.createChannel({
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.post("/chat/direct", (req, res) => handle(res, "chat.direct", chatService.openDirectChannel({
  participantUserId: req.body?.participantUserId,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.get("/chat/members", (req, res) => handle(res, "chat.members", chatService.listMembers({
  context: req.tenantContext,
  search: req.query.search,
  limit: req.query.limit,
})));
router.get("/chat/channels/:channelId/messages", (req, res) => handle(res, "chat.messages", chatService.listMessages({
  channelId: req.params.channelId,
  context: req.tenantContext,
  userId: req.user.id,
  limit: req.query.limit,
  before: req.query.before,
})));
router.post("/chat/channels/:channelId/messages", chatMessageLimiter, (req, res) => handle(res, "chat.message.send", chatService.sendMessage({
  channelId: req.params.channelId,
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
  idempotencyKey: req.get("Idempotency-Key"),
})));
router.patch("/chat/channels/:channelId/messages/:messageId", (req, res) => handle(res, "chat.message.edit", chatService.editMessage({
  channelId: req.params.channelId,
  messageId: req.params.messageId,
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.delete("/chat/channels/:channelId/messages/:messageId", (req, res) => handle(res, "chat.message.delete", chatService.deleteMessage({
  channelId: req.params.channelId,
  messageId: req.params.messageId,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.post("/chat/channels/:channelId/read", (req, res) => handle(res, "chat.read", chatService.markRead({
  channelId: req.params.channelId,
  context: req.tenantContext,
  userId: req.user.id,
})));

router.get("/dashboard", (req, res) => handle(res, "dashboard", service.dashboard(req.tenantContext)));
router.get("/workspace", (req, res) => handle(res, "workspace", service.workspace(req.tenantContext)));
router.get("/workspace/brand", (req, res) => handle(res, "brand", service.listResources({ type: "brand", context: req.tenantContext, limit: 1 })));
router.get("/capabilities", (req, res) => handle(
  res,
  "capabilities",
  social.capabilities({
    context: req.tenantContext,
    userId: req.user.id,
  }).then((capabilities) => ({
    ...capabilities,
    modules: {
      ...capabilities.modules,
      ...workflows.workflowCapabilities(),
      ...ads.capabilities(),
      ...analytics.capabilities(),
      ...competitorIntelligence.capabilities(),
    },
  }))
));
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
router.delete("/connections/account/:id", (req, res) => handle(res, "connections.account.disconnect", social.disconnectConnection({
  context: req.tenantContext,
  userId: req.user.id,
  id: req.params.id,
})));
router.post("/generation/content", generationLimiter, (req, res) => handle(res, "generation.content", service.generateContent({
  payload: req.body,
  context: req.tenantContext,
})));
router.post("/publishing/jobs", publishingLimiter, (req, res) => handle(res, "publishing.create", social.publish({
  context: req.tenantContext,
  userId: req.user.id,
  idempotencyKey: req.get("Idempotency-Key"),
  providers: req.body?.providers,
  connectionIds: req.body?.connectionIds,
  content: req.body?.content,
  scheduledFor: req.body?.scheduledFor,
  timezone: req.body?.timezone,
  approvalId: req.body?.approvalId,
})));
router.post("/publishing/batches", bulkPublishingLimiter, (req, res) => handle(res, "publishing.batch.create", social.publishBatch({
  context: req.tenantContext,
  userId: req.user.id,
  idempotencyKey: req.get("Idempotency-Key"),
  providers: req.body?.providers,
  connectionIds: req.body?.connectionIds,
  items: req.body?.items,
  timezone: req.body?.timezone,
})));
router.get("/publishing/jobs", (req, res) => handle(res, "publishing.list", social.listPublishJobs({
  context: req.tenantContext,
  userId: req.user.id,
  limit: req.query.limit,
  offset: req.query.offset,
  status: req.query.status,
})));
router.get("/publishing/jobs/:id", (req, res) => handle(res, "publishing.get", social.getPublishJob({
  context: req.tenantContext,
  userId: req.user.id,
  id: req.params.id,
})));
router.post("/publishing/jobs/:id/cancel", (req, res) => handle(res, "publishing.cancel", social.cancelPublishJob({
  context: req.tenantContext,
  userId: req.user.id,
  id: req.params.id,
})));
router.post("/publishing/jobs/:id/retry", (req, res) => handle(res, "publishing.retry", social.retryPublishJob({
  context: req.tenantContext,
  userId: req.user.id,
  id: req.params.id,
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

router.get("/engagement", (req, res) => handle(res, "engagement.list", workflows.listEngagement({
  context: req.tenantContext,
  status: req.query.status,
  itemType: req.query.itemType,
  provider: req.query.provider,
  assignedTo: req.query.assignedTo,
  search: req.query.search,
  limit: req.query.limit,
  offset: req.query.offset,
})));
router.patch("/engagement/:id", (req, res) => handle(res, "engagement.update", workflows.updateEngagement({
  id: req.params.id,
  payload: req.body,
  context: req.tenantContext,
})));

router.get("/approvals", (req, res) => handle(res, "approvals.list", service.listResources({
  type: "approvals",
  context: req.tenantContext,
  limit: req.query.limit,
  offset: req.query.offset,
  status: req.query.status,
})));
router.post("/approvals", (req, res) => handle(res, "approvals.create", workflows.saveApproval({
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
  idempotencyKey: req.get("Idempotency-Key"),
})));
router.get("/approvals/:id", (req, res) => handle(res, "approvals.get", service.getResource({
  type: "approvals",
  id: req.params.id,
  context: req.tenantContext,
})));
router.put("/approvals/:id", (req, res) => handle(res, "approvals.update", workflows.saveApproval({
  id: req.params.id,
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.patch("/approvals/:id", (req, res) => handle(res, "approvals.update", workflows.saveApproval({
  id: req.params.id,
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.delete("/approvals/:id", (req, res) => handle(res, "approvals.archive", service.archiveResource({
  type: "approvals",
  id: req.params.id,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.post("/approvals/:id/decision", (req, res) => handle(
  res,
  "approvals.decision",
  workflows.decideApproval({
    id: req.params.id,
    decision: req.body?.decision,
    note: req.body?.note,
    context: req.tenantContext,
    userId: req.user.id,
  }).then(async (approval) => {
    let publishingJob = null;
    let publishingError = null;
    if (
      approval.status === "approved"
      && approval.publication?.autoQueue === true
    ) {
      try {
        publishingJob = await social.publish({
          context: req.tenantContext,
          userId: approval.ownerUserId || req.user.id,
          idempotencyKey: `approval:${approval.id}`,
          connectionIds: approval.publication.connectionIds,
          content: approval.publication.content,
          scheduledFor: approval.publication.scheduledFor,
          timezone: approval.publication.timezone,
          approvalId: approval.id,
        });
      } catch (requestError) {
        publishingError = {
          code: requestError.code || "GOODADS_APPROVED_PUBLISH_FAILED",
          message: requestError.message,
        };
      }
    }
    return { approval, publishingJob, publishingError };
  })
));

router.get("/automations", (req, res) => handle(res, "automations.list", service.listResources({
  type: "automations",
  context: req.tenantContext,
  limit: req.query.limit,
  offset: req.query.offset,
  status: req.query.status,
})));
router.post("/automations", (req, res) => handle(res, "automations.create", workflows.saveAutomation({
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.get("/automations/:id", (req, res) => handle(res, "automations.get", service.getResource({
  type: "automations",
  id: req.params.id,
  context: req.tenantContext,
})));
router.put("/automations/:id", (req, res) => handle(res, "automations.update", workflows.saveAutomation({
  id: req.params.id,
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.patch("/automations/:id", (req, res) => handle(res, "automations.update", workflows.saveAutomation({
  id: req.params.id,
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.delete("/automations/:id", (req, res) => handle(res, "automations.archive", service.archiveResource({
  type: "automations",
  id: req.params.id,
  context: req.tenantContext,
  userId: req.user.id,
})));
router.post("/automations/:id/run", (req, res) => handle(res, "automations.run", workflows.runAutomation({
  id: req.params.id,
  input: req.body,
  context: req.tenantContext,
  userId: req.user.id,
  idempotencyKey: req.get("Idempotency-Key"),
})));
router.get("/automations/:id/runs", (req, res) => handle(res, "automations.runs", workflows.listAutomationRuns({
  id: req.params.id,
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
  ["calendar", "calendar"],
  ["analytics", "analytics"],
  ["media", "media"],
  ["link-hubs", "link_hubs"],
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
  ["rss-feeds", "rss_feeds"],
  ["brand", "brand"],
].forEach(([path, type]) => registerResource(path, type));

router.post("/rss-feeds/:id/sync", (req, res) => handle(res, "rss-feed.sync", service.syncRssFeed({
  id: req.params.id,
  context: req.tenantContext,
  userId: req.user.id,
})));

router.post("/rss-feeds/:id/items/:itemId/repurpose", generationLimiter, (req, res) => (
  handle(res, "rss-feed.repurpose", service.repurposeRssItem({
    id: req.params.id,
    itemId: req.params.itemId,
    payload: req.body,
    context: req.tenantContext,
    userId: req.user.id,
  }))
));

router.get("/ads/providers", (_req, res) => success(res, { data: ads.publicProviders() }));
router.get("/competitor-intelligence/overview", (req, res) => handle(
  res,
  "competitor-intelligence.overview",
  competitorIntelligence.overview({ context: req.tenantContext })
));
router.get("/competitor-intelligence/competitors", (req, res) => handle(
  res,
  "competitor-intelligence.competitors.list",
  competitorIntelligence.listCompetitors({
    context: req.tenantContext,
    search: req.query.search,
    status: req.query.status,
    limit: req.query.limit,
  })
));
router.post("/competitor-intelligence/competitors", (req, res) => handle(
  res,
  "competitor-intelligence.competitors.create",
  competitorIntelligence.saveCompetitor({
    payload: req.body,
    context: req.tenantContext,
    userId: req.user.id,
  })
));
router.get("/competitor-intelligence/competitors/:id", (req, res) => handle(
  res,
  "competitor-intelligence.competitors.get",
  competitorIntelligence.getCompetitor({
    id: req.params.id,
    context: req.tenantContext,
  })
));
router.put("/competitor-intelligence/competitors/:id", (req, res) => handle(
  res,
  "competitor-intelligence.competitors.update",
  competitorIntelligence.saveCompetitor({
    id: req.params.id,
    payload: req.body,
    context: req.tenantContext,
    userId: req.user.id,
  })
));
router.delete("/competitor-intelligence/competitors/:id", (req, res) => handle(
  res,
  "competitor-intelligence.competitors.archive",
  competitorIntelligence.archiveCompetitor({
    id: req.params.id,
    context: req.tenantContext,
  })
));
router.post("/competitor-intelligence/competitors/:id/sync", publishingLimiter, (req, res) => handle(
  res,
  "competitor-intelligence.competitors.sync",
  competitorIntelligence.syncCompetitor({
    id: req.params.id,
    context: req.tenantContext,
  })
));
router.get("/competitor-intelligence/creatives", (req, res) => handle(
  res,
  "competitor-intelligence.creatives.list",
  competitorIntelligence.listCreatives({
    context: req.tenantContext,
    competitorId: req.query.competitorId,
    channel: req.query.channel,
    sourceProvider: req.query.sourceProvider,
    favorite: req.query.favorite,
    search: req.query.search,
    limit: req.query.limit,
    offset: req.query.offset,
  })
));
router.post("/competitor-intelligence/creatives", (req, res) => handle(
  res,
  "competitor-intelligence.creatives.create",
  competitorIntelligence.saveCreative({
    competitorId: req.body?.competitorId,
    payload: req.body,
    context: req.tenantContext,
    userId: req.user.id,
  })
));
router.put("/competitor-intelligence/creatives/:id", (req, res) => handle(
  res,
  "competitor-intelligence.creatives.update",
  competitorIntelligence.saveCreative({
    id: req.params.id,
    competitorId: req.body?.competitorId,
    payload: req.body,
    context: req.tenantContext,
    userId: req.user.id,
  })
));
router.delete("/competitor-intelligence/creatives/:id", (req, res) => handle(
  res,
  "competitor-intelligence.creatives.archive",
  competitorIntelligence.archiveCreative({
    id: req.params.id,
    context: req.tenantContext,
  })
));
router.get("/competitor-intelligence/alerts", (req, res) => handle(
  res,
  "competitor-intelligence.alerts.list",
  competitorIntelligence.listAlerts({
    context: req.tenantContext,
    limit: req.query.limit,
  })
));
router.patch("/competitor-intelligence/alerts/:id/acknowledge", (req, res) => handle(
  res,
  "competitor-intelligence.alerts.acknowledge",
  competitorIntelligence.acknowledgeAlert({
    id: req.params.id,
    context: req.tenantContext,
    userId: req.user.id,
  })
));
router.get("/analytics/overview", (req, res) => handle(res, "analytics.overview", analytics.overview({
  context: req.tenantContext,
  from: req.query.from,
  to: req.query.to,
})));
router.post("/analytics/provider-sync", publishingLimiter, (req, res) => handle(
  res,
  "analytics.provider-sync",
  analytics.syncProviderMetrics({
    context: req.tenantContext,
    from: req.body?.from,
    to: req.body?.to,
  })
));
router.get("/ads/accounts", (req, res) => handle(res, "ads.accounts.list", ads.listAdAccounts({
  context: req.tenantContext,
})));
router.post("/ads/accounts/discover", publishingLimiter, (req, res) => handle(
  res,
  "ads.accounts.discover",
  ads.discoverAccounts({
    provider: req.body?.provider,
    connectionId: req.body?.connectionId,
    context: req.tenantContext,
    userId: req.user.id,
  })
));
router.post("/ads/accounts", publishingLimiter, (req, res) => handle(
  res,
  "ads.accounts.save",
  ads.saveAdAccount({
    payload: req.body,
    context: req.tenantContext,
    userId: req.user.id,
  })
));
router.delete("/ads/accounts/:id", (req, res) => handle(
  res,
  "ads.accounts.disable",
  ads.disableAdAccount({
    id: req.params.id,
    context: req.tenantContext,
  })
));
router.post("/ads/operations/:id/retry", publishingLimiter, (req, res) => handle(
  res,
  "ads.operation.retry",
  ads.retryOperation({
    id: req.params.id,
    context: req.tenantContext,
  })
));
router.get("/campaigns/:id/provider-state", (req, res) => handle(
  res,
  "campaign.provider-state",
  ads.getCampaignState({
    campaignId: req.params.id,
    context: req.tenantContext,
  })
));
router.post("/campaigns/:id/launch", publishingLimiter, (req, res) => (
  handle(res, "campaign.launch", ads.launchCampaign({
    campaignId: req.params.id,
    adAccountIds: req.body?.adAccountIds,
    context: req.tenantContext,
    userId: req.user.id,
    idempotencyKey: req.get("Idempotency-Key"),
  }))
));
router.post("/campaigns/:id/provider-campaigns/:providerCampaignId/activation-approval", (req, res) => (
  handle(res, "campaign.activation-approval", ads.requestActivationApproval({
    campaignId: req.params.id,
    providerCampaignId: req.params.providerCampaignId,
    context: req.tenantContext,
    userId: req.user.id,
    idempotencyKey: req.get("Idempotency-Key"),
  }))
));
["sync", "pause", "activate", "archive"].forEach((operationType) => {
  router.post(
    `/campaigns/:id/provider-campaigns/:providerCampaignId/${operationType}`,
    publishingLimiter,
    (req, res) => handle(res, `campaign.${operationType}`, ads.queueLifecycleOperation({
      campaignId: req.params.id,
      providerCampaignId: req.params.providerCampaignId,
      operationType,
      approvalId: req.body?.approvalId,
      context: req.tenantContext,
      userId: req.user.id,
      idempotencyKey: req.get("Idempotency-Key"),
    }))
  );
});

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
