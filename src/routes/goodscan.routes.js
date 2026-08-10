"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const authRequired = require("../middleware/authRequired");
const service = require("../services/goodscan.service");
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

async function cleanup(files) {
  await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
}

router.get("/health", (_req, res) => res.json({ success: true, status: "online", service: "goodscan", storage: "private" }));
router.use(authRequired, requireGoodScanAccess);
router.get("/workspace", async (req, res, next) => {
  try { return res.json({ success: true, data: await service.workspace(req.user.id) }); } catch (error) { return next(error); }
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
router.get("/ai/capabilities", (_req, res) => res.json({ success: true, available: false, methods: [], operations: [], outputFormats: [], message: "GoodScan AI generation providers are not configured." }));

module.exports = router;
