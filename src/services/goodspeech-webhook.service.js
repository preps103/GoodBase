"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const net = require("node:net");
const database = require("../config/database");

const SUPPORTED_EVENTS = Object.freeze([
  "speech.completed",
  "voice.created",
  "voice.revoked",
  "agent.session.completed",
  "agent.handoff.requested",
  "studio.job.completed",
  "studio.job.failed",
  "webhook.test",
]);
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_SECONDS = [15, 60, 300, 900, 1800];

function serviceError(message, statusCode = 400, code = "GOODSPEECH_WEBHOOK_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

function scope(context = {}) {
  return {
    organizationId: String(context.organizationId || "org_goodos"),
    projectId: String(context.projectId || "proj_goodos_platform"),
    environmentId: String(context.environmentId || "env_goodos_production"),
  };
}

function encryptionKey() {
  const source = String(process.env.GOODSPEECH_WEBHOOK_ENCRYPTION_KEY || process.env.JWT_SECRET || "");
  if (source.length < 32) throw serviceError("GoodSpeech webhook encryption is not configured.", 503, "GOODSPEECH_WEBHOOK_NOT_CONFIGURED");
  return crypto.createHash("sha256").update(source).digest();
}

function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

function decryptSecret(value) {
  const [version, iv, tag, encrypted, extra] = String(value || "").split(":");
  if (version !== "v1" || !iv || !tag || !encrypted || extra) throw serviceError("Webhook secret could not be opened.", 500, "GOODSPEECH_WEBHOOK_SECRET_INVALID");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

function isPrivateAddress(address) {
  const normalized = String(address || "").toLowerCase().split("%")[0];
  if (net.isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 192 && parts[1] === 0 && [0, 2].includes(parts[2])) ||
      (parts[0] === 198 && [18, 19].includes(parts[1])) ||
      (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
      (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
  }
  if (net.isIP(normalized) === 6) {
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("2001:db8:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
    if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  }
  return false;
}

function normalizeEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(String(value || "").trim()); } catch { throw serviceError("Webhook endpoint must be a valid HTTPS URL."); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port && endpoint.port !== "443") {
    throw serviceError("Webhook endpoint must use HTTPS without embedded credentials or a custom port.");
  }
  const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal") || isPrivateAddress(hostname)) {
    throw serviceError("Webhook endpoint must resolve to a public Internet address.");
  }
  endpoint.hash = "";
  return endpoint.toString();
}

async function assertPublicDestination(endpointUrl) {
  const endpoint = new URL(endpointUrl);
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw serviceError("Webhook endpoint resolved to a private or unavailable address.", 422, "GOODSPEECH_WEBHOOK_DESTINATION_BLOCKED");
  }
}

function normalizeEvents(events) {
  const requested = Array.isArray(events) ? [...new Set(events.map(String))] : [];
  if (!requested.length || requested.some((event) => !SUPPORTED_EVENTS.includes(event))) {
    throw serviceError("Select at least one supported GoodSpeech webhook event.");
  }
  return requested;
}

function normalizeWebhookId(value) {
  const webhookId = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(webhookId)) {
    throw serviceError("Webhook identifier is invalid.", 400, "GOODSPEECH_WEBHOOK_ID_INVALID");
  }
  return webhookId;
}

function publicWebhook(row) {
  return {
    id: row.id,
    endpointUrl: row.endpoint_url,
    description: row.description,
    events: row.events,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveries: Number(row.delivery_count || 0),
    failedDeliveries: Number(row.failed_count || 0),
    lastDeliveredAt: row.last_delivered_at || null,
  };
}

async function listWebhooks({ context, userId }) {
  const current = scope(context);
  const result = await database.query(
    `SELECT hook.*,
       (SELECT COUNT(*) FROM goodspeech_webhook_deliveries delivery WHERE delivery.webhook_id = hook.id) AS delivery_count,
       (SELECT COUNT(*) FROM goodspeech_webhook_deliveries delivery WHERE delivery.webhook_id = hook.id AND delivery.status = 'failed') AS failed_count,
       (SELECT MAX(delivery.delivered_at) FROM goodspeech_webhook_deliveries delivery WHERE delivery.webhook_id = hook.id) AS last_delivered_at
     FROM goodspeech_webhooks hook
     WHERE hook.organization_id = $1 AND hook.owner_user_id = $2::uuid
     ORDER BY hook.updated_at DESC`,
    [current.organizationId, userId],
  );
  return { webhooks: result.rows.map(publicWebhook), supportedEvents: SUPPORTED_EVENTS };
}

async function createWebhook({ payload = {}, context, userId }) {
  const current = scope(context);
  const endpointUrl = normalizeEndpoint(payload.endpointUrl);
  await assertPublicDestination(endpointUrl);
  const events = normalizeEvents(payload.events);
  const description = String(payload.description || "").trim().slice(0, 240);
  const signingSecret = `whsec_gs_${crypto.randomBytes(32).toString("base64url")}`;
  try {
    const result = await database.query(
      `INSERT INTO goodspeech_webhooks
       (organization_id, project_id, environment_id, owner_user_id, endpoint_url, description, events, secret_ciphertext)
       VALUES ($1,$2,$3,$4::uuid,$5,$6,$7::text[],$8)
       RETURNING *`,
      [current.organizationId, current.projectId, current.environmentId, userId, endpointUrl, description, events, encryptSecret(signingSecret)],
    );
    return { ...publicWebhook(result.rows[0]), signingSecret };
  } catch (error) {
    if (error?.code === "23505") throw serviceError("A webhook for this endpoint already exists.", 409, "GOODSPEECH_WEBHOOK_EXISTS");
    throw error;
  }
}

async function deleteWebhook({ webhookId, context, userId }) {
  const current = scope(context);
  const currentWebhookId = normalizeWebhookId(webhookId);
  const result = await database.query(
    `DELETE FROM goodspeech_webhooks WHERE id = $1::uuid AND organization_id = $2 AND owner_user_id = $3::uuid RETURNING id`,
    [currentWebhookId, current.organizationId, userId],
  );
  if (!result.rows[0]) throw serviceError("Webhook not found.", 404, "GOODSPEECH_WEBHOOK_NOT_FOUND");
  return { id: result.rows[0].id, deleted: true };
}

async function emitEvent({ type, data = {}, context, userId, webhookId = null }) {
  if (!SUPPORTED_EVENTS.includes(type)) throw serviceError("Webhook event type is unsupported.");
  const current = scope(context);
  const event = { id: `evt_gs_${crypto.randomUUID().replace(/-/g, "")}`, type, createdAt: new Date().toISOString(), data };
  const serialized = JSON.stringify(event);
  const targetWebhookId = webhookId ? normalizeWebhookId(webhookId) : null;
  if (Buffer.byteLength(serialized) > 32 * 1024) throw serviceError("Webhook event is too large.", 413, "GOODSPEECH_WEBHOOK_EVENT_TOO_LARGE");
  await database.query(
    `INSERT INTO goodspeech_webhook_deliveries (webhook_id, event_id, event_type, payload_json)
     SELECT id, $3, $4, $5::jsonb FROM goodspeech_webhooks
     WHERE organization_id = $1 AND owner_user_id = $2::uuid AND status = 'active'
       AND (($6::uuid IS NOT NULL AND id = $6::uuid) OR ($6::uuid IS NULL AND $4 = ANY(events)))
     ON CONFLICT (webhook_id, event_id) DO NOTHING`,
    [current.organizationId, userId, event.id, type, serialized, targetWebhookId],
  );
  return event;
}

async function claimDelivery(workerId) {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH expired AS (
         UPDATE goodspeech_webhook_deliveries
         SET status='failed', last_error='Delivery worker stopped before the final attempt completed.', updated_at=NOW()
         WHERE status='delivering' AND attempts >= ${MAX_ATTEMPTS} AND updated_at < NOW()-INTERVAL '2 minutes'
         RETURNING id
       ), selected AS (
         SELECT delivery.id FROM goodspeech_webhook_deliveries delivery
         JOIN goodspeech_webhooks hook ON hook.id = delivery.webhook_id AND hook.status = 'active'
         WHERE ((delivery.status IN ('pending','retrying') AND delivery.next_attempt_at <= NOW())
           OR (delivery.status='delivering' AND delivery.attempts < ${MAX_ATTEMPTS} AND delivery.updated_at < NOW()-INTERVAL '2 minutes'))
         ORDER BY delivery.next_attempt_at, delivery.created_at FOR UPDATE OF delivery SKIP LOCKED LIMIT 1
       )
       UPDATE goodspeech_webhook_deliveries delivery
       SET status = 'delivering', attempts = attempts + 1, updated_at = NOW(), last_error = NULL
       FROM selected, goodspeech_webhooks hook
       WHERE delivery.id = selected.id AND hook.id = delivery.webhook_id AND hook.status = 'active'
       RETURNING delivery.*, hook.endpoint_url, hook.secret_ciphertext, $1::text AS worker_id`,
      [workerId],
    );
    await client.query("COMMIT");
    return result.rows[0] || null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function deliver(row, fetchFn = globalThis.fetch) {
  const payload = JSON.stringify(row.payload_json);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(`${timestamp}.${payload}`).digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    if (typeof fetchFn !== "function") throw new Error("Webhook transport is unavailable.");
    await assertPublicDestination(row.endpoint_url);
    const response = await fetchFn(row.endpoint_url, {
      method: "POST",
      signal: controller.signal,
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "GoodSpeech-Webhooks/1.0",
        "Idempotency-Key": row.event_id,
        "X-GoodSpeech-Delivery": row.id,
        "X-GoodSpeech-Event": row.event_type,
        "X-GoodSpeech-Timestamp": timestamp,
        "X-GoodSpeech-Signature": `sha256=${signature}`,
      },
      body: payload,
    });
    await response.body?.cancel().catch(() => {});
    if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`Endpoint returned HTTP ${response.status}.`), { responseStatus: response.status });
    await database.query(
      `UPDATE goodspeech_webhook_deliveries SET status='succeeded', response_status=$2, delivered_at=NOW(), updated_at=NOW() WHERE id=$1::uuid`,
      [row.id, response.status],
    );
    return { id: row.id, status: "succeeded" };
  } catch (error) {
    const terminal = Number(row.attempts) >= MAX_ATTEMPTS;
    const delay = RETRY_DELAYS_SECONDS[Math.min(Number(row.attempts) - 1, RETRY_DELAYS_SECONDS.length - 1)];
    await database.query(
      `UPDATE goodspeech_webhook_deliveries
       SET status=$2, response_status=$3, last_error=$4, next_attempt_at=NOW()+($5*INTERVAL '1 second'), updated_at=NOW()
       WHERE id=$1::uuid`,
      [row.id, terminal ? "failed" : "retrying", error.responseStatus || null, String(error.message || "Delivery failed.").slice(0, 1000), delay],
    );
    return { id: row.id, status: terminal ? "failed" : "retrying" };
  } finally { clearTimeout(timeout); }
}

async function processDueDeliveries(limit = 5, workerId = "goodspeech-webhook-worker", fetchFn = globalThis.fetch) {
  const boundedLimit = Math.min(25, Math.max(1, Number(limit) || 5));
  const results = [];
  for (let index = 0; index < boundedLimit; index += 1) {
    const row = await claimDelivery(workerId);
    if (!row) break;
    results.push(await deliver(row, fetchFn));
  }
  return results;
}

module.exports = {
  SUPPORTED_EVENTS,
  MAX_ATTEMPTS,
  scope,
  encryptionKey,
  encryptSecret,
  decryptSecret,
  isPrivateAddress,
  normalizeEndpoint,
  normalizeEvents,
  normalizeWebhookId,
  listWebhooks,
  createWebhook,
  deleteWebhook,
  emitEvent,
  deliver,
  processDueDeliveries,
};
