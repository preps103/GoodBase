"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { pool, query } = require("../config/database");

const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
const GOODSCAN_PHONE_ORIGIN = "https://scan.goodos.app";

function serviceError(message, statusCode = 400, code = "GOODSCAN_REQUEST_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

function bounded(value, maximum = 240) {
  return String(value || "").trim().slice(0, maximum);
}

function cleanStringArray(value, maximumItems = 30, maximumLength = 80) {
  return Array.isArray(value) ? value.slice(0, maximumItems).map(item => bounded(item, maximumLength)).filter(Boolean) : [];
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function validInstallationId(value) {
  const id = bounded(value, 120);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{15,119}$/.test(id)) {
    throw serviceError("A valid device installation identifier is required.", 400, "GOODSCAN_DEVICE_ID_INVALID");
  }
  return id;
}

function pairingSecretHash(pairingId, secret) {
  return sha256(`${bounded(pairingId, 80)}:${String(secret || "")}`);
}

function validPairingSecret(secret) {
  const value = String(secret || "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw serviceError("The phone pairing secret is invalid.", 400, "GOODSCAN_PAIRING_SECRET_INVALID");
  }
  return value;
}

function validPairingId(pairingId) {
  const value = bounded(pairingId, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw serviceError("The phone pairing identifier is invalid.", 400, "GOODSCAN_PAIRING_ID_INVALID");
  }
  return value;
}

function safeHashEqual(left, right) {
  const first = Buffer.from(String(left || ""), "utf8");
  const second = Buffer.from(String(right || ""), "utf8");
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function publicDevice(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    kind: row.metadata?.kind || null,
    platform: row.metadata?.platform || null,
    lastSeenAt: row.last_seen_at,
  };
}

function publicPairing(row) {
  return {
    id: row.id,
    status: row.status,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at,
    lastActivityAt: row.last_activity_at,
    latestAssetId: row.latest_asset_id,
    desktopDevice: row.desktop_device_id ? {
      id: row.desktop_device_id,
      name: row.desktop_device_name,
      status: row.desktop_device_status,
    } : null,
    phoneDevice: row.phone_device_id ? {
      id: row.phone_device_id,
      name: row.phone_device_name,
      status: row.phone_device_status,
    } : null,
  };
}

async function upsertDevice(client, { userId, installationId, name, kind, platform, publicKey }) {
  const installationIdHash = sha256(validInstallationId(installationId));
  const deviceName = bounded(name, 120) || (kind === "phone" ? "GoodScan phone" : "GoodScan desktop");
  const deviceKind = ["desktop", "phone"].includes(kind) ? kind : "unknown";
  const devicePlatform = bounded(platform, 80) || "unknown";
  const existing = await client.query(`
    SELECT * FROM goodscan_devices
    WHERE owner_user_id = $1 AND metadata->>'installationIdHash' = $2
    ORDER BY updated_at DESC LIMIT 1
  `, [userId, installationIdHash]);
  if (existing.rows[0]) {
    const result = await client.query(`
      UPDATE goodscan_devices
      SET name = $3, status = 'connected', device_public_key = COALESCE($4, device_public_key),
          metadata = metadata || $5::jsonb, last_seen_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND owner_user_id = $2
      RETURNING *
    `, [existing.rows[0].id, userId, deviceName, bounded(publicKey, 4096) || null, JSON.stringify({ installationIdHash, kind: deviceKind, platform: devicePlatform })]);
    return result.rows[0];
  }
  const result = await client.query(`
    INSERT INTO goodscan_devices (owner_user_id, name, status, device_public_key, metadata, last_seen_at)
    VALUES ($1, $2, 'connected', $3, $4::jsonb, NOW())
    RETURNING *
  `, [userId, deviceName, bounded(publicKey, 4096) || null, JSON.stringify({ installationIdHash, kind: deviceKind, platform: devicePlatform })]);
  return result.rows[0];
}

async function createDevicePairing({ userId, device }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const desktop = await upsertDevice(client, { ...device, userId, kind: "desktop" });
    await client.query(`
      UPDATE goodscan_device_pairings
      SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
      WHERE owner_user_id = $1 AND desktop_device_id = $2 AND status = 'pending'
    `, [userId, desktop.id]);
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + PAIRING_LIFETIME_MS);
    const tokenHash = pairingSecretHash(id, secret);
    const inserted = await client.query(`
      INSERT INTO goodscan_device_pairings
        (id, owner_user_id, desktop_device_id, token_hash, status, expires_at, metadata)
      VALUES ($1, $2, $3, $4, 'pending', $5, $6::jsonb)
      RETURNING *
    `, [id, userId, desktop.id, tokenHash, expiresAt, JSON.stringify({ protocol: "goodscan.pairing.v1" })]);
    await client.query("COMMIT");
    const pairingUrl = new URL("/", GOODSCAN_PHONE_ORIGIN);
    pairingUrl.searchParams.set("phone", "1");
    pairingUrl.searchParams.set("pairing", id);
    pairingUrl.searchParams.set("secret", secret);
    return {
      ...publicPairing({
        ...inserted.rows[0],
        desktop_device_name: desktop.name,
        desktop_device_status: desktop.status,
      }),
      pairingUrl: pairingUrl.toString(),
      desktopDevice: publicDevice(desktop),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function pairingStatus({ userId, pairingId }) {
  pairingId = validPairingId(pairingId);
  await query(`
    UPDATE goodscan_device_pairings
    SET status = 'expired', updated_at = NOW()
    WHERE id = $1 AND owner_user_id = $2 AND status = 'pending' AND expires_at <= NOW()
  `, [pairingId, userId]);
  const result = await query(`
    SELECT pairing.*,
           desktop.name AS desktop_device_name, desktop.status AS desktop_device_status,
           phone.name AS phone_device_name, phone.status AS phone_device_status
    FROM goodscan_device_pairings pairing
    JOIN goodscan_devices desktop ON desktop.id = pairing.desktop_device_id
    LEFT JOIN goodscan_devices phone ON phone.id = pairing.phone_device_id
    WHERE pairing.id = $1 AND pairing.owner_user_id = $2
  `, [pairingId, userId]);
  if (!result.rows[0]) throw serviceError("Phone pairing was not found.", 404, "GOODSCAN_PAIRING_NOT_FOUND");
  return publicPairing(result.rows[0]);
}

async function claimDevicePairing({ userId, pairingId, secret, device }) {
  pairingId = validPairingId(pairingId);
  const suppliedSecret = validPairingSecret(secret);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`
      SELECT pairing.*, phone.metadata AS phone_metadata,
             desktop.name AS desktop_device_name, desktop.status AS desktop_device_status,
             phone.name AS phone_device_name, phone.status AS phone_device_status
      FROM goodscan_device_pairings pairing
      JOIN goodscan_devices desktop ON desktop.id = pairing.desktop_device_id
      LEFT JOIN goodscan_devices phone ON phone.id = pairing.phone_device_id
      WHERE pairing.id = $1 AND pairing.owner_user_id = $2
      FOR UPDATE OF pairing
    `, [pairingId, userId]);
    const pairing = result.rows[0];
    if (!pairing) throw serviceError("Phone pairing was not found.", 404, "GOODSCAN_PAIRING_NOT_FOUND");
    const installationIdHash = sha256(validInstallationId(device?.installationId));
    if (pairing.status === "claimed" && pairing.phone_metadata?.installationIdHash === installationIdHash) {
      await client.query("COMMIT");
      return publicPairing(pairing);
    }
    if (pairing.status !== "pending") throw serviceError("This phone pairing can no longer be claimed.", 409, "GOODSCAN_PAIRING_NOT_PENDING");
    if (new Date(pairing.expires_at).getTime() <= Date.now()) {
      await client.query("UPDATE goodscan_device_pairings SET status = 'expired', updated_at = NOW() WHERE id = $1", [pairingId]);
      await client.query("COMMIT");
      throw serviceError("This phone pairing has expired. Start a new pairing from the desktop app.", 410, "GOODSCAN_PAIRING_EXPIRED");
    }
    if (!safeHashEqual(pairing.token_hash, pairingSecretHash(pairingId, suppliedSecret))) {
      throw serviceError("The phone pairing secret is invalid.", 403, "GOODSCAN_PAIRING_SECRET_INVALID");
    }
    const phone = await upsertDevice(client, { ...device, userId, kind: "phone" });
    const updated = await client.query(`
      UPDATE goodscan_device_pairings
      SET phone_device_id = $2, status = 'claimed', claimed_at = NOW(),
          last_activity_at = NOW(), token_hash = $3, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [pairingId, phone.id, sha256(crypto.randomBytes(32))]);
    await client.query("COMMIT");
    return publicPairing({
      ...updated.rows[0],
      desktop_device_name: pairing.desktop_device_name,
      desktop_device_status: pairing.desktop_device_status,
      phone_device_name: phone.name,
      phone_device_status: phone.status,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function revokeDevicePairing({ userId, pairingId }) {
  pairingId = validPairingId(pairingId);
  const result = await query(`
    UPDATE goodscan_device_pairings
    SET status = 'revoked', revoked_at = NOW(), token_hash = $3, updated_at = NOW()
    WHERE id = $1 AND owner_user_id = $2 AND status IN ('pending', 'claimed')
    RETURNING id
  `, [pairingId, userId, sha256(crypto.randomBytes(32))]);
  if (!result.rows[0]) throw serviceError("Active phone pairing was not found.", 404, "GOODSCAN_PAIRING_NOT_FOUND");
}

async function validateCapturePairing({ userId, pairingId, sourceDeviceId }) {
  if (!pairingId) return null;
  pairingId = validPairingId(pairingId);
  const result = await query(`
    SELECT id, phone_device_id FROM goodscan_device_pairings
    WHERE id = $1 AND owner_user_id = $2 AND status = 'claimed'
  `, [pairingId, userId]);
  const pairing = result.rows[0];
  if (!pairing || !sourceDeviceId || pairing.phone_device_id !== sourceDeviceId) {
    throw serviceError("The capture is not associated with an active paired phone.", 403, "GOODSCAN_CAPTURE_DEVICE_INVALID");
  }
  return pairing;
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
  const pairing = await validateCapturePairing({ userId, pairingId: bounded(manifest.pairingId, 80), sourceDeviceId: bounded(manifest.sourceDeviceId, 80) });
  const result = await query(`
    INSERT INTO goodscan_assets (owner_user_id, name, asset_type, status, quality, use_case, visibility, source_manifest, storage_bytes, progress, tags)
    VALUES ($1,$2,$3,'queued',$4,$5,'private',$6::jsonb,$7,0,$8::jsonb)
    RETURNING *
  `, [userId, name, type, bounded(manifest.quality, 40) || null, bounded(manifest.useCase, 80) || null, JSON.stringify({ ...manifest, files: sources }), storageBytes, JSON.stringify(cleanStringArray(manifest.tags))]);
  if (pairing) {
    await query(`
      UPDATE goodscan_device_pairings
      SET latest_asset_id = $3, last_activity_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND owner_user_id = $2 AND status = 'claimed'
    `, [pairing.id, userId, result.rows[0].id]);
    await query("UPDATE goodscan_devices SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1 AND owner_user_id = $2", [pairing.phone_device_id, userId]);
  }
  return publicAsset(result.rows[0]);
}

module.exports = {
  claimDevicePairing,
  createCapture,
  createDevicePairing,
  normalizeManifest,
  pairingSecretHash,
  pairingStatus,
  publicAsset,
  revokeDevicePairing,
  safeHashEqual,
  serviceError,
  workspace,
};
