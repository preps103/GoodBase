"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const authRequired = require("../middleware/authRequired");
const service = require("../services/goodscan.service");
const credits = require("../services/goodscan-credits.service");
const { STORAGE_ROOT } = require("../services/storage-v2.service");

const router = express.Router();
const storageRoot = path.resolve(process.env.GOODSCAN_CAPTURE_ROOT || path.join(STORAGE_ROOT, "goodscan-captures"));
fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });

function requireGoodScanAccess(req, res, next) {
  const role = String(req.user?.platformRole || req.user?.role || "").toLowerCase();
  const entitled = (req.apps || []).some((app) => {
    const id = String(app.id || app.appId || app.slug || "").toLowerCase();
    const domain = String(app.domain || "").toLowerCase();
    const membership = String(app.membershipStatus || app.membership_status || "active").toLowerCase();
    const status = String(app.appStatus || app.status || "active").toLowerCase();
    return (["goodscan", "goodscan3d", "goodscan-3d", "scan"].includes(id) || domain === "scan.goodos.app") && membership === "active" && status === "active";
  });
  if (!entitled && role !== "owner" && role !== "admin") return res.status(403).json({ success: false, code: "GOODSCAN_ACCESS_REQUIRED", message: "Your GoodOS account does not have access to GoodScan." });
  return next();
}

const upload = multer({
  storage: multer.diskStorage({ destination: storageRoot, filename: (_req, _file, callback) => callback(null, crypto.randomUUID()) }),
  limits: { files: 501, fileSize: 512 * 1024 * 1024, fields: 10 },
  fileFilter: (_req, file, callback) => {
    const allowed = file.fieldname === "manifest" ? file.mimetype === "application/json" : /^(image\/(jpeg|png|heic|heif)|video\/(mp4|quicktime|webm))$/i.test(file.mimetype);
    callback(allowed ? null : Object.assign(new Error("Unsupported GoodScan capture file type."), { statusCode: 415 }), allowed);
  },
});
const captureLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
const billingLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
const quoteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });

async function cleanup(files) {
  await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
}

router.get("/health", (_req, res) => res.json({ success: true, status: "online", service: "goodscan", storage: "private" }));
router.post("/credits/webhooks/stripe", async (req, res) => {
  if (!/^whsec_/.test(credits.webhookSecret())) {
    return res.status(503).json({ success: false, code: "GOODSCAN_WEBHOOK_NOT_CONFIGURED", message: "GoodScan payment webhooks are not activated." });
  }
  let event;
  try {
    event = credits.stripeClient().webhooks.constructEvent(
      req.rawBody || Buffer.from(JSON.stringify(req.body || {})),
      req.get("Stripe-Signature"),
      credits.webhookSecret(),
    );
  } catch {
    return res.status(400).json({ success: false, code: "INVALID_WEBHOOK_SIGNATURE", message: "Webhook signature verification failed." });
  }
  try {
    const result = await credits.processStripeEvent(event);
    return res.json({ success: true, received: true, duplicate: result.duplicate === true });
  } catch {
    return res.status(500).json({ success: false, code: "GOODSCAN_WEBHOOK_PROCESSING_FAILED", message: "The verified payment event could not be processed." });
  }
});
router.use(authRequired, requireGoodScanAccess);
router.get("/workspace", async (req, res, next) => {
  try {
    const [workspace, account] = await Promise.all([service.workspace(req.user.id), credits.accountUsage(req.user.id)]);
    workspace.usage.creditsRemaining = account.balance;
    workspace.usage.creditsLimit = null;
    return res.json({ success: true, data: workspace });
  } catch (error) { return next(error); }
});
router.get("/credits", async (req, res, next) => {
  try { return res.json({ success: true, data: await credits.summary(req.user.id) }); } catch (error) { return next(error); }
});
router.post("/credits/checkout-sessions", billingLimiter, async (req, res, next) => {
  try {
    const data = await credits.createCheckoutSession({
      userId: req.user.id,
      productSku: req.body?.productSku,
      idempotencyKey: req.get("Idempotency-Key"),
    });
    return res.status(201).json({ success: true, data });
  } catch (error) { return next(error); }
});
router.post("/ai/quote", quoteLimiter, async (req, res, next) => {
  try { return res.json({ success: true, data: credits.quoteGeneration(req.body?.manifest) }); } catch (error) { return next(error); }
});
router.post("/captures", captureLimiter, upload.fields([{ name: "manifest", maxCount: 1 }, { name: "sources", maxCount: 500 }]), async (req, res, next) => {
  const grouped = req.files || {};
  const manifestFiles = grouped.manifest || [];
  const sources = grouped.sources || [];
  try {
    if (manifestFiles.length !== 1) throw service.serviceError("Exactly one capture manifest is required.");
    const rawManifest = JSON.parse(await fs.promises.readFile(manifestFiles[0].path, "utf8"));
    const asset = await service.createCapture({ userId: req.user.id, manifest: rawManifest, files: sources });
    await cleanup(manifestFiles);
    return res.status(202).json({ success: true, asset });
  } catch (error) {
    await cleanup([...manifestFiles, ...sources]);
    return next(error);
  }
});
router.get("/ai/capabilities", (_req, res) => res.json({
  success: true,
  available: false,
  methods: [],
  operations: [],
  outputFormats: [],
  creditMetering: true,
  quoteEndpoint: "/api/goodscan/v1/ai/quote",
  message: "GoodScan AI generation providers are not configured. Credit quotes and purchases are available; jobs are never charged until a provider accepts them.",
}));
router.post("/ai/generations", (_req, res) => res.status(503).json({
  success: false,
  code: "GOODSCAN_AI_PROVIDER_UNAVAILABLE",
  message: "GoodScan AI generation is not activated. No credits were charged.",
}));

module.exports = router;
