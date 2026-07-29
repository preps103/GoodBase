"use strict";

const crypto = require("node:crypto");
const { pool, query } = require("../config/database");
const social = require("./goodads-social.service");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._:-]{2,120}$/;
const MANAGEMENT_ROLES = new Set(["owner", "admin", "manager"]);
const PROVIDERS = Object.freeze({
  google: {
    name: "Google Ads",
    connectionProviders: ["google"],
    requiredEnvironment: ["GOODADS_GOOGLE_ADS_DEVELOPER_TOKEN"],
    safePausedCreation: true,
    deliveryAdapter: "search",
  },
  meta: {
    name: "Meta Ads",
    connectionProviders: ["facebook", "instagram"],
    requiredEnvironment: [],
    safePausedCreation: true,
    deliveryAdapter: "link_ad",
  },
});

function adsError(message, statusCode = 400, code = "GOODADS_ADS_ERROR", retryable = false) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function boundedText(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function requireUuid(value, label = "ID") {
  const id = boundedText(value, 64);
  if (!UUID_PATTERN.test(id)) throw adsError(`A valid ${label} is required.`);
  return id;
}

function roleFromContext(context) {
  return String(context?.organization?.membershipRole || context?.membershipRole || "").toLowerCase();
}

function requireManagement(context) {
  if (!MANAGEMENT_ROLES.has(roleFromContext(context))) {
    throw adsError(
      "Owner, admin, or manager access is required for paid campaign operations.",
      403,
      "GOODADS_ADS_MANAGEMENT_REQUIRED"
    );
  }
}

function requireIdempotencyKey(value) {
  const key = boundedText(value, 180);
  if (!key) throw adsError("Idempotency-Key header is required.", 400, "GOODADS_IDEMPOTENCY_REQUIRED");
  return key;
}

function canonicalProvider(value) {
  const provider = boundedText(value, 20).toLowerCase();
  if (!PROVIDERS[provider]) throw adsError("Unsupported paid-ad provider.", 404, "GOODADS_AD_PROVIDER_NOT_FOUND");
  return provider;
}

function providerAvailability(provider) {
  const id = canonicalProvider(provider);
  const definition = PROVIDERS[id];
  const oauthConfigured = definition.connectionProviders.some((connectionProvider) => {
    try {
      return social.providerConfig(connectionProvider).configured;
    } catch {
      return false;
    }
  });
  const missingEnvironment = definition.requiredEnvironment.filter((name) => !boundedText(process.env[name], 10000));
  return {
    id,
    name: definition.name,
    available: oauthConfigured && missingEnvironment.length === 0,
    oauthConfigured,
    missingEnvironment,
    safePausedCreation: definition.safePausedCreation,
    deliveryAdapter: definition.deliveryAdapter,
  };
}

function publicProviders() {
  return Object.keys(PROVIDERS).map(providerAvailability);
}

function providerRequestError(response, payload, fallback) {
  const providerMessage = boundedText(
    payload?.error?.message
      || payload?.error?.details?.[0]?.errors?.[0]?.message
      || payload?.message
      || fallback,
    2000
  );
  return adsError(
    providerMessage || fallback,
    response.status === 401 || response.status === 403 ? 409 : 502,
    "GOODADS_AD_PROVIDER_REQUEST_FAILED",
    response.status === 408 || response.status === 429 || response.status >= 500
  );
}

async function requestJson(url, options, fallback) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(25000) });
  } catch (error) {
    throw adsError(
      error.name === "TimeoutError" ? `${fallback} timed out.` : `${fallback} could not reach the provider.`,
      502,
      "GOODADS_AD_PROVIDER_UNREACHABLE",
      true
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw providerRequestError(response, payload, fallback);
  return { response, payload };
}

async function ownedConnection({ context, userId, connectionId, allowedProviders }) {
  const result = await query(
    `SELECT * FROM goodads_social_connections
     WHERE id = $1::uuid AND organization_id = $2 AND user_id = $3::uuid
       AND status = 'connected'`,
    [requireUuid(connectionId, "connection ID"), context.organizationId, userId]
  );
  const connection = result.rows[0];
  if (!connection) {
    throw adsError("A connected provider account was not found.", 404, "GOODADS_AD_CONNECTION_NOT_FOUND");
  }
  if (!allowedProviders.includes(connection.provider)) {
    throw adsError("This connection does not match the selected ad network.", 409, "GOODADS_AD_CONNECTION_MISMATCH");
  }
  return connection;
}

function normalizeMetaAccount(row) {
  const providerAccountId = boundedText(row.account_id || row.id, 120).replace(/^act_/, "");
  return {
    providerAccountId,
    name: boundedText(row.name || `Meta ad account ${providerAccountId}`, 240),
    currency: boundedText(row.currency, 12).toUpperCase(),
    timezone: boundedText(row.timezone_name, 120),
    eligible: Number(row.account_status) === 1,
    status: Number(row.account_status) === 1 ? "active" : `provider_status_${row.account_status || "unknown"}`,
  };
}

async function discoverMetaAccounts(accessToken) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "GoodAds/1.0",
  };
  const [{ payload: accountPayload }, { payload: pagePayload }] = await Promise.all([
    requestJson(
      "https://graph.facebook.com/v23.0/me/adaccounts?fields=id,account_id,name,account_status,currency,timezone_name&limit=100",
      { headers },
      "Meta ad-account discovery"
    ),
    requestJson(
      "https://graph.facebook.com/v23.0/me/accounts?fields=id,name,instagram_business_account{id,username}&limit=100",
      { headers },
      "Meta Page discovery"
    ).catch(() => ({ payload: { data: [] } })),
  ]);
  return {
    accounts: (Array.isArray(accountPayload.data) ? accountPayload.data : []).map(normalizeMetaAccount),
    pages: (Array.isArray(pagePayload.data) ? pagePayload.data : []).map((page) => ({
      id: boundedText(page.id, 120),
      name: boundedText(page.name, 240),
      instagramActorId: boundedText(page.instagram_business_account?.id, 120) || null,
      instagramUsername: boundedText(page.instagram_business_account?.username, 240) || null,
    })),
  };
}

function googleHeaders(accessToken) {
  const developerToken = boundedText(process.env.GOODADS_GOOGLE_ADS_DEVELOPER_TOKEN, 1000);
  if (!developerToken) {
    throw adsError(
      "Google Ads developer access is not configured in GoodBase.",
      503,
      "GOODADS_GOOGLE_DEVELOPER_TOKEN_MISSING"
    );
  }
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "GoodAds/1.0",
  };
  const loginCustomerId = boundedText(process.env.GOODADS_GOOGLE_ADS_LOGIN_CUSTOMER_ID, 40).replace(/\D/g, "");
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;
  return headers;
}

async function discoverGoogleAccounts(accessToken) {
  const { payload } = await requestJson(
    "https://googleads.googleapis.com/v24/customers:listAccessibleCustomers",
    { headers: googleHeaders(accessToken) },
    "Google Ads account discovery"
  );
  const accounts = (Array.isArray(payload.resourceNames) ? payload.resourceNames : [])
    .slice(0, 100)
    .map((resourceName) => {
      const providerAccountId = boundedText(resourceName, 160).replace(/^customers\//, "");
      return {
        providerAccountId,
        name: `Google Ads ${providerAccountId}`,
        currency: "",
        timezone: "",
        eligible: true,
        status: "accessible",
      };
    });
  return { accounts, pages: [] };
}

async function discoverAccounts({ provider, connectionId, context, userId }) {
  requireManagement(context);
  const id = canonicalProvider(provider);
  const availability = providerAvailability(id);
  if (!availability.available) {
    throw adsError(
      `${availability.name} is not fully configured in GoodBase.`,
      503,
      "GOODADS_AD_PROVIDER_NOT_CONFIGURED"
    );
  }
  const connection = await ownedConnection({
    context,
    userId,
    connectionId,
    allowedProviders: PROVIDERS[id].connectionProviders,
  });
  const accessToken = await social.accessTokenForConnection(connection);
  const discovered = id === "meta"
    ? await discoverMetaAccounts(accessToken)
    : await discoverGoogleAccounts(accessToken);
  return {
    provider: id,
    connectionId: connection.id,
    accounts: discovered.accounts,
    pages: discovered.pages,
  };
}

function rowToAdAccount(row) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    name: row.name,
    currency: row.currency,
    timezone: row.timezone,
    status: row.status,
    metadata: row.metadata || {},
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listAdAccounts({ context }) {
  const result = await query(
    `SELECT * FROM goodads_ad_accounts
     WHERE organization_id = $1
     ORDER BY status = 'verified' DESC, provider, name`,
    [context.organizationId]
  );
  return result.rows.map(rowToAdAccount);
}

async function saveAdAccount({ payload, context, userId }) {
  requireManagement(context);
  const provider = canonicalProvider(payload?.provider);
  const providerAccountId = boundedText(payload?.providerAccountId, 120).replace(/^act_/, "");
  if (!ACCOUNT_ID_PATTERN.test(providerAccountId)) throw adsError("Select a valid provider ad account.");
  const discovered = await discoverAccounts({
    provider,
    connectionId: payload?.connectionId,
    context,
    userId,
  });
  const account = discovered.accounts.find((item) => item.providerAccountId === providerAccountId);
  if (!account) {
    throw adsError(
      "The provider did not confirm access to this ad account.",
      409,
      "GOODADS_AD_ACCOUNT_NOT_ACCESSIBLE"
    );
  }
  if (!account.eligible) {
    throw adsError(
      "The provider reports that this ad account is not active.",
      409,
      "GOODADS_AD_ACCOUNT_NOT_ACTIVE"
    );
  }
  const pageId = boundedText(payload?.pageId, 120);
  const selectedPage = provider === "meta" && pageId
    ? discovered.pages.find((page) => page.id === pageId)
    : null;
  if (provider === "meta" && pageId && !selectedPage) {
    throw adsError("The selected Meta Page is not accessible to this connection.", 409, "GOODADS_META_PAGE_NOT_ACCESSIBLE");
  }
  const metadata = provider === "meta"
    ? {
        pageId: selectedPage?.id || null,
        pageName: selectedPage?.name || null,
        instagramActorId: selectedPage?.instagramActorId || null,
        instagramUsername: selectedPage?.instagramUsername || null,
        deliveryReady: Boolean(selectedPage?.id),
      }
    : { deliveryReady: true, channelType: "SEARCH" };
  const result = await query(
    `INSERT INTO goodads_ad_accounts (
       organization_id, connection_id, provider, provider_account_id, name,
       currency, timezone, status, metadata, verified_at, created_by_user_id
     ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, 'verified', $8::jsonb, NOW(), $9::uuid)
     ON CONFLICT (organization_id, provider, provider_account_id) DO UPDATE SET
       connection_id = EXCLUDED.connection_id,
       name = EXCLUDED.name,
       currency = EXCLUDED.currency,
       timezone = EXCLUDED.timezone,
       status = 'verified',
       metadata = EXCLUDED.metadata,
       verified_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [
      context.organizationId,
      payload.connectionId,
      provider,
      providerAccountId,
      account.name,
      account.currency,
      account.timezone,
      JSON.stringify(metadata),
      userId,
    ]
  );
  return rowToAdAccount(result.rows[0]);
}

async function disableAdAccount({ id, context }) {
  requireManagement(context);
  const result = await query(
    `UPDATE goodads_ad_accounts
     SET status = 'disabled', updated_at = NOW()
     WHERE id = $1::uuid AND organization_id = $2
     RETURNING *`,
    [requireUuid(id, "ad account ID"), context.organizationId]
  );
  if (!result.rows[0]) throw adsError("Ad account was not found.", 404, "GOODADS_AD_ACCOUNT_NOT_FOUND");
  return rowToAdAccount(result.rows[0]);
}

function campaignSnapshot(row) {
  return {
    id: row.id,
    version: Number(row.version || 1),
    name: boundedText(row.name, 240),
    status: row.status,
    data: row.data || {},
  };
}

function snapshotHash(snapshot) {
  return crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function validateCampaignForAccount(campaign, account) {
  const data = campaign.data || {};
  if (campaign.status !== "ready") {
    throw adsError("Mark this campaign ready before creating it on an ad network.", 409, "GOODADS_CAMPAIGN_NOT_READY");
  }
  const dailyBudget = Number(data.dailyBudget);
  const maximum = Math.max(Number(process.env.GOODADS_MAX_DAILY_BUDGET || 10000), 1);
  if (!Number.isFinite(dailyBudget) || dailyBudget < 1 || dailyBudget > maximum) {
    throw adsError(`Daily budget must be between 1 and ${maximum}.`, 409, "GOODADS_CAMPAIGN_BUDGET_INVALID");
  }
  const platforms = Array.isArray(data.platforms) ? data.platforms.map((item) => String(item).toLowerCase()) : [];
  const matchesProvider = account.provider === "google"
    ? platforms.includes("google")
    : platforms.some((provider) => provider === "facebook" || provider === "instagram" || provider === "meta");
  if (!matchesProvider) {
    throw adsError(`${PROVIDERS[account.provider].name} is not selected on this campaign.`, 409, "GOODADS_AD_ACCOUNT_NOT_SELECTED");
  }
  if (!data.startDate || !data.endDate || data.endDate < data.startDate) {
    throw adsError("Campaign dates are invalid.", 409, "GOODADS_CAMPAIGN_DATES_INVALID");
  }
  if (
    !Array.isArray(data.targetCountries)
    || !data.targetCountries.length
    || data.targetCountries.some((country) => !/^[A-Za-z]{2}$/.test(String(country)))
  ) {
    throw adsError(
      "Campaign targeting requires at least one two-letter country code.",
      409,
      "GOODADS_CAMPAIGN_COUNTRIES_REQUIRED"
    );
  }
  if (account.provider === "meta") {
    if (!account.metadata?.pageId) {
      throw adsError(
        "Select an accessible Facebook Page on this Meta ad account before launch.",
        409,
        "GOODADS_META_PAGE_REQUIRED"
      );
    }
    if (!data.creative?.imageUrl) {
      throw adsError("Meta delivery requires a public HTTPS creative image.", 409, "GOODADS_META_IMAGE_REQUIRED");
    }
  }
  if (account.provider === "google") {
    if (!Array.isArray(data.searchKeywords) || data.searchKeywords.filter(Boolean).length < 1) {
      throw adsError("Google Search delivery requires at least one keyword.", 409, "GOODADS_GOOGLE_KEYWORDS_REQUIRED");
    }
    if (!Array.isArray(data.searchHeadlines) || data.searchHeadlines.filter(Boolean).length < 3) {
      throw adsError("Google Search delivery requires at least three headlines.", 409, "GOODADS_GOOGLE_HEADLINES_REQUIRED");
    }
    if (!Array.isArray(data.searchDescriptions) || data.searchDescriptions.filter(Boolean).length < 2) {
      throw adsError("Google Search delivery requires at least two descriptions.", 409, "GOODADS_GOOGLE_DESCRIPTIONS_REQUIRED");
    }
  }
}

function rowToProviderCampaign(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    adAccountId: row.ad_account_id,
    provider: row.provider,
    providerCampaignId: row.provider_campaign_id,
    providerResourceName: row.provider_resource_name,
    providerBudgetId: row.provider_budget_id,
    status: row.status,
    campaignVersion: Number(row.campaign_version),
    activationApprovalId: row.activation_approval_id,
    activationApprovalStatus: row.activation_approval_status || null,
    receipt: row.receipt || {},
    lastError: row.last_error,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    account: row.account_name ? {
      id: row.ad_account_id,
      name: row.account_name,
      providerAccountId: row.provider_account_id,
      currency: row.account_currency,
      timezone: row.account_timezone,
      status: row.account_status,
    } : undefined,
  };
}

function rowToOperation(row) {
  return {
    id: row.id,
    providerCampaignId: row.provider_campaign_id,
    operationType: row.operation_type,
    status: row.status,
    receipt: row.receipt || {},
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 5),
    lastError: row.last_error,
    availableAt: row.available_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

async function getCampaignState({ campaignId, context }) {
  const safeCampaignId = requireUuid(campaignId, "campaign ID");
  const result = await query(
    `SELECT provider_campaign.*, account.name AS account_name,
       account.provider_account_id, account.currency AS account_currency,
       account.timezone AS account_timezone, account.status AS account_status,
       approval.status AS activation_approval_status
     FROM goodads_provider_campaigns provider_campaign
     JOIN goodads_ad_accounts account ON account.id = provider_campaign.ad_account_id
     LEFT JOIN goodads_resources approval ON approval.id = provider_campaign.activation_approval_id
     WHERE provider_campaign.organization_id = $1
       AND provider_campaign.campaign_id = $2::uuid
     ORDER BY provider_campaign.created_at`,
    [context.organizationId, safeCampaignId]
  );
  const operationResult = await query(
    `SELECT operation.*
     FROM goodads_ad_operations operation
     JOIN goodads_provider_campaigns provider_campaign ON provider_campaign.id = operation.provider_campaign_id
     WHERE operation.organization_id = $1 AND provider_campaign.campaign_id = $2::uuid
     ORDER BY operation.created_at DESC LIMIT 100`,
    [context.organizationId, safeCampaignId]
  );
  return {
    campaigns: result.rows.map(rowToProviderCampaign),
    operations: operationResult.rows.map(rowToOperation),
  };
}

async function launchCampaign({ campaignId, adAccountIds, context, userId, idempotencyKey }) {
  requireManagement(context);
  const requestKey = requireIdempotencyKey(idempotencyKey);
  const safeCampaignId = requireUuid(campaignId, "campaign ID");
  const accountIds = [...new Set(Array.isArray(adAccountIds) ? adAccountIds.map((id) => requireUuid(id, "ad account ID")) : [])];
  if (!accountIds.length || accountIds.length > 10) {
    throw adsError("Select between one and ten verified ad accounts.");
  }
  const campaignResult = await query(
    `SELECT * FROM goodads_resources
     WHERE id = $1::uuid AND organization_id = $2
       AND resource_type = 'campaigns' AND archived_at IS NULL`,
    [safeCampaignId, context.organizationId]
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) throw adsError("Campaign was not found.", 404, "GOODADS_CAMPAIGN_NOT_FOUND");
  const accountResult = await query(
    `SELECT * FROM goodads_ad_accounts
     WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND status = 'verified'`,
    [context.organizationId, accountIds]
  );
  if (accountResult.rows.length !== accountIds.length) {
    throw adsError("Every selected ad account must be verified.", 409, "GOODADS_AD_ACCOUNT_NOT_VERIFIED");
  }
  const snapshot = campaignSnapshot(campaign);
  const hash = snapshotHash(snapshot);
  for (const account of accountResult.rows) {
    const availability = providerAvailability(account.provider);
    if (!availability.available) {
      throw adsError(`${availability.name} is not fully configured in GoodBase.`, 503, "GOODADS_AD_PROVIDER_NOT_CONFIGURED");
    }
    validateCampaignForAccount(campaign, account);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const account of accountResult.rows) {
      const providerCampaign = await client.query(
        `INSERT INTO goodads_provider_campaigns (
           organization_id, campaign_id, ad_account_id, provider, status,
           campaign_version, snapshot_hash, created_by_user_id
         ) VALUES ($1, $2::uuid, $3::uuid, $4, 'queued', $5, $6, $7::uuid)
         ON CONFLICT (organization_id, campaign_id, ad_account_id) DO UPDATE SET
           campaign_version = EXCLUDED.campaign_version,
           snapshot_hash = EXCLUDED.snapshot_hash,
           status = CASE
             WHEN goodads_provider_campaigns.provider_campaign_id IS NULL THEN 'queued'
             ELSE goodads_provider_campaigns.status
           END,
           last_error = NULL,
           updated_at = NOW()
         RETURNING *`,
        [context.organizationId, campaign.id, account.id, account.provider, campaign.version, hash, userId]
      );
      const record = providerCampaign.rows[0];
      if (!record.provider_campaign_id) {
        await client.query(
          `INSERT INTO goodads_ad_operations (
             organization_id, provider_campaign_id, requested_by_user_id,
             operation_type, idempotency_key, payload
           ) VALUES ($1, $2::uuid, $3::uuid, 'create', $4, $5::jsonb)
           ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
          [
            context.organizationId,
            record.id,
            userId,
            `${requestKey}:${account.id}:create`,
            JSON.stringify({ snapshot, snapshotHash: hash }),
          ]
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getCampaignState({ campaignId: safeCampaignId, context });
}

async function queueLifecycleOperation({
  campaignId,
  providerCampaignId,
  operationType,
  approvalId,
  context,
  userId,
  idempotencyKey,
}) {
  requireManagement(context);
  const requestKey = requireIdempotencyKey(idempotencyKey);
  if (!["sync", "pause", "activate", "archive"].includes(operationType)) {
    throw adsError("Unsupported campaign operation.");
  }
  const selected = await query(
    `SELECT provider_campaign.*, campaign.name AS campaign_name,
       campaign.status AS campaign_status, campaign.data AS campaign_data,
       campaign.version AS current_version,
       approval.status AS approval_status, approval.data AS approval_data
     FROM goodads_provider_campaigns provider_campaign
     JOIN goodads_resources campaign ON campaign.id = provider_campaign.campaign_id
     LEFT JOIN goodads_resources approval
       ON approval.id = $4::uuid AND approval.organization_id = provider_campaign.organization_id
       AND approval.resource_type = 'approvals'
     WHERE provider_campaign.id = $1::uuid
       AND provider_campaign.campaign_id = $2::uuid
       AND provider_campaign.organization_id = $3`,
    [
      requireUuid(providerCampaignId, "provider campaign ID"),
      requireUuid(campaignId, "campaign ID"),
      context.organizationId,
      approvalId && UUID_PATTERN.test(String(approvalId)) ? approvalId : null,
    ]
  );
  const campaign = selected.rows[0];
  if (!campaign) throw adsError("Provider campaign was not found.", 404, "GOODADS_PROVIDER_CAMPAIGN_NOT_FOUND");
  if (operationType === "activate") {
    const currentSnapshot = {
      id: campaign.campaign_id,
      version: Number(campaign.current_version),
      name: boundedText(campaign.campaign_name, 240),
      status: campaign.campaign_status,
      data: campaign.campaign_data || {},
    };
    if (snapshotHash(currentSnapshot) !== campaign.snapshot_hash) {
      throw adsError(
        "The campaign changed after provider creation. Create a fresh paused provider campaign before activation.",
        409,
        "GOODADS_AD_CAMPAIGN_VERSION_CHANGED"
      );
    }
    if (!approvalId || campaign.approval_status !== "approved") {
      throw adsError(
        "An approved paid-campaign activation review is required.",
        409,
        "GOODADS_AD_ACTIVATION_APPROVAL_REQUIRED"
      );
    }
    const approvalData = campaign.approval_data || {};
    if (
      approvalData.reviewType !== "paid_campaign_activation"
      || approvalData.campaignId !== campaign.campaign_id
      || approvalData.providerCampaignId !== campaign.id
      || approvalData.snapshotHash !== campaign.snapshot_hash
    ) {
      throw adsError(
        "This approval does not match the exact campaign version and ad account.",
        409,
        "GOODADS_AD_ACTIVATION_APPROVAL_MISMATCH"
      );
    }
  }
  await query(
    `INSERT INTO goodads_ad_operations (
       organization_id, provider_campaign_id, requested_by_user_id,
       operation_type, idempotency_key, payload
     ) VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6::jsonb)
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
    [
      context.organizationId,
      campaign.id,
      userId,
      operationType,
      `${requestKey}:${campaign.id}:${operationType}`,
      JSON.stringify({ approvalId: approvalId || null }),
    ]
  );
  if (operationType === "activate") {
    await query(
      `UPDATE goodads_provider_campaigns
       SET activation_approval_id = $2::uuid, updated_at = NOW()
       WHERE id = $1::uuid`,
      [campaign.id, approvalId]
    );
  }
  return getCampaignState({ campaignId, context });
}

async function requestActivationApproval({
  campaignId,
  providerCampaignId,
  context,
  userId,
  idempotencyKey,
}) {
  requireManagement(context);
  const requestKey = requireIdempotencyKey(idempotencyKey);
  const selected = await query(
    `SELECT provider_campaign.*, campaign.name AS campaign_name, campaign.data AS campaign_data,
       account.name AS account_name, account.provider_account_id
     FROM goodads_provider_campaigns provider_campaign
     JOIN goodads_resources campaign ON campaign.id = provider_campaign.campaign_id
     JOIN goodads_ad_accounts account ON account.id = provider_campaign.ad_account_id
     WHERE provider_campaign.id = $1::uuid AND provider_campaign.campaign_id = $2::uuid
       AND provider_campaign.organization_id = $3`,
    [
      requireUuid(providerCampaignId, "provider campaign ID"),
      requireUuid(campaignId, "campaign ID"),
      context.organizationId,
    ]
  );
  const campaign = selected.rows[0];
  if (!campaign) throw adsError("Provider campaign was not found.", 404, "GOODADS_PROVIDER_CAMPAIGN_NOT_FOUND");
  if (campaign.status !== "paused") {
    throw adsError("The provider campaign must be created and paused before activation review.", 409, "GOODADS_AD_CAMPAIGN_NOT_PAUSED");
  }
  const approval = await require("./goodads-workflows.service").saveApproval({
    payload: {
      name: `Activate ${campaign.campaign_name} on ${PROVIDERS[campaign.provider].name}`,
      status: "pending",
      reviewType: "paid_campaign_activation",
      priority: "high",
      description: `Approve activation for ${campaign.account_name} (${campaign.provider_account_id}). Planned daily budget: ${campaign.campaign_data?.dailyBudget || 0}.`,
      campaignId: campaign.campaign_id,
      providerCampaignId: campaign.id,
      snapshotHash: campaign.snapshot_hash,
      provider: campaign.provider,
      providerAccountId: campaign.provider_account_id,
      dailyBudget: campaign.campaign_data?.dailyBudget,
      startDate: campaign.campaign_data?.startDate,
      endDate: campaign.campaign_data?.endDate,
    },
    context,
    userId,
    idempotencyKey: `${requestKey}:${campaign.id}:activation-approval`,
  });
  await query(
    `UPDATE goodads_provider_campaigns SET activation_approval_id = $2::uuid, updated_at = NOW()
     WHERE id = $1::uuid`,
    [campaign.id, approval.id]
  );
  return approval;
}

function metaObjective(value) {
  return {
    traffic: "OUTCOME_TRAFFIC",
    conversions: "OUTCOME_SALES",
    sales: "OUTCOME_SALES",
    leads: "OUTCOME_LEADS",
    awareness: "OUTCOME_AWARENESS",
  }[String(value || "").toLowerCase()] || "OUTCOME_TRAFFIC";
}

function dateAtNoonUtc(value) {
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw adsError("Campaign schedule is invalid.");
  return date.toISOString();
}

async function metaPost(path, accessToken, fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    body.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const { payload } = await requestJson(
    `https://graph.facebook.com/v23.0/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "GoodAds/1.0",
      },
      body,
    },
    "Meta campaign operation"
  );
  return payload;
}

async function createMetaDelivery(row, accessToken) {
  const data = row.campaign_data || {};
  const creative = data.creative || {};
  const accountId = String(row.provider_account_id).replace(/^act_/, "");
  let providerCampaignId = row.provider_campaign_id;
  if (!providerCampaignId) {
    const campaign = await metaPost(`act_${accountId}/campaigns`, accessToken, {
      name: row.campaign_name,
      objective: metaObjective(data.objective),
      status: "PAUSED",
      special_ad_categories: [],
    });
    if (!campaign.id) throw adsError("Meta did not return a campaign ID.", 502, "GOODADS_META_CAMPAIGN_CREATE_FAILED");
    providerCampaignId = campaign.id;
    await query(
      `UPDATE goodads_provider_campaigns
       SET provider_campaign_id = $2, provider_resource_name = $2, receipt = receipt || $3::jsonb, updated_at = NOW()
       WHERE id = $1::uuid`,
      [row.provider_campaign_record_id, providerCampaignId, JSON.stringify({ campaignId: providerCampaignId })]
    );
  }
  const countries = Array.isArray(data.targetCountries) && data.targetCountries.length
    ? data.targetCountries.map((country) => boundedText(country, 2).toUpperCase()).filter(Boolean)
    : ["US"];
  let adSetId = row.receipt?.adSetId;
  if (!adSetId) {
    const adSet = await metaPost(`act_${accountId}/adsets`, accessToken, {
      name: `${row.campaign_name} audience`,
      campaign_id: providerCampaignId,
      daily_budget: Math.round(Number(data.dailyBudget) * 100),
      billing_event: "IMPRESSIONS",
      optimization_goal: "LINK_CLICKS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: { geo_locations: { countries } },
      start_time: dateAtNoonUtc(data.startDate),
      end_time: dateAtNoonUtc(data.endDate),
      status: "PAUSED",
    });
    if (!adSet.id) throw adsError("Meta did not return an ad-set ID.", 502, "GOODADS_META_ADSET_CREATE_FAILED");
    adSetId = adSet.id;
    await query(
      `UPDATE goodads_provider_campaigns
       SET provider_budget_id = $2, receipt = receipt || $3::jsonb, updated_at = NOW()
       WHERE id = $1::uuid`,
      [row.provider_campaign_record_id, adSetId, JSON.stringify({ adSetId })]
    );
  }
  const linkData = {
    link: creative.destinationUrl,
    message: creative.primaryText,
    name: creative.headline,
    picture: creative.imageUrl,
    call_to_action: {
      type: {
        "Shop Now": "SHOP_NOW",
        "Sign Up": "SIGN_UP",
        "Book Now": "BOOK_TRAVEL",
        "Get Offer": "GET_OFFER",
      }[creative.callToAction] || "LEARN_MORE",
      value: { link: creative.destinationUrl },
    },
  };
  let adId = row.receipt?.adId;
  if (!adId) {
    const ad = await metaPost(`act_${accountId}/ads`, accessToken, {
      name: `${row.campaign_name} ad`,
      adset_id: adSetId,
      status: "PAUSED",
      creative: {
        object_story_spec: {
          page_id: row.account_metadata?.pageId,
          ...(row.account_metadata?.instagramActorId
            ? { instagram_actor_id: row.account_metadata.instagramActorId }
            : {}),
          link_data: linkData,
        },
      },
    });
    if (!ad.id) throw adsError("Meta did not return an ad ID.", 502, "GOODADS_META_AD_CREATE_FAILED");
    adId = ad.id;
  }
  return {
    providerCampaignId,
    providerResourceName: providerCampaignId,
    providerBudgetId: adSetId,
    receipt: { campaignId: providerCampaignId, adSetId, adId, state: "PAUSED" },
  };
}

async function googleMutate(row, accessToken, resource, operations) {
  const customerId = String(row.provider_account_id).replace(/\D/g, "");
  const { payload } = await requestJson(
    `https://googleads.googleapis.com/v24/customers/${customerId}/${resource}:mutate`,
    {
      method: "POST",
      headers: googleHeaders(accessToken),
      body: JSON.stringify({ operations, partialFailure: false, validateOnly: false }),
    },
    `Google Ads ${resource} operation`
  );
  return payload;
}

function googleResource(payload) {
  return payload?.results?.[0]?.resourceName || "";
}

async function createGoogleDelivery(row, accessToken) {
  const data = row.campaign_data || {};
  const creative = data.creative || {};
  const customerId = String(row.provider_account_id).replace(/\D/g, "");
  let budgetResource = row.provider_budget_id;
  if (!budgetResource) {
    const budgetPayload = await googleMutate(row, accessToken, "campaignBudgets", [{
      create: {
        name: `${row.campaign_name} budget ${crypto.randomUUID().slice(0, 8)}`,
        amountMicros: String(Math.round(Number(data.dailyBudget) * 1000000)),
        deliveryMethod: "STANDARD",
        explicitlyShared: false,
      },
    }]);
    budgetResource = googleResource(budgetPayload);
    if (!budgetResource) throw adsError("Google Ads did not return a budget resource.", 502, "GOODADS_GOOGLE_BUDGET_CREATE_FAILED");
    await query(
      `UPDATE goodads_provider_campaigns SET provider_budget_id = $2, updated_at = NOW() WHERE id = $1::uuid`,
      [row.provider_campaign_record_id, budgetResource]
    );
  }
  let campaignResource = row.provider_resource_name;
  if (!campaignResource) {
    const campaignPayload = await googleMutate(row, accessToken, "campaigns", [{
      create: {
        name: row.campaign_name,
        status: "PAUSED",
        campaignBudget: budgetResource,
        advertisingChannelType: "SEARCH",
        startDate: String(data.startDate).replaceAll("-", ""),
        endDate: String(data.endDate).replaceAll("-", ""),
        manualCpc: { enhancedCpcEnabled: false },
        networkSettings: {
          targetGoogleSearch: true,
          targetSearchNetwork: true,
          targetContentNetwork: false,
          targetPartnerSearchNetwork: false,
        },
      },
    }]);
    campaignResource = googleResource(campaignPayload);
    if (!campaignResource) throw adsError("Google Ads did not return a campaign resource.", 502, "GOODADS_GOOGLE_CAMPAIGN_CREATE_FAILED");
    await query(
      `UPDATE goodads_provider_campaigns
       SET provider_campaign_id = $2, provider_resource_name = $3,
           receipt = receipt || $4::jsonb, updated_at = NOW()
       WHERE id = $1::uuid`,
      [
        row.provider_campaign_record_id,
        campaignResource.split("/").pop(),
        campaignResource,
        JSON.stringify({ campaignResource, budgetResource }),
      ]
    );
  }
  const campaignId = campaignResource.split("/").pop();
  let adGroupResource = row.receipt?.adGroupResource;
  if (!adGroupResource) {
    const adGroupPayload = await googleMutate(row, accessToken, "adGroups", [{
      create: {
        name: `${row.campaign_name} search group`,
        campaign: campaignResource,
        status: "PAUSED",
        type: "SEARCH_STANDARD",
        cpcBidMicros: String(Math.round(Math.max(Number(data.maxCpc || 1), 0.01) * 1000000)),
      },
    }]);
    adGroupResource = googleResource(adGroupPayload);
    if (!adGroupResource) throw adsError("Google Ads did not return an ad-group resource.", 502, "GOODADS_GOOGLE_ADGROUP_CREATE_FAILED");
    await query(
      `UPDATE goodads_provider_campaigns SET receipt = receipt || $2::jsonb, updated_at = NOW()
       WHERE id = $1::uuid`,
      [row.provider_campaign_record_id, JSON.stringify({ adGroupResource })]
    );
  }
  const keywordOperations = data.searchKeywords
    .map((text) => boundedText(text, 80))
    .filter(Boolean)
    .slice(0, 50)
    .map((text) => ({
      create: {
        adGroup: adGroupResource,
        status: "ENABLED",
        keyword: { text, matchType: "PHRASE" },
      },
    }));
  if (!row.receipt?.keywordsCreated) {
    await googleMutate(row, accessToken, "adGroupCriteria", keywordOperations);
    await query(
      `UPDATE goodads_provider_campaigns SET receipt = receipt || '{"keywordsCreated":true}'::jsonb, updated_at = NOW()
       WHERE id = $1::uuid`,
      [row.provider_campaign_record_id]
    );
  }
  let adResource = row.receipt?.adResource;
  if (!adResource) {
    const adPayload = await googleMutate(row, accessToken, "adGroupAds", [{
      create: {
        adGroup: adGroupResource,
        status: "PAUSED",
        ad: {
          finalUrls: [creative.destinationUrl],
          responsiveSearchAd: {
            headlines: data.searchHeadlines.slice(0, 15).map((text) => ({ text: boundedText(text, 30) })),
            descriptions: data.searchDescriptions.slice(0, 4).map((text) => ({ text: boundedText(text, 90) })),
          },
        },
      },
    }]);
    adResource = googleResource(adPayload);
    if (!adResource) throw adsError("Google Ads did not return an ad resource.", 502, "GOODADS_GOOGLE_AD_CREATE_FAILED");
  }
  return {
    providerCampaignId: campaignId,
    providerResourceName: campaignResource,
    providerBudgetId: budgetResource,
    receipt: {
      campaignResource,
      budgetResource,
      adGroupResource,
      adResource,
      customerId,
      state: "PAUSED",
    },
  };
}

async function updateMetaStatus(row, accessToken, status) {
  const ids = [row.provider_campaign_id, row.receipt?.adSetId, row.receipt?.adId].filter(Boolean);
  for (const id of ids) await metaPost(id, accessToken, { status });
  return { ...row.receipt, state: status };
}

async function updateGoogleStatus(row, accessToken, status) {
  const operations = [{
    updateMask: "status",
    update: { resourceName: row.provider_resource_name, status },
  }];
  await googleMutate(row, accessToken, "campaigns", operations);
  if (row.receipt?.adGroupResource) {
    await googleMutate(row, accessToken, "adGroups", [{
      updateMask: "status",
      update: { resourceName: row.receipt.adGroupResource, status },
    }]);
  }
  if (row.receipt?.adResource) {
    await googleMutate(row, accessToken, "adGroupAds", [{
      updateMask: "status",
      update: { resourceName: row.receipt.adResource, status },
    }]);
  }
  return { ...row.receipt, state: status };
}

async function syncMetaStatus(row, accessToken) {
  const { payload } = await requestJson(
    `https://graph.facebook.com/v23.0/${encodeURIComponent(row.provider_campaign_id)}?fields=id,status,effective_status`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "GoodAds/1.0",
      },
    },
    "Meta campaign status"
  );
  const providerStatus = String(payload.effective_status || payload.status || "").toUpperCase();
  const status = providerStatus === "ACTIVE"
    ? "active"
    : providerStatus === "ARCHIVED" || providerStatus === "DELETED"
      ? "archived"
      : providerStatus === "PAUSED" || providerStatus === "CAMPAIGN_PAUSED"
        ? "paused"
        : row.status;
  return { receipt: { ...row.receipt, providerStatus, state: providerStatus }, status };
}

async function syncGoogleStatus(row, accessToken) {
  const customerId = String(row.provider_account_id).replace(/\D/g, "");
  const campaignId = String(row.provider_campaign_id).replace(/\D/g, "");
  const { payload } = await requestJson(
    `https://googleads.googleapis.com/v24/customers/${customerId}/googleAds:searchStream`,
    {
      method: "POST",
      headers: googleHeaders(accessToken),
      body: JSON.stringify({
        query: `SELECT campaign.id, campaign.status FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`,
      }),
    },
    "Google Ads campaign status"
  );
  const record = Array.isArray(payload)
    ? payload.flatMap((batch) => batch.results || [])[0]
    : payload.results?.[0];
  const providerStatus = String(record?.campaign?.status || "").toUpperCase();
  const status = providerStatus === "ENABLED"
    ? "active"
    : providerStatus === "REMOVED"
      ? "archived"
      : providerStatus === "PAUSED"
        ? "paused"
        : row.status;
  return { receipt: { ...row.receipt, providerStatus, state: providerStatus }, status };
}

async function executeOperation(row) {
  const accessToken = await social.accessTokenForConnection(row);
  if (row.operation_type === "create") {
    return row.provider === "meta"
      ? createMetaDelivery(row, accessToken)
      : createGoogleDelivery(row, accessToken);
  }
  if (!row.provider_campaign_id) throw adsError("The provider campaign has not been created.");
  if (row.operation_type === "pause") {
    const receipt = row.provider === "meta"
      ? await updateMetaStatus(row, accessToken, "PAUSED")
      : await updateGoogleStatus(row, accessToken, "PAUSED");
    return { receipt, status: "paused" };
  }
  if (row.operation_type === "activate") {
    const receipt = row.provider === "meta"
      ? await updateMetaStatus(row, accessToken, "ACTIVE")
      : await updateGoogleStatus(row, accessToken, "ENABLED");
    return { receipt, status: "active" };
  }
  if (row.operation_type === "archive") {
    const receipt = row.provider === "meta"
      ? await updateMetaStatus(row, accessToken, "ARCHIVED")
      : await updateGoogleStatus(row, accessToken, "REMOVED");
    return { receipt, status: "archived" };
  }
  return row.provider === "meta"
    ? syncMetaStatus(row, accessToken)
    : syncGoogleStatus(row, accessToken);
}

async function processOperation(row) {
  try {
    const result = await executeOperation(row);
    const status = result.status || "paused";
    await query(
      `UPDATE goodads_provider_campaigns
       SET provider_campaign_id = COALESCE($2, provider_campaign_id),
           provider_resource_name = COALESCE($3, provider_resource_name),
           provider_budget_id = COALESCE($4, provider_budget_id),
           status = $5,
           receipt = COALESCE($6::jsonb, receipt),
           last_error = NULL,
           last_synced_at = NOW(),
           updated_at = NOW()
       WHERE id = $1::uuid`,
      [
        row.provider_campaign_record_id,
        result.providerCampaignId || null,
        result.providerResourceName || null,
        result.providerBudgetId || null,
        status,
        JSON.stringify(result.receipt || {}),
      ]
    );
    await query(
      `UPDATE goodads_ad_operations
       SET status = 'completed', receipt = $2::jsonb, last_error = NULL,
           completed_at = NOW(), locked_by = NULL, locked_until = NULL, updated_at = NOW()
       WHERE id = $1::uuid`,
      [row.operation_id, JSON.stringify(result.receipt || result)]
    );
    return { id: row.operation_id, status: "completed" };
  } catch (error) {
    const attempts = Number(row.attempts || 1);
    const retry = error.retryable === true && attempts < Number(row.max_attempts || 5);
    const nextStatus = retry ? "retrying" : attempts >= Number(row.max_attempts || 5) ? "dead_letter" : "failed";
    const retrySeconds = Math.min(3600, 30 * (2 ** Math.max(0, attempts - 1)));
    await query(
      `UPDATE goodads_ad_operations
       SET status = $2, last_error = $3,
           available_at = CASE WHEN $2 = 'retrying' THEN NOW() + ($4::text || ' seconds')::interval ELSE available_at END,
           completed_at = CASE WHEN $2 IN ('failed','dead_letter') THEN NOW() ELSE NULL END,
           locked_by = NULL, locked_until = NULL, updated_at = NOW()
       WHERE id = $1::uuid`,
      [row.operation_id, nextStatus, boundedText(error.message, 2000), retrySeconds]
    );
    await query(
      `UPDATE goodads_provider_campaigns
       SET status = $2, last_error = $3, updated_at = NOW()
       WHERE id = $1::uuid`,
      [row.provider_campaign_record_id, retry ? row.status : "failed", boundedText(error.message, 2000)]
    );
    return { id: row.operation_id, status: nextStatus, error: boundedText(error.message, 2000) };
  }
}

async function processDueOperations(limit = 10, workerId = `goodads-ads-${process.pid}`) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const claimed = await query(
    `WITH due AS (
       SELECT operation.id
       FROM goodads_ad_operations operation
       WHERE operation.status IN ('queued','retrying')
         AND operation.available_at <= NOW()
         AND (operation.locked_until IS NULL OR operation.locked_until < NOW())
       ORDER BY operation.available_at, operation.created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE goodads_ad_operations operation
     SET status = 'processing', attempts = operation.attempts + 1,
         locked_by = $2, locked_until = NOW() + INTERVAL '2 minutes',
         started_at = COALESCE(operation.started_at, NOW()), updated_at = NOW()
     FROM due
     WHERE operation.id = due.id
     RETURNING operation.id`,
    [safeLimit, boundedText(workerId, 200)]
  );
  const results = [];
  for (const operation of claimed.rows) {
    const selected = await query(
      `SELECT operation.id AS operation_id, operation.operation_type, operation.attempts,
         operation.max_attempts, operation.payload AS operation_payload,
         provider_campaign.id AS provider_campaign_record_id,
         provider_campaign.provider_campaign_id, provider_campaign.provider_resource_name,
         provider_campaign.provider_budget_id, provider_campaign.status,
         provider_campaign.receipt, provider_campaign.provider,
         account.provider_account_id, account.metadata AS account_metadata,
         connection.*,
         campaign.name AS campaign_name, campaign.data AS campaign_data
       FROM goodads_ad_operations operation
       JOIN goodads_provider_campaigns provider_campaign ON provider_campaign.id = operation.provider_campaign_id
       JOIN goodads_ad_accounts account ON account.id = provider_campaign.ad_account_id
       JOIN goodads_social_connections connection ON connection.id = account.connection_id
       JOIN goodads_resources campaign ON campaign.id = provider_campaign.campaign_id
       WHERE operation.id = $1::uuid`,
      [operation.id]
    );
    if (selected.rows[0]) results.push(await processOperation(selected.rows[0]));
  }
  return { claimed: claimed.rows.length, results };
}

async function retryOperation({ id, context }) {
  requireManagement(context);
  const result = await query(
    `UPDATE goodads_ad_operations operation
     SET status = 'queued', attempts = 0, available_at = NOW(),
         locked_by = NULL, locked_until = NULL, last_error = NULL,
         completed_at = NULL, updated_at = NOW()
     FROM goodads_provider_campaigns provider_campaign
     WHERE operation.id = $1::uuid
       AND operation.provider_campaign_id = provider_campaign.id
       AND operation.organization_id = $2
       AND provider_campaign.organization_id = $2
       AND operation.status IN ('failed','dead_letter')
     RETURNING operation.*`,
    [requireUuid(id, "operation ID"), context.organizationId]
  );
  if (!result.rows[0]) {
    throw adsError("This provider operation is not eligible for retry.", 409, "GOODADS_AD_OPERATION_RETRY_DENIED");
  }
  await query(
    `UPDATE goodads_provider_campaigns
     SET status = CASE
       WHEN $2 = 'create' THEN 'queued'
       WHEN $2 = 'activate' THEN 'paused'
       ELSE status
     END,
     last_error = NULL, updated_at = NOW()
     WHERE id = $1::uuid`,
    [result.rows[0].provider_campaign_id, result.rows[0].operation_type]
  );
  return rowToOperation(result.rows[0]);
}

function capabilities() {
  const providers = publicProviders();
  const supportedProviders = providers.filter((provider) => provider.available).map((provider) => provider.id);
  return {
    paidAdvertising: {
      available: supportedProviders.length > 0,
      reason: supportedProviders.length
        ? null
        : "Configure a supported provider OAuth app and its required server credentials in GoodBase.",
      supportedProviders,
      providers,
      verifiedAccountsRequired: true,
      safePausedCreation: true,
      activationApprovalRequired: true,
      durableOperations: true,
      boundedRetries: true,
      maximumAccountsPerLaunch: 10,
    },
  };
}

module.exports = {
  publicProviders,
  capabilities,
  discoverAccounts,
  listAdAccounts,
  saveAdAccount,
  disableAdAccount,
  getCampaignState,
  launchCampaign,
  queueLifecycleOperation,
  requestActivationApproval,
  processDueOperations,
  retryOperation,
  _test: {
    providerAvailability,
    normalizeMetaAccount,
    metaObjective,
    snapshotHash,
    validateCampaignForAccount,
  },
};
