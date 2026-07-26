"use strict";

const express = require("express");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { query } = require("../config/database");

const router = express.Router();
router.use(authRequired, tenantContext);

function credentialsConfigured() {
  return Boolean(
    /^sk_(test|live)_/.test(process.env.STRIPE_SECRET_KEY || "") &&
    /^pk_(test|live)_/.test(process.env.STRIPE_PUBLISHABLE_KEY || "") &&
    /^whsec_/.test(process.env.STRIPE_WEBHOOK_SECRET || "")
  );
}

function unavailable(_request, response) {
  return response.status(503).json({
    success: false,
    code: "PAYMENTS_NOT_ACTIVATED",
    message: "GoodFleet payments are safely disabled until Stripe processing and webhook verification are activated."
  });
}

router.get("/capability", async (_request, response, next) => {
  try {
    const schema = await query(
      `SELECT
        to_regclass('public.fleet_payment_operations') IS NOT NULL AS ledger_ready,
        to_regclass('public.fleet_payment_webhook_events') IS NOT NULL AS webhook_store_ready`
    );
    const readiness = schema.rows[0];
    const credentialsReady = credentialsConfigured();
    const missingRequirements = [];
    if (!readiness.ledger_ready) missingRequirements.push("payment ledger migration");
    if (!readiness.webhook_store_ready) missingRequirements.push("webhook event migration");
    if (!/^sk_(test|live)_/.test(process.env.STRIPE_SECRET_KEY || "")) missingRequirements.push("Stripe secret key");
    if (!/^pk_(test|live)_/.test(process.env.STRIPE_PUBLISHABLE_KEY || "")) missingRequirements.push("Stripe publishable key");
    if (!/^whsec_/.test(process.env.STRIPE_WEBHOOK_SECRET || "")) missingRequirements.push("Stripe webhook signing secret");
    missingRequirements.push("payment processing activation");

    response.json({
      success: true,
      data: {
        provider: "stripe",
        configured: credentialsReady && readiness.ledger_ready && readiness.webhook_store_ready,
        acceptingPayments: false,
        payoutsEnabled: false,
        webhooksHealthy: false,
        currency: String(process.env.STRIPE_DEFAULT_CURRENCY || "USD").toUpperCase(),
        supportedMethods: [],
        missingRequirements,
        readiness: {
          credentialsConfigured: credentialsReady,
          ledgerReady: readiness.ledger_ready,
          webhookStoreReady: readiness.webhook_store_ready,
          processingActivated: false
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post("/checkout-sessions", unavailable);
router.post("/invoices", unavailable);
router.post("/authorizations", unavailable);
router.post("/:paymentId/capture", unavailable);
router.post("/:paymentId/refunds", unavailable);
router.post("/:paymentId/void", unavailable);
router.post("/:paymentId/increment", unavailable);
router.post("/invoices/:invoiceId/dispute", unavailable);
router.post("/provider/connect", unavailable);

module.exports = router;
