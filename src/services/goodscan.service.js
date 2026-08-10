"use strict";

const path = require("node:path");
const { query } = require("../config/database");

function serviceError(message, statusCode = 400, code = "GOODSCAN_REQUEST_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

function bounded(value, maximum = 240) {
  return String(value || "").trim().slice(0, maximum);
}

function cleanStringArray(value, maximumItems = 30, maximumLength = 80) {
  return Array.isArray(value) ? value.slice(0, maximumItems).map(item => bounded(item, maximumLength)).filter(Boolean) : [];
}

function normalizeManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw serviceError("A valid GoodScan capture manifest is required.");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 262_144) throw serviceError("The capture manifest exceeds 256 KB.", 413, "GOODSCAN_MANIFEST_TOO_LARGE");
  const schema = bounded(value.schema, 80);
  if (schema !== "goodscan.capture.v1") throw serviceError("Unsupported GoodScan capture manifest schema.");
  const engine = bounded(value.engine, 20).toLowerCase();
  if (!["photo", "3dgs"].includes(engine)) throw serviceError("Unsupported GoodScan reconstruction engine.");
  return { ...JSON.parse(encoded), schema, engine };
}

function publicAsset(row) {
  const manifest = row.source_manifest || {};
  return {
    id: row.id,
    name: row.name,
    type: row.asset_type,
    status: row.status,
    quality: row.quality,
    folder: row.folder,
    useCase: row.use_case,
    visibility: row.visibility,
    thumbnailUrl: row.thumbnail_url,
    previewUrl: row.preview_url,
    modelUrl: row.model_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    storageBytes: Number(row.storage_bytes || 0),
    processingSeconds: row.processing_seconds,
    creditsUsed: row.credits_used,
    progress: row.progress === null ? null : Number(row.progress),
    tags: Array.isArray(row.tags) ? row.tags : [],
    views: Number(row.views || 0),
    appreciations: Number(row.appreciations || 0),
    outputs: Array.isArray(row.outputs) ? row.outputs : [],
    author: row.author_name ? { id: row.owner_user_id, name: row.author_name, avatarUrl: row.author_avatar_url || null } : null,
    source: bounded(manifest.source, 40) || null,
  };
}

async function workspace(userId) {
  const [assetsResult, publicResult, analyticsResult, sourcesResult, devicesResult, integrationsResult] = await Promise.all([
    query(`SELECT * FROM goodscan_assets WHERE owner_user_id = $1 ORDER BY updated_at DESC LIMIT 500`, [userId]),
    query(`
      SELECT asset.*, COALESCE(NULLIF(TRIM(CONCAT(users.first_name, ' ', users.last_name)), ''), users.email) AS author_name,
             users.avatar_url AS author_avatar_url
      FROM goodscan_assets asset
      JOIN users ON users.id = asset.owner_user_id
      WHERE asset.visibility = 'public' AND asset.status = 'completed'
      ORDER BY asset.updated_at DESC LIMIT 200
    `),
    query(`
      SELECT day::date AS date,
             COUNT(asset.id)::int AS scans,
             COALESCE(SUM(asset.credits_used), 0)::int AS credits,
             COALESCE(SUM(asset.storage_bytes), 0)::bigint AS storage_bytes,
             COALESCE(SUM(asset.processing_seconds), 0)::int AS processing_seconds
      FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') day
      LEFT JOIN goodscan_assets asset ON asset.owner_user_id = $1 AND asset.created_at >= day AND asset.created_at < day + INTERVAL '1 day'
      GROUP BY day ORDER BY day
    `, [userId]),
    query(`SELECT COALESCE(NULLIF(source_manifest->>'source',''),'Unknown') AS name, COUNT(*)::int AS value FROM goodscan_assets WHERE owner_user_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [userId]),
    query(`SELECT id, name, status, last_seen_at FROM goodscan_devices WHERE owner_user_id = $1 ORDER BY updated_at DESC`, [userId]),
    query(`SELECT id, slug, name, description, category, status, action_url FROM goodscan_integrations WHERE owner_user_id = $1 ORDER BY name`, [userId]),
  ]);
  const assets = assetsResult.rows.map(publicAsset);
  return {
    generatedAt: new Date().toISOString(),
    assets,
    communityAssets: publicResult.rows.map(publicAsset),
    analytics: {
      series: analyticsResult.rows.map(row => ({ date: row.date, scans: row.scans, credits: row.credits, storageBytes: Number(row.storage_bytes || 0), processingSeconds: row.processing_seconds })),
      sourceDistribution: sourcesResult.rows,
    },
    usage: {
      creditsRemaining: null,
      creditsLimit: null,
      storageBytes: assets.reduce((sum, asset) => sum + Number(asset.storageBytes || 0), 0),
      storageLimitBytes: null,
    },
    devices: devicesResult.rows.map(row => ({ id: row.id, name: row.name, status: row.status, lastSeenAt: row.last_seen_at })),
    integrations: integrationsResult.rows.map(row => ({ id: row.slug || row.id, name: row.name, description: row.description, category: row.category, status: row.status, actionUrl: row.action_url })),
  };
}

async function createCapture({ userId, manifest: rawManifest, files }) {
  const manifest = normalizeManifest(rawManifest);
  if (!files.length) throw serviceError("At least one original capture file is required.");
  const storageBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  if (storageBytes > 12 * 1024 * 1024 * 1024) throw serviceError("Capture media exceeds the 12 GB upload limit.", 413, "GOODSCAN_CAPTURE_TOO_LARGE");
  const sources = files.map(file => ({
    name: bounded(file.originalname, 255),
    mimeType: bounded(file.mimetype, 120),
    bytes: Number(file.size || 0),
    storageKey: path.basename(file.filename),
  }));
  const name = bounded(manifest.name, 160) || `GoodScan capture ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const type = manifest.engine === "3dgs" ? "Gaussian Splat" : "Photo Scan";
  const result = await query(`
    INSERT INTO goodscan_assets (owner_user_id, name, asset_type, status, quality, use_case, visibility, source_manifest, storage_bytes, progress, tags)
    VALUES ($1,$2,$3,'queued',$4,$5,'private',$6::jsonb,$7,0,$8::jsonb)
    RETURNING *
  `, [userId, name, type, bounded(manifest.quality, 40) || null, bounded(manifest.useCase, 80) || null, JSON.stringify({ ...manifest, files: sources }), storageBytes, JSON.stringify(cleanStringArray(manifest.tags))]);
  return publicAsset(result.rows[0]);
}

module.exports = { createCapture, normalizeManifest, publicAsset, serviceError, workspace };
