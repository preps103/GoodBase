"use strict";

const crypto = require("node:crypto");
const { query } = require("../config/database");

const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/ogg", "audio/webm", "audio/mp4", "audio/aac", "audio/flac"]);

function podcastError(message, statusCode = 400, code = "GOODSPEECH_PODCAST_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

function text(value, maximum, fallback = "") {
  return String(value || "").trim().slice(0, maximum) || fallback;
}

function uuid(value, label = "ID") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw podcastError(`A valid ${label} is required.`, 400, "GOODSPEECH_PODCAST_ID_INVALID");
  }
  return normalized;
}

function token(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(normalized)) {
    throw podcastError("Podcast feed not found.", 404, "GOODSPEECH_PODCAST_NOT_FOUND");
  }
  return normalized;
}

function publicOrigin(value) {
  try {
    const url = new URL(String(value || "https://base.goodos.app"));
    if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("HTTPS required");
    return url.origin;
  } catch {
    return "https://base.goodos.app";
  }
}

function feedRecord(row, origin) {
  const base = `${publicOrigin(origin)}/api/goodspeech/v1/podcasts/public/${row.public_token}`;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    author: row.author,
    language: row.language,
    status: row.status,
    episodeCount: Number(row.episode_count || 0),
    feedUrl: `${base}/feed.xml`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function episodeRecord(row) {
  return {
    id: row.id,
    assetId: row.asset_id,
    title: row.title,
    description: row.description,
    episodeNumber: row.episode_number === null ? null : Number(row.episode_number),
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    publishedAt: row.published_at,
  };
}

async function listFeeds({ context, userId, origin }) {
  const result = await query(
    `SELECT f.*, COUNT(e.id)::integer AS episode_count
     FROM goodspeech_podcast_feeds f
     LEFT JOIN goodspeech_podcast_episodes e ON e.feed_id = f.id
     WHERE f.organization_id = $1 AND f.owner_user_id = $2::uuid
     GROUP BY f.id ORDER BY f.created_at DESC LIMIT 50`,
    [context.organizationId, userId],
  );
  return result.rows.map((row) => feedRecord(row, origin));
}

async function createFeed({ payload, context, userId, origin }) {
  const title = text(payload?.title, 120);
  if (!title) throw podcastError("Add a feed title before publishing.", 400, "GOODSPEECH_PODCAST_TITLE_REQUIRED");
  const result = await query(
    `INSERT INTO goodspeech_podcast_feeds (
       organization_id, project_id, environment_id, owner_user_id, public_token,
       title, description, author, language
     ) VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9) RETURNING *`,
    [context.organizationId, context.projectId, context.environmentId, userId,
      crypto.randomBytes(32).toString("base64url"), title, text(payload?.description, 1000),
      text(payload?.author, 120, "GoodSpeech creator"), text(payload?.language, 20, "en-us").toLowerCase()],
  );
  return feedRecord({ ...result.rows[0], episode_count: 0 }, origin);
}

async function ownedFeed({ feedId, context, userId }) {
  const result = await query(
    `SELECT * FROM goodspeech_podcast_feeds
     WHERE id = $1::uuid AND organization_id = $2 AND owner_user_id = $3::uuid LIMIT 1`,
    [uuid(feedId, "feed ID"), context.organizationId, userId],
  );
  if (!result.rows[0]) throw podcastError("Podcast feed not found.", 404, "GOODSPEECH_PODCAST_NOT_FOUND");
  return result.rows[0];
}

async function addEpisode({ feedId, payload, context, userId }) {
  const feed = await ownedFeed({ feedId, context, userId });
  if (feed.status !== "active") throw podcastError("This podcast feed has been revoked.", 409, "GOODSPEECH_PODCAST_REVOKED");
  const assetId = uuid(payload?.assetId, "asset ID");
  const assetResult = await query(
    `SELECT * FROM goodspeech_assets
     WHERE id = $1::uuid AND organization_id = $2 AND owner_user_id = $3::uuid AND deleted_at IS NULL LIMIT 1`,
    [assetId, context.organizationId, userId],
  );
  const asset = assetResult.rows[0];
  if (!asset) throw podcastError("Audio asset not found.", 404, "GOODSPEECH_PODCAST_ASSET_NOT_FOUND");
  if (!AUDIO_TYPES.has(asset.mime_type)) throw podcastError("Only audio assets can be published to an RSS feed.", 415, "GOODSPEECH_PODCAST_AUDIO_REQUIRED");
  const title = text(payload?.title, 180);
  if (!title) throw podcastError("Add an episode title before publishing.", 400, "GOODSPEECH_PODCAST_EPISODE_TITLE_REQUIRED");
  const episodeNumber = payload?.episodeNumber === null || payload?.episodeNumber === undefined || payload?.episodeNumber === ""
    ? null : Math.floor(Number(payload.episodeNumber));
  if (episodeNumber !== null && (!Number.isInteger(episodeNumber) || episodeNumber < 1 || episodeNumber > 1000000)) {
    throw podcastError("Episode number must be between 1 and 1,000,000.");
  }
  const duration = Number(payload?.durationSeconds);
  const durationSeconds = Number.isFinite(duration) && duration >= 0 ? Math.min(duration, 31536000) : null;
  try {
    const result = await query(
      `INSERT INTO goodspeech_podcast_episodes (
         feed_id, organization_id, owner_user_id, asset_id, title, description, episode_number, duration_seconds
       ) VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7,$8) RETURNING *`,
      [feed.id, context.organizationId, userId, asset.id, title, text(payload?.description, 2000), episodeNumber, durationSeconds],
    );
    return episodeRecord(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") throw podcastError("This audio asset is already published in the feed.", 409, "GOODSPEECH_PODCAST_DUPLICATE");
    throw error;
  }
}

async function revokeFeed({ feedId, context, userId, origin }) {
  const feed = await ownedFeed({ feedId, context, userId });
  const result = await query(
    `UPDATE goodspeech_podcast_feeds SET status = 'revoked', updated_at = NOW()
     WHERE id = $1::uuid RETURNING *`, [feed.id],
  );
  return feedRecord({ ...result.rows[0], episode_count: 0 }, origin);
}

async function publicFeed(publicToken) {
  const result = await query(
    `SELECT f.*, COUNT(e.id)::integer AS episode_count
     FROM goodspeech_podcast_feeds f
     LEFT JOIN goodspeech_podcast_episodes e ON e.feed_id = f.id
     WHERE f.public_token = $1 AND f.status = 'active'
     GROUP BY f.id LIMIT 1`, [token(publicToken)],
  );
  if (!result.rows[0]) throw podcastError("Podcast feed not found.", 404, "GOODSPEECH_PODCAST_NOT_FOUND");
  const episodes = await query(
    `SELECT e.*, a.name AS asset_name, a.mime_type, a.size_bytes
     FROM goodspeech_podcast_episodes e
     JOIN goodspeech_assets a ON a.id = e.asset_id AND a.deleted_at IS NULL
     WHERE e.feed_id = $1::uuid ORDER BY e.published_at DESC, e.created_at DESC`,
    [result.rows[0].id],
  );
  return { feed: result.rows[0], episodes: episodes.rows };
}

async function publicEpisode({ publicToken, episodeId }) {
  const result = await query(
    `SELECT e.*, a.storage_file_id, a.name AS asset_name, a.mime_type, a.size_bytes
     FROM goodspeech_podcast_episodes e
     JOIN goodspeech_podcast_feeds f ON f.id = e.feed_id AND f.status = 'active'
     JOIN goodspeech_assets a ON a.id = e.asset_id AND a.deleted_at IS NULL
     WHERE f.public_token = $1 AND e.id = $2::uuid LIMIT 1`,
    [token(publicToken), uuid(episodeId, "episode ID")],
  );
  if (!result.rows[0]) throw podcastError("Podcast episode not found.", 404, "GOODSPEECH_PODCAST_EPISODE_NOT_FOUND");
  return result.rows[0];
}

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}

function duration(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  return `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function rssXml({ feed, episodes, origin }) {
  const base = `${publicOrigin(origin)}/api/goodspeech/v1/podcasts/public/${feed.public_token}`;
  const items = episodes.map((episode) => `    <item>
      <title>${escapeXml(episode.title)}</title>
      <description>${escapeXml(episode.description)}</description>
      <guid isPermaLink="false">urn:goodspeech:episode:${episode.id}</guid>
      <pubDate>${new Date(episode.published_at).toUTCString()}</pubDate>
      <enclosure url="${escapeXml(`${base}/episodes/${episode.id}/audio`)}" length="${Number(episode.size_bytes)}" type="${escapeXml(episode.mime_type)}" />
      <itunes:duration>${duration(episode.duration_seconds)}</itunes:duration>${episode.episode_number ? `\n      <itunes:episode>${episode.episode_number}</itunes:episode>` : ""}
    </item>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(feed.title)}</title>
    <link>${escapeXml(`${base}/feed.xml`)}</link>
    <atom:link href="${escapeXml(`${base}/feed.xml`)}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(feed.description)}</description>
    <language>${escapeXml(feed.language)}</language>
    <itunes:author>${escapeXml(feed.author)}</itunes:author>
    <itunes:explicit>false</itunes:explicit>
${items}
  </channel>
</rss>`;
}

module.exports = {
  AUDIO_TYPES,
  listFeeds,
  createFeed,
  addEpisode,
  revokeFeed,
  publicFeed,
  publicEpisode,
  rssXml,
  _internal: { escapeXml, feedRecord, token, uuid },
};
