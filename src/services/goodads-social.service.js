"use strict";

const crypto = require("crypto");
const { query } = require("../config/database");

const PROVIDERS = {
  google: {
    label: "Google / YouTube",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/youtube.upload"],
    extraAuth: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
  facebook: {
    label: "Facebook",
    authUrl: "https://www.facebook.com/v23.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v23.0/oauth/access_token",
    userUrl: "https://graph.facebook.com/v23.0/me?fields=id,name,picture",
    scopes: ["public_profile", "pages_show_list", "pages_manage_posts", "pages_read_engagement"],
  },
  instagram: {
    label: "Instagram",
    authUrl: "https://www.facebook.com/v23.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v23.0/oauth/access_token",
    userUrl: "https://graph.facebook.com/v23.0/me?fields=id,name,picture",
    scopes: ["public_profile", "instagram_basic", "instagram_content_publish", "pages_show_list"],
  },
  threads: {
    label: "Threads",
    authUrl: "https://threads.net/oauth/authorize",
    tokenUrl: "https://graph.threads.net/oauth/access_token",
    userUrl: "https://graph.threads.net/v1.0/me?fields=id,username,threads_profile_picture_url",
    scopes: ["threads_basic", "threads_content_publish"],
  },
  linkedin: {
    label: "LinkedIn",
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    userUrl: "https://api.linkedin.com/v2/userinfo",
    scopes: ["openid", "profile", "email", "w_member_social"],
  },
  x: {
    label: "X",
    authUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    userUrl: "https://api.x.com/2/users/me?user.fields=profile_image_url",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    pkce: true,
  },
  tiktok: {
    label: "TikTok",
    authUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    userUrl: "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
    scopes: ["user.info.basic", "video.publish", "video.upload"],
    clientIdParameter: "client_key",
  },
  pinterest: {
    label: "Pinterest",
    authUrl: "https://www.pinterest.com/oauth/",
    tokenUrl: "https://api.pinterest.com/v5/oauth/token",
    userUrl: "https://api.pinterest.com/v5/user_account",
    scopes: ["user_accounts:read", "pins:read", "pins:write", "boards:read"],
  },
  reddit: {
    label: "Reddit",
    authUrl: "https://www.reddit.com/api/v1/authorize",
    tokenUrl: "https://www.reddit.com/api/v1/access_token",
    userUrl: "https://oauth.reddit.com/api/v1/me",
    scopes: ["identity", "read", "submit"],
    extraAuth: { duration: "permanent" },
  },
};

const PROVIDER_ALIASES = {
  twitter: "x",
  youtube: "google",
  youtube_shorts: "google",
  google_business: "google",
};

const PROVIDER_PUBLISH_CAPABILITIES = Object.freeze({
  google: { text: false, media: false, video: false, immediate: false, scheduling: false, paidAds: false },
  facebook: { text: true, media: false, video: false, immediate: true, scheduling: false, paidAds: false },
  instagram: { text: false, media: false, video: false, immediate: false, scheduling: false, paidAds: false },
  threads: { text: false, media: false, video: false, immediate: false, scheduling: false, paidAds: false },
  linkedin: { text: true, media: false, video: false, immediate: true, scheduling: false, paidAds: false },
  x: { text: true, media: false, video: false, immediate: true, scheduling: false, paidAds: false },
  tiktok: { text: false, media: false, video: false, immediate: false, scheduling: false, paidAds: false },
  pinterest: { text: false, media: false, video: false, immediate: false, scheduling: false, paidAds: false },
  reddit: { text: true, media: false, video: false, immediate: true, scheduling: false, paidAds: false },
});

function socialError(message, statusCode = 400, code = "GOODADS_SOCIAL_ERROR") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function providerConfig(provider) {
  const requestedId = String(provider || "").toLowerCase();
  const id = PROVIDER_ALIASES[requestedId] || requestedId;
  const definition = PROVIDERS[id];
  if (!definition) throw socialError("Unsupported social provider.", 404, "GOODADS_PROVIDER_NOT_FOUND");
  const prefix = `GOODADS_${id.toUpperCase()}_`;
  const clientId = process.env[`${prefix}CLIENT_ID`] || process.env[`${prefix}CLIENT_KEY`] || "";
  const clientSecret = process.env[`${prefix}CLIENT_SECRET`] || "";
  return { id, ...definition, clientId, clientSecret, configured: Boolean(clientId && clientSecret) };
}

function encryptionKey() {
  const raw = String(process.env.GOODADS_OAUTH_ENCRYPTION_KEY || "");
  if (!raw) throw socialError("GoodAds OAuth encryption is not configured.", 503, "GOODADS_OAUTH_KEY_MISSING");
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decrypt(ciphertext, iv, tag) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function baseUrl(value) {
  return String(value || process.env.PUBLIC_BASE_URL || "https://base.goodos.app").replace(/\/+$/, "");
}

function callbackUrl(provider) {
  return `${baseUrl()}/api/apps/goodads/v1/oauth/${encodeURIComponent(provider)}/callback`;
}

function stateHash(state) {
  return crypto.createHash("sha256").update(state).digest("hex");
}

function codeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

async function beginAuthorization({ provider, context, userId, returnOrigin = "https://ads.goodos.app" }) {
  const config = providerConfig(provider);
  if (!config.configured) throw socialError(`${config.label} OAuth credentials are not configured.`, 503, "GOODADS_PROVIDER_NOT_CONFIGURED");
  encryptionKey();
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = config.pkce ? crypto.randomBytes(48).toString("base64url") : null;
  await query(
    `INSERT INTO goodads_oauth_states (
       state_hash, provider, organization_id, user_id, code_verifier, return_origin
     ) VALUES ($1, $2, $3, $4::uuid, $5, $6)`,
    [stateHash(state), config.id, context.organizationId, userId, verifier, returnOrigin]
  );
  const url = new URL(config.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(config.clientIdParameter || "client_id", config.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(config.id));
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(config.extraAuth || {})) url.searchParams.set(key, value);
  if (verifier) {
    url.searchParams.set("code_challenge", codeChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

async function consumeState(provider, state) {
  const result = await query(
    `UPDATE goodads_oauth_states SET consumed_at = NOW()
     WHERE state_hash = $1 AND provider = $2 AND consumed_at IS NULL
       AND expires_at > NOW()
     RETURNING *`,
    [stateHash(String(state || "")), provider]
  );
  if (!result.rows[0]) throw socialError("OAuth state is invalid or expired.", 401, "GOODADS_OAUTH_STATE_INVALID");
  return result.rows[0];
}

async function exchangeCode(config, code, stateRow) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(config.id),
    [config.clientIdParameter || "client_id"]: config.clientId,
  });
  if (config.id !== "x" || config.clientSecret) body.set("client_secret", config.clientSecret);
  if (stateRow.code_verifier) body.set("code_verifier", stateRow.code_verifier);
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (config.id === "reddit" || config.id === "pinterest") {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  }
  const response = await fetch(config.tokenUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(15000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw socialError(payload.error_description || payload.message || `${config.label} rejected the authorization code.`, 502, "GOODADS_TOKEN_EXCHANGE_FAILED");
  }
  return payload;
}

async function fetchIdentity(config, accessToken) {
  const response = await fetch(config.userUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "GoodAds/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw socialError(`${config.label} account identity could not be loaded.`, 502, "GOODADS_IDENTITY_FAILED");
  const value = payload.data?.user || payload.data || payload;
  return {
    id: String(value.id || value.sub || value.open_id || value.openId || value.name || ""),
    name: String(value.name || value.display_name || value.localizedFirstName || value.username || value.login || "Connected account"),
    avatarUrl: value.picture?.data?.url || value.picture || value.avatar_url || value.profile_image_url || value.threads_profile_picture_url || null,
    raw: value,
  };
}

async function completeAuthorization({ provider, code, state }) {
  const config = providerConfig(provider);
  if (!code) throw socialError("OAuth authorization code is missing.");
  const stateRow = await consumeState(config.id, state);
  const token = await exchangeCode(config, code, stateRow);
  const identity = await fetchIdentity(config, token.access_token);
  if (!identity.id) throw socialError(`${config.label} did not return an account identifier.`, 502, "GOODADS_ACCOUNT_ID_MISSING");
  const access = encrypt(token.access_token);
  const refresh = encrypt(token.refresh_token);
  const expiresAt = token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000) : null;
  const scopes = String(token.scope || config.scopes.join(" ")).split(/[ ,]+/).filter(Boolean);
  const result = await query(
    `INSERT INTO goodads_social_connections (
       organization_id, user_id, provider, provider_account_id, account_name,
       avatar_url, scopes, access_token_ciphertext, access_token_iv,
       access_token_tag, refresh_token_ciphertext, refresh_token_iv,
       refresh_token_tag, token_expires_at, status, metadata, last_verified_at
     ) VALUES (
       $1, $2::uuid, $3, $4, $5, $6, $7::text[], $8, $9, $10,
       $11, $12, $13, $14, 'connected', $15::jsonb, NOW()
     )
     ON CONFLICT (organization_id, user_id, provider, provider_account_id)
     DO UPDATE SET account_name = EXCLUDED.account_name, avatar_url = EXCLUDED.avatar_url,
       scopes = EXCLUDED.scopes, access_token_ciphertext = EXCLUDED.access_token_ciphertext,
       access_token_iv = EXCLUDED.access_token_iv, access_token_tag = EXCLUDED.access_token_tag,
       refresh_token_ciphertext = COALESCE(EXCLUDED.refresh_token_ciphertext, goodads_social_connections.refresh_token_ciphertext),
       refresh_token_iv = COALESCE(EXCLUDED.refresh_token_iv, goodads_social_connections.refresh_token_iv),
       refresh_token_tag = COALESCE(EXCLUDED.refresh_token_tag, goodads_social_connections.refresh_token_tag),
       token_expires_at = EXCLUDED.token_expires_at, status = 'connected',
       metadata = EXCLUDED.metadata, last_verified_at = NOW(), updated_at = NOW()
     RETURNING id, provider, provider_account_id, account_name, avatar_url, scopes,
       token_expires_at, status, connected_at, updated_at`,
    [
      stateRow.organization_id, stateRow.user_id, config.id, identity.id, identity.name,
      identity.avatarUrl, scopes, access.ciphertext, access.iv, access.tag,
      refresh?.ciphertext || null, refresh?.iv || null, refresh?.tag || null,
      expiresAt, JSON.stringify({ identity: identity.raw }),
    ]
  );
  return { connection: result.rows[0], returnOrigin: stateRow.return_origin };
}

async function listConnections({ context, userId }) {
  const result = await query(
    `SELECT id, provider AS "platformId", provider_account_id AS "providerAccountId",
       account_name AS username, avatar_url AS "avatarUrl", scopes,
       token_expires_at AS "tokenExpiresAt", status,
       connected_at AS "connectedAt", last_verified_at AS "lastSyncAt", updated_at AS "updatedAt"
     FROM goodads_social_connections
     WHERE organization_id = $1 AND user_id = $2::uuid AND status <> 'disconnected'
     ORDER BY connected_at DESC`,
    [context.organizationId, userId]
  );
  return result.rows;
}

async function disconnect({ context, userId, provider }) {
  const result = await query(
    `UPDATE goodads_social_connections SET status = 'disconnected', updated_at = NOW()
     WHERE organization_id = $1 AND user_id = $2::uuid AND provider = $3
       AND status <> 'disconnected'
     RETURNING id`,
    [context.organizationId, userId, provider]
  );
  return { disconnected: result.rowCount };
}

function publicProviders() {
  return Object.keys(PROVIDERS).map((id) => {
    const config = providerConfig(id);
    return {
      id,
      name: config.label,
      configured: config.configured,
      scopes: config.scopes,
      capabilities: PROVIDER_PUBLISH_CAPABILITIES[id],
    };
  });
}

async function capabilities({ context, userId }) {
  const connectionResult = await query(
    `SELECT provider, COUNT(*)::int AS count
     FROM goodads_social_connections
     WHERE organization_id = $1 AND user_id = $2::uuid AND status = 'connected'
     GROUP BY provider`,
    [context.organizationId, userId]
  );
  const connectionCounts = new Map(
    connectionResult.rows.map((row) => [String(row.provider), Number(row.count || 0)])
  );
  const providers = publicProviders().map((provider) => ({
    ...provider,
    connectedAccounts: connectionCounts.get(provider.id) || 0,
  }));
  const configuredTextProviders = providers
    .filter((provider) => provider.configured && provider.capabilities.text)
    .map((provider) => provider.id);
  const connectedTextProviders = providers
    .filter((provider) => provider.connectedAccounts > 0 && provider.capabilities.text)
    .map((provider) => provider.id);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    providers,
    modules: {
      socialConnections: {
        available: true,
        configuredProviders: providers.filter((provider) => provider.configured).map((provider) => provider.id),
      },
      immediateTextPublishing: {
        available: configuredTextProviders.length > 0,
        configuredProviders: configuredTextProviders,
        connectedProviders: connectedTextProviders,
        durableHistory: true,
      },
      scheduledPublishing: {
        available: false,
        reason: "Durable scheduling and background delivery are not installed.",
      },
      mediaPublishing: {
        available: false,
        reason: "Provider media upload adapters are not installed.",
      },
      paidAdvertising: {
        available: false,
        reason: "Paid-ad provider campaign adapters are not installed.",
        supportedProviders: [],
      },
      inboundEngagement: {
        available: false,
        reason: "Provider comment and direct-message ingestion is not installed.",
      },
      providerAnalytics: {
        available: false,
        reason: "Provider performance ingestion is not installed.",
      },
      aiTextGeneration: {
        available: Boolean(
          process.env.GOODADS_GEMINI_API_KEY
          || process.env.GEMINI_API_KEY
          || process.env.GOOGLE_AI_API_KEY
        ),
      },
      leadCapture: { available: true },
      payments: { available: true },
      teamChat: { available: true, realtime: false },
    },
  };
}

function serializePublishJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    content: row.content || {},
    requestedProviders: row.requested_providers || [],
    results: row.results || [],
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

async function listPublishJobs({ context, userId, limit = 25, offset = 0, status }) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), 100);
  const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const values = [context.organizationId, userId, safeLimit, safeOffset];
  let statusClause = "";
  if (status) {
    values.push(String(status).toLowerCase());
    statusClause = ` AND status = $${values.length}`;
  }
  const result = await query(
    `SELECT id, status, content, requested_providers, results, created_at, started_at, completed_at
     FROM goodads_publish_jobs
     WHERE organization_id = $1 AND user_id = $2::uuid${statusClause}
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    values
  );
  return result.rows.map(serializePublishJob);
}

async function getPublishJob({ context, userId, id }) {
  const result = await query(
    `SELECT id, status, content, requested_providers, results, created_at, started_at, completed_at
     FROM goodads_publish_jobs
     WHERE id = $1::uuid AND organization_id = $2 AND user_id = $3::uuid`,
    [id, context.organizationId, userId]
  );
  if (!result.rows[0]) {
    throw socialError("Publishing job was not found.", 404, "GOODADS_PUBLISH_JOB_NOT_FOUND");
  }
  return serializePublishJob(result.rows[0]);
}

function rejectPaidCampaignLaunch() {
  throw socialError(
    "Paid campaign launch is unavailable until a real ad-provider adapter is configured. The campaign remains saved and ready for launch.",
    503,
    "GOODADS_AD_PROVIDER_NOT_READY"
  );
}

async function loadConnectionTokens({ context, userId, providers }) {
  const result = await query(
    `SELECT * FROM goodads_social_connections
     WHERE organization_id = $1 AND user_id = $2::uuid
       AND provider = ANY($3::text[]) AND status = 'connected'`,
    [context.organizationId, userId, providers]
  );
  return result.rows.map((row) => ({
    ...row,
    accessToken: decrypt(row.access_token_ciphertext, row.access_token_iv, row.access_token_tag),
  }));
}

async function providerPost(connection, content) {
  const text = String(content.text || content.message || "").trim();
  if (!text) throw socialError("Post text is required.");
  const headers = { Authorization: `Bearer ${connection.accessToken}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "GoodAds/1.0" };
  let url;
  let body;
  switch (connection.provider) {
    case "x":
      url = "https://api.x.com/2/tweets";
      body = { text };
      break;
    case "linkedin":
      url = "https://api.linkedin.com/v2/ugcPosts";
      body = {
        author: `urn:li:person:${connection.provider_account_id}`,
        lifecycleState: "PUBLISHED",
        specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text }, shareMediaCategory: "NONE" } },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      };
      headers["X-Restli-Protocol-Version"] = "2.0.0";
      break;
    case "facebook":
      url = `https://graph.facebook.com/v23.0/${encodeURIComponent(connection.provider_account_id)}/feed`;
      body = { message: text };
      break;
    case "reddit":
      if (!content.subreddit) throw socialError("A subreddit is required for Reddit.");
      url = "https://oauth.reddit.com/api/submit";
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams({ api_type: "json", kind: "self", sr: content.subreddit, title: content.title || text.slice(0, 280), text });
      break;
    default:
      throw socialError(`${connection.provider} publishing requires provider-specific media configuration.`, 422, "GOODADS_PROVIDER_CONTENT_REQUIRED");
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: body instanceof URLSearchParams ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw socialError(payload.error?.message || payload.message || `${connection.provider} rejected the post.`, 502, "GOODADS_PROVIDER_PUBLISH_FAILED");
  return payload;
}

async function publish({ context, userId, idempotencyKey, providers, content }) {
  if (!idempotencyKey) throw socialError("Idempotency-Key header is required.", 400, "GOODADS_IDEMPOTENCY_REQUIRED");
  const targets = [...new Set((Array.isArray(providers) ? providers : []).map((value) => String(value).toLowerCase()))];
  if (!targets.length || targets.length > 12) throw socialError("Select between 1 and 12 providers.");
  const safeContent = JSON.parse(JSON.stringify(content || {}));
  const existing = await query(
    `SELECT * FROM goodads_publish_jobs WHERE organization_id = $1 AND idempotency_key = $2`,
    [context.organizationId, idempotencyKey]
  );
  if (existing.rows[0]) return serializePublishJob(existing.rows[0]);
  const inserted = await query(
    `INSERT INTO goodads_publish_jobs (
       organization_id, user_id, idempotency_key, content, requested_providers, status, started_at
     ) VALUES ($1, $2::uuid, $3, $4::jsonb, $5::text[], 'processing', NOW())
     RETURNING *`,
    [context.organizationId, userId, idempotencyKey, JSON.stringify(safeContent), targets]
  );
  const connections = await loadConnectionTokens({ context, userId, providers: targets });
  const byProvider = new Map(connections.map((item) => [item.provider, item]));
  const results = [];
  for (const provider of targets) {
    const connection = byProvider.get(provider);
    if (!connection) {
      results.push({ provider, success: false, error: "No connected account." });
      continue;
    }
    try {
      const receipt = await providerPost(connection, safeContent);
      results.push({ provider, success: true, receipt });
    } catch (error) {
      results.push({ provider, success: false, error: error.message });
    }
  }
  const successes = results.filter((item) => item.success).length;
  const status = successes === results.length ? "completed" : successes > 0 ? "partial" : "failed";
  const updated = await query(
    `UPDATE goodads_publish_jobs SET status = $1, results = $2::jsonb, completed_at = NOW()
     WHERE id = $3::uuid RETURNING *`,
    [status, JSON.stringify(results), inserted.rows[0].id]
  );
  return serializePublishJob(updated.rows[0]);
}

module.exports = {
  PROVIDERS,
  PROVIDER_PUBLISH_CAPABILITIES,
  providerConfig,
  encrypt,
  decrypt,
  publicProviders,
  capabilities,
  beginAuthorization,
  completeAuthorization,
  listConnections,
  disconnect,
  listPublishJobs,
  getPublishJob,
  rejectPaidCampaignLaunch,
  publish,
};
