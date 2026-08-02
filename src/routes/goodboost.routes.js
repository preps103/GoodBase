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
