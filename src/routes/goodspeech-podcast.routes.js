"use strict";

const path = require("node:path");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const storage = require("../services/storage-v2.service");
const podcasts = require("../services/goodspeech-podcast.service");
const { logAudit } = require("../services/audit.service");
const { requireGoodSpeechAccess } = require("./goodspeech-collaboration.routes");

const router = express.Router();
const publicLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });
const origin = () => String(process.env.GOODBASE_PUBLIC_ORIGIN || "https://base.goodos.app").replace(/\/+$/, "");

function handle(res, label, operation, status = 200) {
  return Promise.resolve(operation).then((data) => res.status(status).json({ success: true, data })).catch((error) => {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error(`[GoodSpeech podcasts] ${label} failed:`, error.message);
    return res.status(statusCode).json({
      success: false,
      code: error.code || "GOODSPEECH_PODCAST_FAILED",
      message: error.statusCode ? error.message : "GoodSpeech could not complete the podcast request.",
    });
  });
}

router.get("/public/:token/feed.xml", publicLimiter, async (req, res) => {
  try {
    const data = await podcasts.publicFeed(req.params.token);
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    res.set("X-Content-Type-Options", "nosniff");
    return res.type("application/rss+xml; charset=utf-8").send(podcasts.rssXml({ ...data, origin: origin() }));
  } catch (error) {
    return handle(res, "feed.public", Promise.reject(error));
  }
});

router.get("/public/:token/episodes/:episodeId/audio", publicLimiter, async (req, res) => {
  try {
    const episode = await podcasts.publicEpisode({ publicToken: req.params.token, episodeId: req.params.episodeId });
    const object = await storage.getFileById(episode.storage_file_id);
    const descriptor = await storage.resolveDownload(object, 300);
    await storage.touchFileAccess(object.id);
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    res.set("Content-Type", episode.mime_type || "application/octet-stream");
    res.set("Content-Disposition", `inline; filename="${String(episode.asset_name || "episode-audio").replace(/[\r\n"]/g, "")}"`);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Accept-Ranges", "bytes");
    if (descriptor.type === "redirect") return res.redirect(302, descriptor.url);
    return res.sendFile(path.resolve(descriptor.path));
  } catch (error) {
    return handle(res, "episode.public", Promise.reject(error));
  }
});

router.use(authRequired, tenantContext, requireGoodSpeechAccess);

router.get("/", (req, res) => handle(res, "feeds.list", podcasts.listFeeds({
  context: req.tenantContext,
  userId: req.user.id,
  origin: origin(),
})));

router.post("/", writeLimiter, async (req, res) => {
  try {
    const result = await podcasts.createFeed({ payload: req.body, context: req.tenantContext, userId: req.user.id, origin: origin() });
    logAudit({ userId: req.user.id, action: "goodspeech.podcast.create", entityType: "goodspeech_podcast_feed", entityId: result.id, ipAddress: req.ip, metadata: { language: result.language } }).catch(() => {});
    return res.status(201).json({ success: true, data: result });
  } catch (error) { return handle(res, "feed.create", Promise.reject(error)); }
});

router.post("/:feedId/episodes", writeLimiter, async (req, res) => {
  try {
    const result = await podcasts.addEpisode({ feedId: req.params.feedId, payload: req.body, context: req.tenantContext, userId: req.user.id });
    logAudit({ userId: req.user.id, action: "goodspeech.podcast.publish", entityType: "goodspeech_podcast_episode", entityId: result.id, ipAddress: req.ip, metadata: { feedId: req.params.feedId, assetId: result.assetId } }).catch(() => {});
    return res.status(201).json({ success: true, data: result });
  } catch (error) { return handle(res, "episode.publish", Promise.reject(error)); }
});

router.delete("/:feedId", writeLimiter, async (req, res) => {
  try {
    const result = await podcasts.revokeFeed({ feedId: req.params.feedId, context: req.tenantContext, userId: req.user.id, origin: origin() });
    logAudit({ userId: req.user.id, action: "goodspeech.podcast.revoke", entityType: "goodspeech_podcast_feed", entityId: result.id, ipAddress: req.ip, metadata: {} }).catch(() => {});
    return res.json({ success: true, data: result });
  } catch (error) { return handle(res, "feed.revoke", Promise.reject(error)); }
});

module.exports = router;
