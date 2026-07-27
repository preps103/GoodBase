"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const multer = require("multer");

const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { success } = require("../utils/response");
const service = require("../services/goodswapz.service");

const router = express.Router();
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const verificationUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 3,
    fileSize: 5 * 1024 * 1024,
    fields: 10,
  },
  fileFilter(_request, file, callback) {
    const allowed = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ]);
    if (!allowed.has(file.mimetype)) {
      const uploadError = new Error("Only JPEG, PNG, WebP, and PDF identity documents are accepted.");
      uploadError.statusCode = 400;
      uploadError.code = "INVALID_UPLOAD_TYPE";
      return callback(uploadError);
    }
    return callback(null, true);
  },
});

function fail(response, requestError, fallbackMessage) {
  const statusCode = Number(requestError.statusCode || 500);
  const operational = Number.isInteger(requestError.statusCode);
  if (!operational) {
    console.error("GoodSwapz request failed:", requestError);
  }
  return response.status(statusCode).json({
    success: false,
    code: requestError.code || "GOODSWAPZ_REQUEST_FAILED",
    message: operational
      ? requestError.message
      : fallbackMessage,
  });
}

function handle(response, operation, fallbackMessage = "The GoodSwapz request could not be completed.") {
  return Promise.resolve(operation)
    .then((data) => success(response, { data }))
    .catch((requestError) => fail(response, requestError, fallbackMessage));
}

function requireGoodSwapzAccess(request, response, next) {
  const role = String(request.user?.platformRole || request.user?.role || "").toLowerCase();
  const entitled = (request.apps || []).some((app) => {
    const id = String(app.id || app.appId || app.slug || "")
      .toLowerCase()
      .replace(/[\s_]+/g, "-");
    const domain = String(app.domain || "").toLowerCase();
    const membership = String(app.membershipStatus || app.membership_status || "active").toLowerCase();
    const status = String(app.appStatus || app.status || "active").toLowerCase();
    return (
      ["goodswapz", "good-swapz", "swapz"].includes(id) ||
      domain === "swapz.goodos.app"
    ) && membership === "active" && status === "active";
  });
  if (!entitled && role !== "owner" && role !== "admin") {
    return response.status(403).json({
      success: false,
      code: "GOODSWAPZ_ACCESS_REQUIRED",
      message: "Active GoodSwapz access is required.",
    });
  }
  return next();
}

function requireGoodSwapzAdmin(request, response, next) {
  const role = String(request.user?.platformRole || request.user?.role || "").toLowerCase();
  if (!["owner", "admin"].includes(role)) {
    return response.status(403).json({
      success: false,
      code: "GOODSWAPZ_ADMIN_REQUIRED",
      message: "GoodSwapz owner or administrator access is required.",
    });
  }
  return next();
}

function requireVerifiedMfa(request, response, next) {
  if (!request.auth?.mfaVerified) {
    return response.status(428).json({
      success: false,
      code: "MFA_VERIFICATION_REQUIRED",
      message: "Verify MFA before completing this protected handoff action.",
      mfaRequired: true,
      nextAction: request.user?.mfaEnabled ? "verify_mfa" : "enroll_mfa",
      enrollmentUrl: "https://base.goodos.app/mfa-enroll",
    });
  }
  return next();
}

function contextInput(request) {
  return {
    context: request.tenantContext,
    userId: request.user.id,
    ipAddress: request.ip,
  };
}

router.get("/health", (_request, response) => (
  handle(response, service.health(), "GoodSwapz health check failed.")
));

router.post("/escrow/webhooks/goodescrow", webhookLimiter, (request, response) => (
  handle(
    response,
    service.processEscrowWebhook({
      payload: request.body || {},
      signature: request.get("X-GoodEscrow-Signature"),
      timestamp: request.get("X-GoodEscrow-Timestamp"),
    }),
    "GoodEscrow event could not be processed."
  )
));

router.use(authRequired, tenantContext, requireGoodSwapzAccess);

router.get("/listings", (request, response) => (
  handle(response, service.listListings(contextInput(request)))
));

router.post("/listings", writeLimiter, (request, response) => (
  handle(response, service.createListing({
    ...contextInput(request),
    payload: request.body || {},
  }))
));

router.post(
  "/listings/:listingId/review",
  sensitiveLimiter,
  requireGoodSwapzAdmin,
  requireVerifiedMfa,
  (request, response) => (
    handle(response, service.reviewListing({
      context: request.tenantContext,
      reviewerUserId: request.user.id,
      listingId: request.params.listingId,
      decision: request.body?.decision,
      note: request.body?.note,
      ipAddress: request.ip,
    }))
  )
);

router.get("/user/watchlist", (request, response) => (
  handle(response, service.getWatchlist(contextInput(request)))
));

router.get("/user/state", (request, response) => (
  handle(response, service.getUserState(contextInput(request)))
));

router.post("/user/watchlist/:listingId", writeLimiter, (request, response) => (
  handle(response, service.toggleWatchlist({
    ...contextInput(request),
    listingId: request.params.listingId,
  }))
));

router.post(
  "/user/verification",
  sensitiveLimiter,
  verificationUpload.fields([
    { name: "frontImage", maxCount: 1 },
    { name: "backImage", maxCount: 1 },
    { name: "selfieImage", maxCount: 1 },
  ]),
  (request, response) => (
    handle(response, service.submitIdentityVerification({
      ...contextInput(request),
      idType: request.body?.idType,
      files: request.files,
    }))
  )
);

router.post(
  "/user/verification/:verificationId/review",
  sensitiveLimiter,
  requireGoodSwapzAdmin,
  requireVerifiedMfa,
  (request, response) => (
    handle(response, service.reviewIdentityVerification({
      context: request.tenantContext,
      reviewerUserId: request.user.id,
      verificationId: request.params.verificationId,
      decision: request.body?.decision,
      note: request.body?.note,
      ipAddress: request.ip,
    }))
  )
);

router.post("/listings/:listingId/offers", writeLimiter, (request, response) => (
  handle(response, service.createOffer({
    ...contextInput(request),
    listingId: request.params.listingId,
    payload: request.body || {},
    idempotencyKey: request.get("Idempotency-Key"),
  }))
));

router.post("/offers/:offerId/respond", writeLimiter, (request, response) => (
  handle(response, service.respondToOffer({
    ...contextInput(request),
    offerId: request.params.offerId,
    decision: request.body?.decision,
  }))
));

router.post("/ai/generate-description", writeLimiter, (request, response) => (
  handle(response, service.generateDescription(request.body || {}))
));

router.post("/ai/estimate-valuation", writeLimiter, (request, response) => (
  handle(response, service.estimateValuation(request.body || {}))
));

router.post("/escrow/initiate", sensitiveLimiter, (request, response) => (
  handle(response, service.initiateTransaction({
    ...contextInput(request),
    listingId: request.body?.listingId,
    offerId: request.body?.offerId,
    idempotencyKey: request.get("Idempotency-Key"),
  }))
));

router.get("/escrow/transactions/:transactionId", (request, response) => (
  handle(response, service.transactionStatus({
    ...contextInput(request),
    transactionId: request.params.transactionId,
  }))
));

router.get("/handoffs", (request, response) => (
  handle(response, service.listHandoffs(contextInput(request)))
));

router.get("/handoffs/:handoffId", (request, response) => (
  handle(response, service.loadHandoff({
    ...contextInput(request),
    handoffId: request.params.handoffId,
  }))
));

router.post(
  "/handoffs/:handoffId/start",
  sensitiveLimiter,
  requireVerifiedMfa,
  (request, response) => (
    handle(response, service.startHandoff({
      ...contextInput(request),
      handoffId: request.params.handoffId,
    }))
  )
);

router.post("/handoffs/:handoffId/steps/:stepId/complete", writeLimiter, (request, response) => (
  handle(response, service.completeHandoffStep({
    ...contextInput(request),
    handoffId: request.params.handoffId,
    stepId: request.params.stepId,
    evidenceReference: request.body?.evidenceReference,
    completionNote: request.body?.completionNote,
  }))
));

router.post(
  "/handoffs/:handoffId/confirm-receipt",
  sensitiveLimiter,
  requireVerifiedMfa,
  (request, response) => (
    handle(response, service.confirmReceipt({
      ...contextInput(request),
      handoffId: request.params.handoffId,
    }))
  )
);

router.post("/handoffs/:handoffId/disputes", sensitiveLimiter, (request, response) => (
  handle(response, service.openDispute({
    ...contextInput(request),
    handoffId: request.params.handoffId,
    reason: request.body?.reason,
  }))
));

module.exports = router;
