"use strict";

const crypto = require("crypto");
const database = require("../config/database");
const { query } = database;

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
  facebook: { text: false, media: false, video: false, immediate: false, scheduling: false, paidAds: false },
  instagram: { text: false, media: false, video: false, immediate: false, scheduling: false, paidAds: false },
  threads: { text: true, media: false, video: false, immediate: true, scheduling: false, paidAds: false },
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
    `SELECT id FROM goodads_social_connections
     WHERE organization_id = $1 AND user_id = $2::uuid AND provider = $3
       AND status <> 'disconnected'
     ORDER BY connected_at DESC`,
    [context.organizationId, userId, provider]
  );
  const disconnected = [];
  for (const row of result.rows) {
    disconnected.push(await disconnectConnection({ context, userId, id: row.id }));
  }
  return { disconnected: disconnected.length, accounts: disconnected };
}

async function revokeProviderToken(connection) {
  const accessToken = decrypt(
    connection.access_token_ciphertext,
    connection.access_token_iv,
    connection.access_token_tag
  );
  const config = providerConfig(connection.provider);
  let url;
  let method = "POST";
  let headers = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };
  let body;
  switch (connection.provider) {
    case "google":
      url = "https://oauth2.googleapis.com/revoke";
      body = new URLSearchParams({ token: accessToken });
      break;
    case "facebook":
    case "instagram":
      url = `https://graph.facebook.com/v23.0/me/permissions?access_token=${encodeURIComponent(accessToken)}`;
      method = "DELETE";
      break;
    case "x":
      url = "https://api.x.com/2/oauth2/revoke";
      headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
      body = new URLSearchParams({ token: accessToken, token_type_hint: "access_token" });
      break;
    case "reddit":
      url = "https://www.reddit.com/api/v1/revoke_token";
      headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
      body = new URLSearchParams({ token: accessToken, token_type_hint: "access_token" });
      break;
    default:
      return { attempted: false, revoked: false };
  }
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(10000),
  });
  return { attempted: true, revoked: response.ok, providerStatus: response.status };
}

async function disconnectConnection({ context, userId, id }) {
  const [safeId] = normalizeConnectionIds([id]);
  const selected = await query(
    `UPDATE goodads_social_connections SET status = 'disconnected', updated_at = NOW()
     WHERE id = $1::uuid AND organization_id = $2 AND user_id = $3::uuid
       AND status <> 'disconnected'
     RETURNING *`,
    [safeId, context.organizationId, userId]
  );
  if (!selected.rows[0]) throw socialError("Connected account was not found.", 404, "GOODADS_CONNECTION_NOT_FOUND");
  const connection = selected.rows[0];
  const revocation = await revokeProviderToken(connection).catch((error) => ({
    attempted: true,
    revoked: false,
    error: String(error.message || "Provider revocation failed.").slice(0, 300),
  }));
  await query(
    `UPDATE goodads_social_connections SET
       status = 'disconnected',
       access_token_ciphertext = '',
       access_token_iv = '',
       access_token_tag = '',
       refresh_token_ciphertext = NULL,
       refresh_token_iv = NULL,
       refresh_token_tag = NULL,
       metadata = metadata || $2::jsonb,
       updated_at = NOW()
     WHERE id = $1::uuid`,
    [
      safeId,
      JSON.stringify({
        disconnectedAt: new Date().toISOString(),
        providerRevocation: revocation,
      }),
    ]
  );
  return { id: safeId, provider: connection.provider, disconnected: true, revocation };
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
        accountSpecificTargets: true,
        boundedRetries: true,
      },
      scheduledPublishing: {
        available: true,
        durableHistory: true,
        accountSpecificTargets: true,
        boundedRetries: true,
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
    targets: row.targets || [],
    scheduledFor: row.scheduled_for,
    timezone: row.timezone || "UTC",
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 5),
    lastError: row.last_error || null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
  };
}

async function listPublishJobs({ context, userId, limit = 25, offset = 0, status }) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), 100);
  const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const values = [context.organizationId, userId, safeLimit, safeOffset];
  let statusClause = "";
  if (status) {
    values.push(String(status).toLowerCase());
    statusClause = ` AND job.status = $${values.length}`;
  }
  const result = await query(
    `SELECT job.id, job.status, job.content, job.requested_providers, job.results,
       job.scheduled_for, job.timezone, job.attempts, job.max_attempts, job.last_error,
       job.created_at, job.started_at, job.completed_at, job.cancelled_at,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', target.id,
           'connectionId', target.connection_id,
           'provider', target.provider,
           'providerAccountId', target.provider_account_id,
           'accountName', target.account_name,
           'status', target.status,
           'attempts', target.attempts,
           'maxAttempts', target.max_attempts,
           'receipt', target.receipt,
           'providerPostId', target.provider_post_id,
           'providerPostUrl', target.provider_post_url,
           'lastError', target.last_error,
           'completedAt', target.completed_at
         ) ORDER BY target.created_at)
         FROM goodads_publish_targets target WHERE target.job_id = job.id
       ), '[]'::jsonb) AS targets
     FROM goodads_publish_jobs job
     WHERE job.organization_id = $1 AND job.user_id = $2::uuid${statusClause}
     ORDER BY job.created_at DESC
     LIMIT $3 OFFSET $4`,
    values
  );
  return result.rows.map(serializePublishJob);
}

async function getPublishJob({ context, userId, id }) {
  const result = await query(
    `SELECT job.id, job.status, job.content, job.requested_providers, job.results,
       job.scheduled_for, job.timezone, job.attempts, job.max_attempts, job.last_error,
       job.created_at, job.started_at, job.completed_at, job.cancelled_at,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', target.id,
           'connectionId', target.connection_id,
           'provider', target.provider,
           'providerAccountId', target.provider_account_id,
           'accountName', target.account_name,
           'status', target.status,
           'attempts', target.attempts,
           'maxAttempts', target.max_attempts,
           'receipt', target.receipt,
           'providerPostId', target.provider_post_id,
           'providerPostUrl', target.provider_post_url,
           'lastError', target.last_error,
           'completedAt', target.completed_at
         ) ORDER BY target.created_at)
         FROM goodads_publish_targets target WHERE target.job_id = job.id
       ), '[]'::jsonb) AS targets
     FROM goodads_publish_jobs job
     WHERE job.id = $1::uuid AND job.organization_id = $2 AND job.user_id = $3::uuid`,
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
    case "threads": {
      const createResponse = await fetch(
        `https://graph.threads.net/v1.0/${encodeURIComponent(connection.provider_account_id)}/threads`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ media_type: "TEXT", text }),
          signal: AbortSignal.timeout(20000),
        }
      );
      const created = await createResponse.json().catch(() => ({}));
      if (!createResponse.ok || !created.id) {
        const requestError = socialError(
          created.error?.message || created.message || "Threads rejected the post container.",
          502,
          "GOODADS_PROVIDER_PUBLISH_FAILED"
        );
        requestError.retryable = createResponse.status === 429 || createResponse.status >= 500;
        throw requestError;
      }
      const publishResponse = await fetch(
        `https://graph.threads.net/v1.0/${encodeURIComponent(connection.provider_account_id)}/threads_publish`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ creation_id: created.id }),
          signal: AbortSignal.timeout(20000),
        }
      );
      const published = await publishResponse.json().catch(() => ({}));
      if (!publishResponse.ok || !published.id) {
        const requestError = socialError(
          published.error?.message || published.message || "Threads rejected the publish request.",
          502,
          "GOODADS_PROVIDER_PUBLISH_FAILED"
        );
        requestError.retryable = publishResponse.status === 429 || publishResponse.status >= 500;
        throw requestError;
      }
      return { receipt: { container: created, published }, providerPostId: String(published.id) };
    }
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
  if (!response.ok) {
    const requestError = socialError(
      payload.error?.message || payload.message || `${connection.provider} rejected the post.`,
      502,
      "GOODADS_PROVIDER_PUBLISH_FAILED"
    );
    requestError.retryable = response.status === 429 || response.status >= 500;
    requestError.providerStatus = response.status;
    throw requestError;
  }
  const providerPostId = payload.data?.id || payload.id || payload.json?.data?.id || response.headers.get("x-restli-id") || null;
  const providerPostUrl = payload.json?.data?.url || null;
  return {
    receipt: payload,
    providerPostId: providerPostId ? String(providerPostId) : null,
    providerPostUrl: providerPostUrl ? String(providerPostUrl) : null,
  };
}

function normalizePublishContent(content) {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw socialError("Publishing content must be a JSON object.");
  }
  const safe = JSON.parse(JSON.stringify(content));
  const text = String(safe.text || safe.message || "").trim();
  if (!text) throw socialError("Post text is required.");
  if (text.length > 5000) throw socialError("Post text cannot exceed 5,000 characters.");
  safe.text = text;
  if (safe.title != null) safe.title = String(safe.title).trim().slice(0, 300);
  if (safe.subreddit != null) safe.subreddit = String(safe.subreddit).trim().replace(/^r\//i, "").slice(0, 100);
  if (Buffer.byteLength(JSON.stringify(safe), "utf8") > 65536) {
    throw socialError("Publishing content cannot exceed 64 KB.");
  }
  return safe;
}

function normalizeSchedule(scheduledFor, timezone) {
  const zone = String(timezone || "UTC").trim().slice(0, 100) || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
  } catch {
    throw socialError("Select a valid IANA timezone.");
  }
  const date = scheduledFor ? new Date(scheduledFor) : new Date();
  if (Number.isNaN(date.getTime())) throw socialError("Select a valid publishing date and time.");
  if (date.getTime() < Date.now() - 5 * 60 * 1000) throw socialError("Publishing time cannot be in the past.");
  if (date.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) {
    throw socialError("Publishing time cannot be more than one year away.");
  }
  return { scheduledFor: date, timezone: zone, scheduled: date.getTime() > Date.now() + 5000 };
}

function normalizeConnectionIds(connectionIds) {
  const ids = [...new Set((Array.isArray(connectionIds) ? connectionIds : []).map((value) => String(value).toLowerCase()))];
  if (ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))) {
    throw socialError("A selected social account identifier is invalid.");
  }
  return ids;
}

async function resolvePublishConnections({ context, userId, connectionIds, providers }) {
  const selectedIds = normalizeConnectionIds(connectionIds);
  const legacyProviders = [...new Set((Array.isArray(providers) ? providers : []).map((value) => String(value).toLowerCase()))];
  if (!selectedIds.length && !legacyProviders.length) throw socialError("Select at least one connected account.");
  if (selectedIds.length > 25 || legacyProviders.length > 12) throw socialError("Select no more than 25 connected accounts.");
  const result = selectedIds.length
    ? await query(
      `SELECT id, provider, provider_account_id, account_name
       FROM goodads_social_connections
       WHERE organization_id = $1 AND user_id = $2::uuid
         AND id = ANY($3::uuid[]) AND status = 'connected'
       ORDER BY connected_at DESC`,
      [context.organizationId, userId, selectedIds]
    )
    : await query(
      `SELECT DISTINCT ON (provider) id, provider, provider_account_id, account_name
       FROM goodads_social_connections
       WHERE organization_id = $1 AND user_id = $2::uuid
         AND provider = ANY($3::text[]) AND status = 'connected'
       ORDER BY provider, updated_at DESC`,
      [context.organizationId, userId, legacyProviders]
    );
  const expected = selectedIds.length || legacyProviders.length;
  if (result.rows.length !== expected) {
    throw socialError("One or more selected accounts are missing, disconnected, or expired.", 409, "GOODADS_CONNECTION_UNAVAILABLE");
  }
  for (const connection of result.rows) {
    if (!PROVIDER_PUBLISH_CAPABILITIES[connection.provider]?.immediate) {
      throw socialError(
        `${PROVIDERS[connection.provider]?.label || connection.provider} does not have an installed text-publishing adapter.`,
        422,
        "GOODADS_PROVIDER_CONTENT_REQUIRED"
      );
    }
  }
  return result.rows;
}

async function publish({ context, userId, idempotencyKey, providers, connectionIds, content, scheduledFor, timezone }) {
  if (!idempotencyKey) throw socialError("Idempotency-Key header is required.", 400, "GOODADS_IDEMPOTENCY_REQUIRED");
  if (String(idempotencyKey).length > 200) throw socialError("Idempotency-Key is too long.");
  const safeContent = normalizePublishContent(content);
  const schedule = normalizeSchedule(scheduledFor, timezone);
  const existing = await query(
    `SELECT id FROM goodads_publish_jobs WHERE organization_id = $1 AND idempotency_key = $2`,
    [context.organizationId, idempotencyKey]
  );
  if (existing.rows[0]) return getPublishJob({ context, userId, id: existing.rows[0].id });
  const connections = await resolvePublishConnections({ context, userId, connectionIds, providers });
  const client = await database.pool.connect();
  let jobId;
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO goodads_publish_jobs (
         organization_id, user_id, idempotency_key, content, requested_providers,
         status, scheduled_for, timezone, available_at, max_attempts
       ) VALUES (
         $1, $2::uuid, $3, $4::jsonb, $5::text[], $6, $7, $8, $7, 5
       ) RETURNING id`,
      [
        context.organizationId,
        userId,
        idempotencyKey,
        JSON.stringify(safeContent),
        [...new Set(connections.map((connection) => connection.provider))],
        schedule.scheduled ? "scheduled" : "queued",
        schedule.scheduledFor.toISOString(),
        schedule.timezone,
      ]
    );
    jobId = inserted.rows[0].id;
    for (const connection of connections) {
      await client.query(
        `INSERT INTO goodads_publish_targets (
           job_id, connection_id, provider, provider_account_id, account_name,
           status, max_attempts, available_at
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'queued', 5, $6)`,
        [
          jobId,
          connection.id,
          connection.provider,
          connection.provider_account_id,
          connection.account_name,
          schedule.scheduledFor.toISOString(),
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      const duplicate = await query(
        `SELECT id FROM goodads_publish_jobs WHERE organization_id = $1 AND idempotency_key = $2`,
        [context.organizationId, idempotencyKey]
      );
      if (duplicate.rows[0]) return getPublishJob({ context, userId, id: duplicate.rows[0].id });
    }
    throw error;
  } finally {
    client.release();
  }
  return getPublishJob({ context, userId, id: jobId });
}

async function accessTokenForConnection(connection) {
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : null;
  if (!expiresAt || expiresAt > Date.now() + 5 * 60 * 1000) {
    return decrypt(connection.access_token_ciphertext, connection.access_token_iv, connection.access_token_tag);
  }
  if (!connection.refresh_token_ciphertext) {
    await query(
      `UPDATE goodads_social_connections SET status = 'expired', updated_at = NOW() WHERE id = $1::uuid`,
      [connection.id]
    );
    throw socialError("The connected account authorization has expired.", 401, "GOODADS_CONNECTION_EXPIRED");
  }
  const config = providerConfig(connection.provider);
  if (!config.configured) throw socialError(`${config.label} OAuth credentials are not configured.`, 503, "GOODADS_PROVIDER_NOT_CONFIGURED");
  const refreshToken = decrypt(
    connection.refresh_token_ciphertext,
    connection.refresh_token_iv,
    connection.refresh_token_tag
  );
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    [config.clientIdParameter || "client_id"]: config.clientId,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (config.id === "reddit" || config.id === "pinterest" || config.id === "x") {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  }
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    await query(
      `UPDATE goodads_social_connections SET status = 'expired', updated_at = NOW() WHERE id = $1::uuid`,
      [connection.id]
    );
    throw socialError(
      payload.error_description || payload.message || `${config.label} authorization could not be refreshed.`,
      401,
      "GOODADS_CONNECTION_EXPIRED"
    );
  }
  const access = encrypt(payload.access_token);
  const nextRefresh = payload.refresh_token ? encrypt(payload.refresh_token) : null;
  const nextExpiry = payload.expires_in ? new Date(Date.now() + Number(payload.expires_in) * 1000) : null;
  await query(
    `UPDATE goodads_social_connections SET
       access_token_ciphertext = $2, access_token_iv = $3, access_token_tag = $4,
       refresh_token_ciphertext = COALESCE($5, refresh_token_ciphertext),
       refresh_token_iv = COALESCE($6, refresh_token_iv),
       refresh_token_tag = COALESCE($7, refresh_token_tag),
       token_expires_at = $8, status = 'connected', last_verified_at = NOW(), updated_at = NOW()
     WHERE id = $1::uuid`,
    [
      connection.id,
      access.ciphertext,
      access.iv,
      access.tag,
      nextRefresh?.ciphertext || null,
      nextRefresh?.iv || null,
      nextRefresh?.tag || null,
      nextExpiry,
    ]
  );
  return payload.access_token;
}

async function claimPublishJob(workerId) {
  const result = await query(
    `WITH selected AS (
       SELECT id FROM goodads_publish_jobs
       WHERE (
           status IN ('scheduled', 'queued', 'retrying')
           OR (status = 'processing' AND locked_until < NOW())
         )
         AND scheduled_for <= NOW() AND available_at <= NOW()
         AND (locked_until IS NULL OR locked_until < NOW())
       ORDER BY scheduled_for ASC, created_at ASC
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE goodads_publish_jobs job SET
       status = 'processing', attempts = attempts + 1,
       locked_by = $1, locked_until = NOW() + INTERVAL '4 minutes',
       started_at = COALESCE(started_at, NOW()), last_error = NULL
     FROM selected WHERE job.id = selected.id
     RETURNING job.*`,
    [workerId]
  );
  return result.rows[0] || null;
}

async function processPublishJob(job, workerId) {
  await query(
    `UPDATE goodads_publish_targets SET status = 'retrying', available_at = NOW(),
       locked_by = NULL, locked_until = NULL,
       last_error = COALESCE(last_error, 'Recovered after an interrupted publishing worker.'),
       updated_at = NOW()
     WHERE job_id = $1::uuid AND status = 'processing' AND locked_until < NOW()`,
    [job.id]
  );
  const targetResult = await query(
    `SELECT connection.*,
       target.id AS target_id,
       target.status AS target_status,
       target.attempts AS target_attempts,
       target.max_attempts AS target_max_attempts
     FROM goodads_publish_targets target
     JOIN goodads_social_connections connection ON connection.id = target.connection_id
     WHERE target.job_id = $1::uuid
       AND target.status IN ('queued', 'retrying')
       AND target.available_at <= NOW()
     ORDER BY target.created_at ASC`,
    [job.id]
  );
  for (const target of targetResult.rows) {
    await query(
      `UPDATE goodads_publish_targets SET status = 'processing', attempts = attempts + 1,
       locked_by = $2, locked_until = NOW() + INTERVAL '3 minutes', last_error = NULL, updated_at = NOW()
       WHERE id = $1::uuid`,
      [target.target_id, workerId]
    );
    try {
      if (target.status === "disconnected" || target.status === "expired") {
        throw socialError("The connected account is no longer available.", 409, "GOODADS_CONNECTION_UNAVAILABLE");
      }
      const accessToken = await accessTokenForConnection(target);
      const delivered = await providerPost({ ...target, accessToken }, job.content || {});
      await query(
        `UPDATE goodads_publish_targets SET
           status = 'completed', receipt = $2::jsonb, provider_post_id = $3,
           provider_post_url = $4, completed_at = NOW(), locked_by = NULL,
           locked_until = NULL, last_error = NULL, updated_at = NOW()
         WHERE id = $1::uuid`,
        [
          target.target_id,
          JSON.stringify(delivered.receipt || {}),
          delivered.providerPostId || null,
          delivered.providerPostUrl || null,
        ]
      );
    } catch (error) {
      const nextAttempt = Number(target.target_attempts || 0) + 1;
      const transientFetchFailure = ["AbortError", "TimeoutError"].includes(error.name)
        || /fetch failed|network|timed out/i.test(String(error.message || ""));
      const retryable = (error.retryable === true || transientFetchFailure)
        && nextAttempt < Number(target.target_max_attempts || 5);
      const delaySeconds = Math.min(3600, 15 * (2 ** Math.max(0, nextAttempt - 1)));
      await query(
        `UPDATE goodads_publish_targets SET
           status = $2, available_at = CASE WHEN $2 = 'retrying'
             THEN NOW() + ($3::text || ' seconds')::interval ELSE available_at END,
           locked_by = NULL, locked_until = NULL, last_error = $4, updated_at = NOW()
         WHERE id = $1::uuid`,
        [
          target.target_id,
          retryable ? "retrying" : nextAttempt >= Number(target.target_max_attempts || 5) ? "dead_letter" : "failed",
          delaySeconds,
          String(error.message || "Provider delivery failed.").slice(0, 2000),
        ]
      );
    }
  }
  const summary = await query(
    `SELECT status, COUNT(*)::int AS count, MIN(available_at) AS next_available
     FROM goodads_publish_targets WHERE job_id = $1::uuid GROUP BY status`,
    [job.id]
  );
  const counts = new Map(summary.rows.map((row) => [row.status, Number(row.count || 0)]));
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const completed = counts.get("completed") || 0;
  const pending = (counts.get("queued") || 0) + (counts.get("retrying") || 0) + (counts.get("processing") || 0);
  const dead = counts.get("dead_letter") || 0;
  let status = "failed";
  if (total === 0) status = "failed";
  else if (pending) status = "retrying";
  else if (completed === total) status = "completed";
  else if (completed > 0) status = "partial";
  else if (dead === total) status = "dead_letter";
  const nextAvailable = summary.rows
    .filter((row) => ["queued", "retrying"].includes(row.status) && row.next_available)
    .map((row) => new Date(row.next_available))
    .sort((left, right) => left.getTime() - right.getTime())[0];
  const results = await query(
    `SELECT provider, provider_account_id, account_name, status,
       receipt, provider_post_id, provider_post_url, last_error
     FROM goodads_publish_targets WHERE job_id = $1::uuid ORDER BY created_at`,
    [job.id]
  );
  await query(
    `UPDATE goodads_publish_jobs SET
       status = $2, results = $3::jsonb,
       available_at = COALESCE($4, available_at),
       completed_at = CASE WHEN $2 IN ('completed','partial','failed','dead_letter') THEN NOW() ELSE NULL END,
       locked_by = NULL, locked_until = NULL,
       last_error = CASE WHEN $2 IN ('failed','dead_letter') THEN 'One or more provider targets failed.' ELSE NULL END
     WHERE id = $1::uuid`,
    [job.id, status, JSON.stringify(results.rows), nextAvailable || null]
  );
  return { id: job.id, status, completed, total };
}

async function processDuePublishJobs(limit = 10, workerId = `goodads-publisher-${process.pid}`) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const results = [];
  for (let index = 0; index < safeLimit; index += 1) {
    const job = await claimPublishJob(workerId);
    if (!job) break;
    try {
      results.push(await processPublishJob(job, workerId));
    } catch (error) {
      await query(
        `UPDATE goodads_publish_jobs SET
           status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'retrying' END,
           available_at = NOW() + (LEAST(3600, 15 * POWER(2, attempts))::text || ' seconds')::interval,
           locked_by = NULL, locked_until = NULL, last_error = $2
         WHERE id = $1::uuid`,
        [job.id, String(error.message || "Publishing worker failed.").slice(0, 2000)]
      );
      results.push({ id: job.id, status: "retrying", error: error.message });
    }
  }
  return { processed: results.length, results };
}

async function cancelPublishJob({ context, userId, id }) {
  const result = await query(
    `UPDATE goodads_publish_jobs SET status = 'cancelled', cancelled_at = NOW(),
       locked_by = NULL, locked_until = NULL
     WHERE id = $1::uuid AND organization_id = $2 AND user_id = $3::uuid
       AND status IN ('scheduled','queued','retrying')
     RETURNING id`,
    [id, context.organizationId, userId]
  );
  if (!result.rows[0]) throw socialError("Only a pending publishing job can be cancelled.", 409, "GOODADS_PUBLISH_CANCEL_DENIED");
  await query(
    `UPDATE goodads_publish_targets SET status = 'cancelled', locked_by = NULL,
       locked_until = NULL, updated_at = NOW()
     WHERE job_id = $1::uuid AND status IN ('queued','retrying')`,
    [id]
  );
  return getPublishJob({ context, userId, id });
}

async function retryPublishJob({ context, userId, id }) {
  const result = await query(
    `UPDATE goodads_publish_jobs SET status = 'queued', available_at = NOW(),
       completed_at = NULL, cancelled_at = NULL, locked_by = NULL, locked_until = NULL,
       last_error = NULL
     WHERE id = $1::uuid AND organization_id = $2 AND user_id = $3::uuid
       AND status IN ('failed','partial','dead_letter')
     RETURNING id`,
    [id, context.organizationId, userId]
  );
  if (!result.rows[0]) throw socialError("This publishing job is not eligible for retry.", 409, "GOODADS_PUBLISH_RETRY_DENIED");
  await query(
    `UPDATE goodads_publish_targets SET status = 'queued', attempts = 0,
       available_at = NOW(), locked_by = NULL, locked_until = NULL,
       last_error = NULL, updated_at = NOW()
     WHERE job_id = $1::uuid AND status IN ('failed','dead_letter')`,
    [id]
  );
  return getPublishJob({ context, userId, id });
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
  disconnectConnection,
  listPublishJobs,
  getPublishJob,
  cancelPublishJob,
  retryPublishJob,
  processDuePublishJobs,
  providerPost,
  normalizePublishContent,
  normalizeSchedule,
  normalizeConnectionIds,
  rejectPaidCampaignLaunch,
  publish,
};
