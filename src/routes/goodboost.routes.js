"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const net = require("node:net");
const database = require("../config/database");
const authRequired = require("../middleware/authRequired");
const { logAudit } = require("../services/audit.service");
const social = require("../services/goodboost-social.service");
const ai = require("../services/goodbase-ai.service");

const router = express.Router();
const aiLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { success: false, code: "GOODBOOST_AI_RATE_LIMITED", message: "AI requests are temporarily rate limited." } });

function clean(value, max = 500) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function privileged(user) {
  return ["owner", "admin", "super_admin", "superadmin"].includes(
    String(user?.platformRole || user?.platform_role || user?.role || "").toLowerCase(),
  );
}

function requireGoodBoostAccess(req, res, next) {
  const entitled = (req.apps || []).some(app => {
    const id = String(app.id || app.appId || app.slug || app.name || "").toLowerCase().replace(/\s+/g, "");
    const domain = String(app.domain || "").toLowerCase();
    const membership = String(app.membershipStatus || app.membership_status || "active").toLowerCase();
    const status = String(app.appStatus || app.status || "active").toLowerCase();
    return (["goodboost", "good-boost", "boost"].includes(id) || domain === "boost.goodos.app") && membership === "active" && status === "active";
  });
  if (!privileged(req.user) && !entitled) return res.status(403).json({ success: false, code: "GOODBOOST_ACCESS_REQUIRED", message: "Your GoodOS account does not have access to GoodBoost." });
  return next();
}

function safePublicHttpsUrl(value) {
  try {
    const url = new URL(clean(value, 2048));
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
    if (net.isIP(host) === 6) return false;
    if (net.isIP(host) === 4) {
      const [a, b] = host.split(".").map(Number);
      if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function publicProfile(row) {
  if (!row) return {};
  return {
    settings: row.preferences_json,
  };
}

function publicPost(row) {
  return { id: row.id, accountId: row.connection_id || undefined, platform: row.platform, content: row.content, mediaUrls: row.media_urls || [], scheduledFor: row.scheduled_for || undefined, publishedAt: row.published_at || undefined, status: row.status, approvalNote: row.approval_note || undefined, providerPostId: row.provider_post_id || undefined, errorReason: row.error_reason || undefined, attempts: Number(row.attempts || 0), maxAttempts: Number(row.max_attempts || 5), createdAt: row.created_at, updatedAt: row.updated_at };
}

function publicInboxItem(row) {
  return { id: row.id, accountId: row.connection_id || undefined, platform: row.platform, providerItemId: row.provider_item_id, itemType: row.item_type, authorName: row.author_name, authorUsername: row.author_username || undefined, content: row.content, status: row.status, sentiment: row.sentiment || undefined, assignedTo: row.assigned_to || undefined, receivedAt: row.received_at, respondedAt: row.responded_at || undefined };
}

function publicMetric(row) {
  return { accountId: row.connection_id || undefined, platform: row.platform, recordedAt: row.recorded_at, followers: Number(row.followers || 0), impressions: Number(row.impressions || 0), reach: Number(row.reach || 0), engagements: Number(row.engagements || 0), clicks: Number(row.clicks || 0), videoViews: Number(row.video_views || 0), postsPublished: Number(row.posts_published || 0) };
}

router.get("/social/callback/:platform", async (req, res) => {
  try {
    await social.callback(req.params.platform, req.query.code, req.query.state);
    return res.redirect(302, "https://boost.goodos.app/?social=connected");
  } catch (error) {
    const message = encodeURIComponent(error.statusCode ? error.message : "Social account connection failed.");
    return res.redirect(302, `https://boost.goodos.app/?social=error&message=${message}`);
  }
});

router.use(authRequired);
router.use(requireGoodBoostAccess);
router.use((req, res, next) => {
  const origin = clean(req.get("Origin"), 300);
  const expected = process.env.GOODBOOST_ORIGIN || "https://boost.goodos.app";
  const developmentOrigin = process.env.NODE_ENV !== "production" && /^https?:\/\/localhost(?::\d+)?$/.test(origin);
  if (origin && origin !== expected && !developmentOrigin) {
    return res.status(403).json({ success: false, code: "GOODBOOST_ORIGIN_DENIED", message: "Request origin is not allowed." });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("X-Requested-With") !== "GoodBoost") {
    return res.status(403).json({ success: false, code: "GOODBOOST_REQUEST_HEADER_REQUIRED", message: "Required request header is missing." });
  }
  return next();
});

router.get("/bootstrap", async (req, res, next) => {
  try {
    await database.query("INSERT INTO goodboost_profiles(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING", [req.user.id]);
    const [profile, connectedAccounts] = await Promise.all([
      database.query("SELECT * FROM goodboost_profiles WHERE user_id=$1", [req.user.id]),
      social.connections(req.user.id),
    ]);
    return res.json({
      success: true,
      profile: publicProfile(profile.rows[0]),
      connectedAccounts,
    });
  } catch (error) { return next(error); }
});

router.get("/social/providers", (_req, res) => res.json({ success: true, providers: social.providers() }));
router.get("/readiness", async (_req, res, next) => {
  try { return res.json({ success: true, ...(await social.operationalReadiness()) }); } catch (error) { return next(error); }
});
router.post("/ai/strategy", aiLimiter, async (req, res, next) => {
  try {
    const platform = clean(req.body?.platform, 40);
    const topic = clean(req.body?.topic, 4000);
    const tone = clean(req.body?.tone, 80);
    const idempotencyKey = clean(req.get("Idempotency-Key"), 160);
    const supported = social.providers().some(provider => provider.platform === platform);
    if (!supported || topic.length < 2 || !["Professional","Funny","Inspirational","Educational","Conversational","Minimalist"].includes(tone) || !idempotencyKey) {
      return res.status(400).json({ success: false, code: "GOODBOOST_AI_INPUT_INVALID", message: "A supported platform, topic, tone, and Idempotency-Key are required." });
    }
    const result = await ai.generate({
      scope: { organizationId: "org_goodos", projectId: "proj_goodos_platform", environmentId: "env_goodos_production" },
      userId: req.user.id,
      attestationToken: "",
      idempotencyKey,
      body: {
        appId: "goodboost",
        model: "goodboost-growth",
        temperature: 0.6,
        maxOutputTokens: 900,
        prompt: `Create a safe, policy-compliant social content strategy for ${platform}. Topic: ${topic}. Tone: ${tone}. Return JSON with title, content, and hashtags.`,
        input: { platform, topic, tone },
        outputSchema: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, content: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } }, required: ["title","content","hashtags"] },
      },
    });
    return res.status(result.duplicate ? 200 : 201).json({ success: true, ...result });
  } catch (error) { return next(error); }
});
router.get("/social/connections", async (req, res, next) => {
  try { return res.json({ success: true, connections: await social.connections(req.user.id) }); } catch (error) { return next(error); }
});
router.post("/social/connections", async (req, res, next) => {
  try { return res.json({ success: true, authorizationUrl: await social.authorizationUrl(req.user.id, req.body?.platform) }); } catch (error) { return next(error); }
});
router.delete("/social/connections/:id", async (req, res, next) => {
  try { return res.json({ success: true, ...(await social.disconnect(req.user.id, req.params.id)) }); } catch (error) { return next(error); }
});
router.post("/social/connections/:id/sync", async (req, res, next) => {
  try { return res.json({ success: true, connection: await social.sync(req.user.id, req.params.id) }); } catch (error) { return next(error); }
});
router.get("/social/relationships", async (req, res, next) => {
  try { return res.json({ success: true, ...(await social.relationships(req.user.id, req.query.accountId, req.query.status)) }); } catch (error) { return next(error); }
});
router.post("/social/relationships/:id/actions", async (req, res, next) => {
  try {
    if (req.body?.confirmation !== true) return res.status(400).json({ success: false, code: "GOODBOOST_CONFIRMATION_REQUIRED", message: "Confirm this provider action before submitting it." });
    const relationship = await social.action(req.user.id, req.params.id, clean(req.body?.action, 20), clean(req.get("Idempotency-Key"), 200));
    return res.json({ success: true, relationship });
  } catch (error) { return next(error); }
});

router.get("/operations", async (req, res, next) => {
  try {
    const [posts, inbox, metrics] = await Promise.all([
      database.query("SELECT * FROM goodboost_publishing_posts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500", [req.user.id]),
      database.query("SELECT * FROM goodboost_inbox_items WHERE user_id=$1 ORDER BY received_at DESC LIMIT 500", [req.user.id]),
      database.query("SELECT * FROM goodboost_metric_snapshots WHERE user_id=$1 ORDER BY recorded_at DESC LIMIT 1000", [req.user.id]),
    ]);
    const readiness = await social.operationalReadiness();
    return res.json({ success: true, posts: posts.rows.map(publicPost), inbox: inbox.rows.map(publicInboxItem), metrics: metrics.rows.map(publicMetric), providerConfigured: readiness.publishingPlatforms.length > 0, publishingPlatforms: readiness.publishingPlatforms, syncWorkerReady: readiness.syncWorkerReady });
  } catch (error) { return next(error); }
});

router.post("/publishing/posts", async (req, res, next) => {
  try {
    const platform = clean(req.body?.platform, 40); const content = clean(req.body?.content, 5000); const status = clean(req.body?.status, 30); const idempotencyKey = clean(req.get("Idempotency-Key"), 200);
    const allowedStatuses = new Set(["draft","pending_approval","scheduled"]);
    if (!platform || content.length < 2 || !allowedStatuses.has(status) || !idempotencyKey) return res.status(400).json({ success: false, code: "GOODBOOST_POST_INVALID", message: "Platform, content, status, and Idempotency-Key are required." });
    const scheduledFor = req.body?.scheduledFor ? new Date(req.body.scheduledFor) : null;
    if (status === "scheduled" && (!scheduledFor || Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() <= Date.now())) return res.status(400).json({ success: false, code: "GOODBOOST_SCHEDULE_INVALID", message: "Scheduled posts require a future publishing time." });
    if (status === "scheduled" && !(await social.publishingReadiness(platform)).configured) return res.status(503).json({ success: false, code: "GOODBOOST_PUBLISHING_NOT_CONFIGURED", message: "Publishing or its delivery worker is not configured for this provider. Save this content as a draft instead." });
    const mediaUrls = Array.isArray(req.body?.mediaUrls) ? req.body.mediaUrls.map(value => clean(value, 2048)).filter(safePublicHttpsUrl).slice(0, 20) : [];
    const accountId = req.body?.accountId || null;
    if (status !== "draft" && !accountId) return res.status(400).json({ success: false, code: "GOODBOOST_CONNECTION_REQUIRED", message: "Choose a connected account before submitting or scheduling content." });
    if (accountId) { const account = await database.query("SELECT id,platform FROM goodboost_social_connections WHERE id=$1 AND user_id=$2 AND status='active'", [accountId, req.user.id]); if (!account.rows[0]) return res.status(404).json({ success: false, code: "GOODBOOST_CONNECTION_NOT_FOUND", message: "Connected account not found." }); if (String(account.rows[0].platform).toLowerCase() !== platform.toLowerCase().replace(/[^a-z0-9]/g, "_")) return res.status(400).json({ success: false, code: "GOODBOOST_PLATFORM_MISMATCH", message: "The selected account does not match the post platform." }); }
    const result = await database.query(`INSERT INTO goodboost_publishing_posts(user_id,connection_id,platform,content,media_urls,scheduled_for,status,idempotency_key) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT(user_id,idempotency_key) DO UPDATE SET updated_at=NOW() RETURNING *`, [req.user.id, accountId, platform, content, JSON.stringify(mediaUrls), scheduledFor, status, idempotencyKey]);
    await logAudit({ userId: req.user.id, appId: "goodboost", action: "goodboost.post.create", entityType: "publishing_post", entityId: result.rows[0].id, ipAddress: req.ip, metadata: { platform, status } }).catch(() => {});
    return res.status(201).json({ success: true, post: publicPost(result.rows[0]) });
  } catch (error) { return next(error); }
});

router.patch("/publishing/posts/:id", async (req, res, next) => {
  try {
    const found = await database.query("SELECT * FROM goodboost_publishing_posts WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]); if (!found.rows[0]) return res.status(404).json({ success: false, message: "Publishing post not found." });
    const current = found.rows[0]; const status = req.body?.status ? clean(req.body.status, 30) : current.status; const allowed = new Set(["draft","pending_approval","scheduled"]); if (!allowed.has(status)) return res.status(400).json({ success: false, message: "Publishing status is invalid." });
    if (status === "scheduled" && !(await social.publishingReadiness(current.platform)).configured) return res.status(503).json({ success: false, code: "GOODBOOST_PUBLISHING_NOT_CONFIGURED", message: "Publishing or its delivery worker is not configured for this provider. Keep this content as a draft." });
    if (current.status === "pending_approval" && status !== "pending_approval" && !privileged(req.user)) return res.status(403).json({ success: false, code: "GOODBOOST_APPROVAL_REQUIRED", message: "An owner or administrator must approve this post." });
    const content = req.body?.content === undefined ? current.content : clean(req.body.content, 5000); const approvalNote = req.body?.approvalNote === undefined ? current.approval_note : clean(req.body.approvalNote, 1000); const scheduledFor = req.body?.scheduledFor === undefined ? current.scheduled_for : req.body.scheduledFor ? new Date(req.body.scheduledFor) : null;
    if (content.length < 2) return res.status(400).json({ success: false, message: "Post content is required." });
    if (status === "scheduled" && (!scheduledFor || Number.isNaN(new Date(scheduledFor).getTime()) || new Date(scheduledFor).getTime() <= Date.now())) return res.status(400).json({ success: false, code: "GOODBOOST_SCHEDULE_INVALID", message: "Scheduled posts require a future publishing time." });
    const result = await database.query("UPDATE goodboost_publishing_posts SET content=$1,scheduled_for=$2,status=$3,approval_note=$4,updated_at=NOW() WHERE id=$5 AND user_id=$6 RETURNING *", [content, scheduledFor, status, approvalNote, req.params.id, req.user.id]);
    return res.json({ success: true, post: publicPost(result.rows[0]) });
  } catch (error) { return next(error); }
});

router.delete("/publishing/posts/:id", async (req, res, next) => {
  try {
    const result = await database.query("UPDATE goodboost_publishing_posts SET status='cancelled',locked_by=NULL,locked_until=NULL,error_reason=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status IN ('draft','pending_approval','scheduled') RETURNING *", [req.params.id, req.user.id]);
    if (!result.rows[0]) return res.status(409).json({ success: false, code: "GOODBOOST_POST_NOT_CANCELLABLE", message: "This post is already publishing, completed, failed, cancelled, or unavailable." });
    await logAudit({ userId: req.user.id, appId: "goodboost", action: "goodboost.post.cancel", entityType: "publishing_post", entityId: result.rows[0].id, ipAddress: req.ip, metadata: { status: "cancelled" } }).catch(() => {});
    return res.json({ success: true, post: publicPost(result.rows[0]) });
  } catch (error) { return next(error); }
});

router.post("/publishing/posts/:id/retry", async (req, res, next) => {
  try {
    const found = await database.query("SELECT * FROM goodboost_publishing_posts WHERE id=$1 AND user_id=$2 AND status='failed'", [req.params.id, req.user.id]);
    const current = found.rows[0];
    if (!current) return res.status(409).json({ success: false, code: "GOODBOOST_POST_NOT_RETRYABLE", message: "Only failed posts can be retried." });
    if (!(await social.publishingReadiness(current.platform)).configured) return res.status(503).json({ success: false, code: "GOODBOOST_PUBLISHING_NOT_CONFIGURED", message: "Publishing or its delivery worker is not configured for this provider." });
    const account = await database.query("SELECT id FROM goodboost_social_connections WHERE id=$1 AND user_id=$2 AND status='active'", [current.connection_id, req.user.id]);
    if (!account.rows[0]) return res.status(409).json({ success: false, code: "GOODBOOST_CONNECTION_REQUIRED", message: "Reconnect the publishing account before retrying this post." });
    const result = await database.query("UPDATE goodboost_publishing_posts SET status='scheduled',scheduled_for=NOW(),available_at=NOW(),attempts=0,locked_by=NULL,locked_until=NULL,error_reason=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='failed' RETURNING *", [req.params.id, req.user.id]);
    await logAudit({ userId: req.user.id, appId: "goodboost", action: "goodboost.post.retry", entityType: "publishing_post", entityId: result.rows[0].id, ipAddress: req.ip, metadata: { platform: result.rows[0].platform } }).catch(() => {});
    return res.json({ success: true, post: publicPost(result.rows[0]) });
  } catch (error) { return next(error); }
});

router.patch("/inbox/:id", async (req, res, next) => {
  try { const status = clean(req.body?.status, 20); if (!["unread","open","resolved","archived"].includes(status)) return res.status(400).json({ success: false, message: "Inbox status is invalid." }); const result = await database.query("UPDATE goodboost_inbox_items SET status=$1,responded_at=CASE WHEN $1='resolved' THEN COALESCE(responded_at,NOW()) ELSE responded_at END,updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING *", [status, req.params.id, req.user.id]); if (!result.rows[0]) return res.status(404).json({ success: false, message: "Inbox item not found." }); return res.json({ success: true, item: publicInboxItem(result.rows[0]) }); } catch (error) { return next(error); }
});

router.get("/reports/export", async (req, res, next) => {
  try { const format = req.query.format === "csv" ? "csv" : "json"; const metrics = await database.query("SELECT * FROM goodboost_metric_snapshots WHERE user_id=$1 ORDER BY recorded_at DESC LIMIT 10000", [req.user.id]); const data = metrics.rows.map(publicMetric); res.setHeader("Content-Disposition", `attachment; filename=goodboost-report.${format}`); res.setHeader("Cache-Control", "private, no-store"); if (format === "json") return res.type("application/json").send(JSON.stringify({ generatedAt: new Date().toISOString(), metrics: data }, null, 2)); const fields = ["platform","recordedAt","followers","impressions","reach","engagements","clicks","videoViews","postsPublished"]; const csv = [fields.join(","), ...data.map(row => fields.map(field => JSON.stringify(row[field] ?? "")).join(","))].join("\n"); return res.type("text/csv").send(csv); } catch (error) { return next(error); }
});

router.patch("/profile", async (req, res, next) => {
  try {
    const settings = req.body?.settings && typeof req.body.settings === "object" ? req.body.settings : {};
    const webhook = clean(settings.webhookUrl, 2048);
    if (webhook && !safePublicHttpsUrl(webhook)) return res.status(400).json({ success: false, message: "Webhook URL must use a public HTTPS address without credentials or a custom port." });
    const safeSettings = {
      emailNotifications: settings.emailNotifications !== false,
      dailyReports: settings.dailyReports !== false,
      onboardingCompleted: settings.onboardingCompleted === true,
      onboardingVersion: settings.onboardingCompleted === true ? 1 : 0,
      webhookUrl: webhook || undefined,
      automationDailyLimit: Math.min(200, Math.max(5, Number(settings.automationDailyLimit) || 25)),
    };
    const result = await database.query(
      `INSERT INTO goodboost_profiles(user_id,preferences_json) VALUES($1,$2::jsonb)
       ON CONFLICT(user_id) DO UPDATE SET preferences_json=$2::jsonb,updated_at=NOW() RETURNING *`,
      [req.user.id, JSON.stringify(safeSettings)]
    );
    return res.json({ success: true, profile: publicProfile(result.rows[0]) });
  } catch (error) { return next(error); }
});

module.exports = router;
