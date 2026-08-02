"use strict";

const express = require("express");
const database = require("../config/database");
const authRequired = require("../middleware/authRequired");
const { logAudit } = require("../services/audit.service");
const social = require("../services/goodboost-social.service");

const router = express.Router();
const PLATFORMS = new Set(["Facebook","YouTube","TikTok","Instagram","Twitter","LinkedIn","Pinterest","SoundCloud","VKontakte","MySpace","Flickr","Vimeo","Reverbnation","Ok.ru","Ask.fm","Twitch","Website"]);
const INTERACTIONS = new Set(["Like","Follow","View","Share","Comment","Subscribe","Save","Repost","Listen","Join","Connection","Fave","Fan","Retweet"]);

function clean(value, max = 500) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function publicCampaign(row) {
  return {
    id: row.id,
    platform: row.platform,
    url: row.content_url,
    type: row.interaction_type,
    target: row.target,
    current: row.current_count,
    status: row.status,
    targeting: row.targeting_json,
    createdAt: row.created_at,
  };
}

function publicProfile(row) {
  if (!row) return {};
  return {
    tier: row.tier,
    trustScore: row.trust_score,
    dailyStreak: row.daily_streak,
    bonusClaimed: row.bonus_claimed,
    referrals: row.referral_json,
    settings: row.preferences_json,
    whiteLabelConfig: row.white_label_json,
  };
}

function publicPost(row) {
  return { id: row.id, accountId: row.connection_id || undefined, platform: row.platform, content: row.content, mediaUrls: row.media_urls || [], scheduledFor: row.scheduled_for || undefined, publishedAt: row.published_at || undefined, status: row.status, approvalNote: row.approval_note || undefined, providerPostId: row.provider_post_id || undefined, errorReason: row.error_reason || undefined, createdAt: row.created_at, updatedAt: row.updated_at };
}

function publicInboxItem(row) {
  return { id: row.id, accountId: row.connection_id || undefined, platform: row.platform, providerItemId: row.provider_item_id, itemType: row.item_type, authorName: row.author_name, authorUsername: row.author_username || undefined, content: row.content, status: row.status, sentiment: row.sentiment || undefined, assignedTo: row.assigned_to || undefined, receivedAt: row.received_at, respondedAt: row.responded_at || undefined };
}

function publicMetric(row) {
  return { accountId: row.connection_id || undefined, platform: row.platform, recordedAt: row.recorded_at, followers: Number(row.followers || 0), impressions: Number(row.impressions || 0), reach: Number(row.reach || 0), engagements: Number(row.engagements || 0), clicks: Number(row.clicks || 0), videoViews: Number(row.video_views || 0), postsPublished: Number(row.posts_published || 0) };
}

function validCampaignUrl(platform, value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  const domains = {
    Facebook: ["facebook.com"], YouTube: ["youtube.com","youtu.be"], TikTok: ["tiktok.com"],
    Instagram: ["instagram.com"], Twitter: ["x.com","twitter.com"], LinkedIn: ["linkedin.com"],
    Pinterest: ["pinterest.com","pin.it"], SoundCloud: ["soundcloud.com"], VKontakte: ["vk.com"],
    MySpace: ["myspace.com"], Flickr: ["flickr.com"], Vimeo: ["vimeo.com"],
    Reverbnation: ["reverbnation.com"], "Ok.ru": ["ok.ru"], "Ask.fm": ["ask.fm"],
    Twitch: ["twitch.tv"],
  };
  if (platform === "Website") return true;
  return (domains[platform] || []).some(domain => host === domain || host.endsWith(`.${domain}`));
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
    const [profile, campaigns, activity, connectedAccounts] = await Promise.all([
      database.query("SELECT * FROM goodboost_profiles WHERE user_id=$1", [req.user.id]),
      database.query("SELECT * FROM goodboost_campaigns WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500", [req.user.id]),
      database.query(`SELECT date_trunc('day',created_at) AS day,COUNT(*)::int AS count FROM goodboost_activity WHERE user_id=$1 AND created_at>NOW()-INTERVAL '90 days' GROUP BY 1 ORDER BY 1`, [req.user.id]),
      social.connections(req.user.id),
    ]);
    return res.json({
      success: true,
      profile: publicProfile(profile.rows[0]),
      campaigns: campaigns.rows.map(publicCampaign),
      activityLogs: activity.rows.map(row => ({ date: row.day, count: row.count })),
      connectedAccounts,
    });
  } catch (error) { return next(error); }
});

router.get("/social/providers", (_req, res) => res.json({ success: true, providers: social.providers() }));
router.get("/social/connections", async (req, res, next) => {
  try { return res.json({ success: true, connections: await social.connections(req.user.id) }); } catch (error) { return next(error); }
});
router.post("/social/connections", async (req, res, next) => {
  try { return res.json({ success: true, authorizationUrl: social.authorizationUrl(req.user.id, req.body?.platform) }); } catch (error) { return next(error); }
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
    const relationship = await social.action(req.user.id, req.params.id, clean(req.body?.action, 20), clean(req.get("Idempotency-Key"), 200), req.body?.dailyLimit);
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
    return res.json({ success: true, posts: posts.rows.map(publicPost), inbox: inbox.rows.map(publicInboxItem), metrics: metrics.rows.map(publicMetric), providerConfigured: social.providers().some(provider => provider.available) });
  } catch (error) { return next(error); }
});

router.post("/publishing/posts", async (req, res, next) => {
  try {
    const platform = clean(req.body?.platform, 40); const content = clean(req.body?.content, 5000); const status = clean(req.body?.status, 30); const idempotencyKey = clean(req.get("Idempotency-Key"), 200);
    const allowedStatuses = new Set(["draft","pending_approval","scheduled"]);
    if (!platform || content.length < 2 || !allowedStatuses.has(status) || !idempotencyKey) return res.status(400).json({ success: false, code: "GOODBOOST_POST_INVALID", message: "Platform, content, status, and Idempotency-Key are required." });
    const scheduledFor = req.body?.scheduledFor ? new Date(req.body.scheduledFor) : null;
    if (status === "scheduled" && (!scheduledFor || Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() <= Date.now())) return res.status(400).json({ success: false, code: "GOODBOOST_SCHEDULE_INVALID", message: "Scheduled posts require a future publishing time." });
    const mediaUrls = Array.isArray(req.body?.mediaUrls) ? req.body.mediaUrls.map(value => clean(value, 2048)).filter(value => { try { return new URL(value).protocol === "https:"; } catch { return false; } }).slice(0, 20) : [];
    const accountId = req.body?.accountId || null;
    if (accountId) { const account = await database.query("SELECT id FROM goodboost_social_connections WHERE id=$1 AND user_id=$2 AND status='active'", [accountId, req.user.id]); if (!account.rows[0]) return res.status(404).json({ success: false, code: "GOODBOOST_CONNECTION_NOT_FOUND", message: "Connected account not found." }); }
    const result = await database.query(`INSERT INTO goodboost_publishing_posts(user_id,connection_id,platform,content,media_urls,scheduled_for,status,idempotency_key) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT(user_id,idempotency_key) DO UPDATE SET updated_at=NOW() RETURNING *`, [req.user.id, accountId, platform, content, JSON.stringify(mediaUrls), scheduledFor, status, idempotencyKey]);
    await logAudit({ userId: req.user.id, appId: "goodboost", action: "goodboost.post.create", entityType: "publishing_post", entityId: result.rows[0].id, ipAddress: req.ip, metadata: { platform, status } }).catch(() => {});
    return res.status(201).json({ success: true, post: publicPost(result.rows[0]) });
  } catch (error) { return next(error); }
});

router.patch("/publishing/posts/:id", async (req, res, next) => {
  try {
    const found = await database.query("SELECT * FROM goodboost_publishing_posts WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]); if (!found.rows[0]) return res.status(404).json({ success: false, message: "Publishing post not found." });
    const current = found.rows[0]; const status = req.body?.status ? clean(req.body.status, 30) : current.status; const allowed = new Set(["draft","pending_approval","scheduled","publishing","published","failed"]); if (!allowed.has(status)) return res.status(400).json({ success: false, message: "Publishing status is invalid." });
    const content = req.body?.content === undefined ? current.content : clean(req.body.content, 5000); const approvalNote = req.body?.approvalNote === undefined ? current.approval_note : clean(req.body.approvalNote, 1000); const scheduledFor = req.body?.scheduledFor === undefined ? current.scheduled_for : req.body.scheduledFor ? new Date(req.body.scheduledFor) : null;
    const result = await database.query("UPDATE goodboost_publishing_posts SET content=$1,scheduled_for=$2,status=$3,approval_note=$4,updated_at=NOW() WHERE id=$5 AND user_id=$6 RETURNING *", [content, scheduledFor, status, approvalNote, req.params.id, req.user.id]);
    return res.json({ success: true, post: publicPost(result.rows[0]) });
  } catch (error) { return next(error); }
});

router.patch("/inbox/:id", async (req, res, next) => {
  try { const status = clean(req.body?.status, 20); if (!["unread","open","resolved","archived"].includes(status)) return res.status(400).json({ success: false, message: "Inbox status is invalid." }); const result = await database.query("UPDATE goodboost_inbox_items SET status=$1,responded_at=CASE WHEN $1='resolved' THEN COALESCE(responded_at,NOW()) ELSE responded_at END,updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING *", [status, req.params.id, req.user.id]); if (!result.rows[0]) return res.status(404).json({ success: false, message: "Inbox item not found." }); return res.json({ success: true, item: publicInboxItem(result.rows[0]) }); } catch (error) { return next(error); }
});

router.get("/reports/export", async (req, res, next) => {
  try { const format = req.query.format === "csv" ? "csv" : "json"; const metrics = await database.query("SELECT * FROM goodboost_metric_snapshots WHERE user_id=$1 ORDER BY recorded_at DESC LIMIT 10000", [req.user.id]); const data = metrics.rows.map(publicMetric); res.setHeader("Content-Disposition", `attachment; filename=goodboost-report.${format}`); res.setHeader("Cache-Control", "private, no-store"); if (format === "json") return res.type("application/json").send(JSON.stringify({ generatedAt: new Date().toISOString(), metrics: data }, null, 2)); const fields = ["platform","recordedAt","followers","impressions","reach","engagements","clicks","videoViews","postsPublished"]; const csv = [fields.join(","), ...data.map(row => fields.map(field => JSON.stringify(row[field] ?? "")).join(","))].join("\n"); return res.type("text/csv").send(csv); } catch (error) { return next(error); }
});

router.post("/campaigns", async (req, res, next) => {
  try {
    const platform = clean(req.body?.platform, 40);
    const interaction = clean(req.body?.type, 40);
    const target = Number(req.body?.target);
    const url = clean(req.body?.url, 2048);
    const targeting = req.body?.targeting && typeof req.body.targeting === "object" ? req.body.targeting : {};
    if (!PLATFORMS.has(platform) || !INTERACTIONS.has(interaction) || !Number.isInteger(target) || target < 10 || target > 1000 || !validCampaignUrl(platform, url)) {
      return res.status(400).json({ success: false, code: "INVALID_CAMPAIGN", message: "Campaign platform, URL, interaction, or target is invalid." });
    }
    const safeTargeting = {
      countries: Array.isArray(targeting.countries) ? targeting.countries.map(value => clean(value, 80)).filter(Boolean).slice(0, 25) : [],
      interests: Array.isArray(targeting.interests) ? targeting.interests.map(value => clean(value, 80)).filter(Boolean).slice(0, 25) : [],
      verifiedOnly: targeting.verifiedOnly === true,
    };
    const result = await database.query(
      `INSERT INTO goodboost_campaigns(user_id,platform,content_url,interaction_type,target,targeting_json)
       VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [req.user.id, platform, url, interaction, target, JSON.stringify(safeTargeting)]
    );
    await logAudit({ userId: req.user.id, appId: "goodboost", action: "goodboost.campaign.create", entityType: "campaign", entityId: result.rows[0].id, ipAddress: req.ip, metadata: { platform, interaction, target } }).catch(() => {});
    return res.status(201).json({ success: true, campaign: publicCampaign(result.rows[0]) });
  } catch (error) { return next(error); }
});

router.post("/activity", async (req, res, next) => {
  const client = await database.pool.connect();
  try {
    const description = clean(req.body?.description, 240);
    if (description.length < 2) return res.status(400).json({ success: false, message: "Activity description is required." });
    await client.query("BEGIN");
    await client.query("INSERT INTO goodboost_activity(user_id,description) VALUES($1,$2)", [req.user.id, description]);
    const boosted = await client.query(
      `UPDATE goodboost_campaigns SET current_count=LEAST(target,current_count+1),
       status=CASE WHEN current_count+1>=target THEN 'Completed' ELSE status END,updated_at=NOW()
       WHERE id=(SELECT id FROM goodboost_campaigns WHERE user_id=$1 AND status='Active' AND current_count<target ORDER BY created_at LIMIT 1)
       RETURNING *`, [req.user.id]
    );
    await client.query("COMMIT");
    const campaigns = await database.query("SELECT * FROM goodboost_campaigns WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500", [req.user.id]);
    return res.json({ success: true, user: {}, boostedCampaign: boosted.rows[0] ? publicCampaign(boosted.rows[0]) : null, campaigns: campaigns.rows.map(publicCampaign) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally { client.release(); }
});

router.patch("/profile", async (req, res, next) => {
  try {
    const settings = req.body?.settings && typeof req.body.settings === "object" ? req.body.settings : {};
    const webhook = clean(settings.webhookUrl, 2048);
    if (webhook) {
      let parsed;
      try { parsed = new URL(webhook); } catch { return res.status(400).json({ success: false, message: "Webhook URL is invalid." }); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return res.status(400).json({ success: false, message: "Webhook URL must use HTTPS and cannot contain credentials." });
    }
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
