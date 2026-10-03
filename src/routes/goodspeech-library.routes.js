"use strict";

const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { rateLimit } = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const storage = require("../services/storage-v2.service");
const library = require("../services/goodspeech-library.service");
const { requireGoodSpeechAccess } = require("./goodspeech-collaboration.routes");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: library.MAX_ASSET_BYTES },
});
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 240,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

function handle(res, label, operation, status = 200) {
  return Promise.resolve(operation)
    .then((data) => res.status(status).json({ success: true, data }))
    .catch((error) => {
      const statusCode = error.statusCode || (error.code === "LIMIT_FILE_SIZE" ? 413 : 500);
      if (statusCode >= 500) console.error(`[GoodSpeech library] ${label} failed:`, error.message);
      return res.status(statusCode).json({
        success: false,
        code: error.code || "GOODSPEECH_LIBRARY_FAILED",
        message: Number.isInteger(error.statusCode) ? error.message : "GoodSpeech could not complete the library request.",
      });
    });
}

router.use(authRequired, tenantContext, requireGoodSpeechAccess);

router.get("/bootstrap", (req, res) => handle(res, "bootstrap", library.bootstrap({
  context: req.tenantContext,
  userId: req.user.id,
})));

router.put("/state", writeLimiter, (req, res) => handle(res, "state.save", library.saveState({
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
})));

router.post("/assets", writeLimiter, upload.single("file"), (req, res) => handle(res, "asset.upload", library.uploadAsset({
  file: req.file,
  source: req.body?.source,
  metadata: req.body?.metadata,
  context: req.tenantContext,
  userId: req.user.id,
}), 201));

router.get("/assets/:assetId/content", async (req, res) => {
  try {
    const asset = await library.getAsset({ assetId: req.params.assetId, context: req.tenantContext, userId: req.user.id });
    const object = await storage.getFileById(asset.storage_file_id);
    const descriptor = await storage.resolveDownload(object, 300);
    await storage.touchFileAccess(object.id);
    res.set("Cache-Control", "private, no-store");
    res.set("Content-Type", asset.mime_type || "application/octet-stream");
    res.set("Content-Disposition", `attachment; filename="${asset.name.replace(/[\r\n"]/g, "")}"`);
    res.set("X-Content-Type-Options", "nosniff");
    if (descriptor.type === "redirect") return res.redirect(302, descriptor.url);
    return res.sendFile(path.resolve(descriptor.path));
  } catch (error) {
    return handle(res, "asset.content", Promise.reject(error));
  }
});

router.delete("/assets/:assetId", writeLimiter, (req, res) => handle(res, "asset.delete", library.deleteAsset({
  assetId: req.params.assetId,
  context: req.tenantContext,
  userId: req.user.id,
})));

router.post("/history", writeLimiter, upload.single("file"), (req, res) => handle(res, "history.create", library.createHistory({
  file: req.file,
  payload: req.body,
  context: req.tenantContext,
  userId: req.user.id,
}), 201));

router.delete("/history/:historyId", writeLimiter, (req, res) => handle(res, "history.delete", library.deleteHistory({
  historyId: req.params.historyId,
  context: req.tenantContext,
  userId: req.user.id,
})));

module.exports = router;
