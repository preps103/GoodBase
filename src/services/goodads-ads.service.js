"use strict";

const crypto = require("node:crypto");
const { pool, query } = require("../config/database");
const social = require("./goodads-social.service");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._:-]{2,120}$/;
const MANAGEMENT_ROLES = new Set(["owner", "admin", "manager"]);
const LINKEDIN_CAMPAIGN_ROLES = new Set([
  "ACCOUNT_BILLING_ADMIN",
  "ACCOUNT_MANAGER",
  "CAMPAIGN_MANAGER",
]);
const LINKEDIN_IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png"]);
const MAX_LINKEDIN_IMAGE_BYTES = 10 * 1024 * 1024;
const GOOGLE_LOGO_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const MAX_GOOGLE_LOGO_BYTES = 5 * 1024 * 1024;
const OAUTH_ENCRYPTION_ENVIRONMENT = "GOODADS_OAUTH_ENCRYPTION_KEY";
const EMERGENCY_PAUSE_CONFIRMATION = "PAUSE ALL CAMPAIGNS";
const MAX_ACCOUNTS_PER_LAUNCH = 10;
const DEFAULT_MAX_CAMPAIGN_ACCOUNTS = 10;
const DEFAULT_MAX_COMBINED_DAILY_BUDGET = 1000;
const DEFAULT_MAX_PLANNING_BUDGET = 30000;
const DEFAULT_PROVIDER_RECONCILIATION_MINUTES = 5;
const PINTEREST_CAMPAIGN_ROLES = new Set(["OWNER", "ADMIN", "CAMPAIGN_MANAGER"]);
const SNAPCHAT_WRITE_ROLES = new Set(["admin", "general"]);
const SNAPCHAT_MEDIA_TYPES = Object.freeze({
  "image/jpeg": { type: "IMAGE", extension: "jpg", maximumBytes: 5 * 1024 * 1024 },
  "image/png": { type: "IMAGE", extension: "png", maximumBytes: 5 * 1024 * 1024 },
  "video/mp4": { type: "VIDEO", extension: "mp4", maximumBytes: 32 * 1024 * 1024 },
  "video/quicktime": { type: "VIDEO", extension: "mov", maximumBytes: 32 * 1024 * 1024 },
});
const PROVIDERS = Object.freeze({
  google: {
    name: "Google Ads",
    connectionProviders: ["google"],
    requiredEnvironment: ["GOODADS_GOOGLE_ADS_DEVELOPER_TOKEN"],
    platforms: ["google"],
    safePausedCreation: true,
    deliveryAdapter: "search",
    adapterType: "native",
    supportedObjectives: ["traffic"],
  },
  meta: {
    name: "Meta Ads",
    connectionProviders: ["facebook", "instagram"],
    requiredEnvironment: [],
    platforms: ["facebook", "instagram", "meta"],
    safePausedCreation: true,
    deliveryAdapter: "link_ad",
    adapterType: "native",
    supportedObjectives: ["traffic"],
  },
  youtube: {
    name: "YouTube Ads",
    connectionProviders: ["google"],
    requiredEnvironment: ["GOODADS_GOOGLE_ADS_DEVELOPER_TOKEN"],
    platforms: ["youtube"],
    safePausedCreation: true,
    deliveryAdapter: "demand_gen_video",
    adapterType: "native",
    supportedObjectives: ["traffic"],
  },
  tiktok: {
    name: "TikTok Ads",
    connectionProviders: ["tiktok_ads"],
    requiredEnvironment: [],
    platforms: ["tiktok"],
    safePausedCreation: true,
    deliveryAdapter: "video",
    adapterType: "native",
    supportedObjectives: ["traffic"],
  },
  linkedin: {
    name: "LinkedIn Ads",
    connectionProviders: ["linkedin"],
    requiredEnvironment: [],
    requiredOAuthScopes: ["r_ads", "r_ads_reporting", "rw_ads"],
    platforms: ["linkedin"],
    safePausedCreation: true,
    deliveryAdapter: "sponsored_content",
    adapterType: "native",
    supportedObjectives: ["traffic"],
  },
  x: {
    name: "X Ads",
    connectionProviders: ["x_ads"],
    requiredEnvironment: [],
    platforms: ["x", "twitter"],
    safePausedCreation: true,
    deliveryAdapter: "promoted_post",
    adapterType: "native",
    supportedObjectives: ["traffic"],
  },
  pinterest: {
    name: "Pinterest Ads",
    connectionProviders: ["pinterest"],
    requiredEnvironment: [],
    requiredOAuthScopes: ["ads:read", "ads:write", "pins:write"],
    platforms: ["pinterest"],
    safePausedCreation: true,
    deliveryAdapter: "promoted_pin",
    adapterType: "native",
    supportedObjectives: ["traffic", "awareness"],
  },
  snapchat: {
    name: "Snapchat Ads",
    connectionProviders: ["snapchat"],
    requiredEnvironment: [],
    platforms: ["snapchat"],
    safePausedCreation: true,
    deliveryAdapter: "snap_ad",
    adapterType: "native",
    supportedObjectives: ["traffic", "awareness"],
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

function emergencyPauseMarker(receipt) {
  const marker = receipt && typeof receipt === "object" && !Array.isArray(receipt)
    ? receipt.emergencyPause
    : null;
  if (!marker || typeof marker !== "object" || marker.active !== true) return null;
  return marker;
}

async function emergencyPauseMarkerForProviderCampaign(providerCampaignId) {
  const result = await query(
    `SELECT receipt->'emergencyPause' AS marker
     FROM goodads_provider_campaigns
     WHERE id = $1::uuid`,
    [providerCampaignId]
  );
  return emergencyPauseMarker({ emergencyPause: result.rows[0]?.marker });
}

function canonicalProvider(value) {
  const provider = boundedText(value, 20).toLowerCase();
  if (!PROVIDERS[provider]) throw adsError("Unsupported paid-ad provider.", 404, "GOODADS_AD_PROVIDER_NOT_FOUND");
  return provider;
}

function providerAvailability(provider) {
  const id = canonicalProvider(provider);
  const definition = PROVIDERS[id];
  const oauthSetup = definition.connectionProviders.map((connectionProvider) => {
    try {
      const config = social.providerConfig(connectionProvider);
      return {
        provider: config.id,
        name: config.label,
        configured: config.configured,
        credentialEnvironment: config.credentialEnvironment,
      };
    } catch {
      return {
        provider: connectionProvider,
        name: connectionProvider,
        configured: false,
        credentialEnvironment: null,
      };
    }
  });
  const oauthConfigured = oauthSetup.some((setup) => setup.configured);
  const requiredEnvironment = [...new Set([
    ...definition.requiredEnvironment,
    OAUTH_ENCRYPTION_ENVIRONMENT,
  ])];
  const missingEnvironment = requiredEnvironment.filter((name) => !boundedText(process.env[name], 10000));
  let configuredOAuthScopes = [];
  for (const connectionProvider of definition.connectionProviders) {
    try {
      configuredOAuthScopes.push(...social.providerConfig(connectionProvider).scopes);
    } catch {}
  }
  configuredOAuthScopes = [...new Set(configuredOAuthScopes)];
  const missingOAuthScopes = (definition.requiredOAuthScopes || [])
    .filter((scope) => !configuredOAuthScopes.includes(scope));
  const adapterConfigured = definition.adapterType === "native";
  const configurationErrors = [];
  if (!adapterConfigured) configurationErrors.push("A native production delivery adapter is not installed for this provider.");
  if (missingEnvironment.includes(OAUTH_ENCRYPTION_ENVIRONMENT)) {
    configurationErrors.push("Secure OAuth token storage is not configured.");
  }
  if (missingOAuthScopes.length) configurationErrors.push("Advertising OAuth scopes are not enabled for this provider.");
  return {
    id,
    name: definition.name,
    available: oauthConfigured
      && missingEnvironment.length === 0
      && missingOAuthScopes.length === 0
      && adapterConfigured,
    oauthConfigured,
    adapterConfigured,
    adapterType: definition.adapterType,
    missingEnvironment,
    missingOAuthScopes,
    configurationErrors,
    connectionProviders: [...definition.connectionProviders],
    oauthSetup,
    callbackUrls: definition.connectionProviders.map((connectionProvider) => ({
      provider: connectionProvider,
      url: social.callbackUrl(connectionProvider),
    })),
    platforms: [...definition.platforms],
    safePausedCreation: definition.safePausedCreation && adapterConfigured,
    activationSupported: definition.activationSupported !== false && adapterConfigured,
    deliveryAdapter: definition.deliveryAdapter,
    supportedObjectives: [...definition.supportedObjectives],
  };
}

function publicProviders() {
  return Object.keys(PROVIDERS).map(providerAvailability);
}

function providerRequestError(response, payload, fallback) {
  const providerMessage = boundedText(
    payload?.error?.message
      || payload?.error?.details?.[0]?.errors?.[0]?.message
      || payload?.display_message
      || payload?.debug_message
      || payload?.errors?.[0]?.message
      || payload?.errors?.[0]?.error_message
      || payload?.code
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

function normalizeGoogleCustomer(providerAccountId, customer = {}) {
  const status = boundedText(customer.status || "UNKNOWN", 40).toUpperCase();
  const manager = customer.manager === true;
  return {
    providerAccountId,
    name: boundedText(customer.descriptiveName || `Google Ads ${providerAccountId}`, 240),
    currency: boundedText(customer.currencyCode, 12).toUpperCase(),
    timezone: boundedText(customer.timeZone, 120),
    eligible: status === "ENABLED" && !manager,
    status: manager ? "manager_account" : status.toLowerCase(),
  };
}

async function discoverGoogleAccounts(accessToken) {
  const { payload } = await requestJson(
    "https://googleads.googleapis.com/v24/customers:listAccessibleCustomers",
    { headers: googleHeaders(accessToken) },
    "Google Ads account discovery"
  );
  const resourceNames = (Array.isArray(payload.resourceNames) ? payload.resourceNames : []).slice(0, 100);
  const accounts = [];
  for (let index = 0; index < resourceNames.length; index += 10) {
    const batch = resourceNames.slice(index, index + 10);
    const details = await Promise.all(batch.map(async (resourceName) => {
      const providerAccountId = boundedText(resourceName, 160).replace(/^customers\//, "");
      try {
        const { payload: detailPayload } = await requestJson(
          `https://googleads.googleapis.com/v24/customers/${providerAccountId}/googleAds:searchStream`,
          {
            method: "POST",
            headers: googleHeaders(accessToken),
            body: JSON.stringify({
              query: "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status, customer.manager, customer.test_account FROM customer LIMIT 1",
            }),
          },
          "Google Ads account details"
        );
        const record = Array.isArray(detailPayload)
          ? detailPayload.flatMap((item) => item.results || [])[0]
          : detailPayload.results?.[0];
        return normalizeGoogleCustomer(providerAccountId, record?.customer);
      } catch {
        return {
          providerAccountId,
          name: `Google Ads ${providerAccountId}`,
          currency: "",
          timezone: "",
          eligible: false,
          status: "details_unavailable",
        };
      }
    }));
    accounts.push(...details);
  }
  return { accounts, pages: [] };
}

function pinterestHeaders(accessToken, extra = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "GoodAds/1.0",
    ...extra,
  };
}

async function pinterestRequest(path, accessToken, options = {}, fallback = "Pinterest Ads operation") {
  return requestJson(
    `https://api.pinterest.com/v5${path}`,
    {
      ...options,
      headers: pinterestHeaders(accessToken, options.headers || {}),
    },
    fallback
  );
}

function normalizePinterestAccount(account = {}) {
  const providerAccountId = boundedText(account.id, 120);
  const permissions = [...new Set((Array.isArray(account.permissions) ? account.permissions : [])
    .map((permission) => boundedText(permission, 80).toUpperCase())
    .filter(Boolean))];
  const canManageCampaigns = permissions.some((permission) => PINTEREST_CAMPAIGN_ROLES.has(permission));
  const currency = boundedText(account.currency, 12).toUpperCase();
  const timezone = boundedText(account.time_zone, 120);
  const eligible = /^\d{2,18}$/.test(providerAccountId)
    && canManageCampaigns
    && Boolean(currency)
    && Boolean(timezone);
  let status = "active";
  if (!canManageCampaigns) status = "campaign_manager_role_required";
  else if (!currency || !timezone) status = "account_locale_required";
  else if (!/^\d{2,18}$/.test(providerAccountId)) status = "invalid_account_id";
  return {
    providerAccountId,
    name: boundedText(account.name || `Pinterest Ads ${providerAccountId}`, 240),
    currency,
    timezone,
    eligible,
    status,
    metadata: {
      permissions,
      country: boundedText(account.country, 2).toUpperCase() || null,
      ownerUsername: boundedText(account.owner?.username, 240) || null,
      deliveryReady: eligible,
      channelType: "PROMOTED_PIN",
    },
  };
}

async function discoverPinterestAccounts(accessToken) {
  const accounts = [];
  let bookmark = "";
  for (let page = 0; page < 5; page += 1) {
    const parameters = new URLSearchParams({ page_size: "100" });
    if (bookmark) parameters.set("bookmark", bookmark);
    const { payload } = await pinterestRequest(
      `/ad_accounts?${parameters}`,
      accessToken,
      {},
      "Pinterest ad-account discovery"
    );
    accounts.push(...(Array.isArray(payload.items) ? payload.items.map(normalizePinterestAccount) : []));
    bookmark = boundedText(payload.bookmark, 1000);
    if (!bookmark) break;
  }
  return { accounts, pages: [] };
}

function linkedInVersion() {
  const value = boundedText(process.env.GOODADS_LINKEDIN_API_VERSION || "202608", 6);
  if (!/^20\d{4}$/.test(value)) {
    throw adsError(
      "LinkedIn Marketing API version must use YYYYMM format.",
      503,
      "GOODADS_LINKEDIN_VERSION_INVALID"
    );
  }
  return value;
}

function linkedInHeaders(accessToken, extra = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Linkedin-Version": linkedInVersion(),
    "X-Restli-Protocol-Version": "2.0.0",
    Accept: "application/json",
    "User-Agent": "GoodAds/1.0",
    ...extra,
  };
}

function linkedInAccountId(value) {
  return boundedText(value, 200).replace(/^urn:li:sponsoredAccount:/, "");
}

function linkedInNumericId(value) {
  return boundedText(value, 300).match(/(\d+)$/)?.[1] || "";
}

function normalizeLinkedInAccount(account = {}, membership = {}) {
  const providerAccountId = linkedInAccountId(account.id || membership.account);
  const providerStatus = boundedText(account.status || "UNKNOWN", 40).toUpperCase();
  const role = boundedText(membership.role, 80).toUpperCase();
  const organizationUrn = /^urn:li:organization:\d+$/.test(String(account.reference || ""))
    ? String(account.reference)
    : null;
  const roleEligible = LINKEDIN_CAMPAIGN_ROLES.has(role);
  const eligible = providerStatus === "ACTIVE" && roleEligible && Boolean(organizationUrn);
  let status = providerStatus.toLowerCase();
  if (providerStatus === "ACTIVE" && !roleEligible) status = "insufficient_campaign_role";
  if (providerStatus === "ACTIVE" && roleEligible && !organizationUrn) status = "organization_required";
  return {
    providerAccountId,
    name: boundedText(account.name || `LinkedIn Ads ${providerAccountId}`, 240),
    currency: boundedText(account.currency, 12).toUpperCase(),
    timezone: "UTC",
    eligible,
    status,
    metadata: {
      organizationUrn,
      role,
      test: account.test === true,
      deliveryReady: eligible,
      channelType: "SPONSORED_UPDATES",
    },
  };
}

async function discoverLinkedInAccounts(accessToken) {
  const headers = linkedInHeaders(accessToken);
  const { payload: membershipPayload } = await requestJson(
    "https://api.linkedin.com/rest/adAccountUsers?q=authenticatedUser",
    { headers },
    "LinkedIn Ads account discovery"
  );
  const memberships = (Array.isArray(membershipPayload.elements) ? membershipPayload.elements : [])
    .slice(0, 100);
  const accounts = await Promise.all(memberships.map(async (membership) => {
    const providerAccountId = linkedInAccountId(membership.account);
    if (!ACCOUNT_ID_PATTERN.test(providerAccountId)) {
      return normalizeLinkedInAccount({}, membership);
    }
    try {
      const { payload } = await requestJson(
        `https://api.linkedin.com/rest/adAccounts/${encodeURIComponent(providerAccountId)}`,
        { headers },
        "LinkedIn Ads account details"
      );
      return normalizeLinkedInAccount({ ...payload, id: payload.id || providerAccountId }, membership);
    } catch {
      return {
        ...normalizeLinkedInAccount({ id: providerAccountId }, membership),
        eligible: false,
        status: "details_unavailable",
      };
    }
  }));
  return { accounts, pages: [] };
}

function snapchatHeaders(accessToken, extra = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "GoodAds/1.0",
    ...extra,
  };
}

async function snapchatRequest(path, accessToken, options = {}, fallback = "Snapchat Ads operation", business = false) {
  const baseUrl = business ? "https://businessapi.snapchat.com" : "https://adsapi.snapchat.com";
  return requestJson(
    `${baseUrl}${path}`,
    {
      ...options,
      headers: snapchatHeaders(accessToken, options.headers || {}),
    },
    fallback
  );
}

function snapchatEntity(payload, collection, key) {
  const requestStatus = boundedText(payload?.request_status, 40).toUpperCase();
  const wrapper = Array.isArray(payload?.[collection]) ? payload[collection][0] : null;
  const subRequestStatus = boundedText(wrapper?.sub_request_status || requestStatus, 40).toUpperCase();
  if (!wrapper || (requestStatus && requestStatus !== "SUCCESS") || subRequestStatus !== "SUCCESS") {
    const message = boundedText(
      wrapper?.errors?.[0]?.message
        || wrapper?.errors?.[0]?.display_message
        || payload?.display_message
        || payload?.debug_message
        || `Snapchat did not return a ${key}.`,
      2000
    );
    throw adsError(message, 502, "GOODADS_SNAPCHAT_SUBREQUEST_FAILED", true);
  }
  const entity = wrapper[key];
  if (!entity || !UUID_PATTERN.test(String(entity.id || ""))) {
    throw adsError(`Snapchat did not return a valid ${key} ID.`, 502, "GOODADS_SNAPCHAT_RESPONSE_INVALID");
  }
  return entity;
}

function normalizeSnapchatAccount(account = {}, organization = {}) {
  const providerAccountId = boundedText(account.id, 120);
  const providerStatus = boundedText(account.status || "UNKNOWN", 40).toUpperCase();
  const roles = [...new Set((Array.isArray(account.roles) ? account.roles : [])
    .map((role) => boundedText(role, 40).toLowerCase())
    .filter(Boolean))];
  const fundingSourceIds = (Array.isArray(account.funding_source_ids) ? account.funding_source_ids : [])
    .map((id) => boundedText(id, 120))
    .filter((id) => UUID_PATTERN.test(id));
  const canWrite = roles.some((role) => SNAPCHAT_WRITE_ROLES.has(role));
  const hasFunding = fundingSourceIds.length > 0 || account.test === true;
  const eligible = providerStatus === "ACTIVE" && canWrite && hasFunding;
  let status = providerStatus.toLowerCase();
  if (providerStatus === "ACTIVE" && !canWrite) status = "campaign_write_role_required";
  if (providerStatus === "ACTIVE" && canWrite && !hasFunding) status = "funding_source_required";
  return {
    providerAccountId,
    name: boundedText(account.name || `Snapchat Ads ${providerAccountId}`, 240),
    currency: boundedText(account.currency, 12).toUpperCase(),
    timezone: boundedText(account.timezone, 120),
    eligible,
    status,
    metadata: {
      organizationId: boundedText(account.organization_id || organization.id, 120) || null,
      organizationName: boundedText(organization.name, 240) || null,
      roles,
      fundingSourceIds,
      test: account.test === true,
      deliveryReady: false,
    },
  };
}

async function discoverSnapchatProfiles(accessToken, providerAccountId) {
  const { payload } = await snapchatRequest(
    `/v1/adaccounts/${encodeURIComponent(providerAccountId)}/sharing_policies?shared_resource_types=public_profiles`,
    accessToken,
    {},
    "Snapchat Public Profile discovery",
    true
  );
  const profileIds = [...new Set((Array.isArray(payload.sharing_policies) ? payload.sharing_policies : [])
    .map((wrapper) => wrapper?.sharing_policy?.source)
    .filter((source) => source?.resource_type === "public_profiles")
    .map((source) => boundedText(source.resource_id, 120))
    .filter((id) => UUID_PATTERN.test(id)))].slice(0, 20);
  const profiles = [];
  for (const profileId of profileIds) {
    let name = `Snapchat Public Profile ${profileId.slice(0, 8)}`;
    try {
      const { payload: profilePayload } = await snapchatRequest(
        `/v1/public_profiles/${encodeURIComponent(profileId)}`,
        accessToken,
        {},
        "Snapchat Public Profile details",
        true
      );
      const profile = profilePayload?.public_profiles?.[0]?.public_profile
        || profilePayload?.public_profile
        || profilePayload?.profile
        || {};
      name = boundedText(profile.display_name || profile.title || profile.name || name, 240);
    } catch {}
    profiles.push({ id: profileId, name, providerAccountId });
  }
  return profiles;
}

async function discoverSnapchatAccounts(accessToken) {
  const { payload } = await snapchatRequest(
    "/v1/me/organizations?with_ad_accounts=true",
    accessToken,
    {},
    "Snapchat Ads account discovery"
  );
  const organizations = (Array.isArray(payload.organizations) ? payload.organizations : [])
    .map((wrapper) => wrapper?.organization)
    .filter(Boolean);
  const summaries = organizations.flatMap((organization) => (
    (Array.isArray(organization.ad_accounts) ? organization.ad_accounts : [])
      .map((account) => ({ account, organization }))
  )).slice(0, 100);
  const accounts = [];
  const pages = [];
  for (let index = 0; index < summaries.length; index += 10) {
    const batch = await Promise.all(summaries.slice(index, index + 10).map(async ({ account, organization }) => {
      const providerAccountId = boundedText(account.id, 120);
      if (!UUID_PATTERN.test(providerAccountId)) return null;
      let normalized;
      try {
        const { payload: accountPayload } = await snapchatRequest(
          `/v1/adaccounts/${encodeURIComponent(providerAccountId)}`,
          accessToken,
          {},
          "Snapchat Ads account details"
        );
        const detail = snapchatEntity(accountPayload, "adaccounts", "adaccount");
        normalized = normalizeSnapchatAccount({ ...account, ...detail, roles: account.roles }, organization);
      } catch {
        normalized = {
          ...normalizeSnapchatAccount(account, organization),
          eligible: false,
          status: "details_unavailable",
        };
      }
      let profiles = [];
      if (normalized.eligible) {
        try {
          profiles = await discoverSnapchatProfiles(accessToken, providerAccountId);
        } catch {
          normalized.eligible = false;
          normalized.status = "public_profile_unavailable";
        }
        if (!profiles.length && normalized.eligible) {
          normalized.eligible = false;
          normalized.status = "public_profile_required";
        }
      }
      normalized.metadata.profileCount = profiles.length;
      return { account: normalized, profiles };
    }));
    for (const item of batch.filter(Boolean)) {
      accounts.push(item.account);
      pages.push(...item.profiles);
    }
  }
  return { accounts, pages };
}

function tiktokHeaders(accessToken, extra = {}) {
  return {
    "Access-Token": accessToken,
    Accept: "application/json",
    "User-Agent": "GoodAds/1.0",
    ...extra,
  };
}

async function tiktokRequest(path, accessToken, options = {}, fallback = "TikTok Ads operation") {
  const result = await requestJson(
    `https://business-api.tiktok.com/open_api/v1.3${path}`,
    {
      ...options,
      headers: tiktokHeaders(accessToken, options.headers || {}),
    },
    fallback
  );
  if (Number(result.payload?.code) !== 0) {
    throw adsError(
      boundedText(result.payload?.message || fallback, 2000),
      502,
      "GOODADS_TIKTOK_REQUEST_FAILED",
      false
    );
  }
  return result;
}

function normalizeTikTokAccount(account = {}) {
  const providerAccountId = boundedText(account.advertiser_id || account.id, 120);
  const providerStatus = boundedText(account.status || "UNKNOWN", 60).toUpperCase();
  const currency = boundedText(account.currency, 12).toUpperCase();
  const timezone = boundedText(account.timezone || account.display_timezone, 120);
  const enabled = ["STATUS_ENABLE", "ENABLE", "ACTIVE"].includes(providerStatus);
  const eligible = /^\d{2,30}$/.test(providerAccountId) && enabled && Boolean(currency) && Boolean(timezone);
  let status = providerStatus.toLowerCase();
  if (!/^\d{2,30}$/.test(providerAccountId)) status = "invalid_account_id";
  else if (!enabled) status = providerStatus === "UNKNOWN" ? "provider_status_unknown" : status;
  else if (!currency || !timezone) status = "account_locale_required";
  return {
    providerAccountId,
    name: boundedText(account.advertiser_name || account.name || `TikTok Ads ${providerAccountId}`, 240),
    currency,
    timezone,
    eligible,
    status,
    metadata: {
      role: boundedText(account.role, 80).toUpperCase() || null,
      country: boundedText(account.country, 2).toUpperCase() || null,
      providerStatus,
      deliveryReady: false,
      channelType: "TIKTOK_VIDEO",
    },
  };
}

function normalizeTikTokIdentity(identity = {}, providerAccountId = "") {
  const id = boundedText(identity.identity_id || identity.id, 120);
  const identityType = boundedText(identity.identity_type || identity.type, 40).toUpperCase();
  const availableStatus = boundedText(identity.available_status || "AVAILABLE", 60).toUpperCase();
  if (
    !ACCOUNT_ID_PATTERN.test(id)
    || !["CUSTOMIZED_USER", "AUTH_CODE", "TT_USER", "BC_AUTH_TT"].includes(identityType)
    || availableStatus !== "AVAILABLE"
  ) return null;
  const username = boundedText(identity.username, 240);
  const displayName = boundedText(identity.display_name || identity.name || username, 240);
  return {
    id,
    name: displayName ? `${displayName}${username && username !== displayName ? ` · @${username}` : ""}` : `TikTok identity ${id}`,
    providerAccountId,
    identityType,
    identityAuthorizedBcId: boundedText(identity.identity_authorized_bc_id, 120) || null,
  };
}

async function discoverTikTokIdentities(accessToken, providerAccountId) {
  const parameters = new URLSearchParams({
    advertiser_id: providerAccountId,
    page: "1",
    page_size: "100",
  });
  const { payload } = await tiktokRequest(
    `/identity/get/?${parameters}`,
    accessToken,
    {},
    "TikTok identity discovery"
  );
  const items = Array.isArray(payload.data?.identity_list)
    ? payload.data.identity_list
    : Array.isArray(payload.data?.list)
      ? payload.data.list
      : [];
  return items.map((identity) => normalizeTikTokIdentity(identity, providerAccountId)).filter(Boolean);
}

async function discoverTikTokAccounts(accessToken) {
  const config = social.providerConfig("tiktok_ads");
  const authorizedParameters = new URLSearchParams({ app_id: config.clientId, secret: config.clientSecret });
  const { payload: authorizedPayload } = await tiktokRequest(
    `/oauth2/advertiser/get/?${authorizedParameters}`,
    accessToken,
    {},
    "TikTok authorized-advertiser discovery"
  );
  const authorized = Array.isArray(authorizedPayload.data?.list)
    ? authorizedPayload.data.list
    : Array.isArray(authorizedPayload.data?.advertisers)
      ? authorizedPayload.data.advertisers
      : [];
  const advertiserIds = [...new Set(authorized
    .map((item) => boundedText(item.advertiser_id || item.id, 120))
    .filter((id) => /^\d{2,30}$/.test(id)))].slice(0, 100);
  if (!advertiserIds.length) return { accounts: [], pages: [] };

  const accounts = [];
  const pages = [];
  for (let index = 0; index < advertiserIds.length; index += 50) {
    const batch = advertiserIds.slice(index, index + 50);
    const parameters = new URLSearchParams({ advertiser_ids: JSON.stringify(batch) });
    const { payload } = await tiktokRequest(
      `/advertiser/info/?${parameters}`,
      accessToken,
      {},
      "TikTok ad-account details"
    );
    const details = Array.isArray(payload.data?.list) ? payload.data.list : [];
    const detailsById = new Map(details.map((item) => [String(item.advertiser_id || item.id), item]));
    for (const providerAccountId of batch) {
      const authorizedSummary = authorized.find((item) => String(item.advertiser_id || item.id) === providerAccountId) || {};
      const account = normalizeTikTokAccount({ ...authorizedSummary, ...detailsById.get(providerAccountId), advertiser_id: providerAccountId });
      let identities = [];
      if (account.eligible) {
        try {
          identities = await discoverTikTokIdentities(accessToken, providerAccountId);
        } catch {
          account.eligible = false;
          account.status = "identity_discovery_unavailable";
        }
        if (!identities.length && account.eligible) {
          account.eligible = false;
          account.status = "advertising_identity_required";
        }
      }
      account.metadata.identityCount = identities.length;
      accounts.push(account);
      pages.push(...identities);
    }
  }
  return { accounts, pages };
}

async function xAdsRequest(path, credentials, { method = "GET", parameters = {}, fallback = "X Ads request", allowNotFound = false } = {}) {
  const url = new URL(`https://ads-api.x.com/12${path}`);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: social.oauth1AuthorizationHeader(
          social.providerConfig("x_ads"),
          url.toString(),
          method,
          credentials.accessToken,
          credentials.tokenSecret
        ),
        Accept: "application/json",
        "User-Agent": "GoodAds/1.0",
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch (error) {
    throw adsError(
      error.name === "TimeoutError" ? `${fallback} timed out.` : `${fallback} could not reach X Ads.`,
      502,
      "GOODADS_AD_PROVIDER_REQUEST_FAILED",
      true
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (allowNotFound && response.status === 404) return { payload: {}, response };
  if (!response.ok || payload.errors?.length) throw providerRequestError(response, payload, fallback);
  return { payload, response };
}

function normalizeXAccount(account = {}, fundingInstrument = {}, promotableUser = {}, authenticatedAccess = {}) {
  const providerAccountId = boundedText(account.id, 120);
  const approved = boundedText(account.approval_status, 40).toUpperCase() === "ACCEPTED";
  const funded = fundingInstrument.deleted !== true
    && boundedText(fundingInstrument.entity_status, 40).toUpperCase() === "ACTIVE"
    && fundingInstrument.able_to_fund === true;
  const promotable = promotableUser.deleted !== true
    && boundedText(promotableUser.promotable_user_type, 40).toUpperCase() === "FULL"
    && /^\d{2,30}$/.test(String(promotableUser.user_id || ""));
  const permissions = Array.isArray(authenticatedAccess.permissions)
    ? authenticatedAccess.permissions.map((permission) => boundedText(permission, 60).toUpperCase())
    : [];
  const campaignAccess = permissions.some((permission) => ["ACCOUNT_ADMIN", "AD_MANAGER"].includes(permission));
  const composerAccess = permissions.includes("TWEET_COMPOSER");
  const eligible = Boolean(
    providerAccountId
    && account.deleted !== true
    && approved
    && funded
    && promotable
    && campaignAccess
    && composerAccess
  );
  return {
    providerAccountId,
    name: boundedText(account.name || `X Ads ${providerAccountId}`, 240),
    currency: boundedText(fundingInstrument.currency || account.currency, 12).toUpperCase(),
    timezone: boundedText(account.timezone, 120),
    eligible,
    status: account.deleted === true
      ? "deleted"
      : !approved
        ? boundedText(account.approval_status, 40).toLowerCase() || "not_approved"
        : !funded
          ? "funding_unavailable"
          : !promotable
            ? "full_promotable_user_required"
            : !campaignAccess || !composerAccess
              ? "campaign_and_tweet_permissions_required"
            : "accepted",
    metadata: {
      fundingInstrumentId: funded ? boundedText(fundingInstrument.id, 120) : null,
      advertiserUserId: promotable ? String(promotableUser.user_id) : null,
      deliveryReady: eligible,
      approvalStatus: boundedText(account.approval_status, 40).toUpperCase(),
      authenticatedPermissions: permissions,
    },
  };
}

async function discoverXAccounts(credentials) {
  const { payload } = await xAdsRequest("/accounts", credentials, {
    parameters: { count: 1000 },
    fallback: "X Ads account discovery",
  });
  const accounts = [];
  for (const account of Array.isArray(payload.data) ? payload.data.slice(0, 100) : []) {
    const accountId = boundedText(account.id, 120);
    if (!ACCOUNT_ID_PATTERN.test(accountId)) continue;
    let fundingInstrument = {};
    let promotableUser = {};
    let authenticatedAccess = {};
    try {
      const [fundingResult, usersResult, accessResult] = await Promise.all([
        xAdsRequest(`/accounts/${encodeURIComponent(accountId)}/funding_instruments`, credentials, {
          parameters: { count: 1000 },
          fallback: "X Ads funding discovery",
        }),
        xAdsRequest(`/accounts/${encodeURIComponent(accountId)}/promotable_users`, credentials, {
          parameters: { count: 1000 },
          fallback: "X Ads promotable-user discovery",
        }),
        xAdsRequest(`/accounts/${encodeURIComponent(accountId)}/authenticated_user_access`, credentials, {
          fallback: "X Ads authenticated-user access discovery",
        }),
      ]);
      fundingInstrument = (Array.isArray(fundingResult.payload.data) ? fundingResult.payload.data : [])
        .find((item) => item.deleted !== true && item.able_to_fund === true && String(item.entity_status).toUpperCase() === "ACTIVE") || {};
      promotableUser = (Array.isArray(usersResult.payload.data) ? usersResult.payload.data : [])
        .find((item) => item.deleted !== true && String(item.promotable_user_type).toUpperCase() === "FULL") || {};
      authenticatedAccess = accessResult.payload.data || {};
    } catch {
      // Keep the account visible but ineligible when its delivery prerequisites cannot be verified.
    }
    accounts.push(normalizeXAccount(account, fundingInstrument, promotableUser, authenticatedAccess));
  }
  return { accounts, pages: [] };
}

function requireConnectionScopes(connection, requiredScopes = []) {
  const granted = new Set(Array.isArray(connection.scopes) ? connection.scopes : []);
  const missing = requiredScopes.filter((scope) => !granted.has(scope));
  if (missing.length) {
    throw adsError(
      `Reconnect this account and grant the required advertising permissions: ${missing.join(", ")}.`,
      409,
      "GOODADS_AD_CONNECTION_SCOPES_MISSING"
    );
  }
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
  requireConnectionScopes(connection, PROVIDERS[id].requiredOAuthScopes || []);
  const accessToken = id === "x"
    ? await social.oauth1CredentialsForConnection(connection)
    : await social.accessTokenForConnection(connection);
  const discovered = id === "meta"
    ? await discoverMetaAccounts(accessToken)
    : ["google", "youtube"].includes(id)
      ? await discoverGoogleAccounts(accessToken)
      : id === "linkedin"
        ? await discoverLinkedInAccounts(accessToken)
        : id === "pinterest"
          ? await discoverPinterestAccounts(accessToken)
          : id === "snapchat"
            ? await discoverSnapchatAccounts(accessToken)
            : id === "tiktok"
              ? await discoverTikTokAccounts(accessToken)
              : id === "x"
                ? await discoverXAccounts(accessToken)
            : (() => {
              throw adsError(
                `${PROVIDERS[id].name} account discovery is unavailable until its native adapter is installed.`,
                503,
                "GOODADS_ADAPTER_NOT_INSTALLED"
              );
            })();
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
      `The provider reports that this ad account is not eligible for campaign setup (${account.status || "unavailable"}).`,
      409,
      "GOODADS_AD_ACCOUNT_NOT_ELIGIBLE"
    );
  }
  const pageId = boundedText(payload?.pageId, 120);
  const selectedPage = ["meta", "snapchat", "tiktok"].includes(provider) && pageId
    ? discovered.pages.find((page) => (
        page.id === pageId
        && (!["snapchat", "tiktok"].includes(provider) || page.providerAccountId === providerAccountId)
      ))
    : null;
  if (provider === "meta" && pageId && !selectedPage) {
    throw adsError("The selected Meta Page is not accessible to this connection.", 409, "GOODADS_META_PAGE_NOT_ACCESSIBLE");
  }
  if (provider === "snapchat" && !selectedPage) {
    throw adsError(
      "Select a Snapchat Public Profile shared with this ad account.",
      409,
      "GOODADS_SNAPCHAT_PROFILE_REQUIRED"
    );
  }
  if (provider === "tiktok" && !selectedPage) {
    throw adsError(
      "Select an available TikTok advertising identity for this ad account.",
      409,
      "GOODADS_TIKTOK_IDENTITY_REQUIRED"
    );
  }
  const metadata = provider === "meta"
    ? {
        pageId: selectedPage?.id || null,
        pageName: selectedPage?.name || null,
        instagramActorId: selectedPage?.instagramActorId || null,
        instagramUsername: selectedPage?.instagramUsername || null,
        deliveryReady: Boolean(selectedPage?.id),
      }
    : provider === "linkedin"
      ? { ...(account.metadata || {}), deliveryReady: account.metadata?.deliveryReady === true }
      : ["pinterest", "x"].includes(provider)
        ? { ...(account.metadata || {}), deliveryReady: account.metadata?.deliveryReady === true }
        : provider === "snapchat"
          ? {
              ...(account.metadata || {}),
              profileId: selectedPage.id,
              profileName: selectedPage.name,
              deliveryReady: true,
              channelType: "SNAP_AD",
            }
          : provider === "tiktok"
            ? {
                ...(account.metadata || {}),
                identityId: selectedPage.id,
                identityName: selectedPage.name,
                identityType: selectedPage.identityType,
                identityAuthorizedBcId: selectedPage.identityAuthorizedBcId,
                deliveryReady: true,
                channelType: "TIKTOK_VIDEO",
              }
          : {
              deliveryReady: true,
              channelType: provider === "youtube" ? "DEMAND_GEN_YOUTUBE" : "SEARCH",
            };
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

function isPublicHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isManagedGoodOsHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (!url.port || url.port === "443")
      && (hostname === "goodos.app" || hostname.endsWith(".goodos.app"));
  } catch {
    return false;
  }
}

function youtubeVideoId(value) {
  try {
    const url = new URL(String(value || ""));
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    let id = "";
    if (hostname === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] || "";
    if (["youtube.com", "m.youtube.com", "music.youtube.com"].includes(hostname)) {
      if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
      else {
        const [kind, candidate] = url.pathname.split("/").filter(Boolean);
        if (["shorts", "embed", "live"].includes(kind)) id = candidate || "";
      }
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

function providerCreativeVideoUrl(data = {}, provider) {
  const creative = data.creative || {};
  if (provider === "youtube") return boundedText(creative.youtubeVideoUrl ?? creative.videoUrl, 4000);
  if (provider === "tiktok") return boundedText(creative.tiktokVideoUrl ?? creative.videoUrl, 4000);
  return boundedText(creative.videoUrl, 4000);
}

function googlePoliticalAdvertisingStatus(value) {
  if (value === true) return "CONTAINS_EU_POLITICAL_ADVERTISING";
  if (value === false) return "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING";
  throw adsError(
    "Declare whether this campaign contains EU political advertising before Google or YouTube setup.",
    409,
    "GOODADS_GOOGLE_POLITICAL_DECLARATION_REQUIRED"
  );
}

function linkedInPolicyCompliance(data = {}) {
  if (data.linkedinPoliticalIntent !== "NOT_POLITICAL") {
    throw adsError(
      "Confirm that the LinkedIn campaign is not political advertising before provider setup or activation.",
      409,
      "GOODADS_LINKEDIN_POLITICAL_CONFIRMATION_REQUIRED"
    );
  }
  if (data.linkedinTargetingNoticeAcknowledged !== true) {
    throw adsError(
      "Acknowledge LinkedIn's targeting-discrimination notice before provider setup or activation.",
      409,
      "GOODADS_LINKEDIN_TARGETING_NOTICE_REQUIRED"
    );
  }
  return "NOT_POLITICAL";
}

function metaPublisherPlatforms(data = {}) {
  const selected = new Set(
    (Array.isArray(data.platforms) ? data.platforms : [])
      .map((platform) => boundedText(platform, 40).toLowerCase())
  );
  const platforms = [];
  if (selected.has("facebook") || selected.has("meta")) platforms.push("facebook");
  if (selected.has("instagram") || selected.has("meta")) platforms.push("instagram");
  return platforms;
}

function campaignCalendarDate(value, label) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw adsError(`${label} must use YYYY-MM-DD.`, 409, "GOODADS_CAMPAIGN_DATES_INVALID");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])
  ) {
    throw adsError(`${label} is not a valid calendar date.`, 409, "GOODADS_CAMPAIGN_DATES_INVALID");
  }
  return date;
}

function zonedMidnightInstant(value, timezone, exclusiveEnd = false) {
  const calendarDate = campaignCalendarDate(value, exclusiveEnd ? "Campaign end date" : "Campaign start date");
  if (exclusiveEnd) calendarDate.setUTCDate(calendarDate.getUTCDate() + 1);
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: boundedText(timezone, 120),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw adsError(
      "Refresh the ad account to load a valid IANA time zone before provider creation.",
      409,
      "GOODADS_AD_ACCOUNT_TIMEZONE_INVALID"
    );
  }
  const target = {
    year: calendarDate.getUTCFullYear(),
    month: calendarDate.getUTCMonth() + 1,
    day: calendarDate.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
  const targetAsUtc = Date.UTC(target.year, target.month - 1, target.day);
  let instant = targetAsUtc;
  const partsAt = (time) => Object.fromEntries(
    formatter.formatToParts(new Date(time))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = partsAt(instant);
    const observedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const adjustment = targetAsUtc - observedAsUtc;
    if (adjustment === 0) break;
    instant += adjustment;
  }
  const resolved = partsAt(instant);
  if (Object.entries(target).some(([key, expected]) => resolved[key] !== expected)) {
    throw adsError(
      "The ad-account time zone cannot represent this campaign boundary safely.",
      409,
      "GOODADS_CAMPAIGN_TIMEZONE_BOUNDARY_INVALID"
    );
  }
  return new Date(instant).toISOString();
}

function campaignScheduleBounds(data = {}, timezone) {
  const start = campaignCalendarDate(data.startDate, "Campaign start date");
  const end = campaignCalendarDate(data.endDate, "Campaign end date");
  if (end < start) throw adsError("Campaign dates are invalid.", 409, "GOODADS_CAMPAIGN_DATES_INVALID");
  return {
    timezone: boundedText(timezone, 120),
    startDate: data.startDate,
    endDate: data.endDate,
    startAt: zonedMidnightInstant(data.startDate, timezone),
    endAt: zonedMidnightInstant(data.endDate, timezone, true),
    endExclusive: true,
    deliveryDays: Math.floor((end.getTime() - start.getTime()) / 86400000) + 1,
  };
}

function positiveEnvironmentNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function campaignExposurePolicy() {
  return {
    maximumAccountsPerCampaign: Math.min(
      Math.max(1, Math.floor(positiveEnvironmentNumber("GOODADS_MAX_ACCOUNTS_PER_CAMPAIGN", DEFAULT_MAX_CAMPAIGN_ACCOUNTS))),
      50
    ),
    maximumCombinedDailyBudget: positiveEnvironmentNumber(
      "GOODADS_MAX_COMBINED_DAILY_BUDGET",
      DEFAULT_MAX_COMBINED_DAILY_BUDGET
    ),
    maximumPlanningBudget: positiveEnvironmentNumber(
      "GOODADS_MAX_PLANNING_BUDGET",
      DEFAULT_MAX_PLANNING_BUDGET
    ),
    unit: "account_currency",
  };
}

function campaignExposure(data, accountCount, timezone) {
  const schedule = campaignScheduleBounds(data, timezone);
  const dailyBudgetPerAccount = Math.max(Number(data?.dailyBudget) || 0, 0);
  const safeAccountCount = Math.max(Math.floor(Number(accountCount) || 0), 0);
  const combinedDailyBudget = dailyBudgetPerAccount * safeAccountCount;
  return {
    accountCount: safeAccountCount,
    deliveryDays: schedule.deliveryDays,
    dailyBudgetPerAccount,
    combinedDailyBudget,
    planningMaximum: combinedDailyBudget * schedule.deliveryDays,
    schedule,
  };
}

function campaignExposureIssues(exposure, policy = campaignExposurePolicy()) {
  const issues = [];
  if (exposure.accountCount > policy.maximumAccountsPerCampaign) {
    issues.push({
      code: "GOODADS_CAMPAIGN_ACCOUNT_LIMIT_EXCEEDED",
      detail: `This campaign would span ${exposure.accountCount} accounts; the campaign-wide limit is ${policy.maximumAccountsPerCampaign}.`,
    });
  }
  if (exposure.combinedDailyBudget > policy.maximumCombinedDailyBudget) {
    issues.push({
      code: "GOODADS_COMBINED_DAILY_BUDGET_EXCEEDED",
      detail: `Combined daily exposure is ${exposure.combinedDailyBudget}; the campaign-wide limit is ${policy.maximumCombinedDailyBudget} account-currency units.`,
    });
  }
  if (exposure.planningMaximum > policy.maximumPlanningBudget) {
    issues.push({
      code: "GOODADS_PLANNING_BUDGET_EXCEEDED",
      detail: `Planned campaign exposure is ${exposure.planningMaximum}; the campaign-wide limit is ${policy.maximumPlanningBudget} account-currency units.`,
    });
  }
  return issues;
}

function validateCampaignExposure(data, accountCount, timezone) {
  const exposure = campaignExposure(data, accountCount, timezone);
  const issue = campaignExposureIssues(exposure)[0];
  if (issue) throw adsError(issue.detail, 409, issue.code);
  return exposure;
}

async function validateStoredCampaignExposure({ organizationId, campaignId, campaignData }) {
  const result = await query(
    `SELECT account.currency, account.timezone
     FROM goodads_provider_campaigns provider_campaign
     JOIN goodads_ad_accounts account ON account.id = provider_campaign.ad_account_id
     WHERE provider_campaign.organization_id = $1
       AND provider_campaign.campaign_id = $2::uuid
       AND provider_campaign.status <> 'archived'`,
    [organizationId, campaignId]
  );
  const locales = new Set(result.rows.map((account) => (
    `${boundedText(account.currency, 12).toUpperCase()}|${boundedText(account.timezone, 120)}`
  )));
  if (!result.rows.length || locales.size !== 1) {
    throw adsError(
      "Campaign-wide activation requires one verified currency and time zone across every provider account.",
      409,
      "GOODADS_AD_ACCOUNT_LOCALE_MISMATCH"
    );
  }
  return validateCampaignExposure(campaignData, result.rows.length, result.rows[0].timezone);
}

function validateProviderObjective(provider, value) {
  const definition = PROVIDERS[provider];
  const objective = boundedText(value || "traffic", 40).toLowerCase();
  if (definition.supportedObjectives.includes(objective)) return objective;
  const supported = definition.supportedObjectives
    .map((item) => item === "traffic" ? "website traffic" : item)
    .join(" or ");
  const measurementRequired = ["conversions", "sales", "leads"].includes(objective);
  throw adsError(
    measurementRequired
      ? `${definition.name} ${objective} setup requires a verified provider conversion source and objective-specific delivery adapter. Use ${supported} until that measurement contract is connected.`
      : `${definition.name} one-click delivery currently supports ${supported}.`,
    409,
    measurementRequired ? "GOODADS_PROVIDER_EVENT_SOURCE_REQUIRED" : "GOODADS_PROVIDER_OBJECTIVE_UNSUPPORTED"
  );
}

function validateCampaignForAccount(campaign, account) {
  const data = campaign.data || {};
  if (campaign.status !== "ready") {
    throw adsError("Mark this campaign ready before creating it on an ad network.", 409, "GOODADS_CAMPAIGN_NOT_READY");
  }
  if (account.status && account.status !== "verified") {
    throw adsError("Refresh and verify this ad account before provider creation.", 409, "GOODADS_AD_ACCOUNT_NOT_VERIFIED");
  }
  const dailyBudget = Number(data.dailyBudget);
  const maximum = Math.max(Number(process.env.GOODADS_MAX_DAILY_BUDGET || 10000), 1);
  if (!Number.isFinite(dailyBudget) || dailyBudget < 1 || dailyBudget > maximum) {
    throw adsError(`Daily budget must be between 1 and ${maximum}.`, 409, "GOODADS_CAMPAIGN_BUDGET_INVALID");
  }
  const platforms = Array.isArray(data.platforms) ? data.platforms.map((item) => String(item).toLowerCase()) : [];
  const definition = PROVIDERS[account.provider];
  const matchesProvider = definition.platforms.some((provider) => platforms.includes(provider));
  if (!matchesProvider) {
    throw adsError(`${definition.name} is not selected on this campaign.`, 409, "GOODADS_AD_ACCOUNT_NOT_SELECTED");
  }
  validateProviderObjective(account.provider, data.objective);
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
  if (!account.currency || !account.timezone) {
    throw adsError(
      `Refresh ${definition.name} account verification to load its currency and time zone before setup.`,
      409,
      "GOODADS_AD_ACCOUNT_LOCALE_REQUIRED"
    );
  }
  campaignScheduleBounds(data, account.timezone);
  const creative = data.creative || {};
  const providerVideoUrl = providerCreativeVideoUrl(data, account.provider);
  if (!isPublicHttpsUrl(creative.destinationUrl)) {
    throw adsError("Campaign delivery requires a public HTTPS destination URL.", 409, "GOODADS_DESTINATION_URL_REQUIRED");
  }
  if (account.provider === "meta") {
    if (!account.metadata?.pageId) {
      throw adsError(
        "Select an accessible Facebook Page on this Meta ad account before launch.",
        409,
        "GOODADS_META_PAGE_REQUIRED"
      );
    }
    if (!isPublicHttpsUrl(creative.imageUrl)) {
      throw adsError("Meta delivery requires a public HTTPS creative image.", 409, "GOODADS_META_IMAGE_REQUIRED");
    }
    if (metaPublisherPlatforms(data).includes("instagram") && !account.metadata?.instagramActorId) {
      throw adsError(
        "Instagram delivery requires a professional Instagram account linked to the selected Facebook Page.",
        409,
        "GOODADS_META_INSTAGRAM_IDENTITY_REQUIRED"
      );
    }
  }
  if (account.provider === "google") {
    googlePoliticalAdvertisingStatus(data.containsEuPoliticalAdvertising);
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
  if (["youtube", "tiktok"].includes(account.provider) && !isPublicHttpsUrl(providerVideoUrl)) {
    throw adsError(
      `${definition.name} delivery requires a public HTTPS creative video.`,
      409,
      "GOODADS_VIDEO_REQUIRED"
    );
  }
  if (account.provider === "tiktok") {
    const identityType = boundedText(account.metadata?.identityType, 40).toUpperCase();
    if (
      !account.metadata?.deliveryReady
      || !ACCOUNT_ID_PATTERN.test(boundedText(account.metadata?.identityId, 120))
      || !["CUSTOMIZED_USER", "AUTH_CODE", "TT_USER", "BC_AUTH_TT"].includes(identityType)
      || (identityType === "BC_AUTH_TT" && !ACCOUNT_ID_PATTERN.test(boundedText(account.metadata?.identityAuthorizedBcId, 120)))
    ) {
      throw adsError(
        "TikTok delivery requires an available advertising identity linked to this ad account.",
        409,
        "GOODADS_TIKTOK_IDENTITY_REQUIRED"
      );
    }
    const minimumBudget = Math.max(Number(process.env.GOODADS_TIKTOK_MIN_DAILY_BUDGET || 20), 1);
    if (dailyBudget < minimumBudget) {
      throw adsError(
        `TikTok requires a daily budget of at least ${minimumBudget} account-currency units.`,
        409,
        "GOODADS_TIKTOK_BUDGET_MINIMUM"
      );
    }
    if (!isManagedGoodOsHttpsUrl(providerVideoUrl)) {
      throw adsError(
        "TikTok creative video must be stored on a managed GoodOS HTTPS address.",
        409,
        "GOODADS_TIKTOK_VIDEO_HOST_INVALID"
      );
    }
    const primaryText = String(creative.primaryText || "").trim();
    if (!primaryText || primaryText.length > 100) {
      throw adsError(
        "TikTok delivery requires ad text of 100 characters or fewer.",
        409,
        "GOODADS_TIKTOK_COPY_INVALID"
      );
    }
  }
  if (account.provider === "youtube") {
    googlePoliticalAdvertisingStatus(data.containsEuPoliticalAdvertising);
    if (!youtubeVideoId(providerVideoUrl)) {
      throw adsError(
        "YouTube delivery requires a valid YouTube watch, Shorts, live, embed, or youtu.be video URL.",
        409,
        "GOODADS_YOUTUBE_VIDEO_URL_INVALID"
      );
    }
    if (!isManagedGoodOsHttpsUrl(creative.logoUrl)) {
      throw adsError(
        "YouTube delivery requires a square logo stored on a managed GoodOS HTTPS address.",
        409,
        "GOODADS_YOUTUBE_LOGO_REQUIRED"
      );
    }
    const businessName = String(creative.businessName || "").trim();
    const headline = String(creative.headline || "").trim();
    const primaryText = String(creative.primaryText || "").trim();
    if (!businessName || !headline || !primaryText) {
      throw adsError(
        "YouTube delivery requires a business name, headline, and description.",
        409,
        "GOODADS_YOUTUBE_COPY_REQUIRED"
      );
    }
    if (businessName.length > 25 || headline.length > 40 || primaryText.length > 90) {
      throw adsError(
        "YouTube business names cannot exceed 25 characters, headlines 40, or descriptions 90.",
        409,
        "GOODADS_YOUTUBE_COPY_TOO_LONG"
      );
    }
  }
  if (["linkedin", "pinterest"].includes(account.provider) && !isPublicHttpsUrl(creative.imageUrl)) {
    throw adsError(
      `${definition.name} delivery requires a public HTTPS creative image.`,
      409,
      "GOODADS_IMAGE_REQUIRED"
    );
  }
  if (account.provider === "linkedin") {
    linkedInPolicyCompliance(data);
    if (!account.metadata?.deliveryReady || !/^urn:li:organization:\d+$/.test(account.metadata?.organizationUrn || "")) {
      throw adsError(
        "LinkedIn delivery requires an active organization-backed ad account and campaign-manager access.",
        409,
        "GOODADS_LINKEDIN_ORGANIZATION_REQUIRED"
      );
    }
    if (!boundedText(creative.primaryText, 600) || !boundedText(creative.headline, 200)) {
      throw adsError(
        "LinkedIn delivery requires primary text and a headline.",
        409,
        "GOODADS_LINKEDIN_COPY_REQUIRED"
      );
    }
  }
  if (account.provider === "pinterest") {
    if (!account.metadata?.deliveryReady) {
      throw adsError(
        "Pinterest delivery requires an ad account with owner, admin, or campaign-manager access.",
        409,
        "GOODADS_PINTEREST_CAMPAIGN_ACCESS_REQUIRED"
      );
    }
    const headline = String(creative.headline || "").trim();
    const primaryText = String(creative.primaryText || "").trim();
    if (!headline || !primaryText) {
      throw adsError(
        "Pinterest delivery requires a headline and primary text.",
        409,
        "GOODADS_PINTEREST_COPY_REQUIRED"
      );
    }
    if (headline.length > 100 || primaryText.length > 800) {
      throw adsError(
        "Pinterest headlines cannot exceed 100 characters and primary text cannot exceed 800 characters.",
        409,
        "GOODADS_PINTEREST_COPY_TOO_LONG"
      );
    }
  }
  if (account.provider === "x") {
    if (
      !account.metadata?.deliveryReady
      || !ACCOUNT_ID_PATTERN.test(boundedText(account.metadata?.fundingInstrumentId, 120))
      || !/^\d{2,30}$/.test(String(account.metadata?.advertiserUserId || ""))
    ) {
      throw adsError(
        "X Ads delivery requires an accepted account, active funding, a full promotable user, and campaign plus Tweet Composer access.",
        409,
        "GOODADS_X_DELIVERY_PREREQUISITES_REQUIRED"
      );
    }
    const minimumBudget = Math.max(Number(process.env.GOODADS_X_MIN_DAILY_BUDGET || 1), 1);
    if (dailyBudget < minimumBudget) {
      throw adsError(
        `X Ads requires a daily budget of at least ${minimumBudget} account-currency units for this GoodAds installation.`,
        409,
        "GOODADS_X_BUDGET_MINIMUM"
      );
    }
    const primaryText = String(creative.primaryText || "").trim();
    const promotedText = `${primaryText}\n${String(creative.destinationUrl || "").trim()}`;
    if (!primaryText || promotedText.length > 280) {
      throw adsError(
        "X Ads delivery requires primary text whose combined text and destination URL are 280 characters or fewer.",
        409,
        "GOODADS_X_COPY_INVALID"
      );
    }
  }
  if (account.provider === "snapchat") {
    if (!account.metadata?.deliveryReady || !UUID_PATTERN.test(account.metadata?.profileId || "")) {
      throw adsError(
        "Snapchat delivery requires a Public Profile shared with this ad account.",
        409,
        "GOODADS_SNAPCHAT_PROFILE_REQUIRED"
      );
    }
    if (dailyBudget < 5) {
      throw adsError(
        "Snapchat requires a daily budget of at least 5 account-currency units.",
        409,
        "GOODADS_SNAPCHAT_BUDGET_MINIMUM"
      );
    }
    if (!boundedText(creative.headline, 34)) {
      throw adsError("Snapchat delivery requires a headline of 34 characters or fewer.", 409, "GOODADS_SNAPCHAT_HEADLINE_REQUIRED");
    }
    if (String(creative.headline || "").trim().length > 34) {
      throw adsError("Snapchat headlines cannot exceed 34 characters.", 409, "GOODADS_SNAPCHAT_HEADLINE_TOO_LONG");
    }
    const mediaUrl = isPublicHttpsUrl(creative.videoUrl) ? creative.videoUrl : creative.imageUrl;
    if (!isManagedGoodOsHttpsUrl(mediaUrl)) {
      throw adsError(
        "Snapchat creative media must be stored on a managed GoodOS HTTPS address.",
        409,
        "GOODADS_SNAPCHAT_MEDIA_HOST_INVALID"
      );
    }
  }
  if (account.provider === "snapchat"
    && !isPublicHttpsUrl(creative.imageUrl)
    && !isPublicHttpsUrl(creative.videoUrl)) {
    throw adsError(
      `${definition.name} delivery requires a public HTTPS image or video.`,
      409,
      "GOODADS_MEDIA_REQUIRED"
    );
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

function campaignPreflightReport({
  campaign,
  requestedAccountIds,
  accounts,
  providerCampaigns = [],
  availabilityByProvider = {},
  generatedAt = new Date().toISOString(),
}) {
  const accountById = new Map((accounts || []).map((account) => [String(account.id), account]));
  const selectedAccounts = requestedAccountIds.map((id) => accountById.get(String(id))).filter(Boolean);
  const missingAccountIds = requestedAccountIds.filter((id) => !accountById.has(String(id)));
  const blockers = [];
  if (campaign.status !== "ready") {
    blockers.push({
      code: "GOODADS_CAMPAIGN_NOT_READY",
      detail: "Save this exact campaign version as ready before provider creation.",
    });
  }
  if (missingAccountIds.length) {
    blockers.push({
      code: "GOODADS_AD_ACCOUNT_NOT_FOUND",
      detail: `${missingAccountIds.length} selected ad account${missingAccountIds.length === 1 ? " is" : "s are"} unavailable to this organization.`,
    });
  }
  const activeDeliveryByAccount = new Map((providerCampaigns || [])
    .filter((delivery) => delivery.status !== "archived")
    .map((delivery) => [String(delivery.ad_account_id || delivery.adAccountId), delivery]));
  const plannedAccounts = new Map(selectedAccounts.map((account) => [String(account.id), account]));
  for (const [accountId, delivery] of activeDeliveryByAccount) {
    if (!plannedAccounts.has(accountId)) {
      plannedAccounts.set(accountId, {
        id: accountId,
        currency: delivery.account_currency || delivery.accountCurrency,
        timezone: delivery.account_timezone || delivery.accountTimezone,
      });
    }
  }
  const accountLocales = new Set([...plannedAccounts.values()].map((account) => (
    `${boundedText(account.currency, 12).toUpperCase()}|${boundedText(account.timezone, 120)}`
  )));
  const accountLocaleIncomplete = [...plannedAccounts.values()].some((account) => (
    !boundedText(account.currency, 12) || !boundedText(account.timezone, 120)
  ));
  const accountLocaleVerified = selectedAccounts.length === requestedAccountIds.length
    && plannedAccounts.size > 0
    && !accountLocaleIncomplete
    && accountLocales.size === 1;
  if (!accountLocaleVerified) {
    blockers.push({
      code: "GOODADS_AD_ACCOUNT_LOCALE_MISMATCH",
      detail: "Every selected ad account must use the same verified currency and time zone.",
    });
  }
  const accountChecks = selectedAccounts.map((account) => {
    const issues = [];
    if (account.status !== "verified") {
      issues.push({
        code: "GOODADS_AD_ACCOUNT_NOT_VERIFIED",
        detail: "Refresh this ad account before provider creation.",
      });
    }
    const availability = availabilityByProvider[account.provider] || providerAvailability(account.provider);
    if (!availability.available) {
      issues.push({
        code: "GOODADS_AD_PROVIDER_NOT_CONFIGURED",
        detail: `${availability.name} is not fully configured in GoodBase.`,
      });
    }
    try {
      validateCampaignForAccount(campaign, account);
    } catch (error) {
      issues.push({
        code: boundedText(error.code, 100) || "GOODADS_CAMPAIGN_PREFLIGHT_FAILED",
        detail: boundedText(error.message, 1000) || "Campaign validation failed.",
      });
    }
    const uniqueIssues = [...new Map(issues.map((issue) => [`${issue.code}:${issue.detail}`, issue])).values()];
    const existingDelivery = activeDeliveryByAccount.get(String(account.id));
    return {
      accountId: account.id,
      provider: account.provider,
      providerName: availability.name,
      accountName: account.name,
      currency: boundedText(account.currency, 12).toUpperCase(),
      timezone: boundedText(account.timezone, 120),
      status: uniqueIssues.length ? "block" : "pass",
      issues: uniqueIssues,
      existingDelivery: existingDelivery ? {
        id: existingDelivery.id,
        status: existingDelivery.status,
        providerCampaignId: existingDelivery.provider_campaign_id || existingDelivery.providerCampaignId || null,
      } : null,
      willCreatePausedDelivery: !existingDelivery && uniqueIssues.length === 0,
    };
  });
  for (const check of accountChecks) blockers.push(...check.issues.map((issue) => ({ ...issue, accountId: check.accountId })));
  let schedule = null;
  if (accountLocaleVerified) {
    try {
      schedule = campaignScheduleBounds(campaign.data, selectedAccounts[0].timezone);
    } catch {}
  }
  const deliveryDays = schedule?.deliveryDays || 0;
  const dailyBudgetPerAccount = Math.max(Number(campaign.data?.dailyBudget) || 0, 0);
  const combinedDailyBudget = dailyBudgetPerAccount * plannedAccounts.size;
  const planningMaximum = combinedDailyBudget * deliveryDays;
  const exposurePolicy = campaignExposurePolicy();
  blockers.push(...campaignExposureIssues({
    accountCount: plannedAccounts.size,
    combinedDailyBudget,
    planningMaximum,
  }, exposurePolicy));
  return {
    campaignId: campaign.id,
    campaignVersion: Number(campaign.version || 1),
    generatedAt,
    ready: blockers.length === 0,
    readOnly: true,
    providerNetworkCalls: 0,
    providerWrites: 0,
    activatesAdvertising: false,
    startsSpend: false,
    deliveryMode: "paused_only",
    blockers,
    accountChecks,
    exposure: {
      accountCount: plannedAccounts.size,
      deliveryDays,
      dailyBudgetPerAccount,
      combinedDailyBudget,
      planningMaximum,
      limits: exposurePolicy,
      schedule,
      currency: accountLocaleVerified
        ? boundedText(selectedAccounts[0]?.currency, 12).toUpperCase()
        : null,
      timezone: accountLocaleVerified
        ? boundedText(selectedAccounts[0]?.timezone, 120)
        : null,
    },
    existingDeliveries: activeDeliveryByAccount.size,
    missingPausedDeliveries: accountChecks.filter((check) => check.willCreatePausedDelivery).length,
  };
}

async function preflightCampaign({ campaignId, adAccountIds, context }) {
  const safeCampaignId = requireUuid(campaignId, "campaign ID");
  const accountIds = [...new Set(Array.isArray(adAccountIds) ? adAccountIds.map((id) => requireUuid(id, "ad account ID")) : [])];
  if (!accountIds.length || accountIds.length > MAX_ACCOUNTS_PER_LAUNCH) {
    throw adsError("Select between one and ten ad accounts for preflight.");
  }
  const [campaignResult, accountResult, deliveryResult] = await Promise.all([
    query(
      `SELECT * FROM goodads_resources
       WHERE id = $1::uuid AND organization_id = $2
         AND resource_type = 'campaigns' AND archived_at IS NULL`,
      [safeCampaignId, context.organizationId]
    ),
    query(
      `SELECT * FROM goodads_ad_accounts
       WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [context.organizationId, accountIds]
    ),
    query(
      `SELECT provider_campaign.*, account.currency AS account_currency,
         account.timezone AS account_timezone
       FROM goodads_provider_campaigns provider_campaign
       JOIN goodads_ad_accounts account ON account.id = provider_campaign.ad_account_id
       WHERE provider_campaign.organization_id = $1
         AND provider_campaign.campaign_id = $2::uuid`,
      [context.organizationId, safeCampaignId]
    ),
  ]);
  const campaign = campaignResult.rows[0];
  if (!campaign) throw adsError("Campaign was not found.", 404, "GOODADS_CAMPAIGN_NOT_FOUND");
  const availabilityByProvider = Object.fromEntries(
    [...new Set(accountResult.rows.map((account) => account.provider))]
      .map((provider) => [provider, providerAvailability(provider)])
  );
  return campaignPreflightReport({
    campaign,
    requestedAccountIds: accountIds,
    accounts: accountResult.rows,
    providerCampaigns: deliveryResult.rows,
    availabilityByProvider,
  });
}

async function launchCampaign({ campaignId, adAccountIds, context, userId, idempotencyKey }) {
  requireManagement(context);
  const requestKey = requireIdempotencyKey(idempotencyKey);
  const safeCampaignId = requireUuid(campaignId, "campaign ID");
  const accountIds = [...new Set(Array.isArray(adAccountIds) ? adAccountIds.map((id) => requireUuid(id, "ad account ID")) : [])];
  if (!accountIds.length || accountIds.length > MAX_ACCOUNTS_PER_LAUNCH) {
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
  const accountLocales = new Set(accountResult.rows.map((account) => (
    `${boundedText(account.currency, 12).toUpperCase()}|${boundedText(account.timezone, 120)}`
  )));
  const accountLocaleIncomplete = accountResult.rows.some((account) => (
    !boundedText(account.currency, 12) || !boundedText(account.timezone, 120)
  ));
  if (accountLocaleIncomplete || accountLocales.size !== 1) {
    throw adsError(
      "One-click setup requires every selected ad account to use the same currency and time zone.",
      409,
      "GOODADS_AD_ACCOUNT_LOCALE_MISMATCH"
    );
  }
  const snapshot = campaignSnapshot(campaign);
  const hash = snapshotHash(snapshot);
  const accounts = [...accountResult.rows].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  for (const account of accounts) {
    const availability = providerAvailability(account.provider);
    if (!availability.available) {
      throw adsError(`${availability.name} is not fully configured in GoodBase.`, 503, "GOODADS_AD_PROVIDER_NOT_CONFIGURED");
    }
    validateCampaignForAccount(campaign, account);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1::text))",
      [`goodads:campaign-exposure:${context.organizationId}:${campaign.id}`]
    );
    const existingAccounts = await client.query(
      `SELECT provider_campaign.ad_account_id, account.currency, account.timezone
       FROM goodads_provider_campaigns provider_campaign
       JOIN goodads_ad_accounts account ON account.id = provider_campaign.ad_account_id
       WHERE provider_campaign.organization_id = $1
         AND provider_campaign.campaign_id = $2::uuid
         AND provider_campaign.status <> 'archived'
       FOR UPDATE OF provider_campaign`,
      [context.organizationId, campaign.id]
    );
    const plannedAccounts = new Map(existingAccounts.rows.map((account) => [String(account.ad_account_id), account]));
    for (const account of accounts) plannedAccounts.set(String(account.id), account);
    const plannedLocales = new Set([...plannedAccounts.values()].map((account) => (
      `${boundedText(account.currency, 12).toUpperCase()}|${boundedText(account.timezone, 120)}`
    )));
    if (plannedLocales.size !== 1) {
      throw adsError(
        "Campaign-wide setup requires one verified currency and time zone across every provider account.",
        409,
        "GOODADS_AD_ACCOUNT_LOCALE_MISMATCH"
      );
    }
    validateCampaignExposure(campaign.data, plannedAccounts.size, [...plannedAccounts.values()][0].timezone);
    for (const account of accounts) {
      const existingResult = await client.query(
        `SELECT provider_campaign.*,
           EXISTS (
             SELECT 1 FROM goodads_ad_operations operation
             WHERE operation.provider_campaign_id = provider_campaign.id
               AND operation.operation_type = 'create'
               AND operation.status IN ('queued','processing','retrying')
           ) AS create_pending
         FROM goodads_provider_campaigns provider_campaign
         WHERE provider_campaign.organization_id = $1
           AND provider_campaign.campaign_id = $2::uuid
           AND provider_campaign.ad_account_id = $3::uuid
         FOR UPDATE`,
        [context.organizationId, campaign.id, account.id]
      );
      const existing = existingResult.rows[0];
      if (
        existing
        && existing.status !== "archived"
        && existing.snapshot_hash !== hash
        && (existing.provider_campaign_id || existing.create_pending)
      ) {
        throw adsError(
          existing.create_pending
            ? "This provider campaign is already being created from an earlier campaign version. Wait for it to finish, then archive it before recreating."
            : "This provider campaign belongs to an earlier campaign version. Archive it before recreating from the current version.",
          409,
          "GOODADS_AD_CAMPAIGN_VERSION_CHANGED"
        );
      }
      const providerCampaign = await client.query(
        `INSERT INTO goodads_provider_campaigns (
           organization_id, campaign_id, ad_account_id, provider, status,
           campaign_version, snapshot_hash, created_by_user_id
         ) VALUES ($1, $2::uuid, $3::uuid, $4, 'queued', $5, $6, $7::uuid)
         ON CONFLICT (organization_id, campaign_id, ad_account_id) DO UPDATE SET
           campaign_version = CASE
             WHEN goodads_provider_campaigns.provider_campaign_id IS NULL
               OR goodads_provider_campaigns.status = 'archived'
             THEN EXCLUDED.campaign_version
             ELSE goodads_provider_campaigns.campaign_version
           END,
           snapshot_hash = CASE
             WHEN goodads_provider_campaigns.provider_campaign_id IS NULL
               OR goodads_provider_campaigns.status = 'archived'
             THEN EXCLUDED.snapshot_hash
             ELSE goodads_provider_campaigns.snapshot_hash
           END,
           provider_campaign_id = CASE
             WHEN goodads_provider_campaigns.status = 'archived' THEN NULL
             ELSE goodads_provider_campaigns.provider_campaign_id
           END,
           provider_resource_name = CASE
             WHEN goodads_provider_campaigns.status = 'archived' THEN NULL
             ELSE goodads_provider_campaigns.provider_resource_name
           END,
           provider_budget_id = CASE
             WHEN goodads_provider_campaigns.status = 'archived' THEN NULL
             ELSE goodads_provider_campaigns.provider_budget_id
           END,
           status = CASE
             WHEN goodads_provider_campaigns.provider_campaign_id IS NULL
               OR goodads_provider_campaigns.status = 'archived'
             THEN 'queued'
             ELSE goodads_provider_campaigns.status
           END,
           activation_approval_id = CASE
             WHEN goodads_provider_campaigns.status = 'archived' THEN NULL
             ELSE goodads_provider_campaigns.activation_approval_id
           END,
           receipt = CASE
             WHEN goodads_provider_campaigns.status = 'archived' THEN '{}'::jsonb
             ELSE goodads_provider_campaigns.receipt
           END,
           last_error = CASE
             WHEN goodads_provider_campaigns.provider_campaign_id IS NULL
               OR goodads_provider_campaigns.status = 'archived'
             THEN NULL
             ELSE goodads_provider_campaigns.last_error
           END,
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
           ON CONFLICT DO NOTHING`,
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
    if (PROVIDERS[campaign.provider]?.activationSupported === false) {
      throw adsError(
        `${PROVIDERS[campaign.provider].name} activation remains disabled until its provider-specific policy confirmation is installed.`,
        409,
        "GOODADS_AD_ACTIVATION_NOT_SUPPORTED"
      );
    }
    const currentSnapshot = {
      id: campaign.campaign_id,
      version: Number(campaign.current_version),
      name: boundedText(campaign.campaign_name, 240),
      status: campaign.campaign_status,
      data: campaign.campaign_data || {},
    };
    if (campaign.provider === "linkedin") linkedInPolicyCompliance(currentSnapshot.data);
    if (snapshotHash(currentSnapshot) !== campaign.snapshot_hash) {
      throw adsError(
        "The campaign changed after provider creation. Create a fresh paused provider campaign before activation.",
        409,
        "GOODADS_AD_CAMPAIGN_VERSION_CHANGED"
      );
    }
    await validateStoredCampaignExposure({
      organizationId: context.organizationId,
      campaignId: campaign.campaign_id,
      campaignData: currentSnapshot.data,
    });
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
     ON CONFLICT DO NOTHING`,
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

async function emergencyPauseAll({ context, userId, idempotencyKey, confirmation }) {
  requireManagement(context);
  const requestKey = requireIdempotencyKey(idempotencyKey);
  if (boundedText(confirmation, 80) !== EMERGENCY_PAUSE_CONFIRMATION) {
    throw adsError(
      `Type ${EMERGENCY_PAUSE_CONFIRMATION} to confirm the emergency pause.`,
      400,
      "GOODADS_EMERGENCY_PAUSE_CONFIRMATION_REQUIRED"
    );
  }

  const requestedAt = new Date().toISOString();
  const marker = {
    active: true,
    requestKey,
    requestedAt,
    requestedByUserId: userId,
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1::text))",
      [`goodads:emergency-pause:${context.organizationId}`]
    );
    const selected = await client.query(
      `SELECT id, campaign_id, status
       FROM goodads_provider_campaigns
       WHERE organization_id = $1
         AND provider_campaign_id IS NOT NULL
         AND status IN ('active','activating','pausing','paused')
       ORDER BY id
       FOR UPDATE`,
      [context.organizationId]
    );
    const providerCampaignIds = selected.rows.map((row) => row.id);
    const campaignIds = [...new Set(
      selected.rows
        .filter((row) => row.status !== "paused")
        .map((row) => row.campaign_id)
    )];
    const processing = await client.query(
      `SELECT COUNT(*)::integer AS count
       FROM goodads_ad_operations operation
       WHERE operation.organization_id = $1
         AND operation.provider_campaign_id = ANY($2::uuid[])
         AND operation.operation_type = 'activate'
         AND operation.status = 'processing'`,
      [context.organizationId, providerCampaignIds]
    );
    const cancelled = await client.query(
      `UPDATE goodads_ad_operations operation
       SET status = 'failed',
           last_error = 'Cancelled by the workspace emergency pause.',
           completed_at = NOW(), locked_by = NULL, locked_until = NULL, updated_at = NOW()
       WHERE operation.organization_id = $1
         AND operation.provider_campaign_id = ANY($2::uuid[])
         AND operation.operation_type = 'activate'
         AND operation.status IN ('queued','retrying')
       RETURNING operation.id`,
      [context.organizationId, providerCampaignIds]
    );
    await client.query(
      `UPDATE goodads_provider_campaigns
       SET receipt = jsonb_set(COALESCE(receipt, '{}'::jsonb), '{emergencyPause}', $2::jsonb, true),
           status = CASE WHEN status IN ('active','activating') THEN 'pausing' ELSE status END,
           updated_at = NOW()
       WHERE organization_id = $1 AND id = ANY($3::uuid[])`,
      [context.organizationId, JSON.stringify(marker), providerCampaignIds]
    );
    const queued = await client.query(
      `INSERT INTO goodads_ad_operations (
         organization_id, provider_campaign_id, requested_by_user_id,
         operation_type, idempotency_key, payload
       )
       SELECT provider_campaign.organization_id, provider_campaign.id, $3::uuid,
         'pause', $4 || ':' || provider_campaign.id::text || ':emergency-pause',
         $5::jsonb
       FROM goodads_provider_campaigns provider_campaign
       WHERE provider_campaign.organization_id = $1
         AND provider_campaign.id = ANY($2::uuid[])
         AND provider_campaign.status = 'pausing'
       ON CONFLICT DO NOTHING
       RETURNING provider_campaign_id`,
      [context.organizationId, providerCampaignIds, userId, requestKey, JSON.stringify({ emergencyPause: marker })]
    );
    if (campaignIds.length) {
      await client.query(
        `UPDATE goodads_resources
         SET status = 'paused',
             data = data || jsonb_build_object(
               'status', 'paused',
               'emergencyPausedAt', $3::text,
               'emergencyPausedByUserId', $4::text,
               'updatedAt', NOW()::text
             ),
             version = version + 1,
             updated_at = NOW()
         WHERE organization_id = $1
           AND id = ANY($2::uuid[])
           AND resource_type = 'campaigns'
           AND archived_at IS NULL`,
        [context.organizationId, campaignIds, requestedAt, userId]
      );
    }
    await client.query("COMMIT");
    return {
      requestedAt,
      matchedProviderCampaigns: providerCampaignIds.length,
      providerPausesQueued: queued.rows.length,
      queuedActivationsCancelled: cancelled.rows.length,
      inFlightActivationsIntercepted: Number(processing.rows[0]?.count || 0),
      affectedCampaigns: campaignIds.length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
  if (PROVIDERS[campaign.provider]?.activationSupported === false) {
    throw adsError(
      `${PROVIDERS[campaign.provider].name} activation review is unavailable until its provider-specific policy confirmation is installed.`,
      409,
      "GOODADS_AD_ACTIVATION_NOT_SUPPORTED"
    );
  }
  if (campaign.provider === "linkedin") linkedInPolicyCompliance(campaign.campaign_data);
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
  const schedule = campaignScheduleBounds(data, row.account_timezone);
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
      targeting: {
        geo_locations: { countries },
        publisher_platforms: metaPublisherPlatforms(data),
      },
      start_time: schedule.startAt,
      end_time: schedule.endAt,
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
        startDateTime: `${data.startDate} 00:00:00`,
        endDateTime: `${data.endDate} 23:59:59`,
        containsEuPoliticalAdvertising: googlePoliticalAdvertisingStatus(data.containsEuPoliticalAdvertising),
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

function googleAdsQueryLiteral(value) {
  return String(value || "").replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

async function googleSearch(row, accessToken, gaql, fallback) {
  const customerId = String(row.provider_account_id).replace(/\D/g, "");
  const { payload } = await requestJson(
    `https://googleads.googleapis.com/v24/customers/${customerId}/googleAds:searchStream`,
    {
      method: "POST",
      headers: googleHeaders(accessToken),
      body: JSON.stringify({ query: gaql }),
    },
    fallback
  );
  return (Array.isArray(payload) ? payload : [payload]).flatMap((batch) => batch?.results || []);
}

async function googleCountryTargets(row, accessToken) {
  const countries = [...new Set((row.campaign_data?.targetCountries || [])
    .map((country) => boundedText(country, 2).toUpperCase())
    .filter((country) => /^[A-Z]{2}$/.test(country)))];
  const quoted = countries.map((country) => `'${country}'`).join(", ");
  const results = await googleSearch(
    row,
    accessToken,
    `SELECT geo_target_constant.resource_name, geo_target_constant.country_code
     FROM geo_target_constant
     WHERE geo_target_constant.country_code IN (${quoted})
       AND geo_target_constant.target_type = 'Country'
       AND geo_target_constant.status = 'ENABLED'`,
    "Google Ads country-target resolution"
  );
  const resources = new Map(results.map((result) => [
    boundedText(result.geoTargetConstant?.countryCode, 2).toUpperCase(),
    boundedText(result.geoTargetConstant?.resourceName, 200),
  ]));
  const missing = countries.filter((country) => !resources.get(country));
  if (missing.length) {
    throw adsError(
      `Google Ads could not resolve country targeting for: ${missing.join(", ")}.`,
      409,
      "GOODADS_GOOGLE_COUNTRY_TARGET_INVALID"
    );
  }
  return countries.map((country) => resources.get(country));
}

function googleDemandGenNames(row) {
  const suffix = boundedText(row.provider_campaign_record_id, 36).slice(0, 8);
  const base = boundedText(row.campaign_name, 180);
  return {
    campaign: boundedText(`${base} [GoodAds ${suffix}]`, 240),
    budget: boundedText(`${base} YouTube budget [${suffix}]`, 240),
    adGroup: boundedText(`${base} YouTube audience [${suffix}]`, 240),
    ad: boundedText(`${base} YouTube ad [${suffix}]`, 240),
    videoAsset: boundedText(`${base} YouTube video [${suffix}]`, 240),
    logoAsset: boundedText(`${base} YouTube logo [${suffix}]`, 240),
  };
}

function validGoogleLogoSignature(buffer, mimeType) {
  if (mimeType === "image/png") return buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  if (mimeType === "image/jpeg") return buffer.subarray(0, 3).toString("hex") === "ffd8ff";
  return false;
}

function googleLogoDimensions(buffer, mimeType) {
  if (mimeType === "image/png" && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType !== "image/jpeg" || buffer.length < 12) return null;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if (startOfFrameMarkers.has(marker) && length >= 7) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

async function loadGoogleLogoImage(value) {
  if (!isManagedGoodOsHttpsUrl(value)) {
    throw adsError(
      "YouTube logo images must be stored on a managed GoodOS HTTPS address.",
      409,
      "GOODADS_YOUTUBE_LOGO_HOST_INVALID"
    );
  }
  let response;
  try {
    response = await fetch(value, { redirect: "error", signal: AbortSignal.timeout(20000) });
  } catch {
    throw adsError("YouTube logo image could not be downloaded.", 502, "GOODADS_YOUTUBE_LOGO_DOWNLOAD_FAILED", true);
  }
  if (!response.ok) {
    throw adsError(
      "YouTube logo image could not be downloaded.",
      502,
      "GOODADS_YOUTUBE_LOGO_DOWNLOAD_FAILED",
      response.status >= 500
    );
  }
  const mimeType = boundedText(response.headers.get("content-type"), 100).split(";")[0].toLowerCase();
  if (!GOOGLE_LOGO_MIME_TYPES.has(mimeType)) {
    throw adsError("YouTube logo images must be PNG or JPEG.", 409, "GOODADS_YOUTUBE_LOGO_TYPE_INVALID");
  }
  const buffer = await readBoundedBody(
    response,
    MAX_GOOGLE_LOGO_BYTES,
    "YouTube logo image exceeds 5 MB.",
    "GOODADS_YOUTUBE_LOGO_TOO_LARGE"
  );
  if (!buffer.length || !validGoogleLogoSignature(buffer, mimeType)) {
    throw adsError("YouTube logo image is invalid.", 409, "GOODADS_YOUTUBE_LOGO_INVALID");
  }
  const dimensions = googleLogoDimensions(buffer, mimeType);
  if (
    !dimensions
    || dimensions.width < 128
    || dimensions.height < 128
    || Math.abs(dimensions.width / dimensions.height - 1) > 0.01
  ) {
    throw adsError(
      "YouTube logo image must be square and at least 128 by 128 pixels.",
      409,
      "GOODADS_YOUTUBE_LOGO_DIMENSIONS_INVALID"
    );
  }
  return { buffer, mimeType };
}

function googleDemandGenOperations(row, { logoBase64, geoTargetResources }) {
  const data = row.campaign_data || {};
  const creative = data.creative || {};
  const customerId = String(row.provider_account_id).replace(/\D/g, "");
  const names = googleDemandGenNames(row);
  const resourceNames = {
    budget: `customers/${customerId}/campaignBudgets/-1`,
    campaign: `customers/${customerId}/campaigns/-2`,
    adGroup: `customers/${customerId}/adGroups/-3`,
    videoAsset: `customers/${customerId}/assets/-4`,
    logoAsset: `customers/${customerId}/assets/-5`,
  };
  return [
    {
      campaignBudgetOperation: {
        create: {
          resourceName: resourceNames.budget,
          name: names.budget,
          amountMicros: String(Math.round(Number(data.dailyBudget) * 1000000)),
          deliveryMethod: "STANDARD",
          explicitlyShared: false,
        },
      },
    },
    {
      campaignOperation: {
        create: {
          resourceName: resourceNames.campaign,
          name: names.campaign,
          status: "PAUSED",
          advertisingChannelType: "DEMAND_GEN",
          campaignBudget: resourceNames.budget,
          maximizeClicks: {},
          startDateTime: `${data.startDate} 00:00:00`,
          endDateTime: `${data.endDate} 23:59:59`,
          containsEuPoliticalAdvertising: googlePoliticalAdvertisingStatus(data.containsEuPoliticalAdvertising),
        },
      },
    },
    {
      adGroupOperation: {
        create: {
          resourceName: resourceNames.adGroup,
          name: names.adGroup,
          campaign: resourceNames.campaign,
          demandGenAdGroupSettings: {
            channelControls: {
              selectedChannels: {
                gmail: false,
                discover: false,
                display: false,
                youtubeInFeed: true,
                youtubeInStream: true,
                youtubeShorts: true,
              },
            },
          },
        },
      },
    },
    ...geoTargetResources.map((geoTargetConstant) => ({
      adGroupCriterionOperation: {
        create: {
          adGroup: resourceNames.adGroup,
          location: { geoTargetConstant },
        },
      },
    })),
    {
      assetOperation: {
        create: {
          resourceName: resourceNames.videoAsset,
          name: names.videoAsset,
          youtubeVideoAsset: { youtubeVideoId: youtubeVideoId(providerCreativeVideoUrl(data, "youtube")) },
        },
      },
    },
    {
      assetOperation: {
        create: {
          resourceName: resourceNames.logoAsset,
          name: names.logoAsset,
          imageAsset: { data: logoBase64 },
        },
      },
    },
    {
      adGroupAdOperation: {
        create: {
          adGroup: resourceNames.adGroup,
          ad: {
            name: names.ad,
            finalUrls: [creative.destinationUrl],
            demandGenVideoResponsiveAd: {
              businessName: { text: creative.businessName.trim() },
              videos: [{ asset: resourceNames.videoAsset }],
              logoImages: [{ asset: resourceNames.logoAsset }],
              headlines: [{ text: creative.headline.trim() }],
              longHeadlines: [{ text: creative.primaryText.trim() }],
              descriptions: [{ text: creative.primaryText.trim() }],
            },
          },
        },
      },
    },
  ];
}

async function findExistingYouTubeDelivery(row, accessToken) {
  const names = googleDemandGenNames(row);
  const results = await googleSearch(
    row,
    accessToken,
    `SELECT campaign.id, campaign.resource_name, campaign_budget.resource_name,
            ad_group.resource_name, ad_group_ad.resource_name
     FROM ad_group_ad
     WHERE campaign.name = '${googleAdsQueryLiteral(names.campaign)}'
       AND ad_group.name = '${googleAdsQueryLiteral(names.adGroup)}'
       AND ad_group_ad.ad.name = '${googleAdsQueryLiteral(names.ad)}'
       AND campaign.status != 'REMOVED'
     LIMIT 1`,
    "YouTube campaign retry recovery"
  );
  const existing = results[0];
  if (!existing?.campaign?.resourceName || !existing?.adGroupAd?.resourceName) return null;
  return {
    providerCampaignId: String(existing.campaign.id || existing.campaign.resourceName.split("/").pop()),
    providerResourceName: existing.campaign.resourceName,
    providerBudgetId: existing.campaignBudget?.resourceName || null,
    receipt: {
      campaignResource: existing.campaign.resourceName,
      budgetResource: existing.campaignBudget?.resourceName || null,
      adGroupResource: existing.adGroup?.resourceName || null,
      adResource: existing.adGroupAd.resourceName,
      customerId: String(row.provider_account_id).replace(/\D/g, ""),
      youtubeVideoId: youtubeVideoId(providerCreativeVideoUrl(row.campaign_data, "youtube")),
      deliveryAdapter: "demand_gen_video",
      youtubeOnly: true,
      recovered: true,
      state: "PAUSED",
    },
  };
}

function googleBulkResource(payload, resultKey) {
  const response = (payload?.mutateOperationResponses || [])
    .find((item) => item?.[resultKey]?.resourceName);
  return response?.[resultKey]?.resourceName || "";
}

async function createYouTubeDelivery(row, accessToken) {
  if (row.provider_resource_name) {
    return {
      providerCampaignId: row.provider_campaign_id,
      providerResourceName: row.provider_resource_name,
      providerBudgetId: row.provider_budget_id,
      receipt: { ...row.receipt, state: "PAUSED" },
    };
  }
  const recovered = await findExistingYouTubeDelivery(row, accessToken);
  if (recovered) return recovered;
  const [geoTargetResources, logo] = await Promise.all([
    googleCountryTargets(row, accessToken),
    loadGoogleLogoImage(row.campaign_data?.creative?.logoUrl),
  ]);
  const customerId = String(row.provider_account_id).replace(/\D/g, "");
  const operations = googleDemandGenOperations(row, {
    logoBase64: logo.buffer.toString("base64"),
    geoTargetResources,
  });
  const { payload } = await requestJson(
    `https://googleads.googleapis.com/v24/customers/${customerId}/googleAds:mutate`,
    {
      method: "POST",
      headers: googleHeaders(accessToken),
      body: JSON.stringify({
        mutateOperations: operations,
        partialFailure: false,
        validateOnly: false,
      }),
    },
    "YouTube Demand Gen campaign creation"
  );
  const campaignResource = googleBulkResource(payload, "campaignResult");
  const budgetResource = googleBulkResource(payload, "campaignBudgetResult");
  const adGroupResource = googleBulkResource(payload, "adGroupResult");
  const adResource = googleBulkResource(payload, "adGroupAdResult");
  if (!campaignResource || !budgetResource || !adGroupResource || !adResource) {
    throw adsError(
      "Google Ads did not return the complete YouTube campaign stack.",
      502,
      "GOODADS_YOUTUBE_CREATE_INCOMPLETE"
    );
  }
  return {
    providerCampaignId: campaignResource.split("/").pop(),
    providerResourceName: campaignResource,
    providerBudgetId: budgetResource,
    receipt: {
      campaignResource,
      budgetResource,
      adGroupResource,
      adResource,
      customerId,
      youtubeVideoId: youtubeVideoId(providerCreativeVideoUrl(row.campaign_data, "youtube")),
      geoTargetResources,
      deliveryAdapter: "demand_gen_video",
      youtubeOnly: true,
      state: "PAUSED",
    },
  };
}

function tiktokRequestId(row, resource) {
  return boundedText(`goodads-${row.provider_campaign_record_id}-${resource}`, 64);
}

function tiktokCampaignPayload(row) {
  return {
    advertiser_id: boundedText(row.provider_account_id, 120),
    campaign_name: boundedText(`${row.campaign_name} [GoodAds]`, 512),
    objective_type: "TRAFFIC",
    budget_mode: "BUDGET_MODE_INFINITE",
    budget_optimize_on: false,
    operation_status: "DISABLE",
    request_id: tiktokRequestId(row, "campaign"),
  };
}

function tiktokCampaignDays(data = {}) {
  const start = new Date(`${data.startDate}T00:00:00.000Z`);
  const end = new Date(`${data.endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    throw adsError("TikTok campaign schedule is invalid.", 409, "GOODADS_TIKTOK_SCHEDULE_INVALID");
  }
  return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
}

function tiktokAdGroupPayload(row, campaignId, locationIds) {
  const data = row.campaign_data || {};
  const identityType = boundedText(row.account_metadata?.identityType, 40).toUpperCase();
  const identityAuthorizedBcId = boundedText(row.account_metadata?.identityAuthorizedBcId, 120);
  return {
    advertiser_id: boundedText(row.provider_account_id, 120),
    campaign_id: campaignId,
    adgroup_name: boundedText(`${row.campaign_name} audience [GoodAds]`, 512),
    promotion_type: "WEBSITE",
    optimization_goal: "CLICK",
    billing_event: "CPC",
    bid_type: "BID_TYPE_NO_BID",
    pacing: "PACING_MODE_SMOOTH",
    budget_mode: "BUDGET_MODE_TOTAL",
    budget: Number((Number(data.dailyBudget) * tiktokCampaignDays(data)).toFixed(2)),
    schedule_type: "SCHEDULE_START_END",
    schedule_start_time: `${data.startDate} 00:00:00`,
    schedule_end_time: `${data.endDate} 23:59:59`,
    placement_type: "PLACEMENT_TYPE_NORMAL",
    placements: ["PLACEMENT_TIKTOK"],
    brand_safety_type: "EXPANDED_INVENTORY",
    location_ids: locationIds,
    identity_id: boundedText(row.account_metadata?.identityId, 120),
    identity_type: identityType,
    ...(identityType === "BC_AUTH_TT" ? { identity_authorized_bc_id: identityAuthorizedBcId } : {}),
    operation_status: "DISABLE",
    request_id: tiktokRequestId(row, "adgroup"),
  };
}

function tiktokCallToAction(value) {
  return {
    "Shop Now": "SHOP_NOW",
    "Sign Up": "SIGN_UP",
    "Book Now": "BOOK_NOW",
    "Get Offer": "GET_OFFER",
    Download: "DOWNLOAD",
  }[value] || "LEARN_MORE";
}

function tiktokAdPayload(row, adGroupId, videoId) {
  const creative = row.campaign_data?.creative || {};
  const identityType = boundedText(row.account_metadata?.identityType, 40).toUpperCase();
  const identityAuthorizedBcId = boundedText(row.account_metadata?.identityAuthorizedBcId, 120);
  return {
    advertiser_id: boundedText(row.provider_account_id, 120),
    adgroup_id: adGroupId,
    creatives: [{
      ad_format: "SINGLE_VIDEO",
      ad_name: boundedText(`${row.campaign_name} video [GoodAds]`, 512),
      ad_text: boundedText(creative.primaryText, 100),
      call_to_action: tiktokCallToAction(creative.callToAction),
      landing_page_url: boundedText(creative.destinationUrl, 2048),
      video_id: videoId,
      identity_id: boundedText(row.account_metadata?.identityId, 120),
      identity_type: identityType,
      ...(identityType === "BC_AUTH_TT" ? { identity_authorized_bc_id: identityAuthorizedBcId } : {}),
      creative_authorized: false,
      aigc_disclosure_type: "NOT_DECLARED",
      operation_status: "DISABLE",
    }],
  };
}

function tiktokCountryLocationIds(payload, targetCountries) {
  const locations = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.location_id || value.geo_id) locations.push(value);
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") visit(nested);
    }
  };
  visit(payload?.data || {});
  const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
  const simplify = (value) => String(value || "").normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const countries = [...new Set((targetCountries || [])
    .map((country) => boundedText(country, 2).toUpperCase())
    .filter((country) => /^[A-Z]{2}$/.test(country)))];
  const ids = [];
  const missing = [];
  for (const country of countries) {
    const expectedName = simplify(displayNames.of(country));
    const match = locations.find((location) => {
      const code = boundedText(
        location.region_code || location.country_code || location.code || location.iso_code,
        2
      ).toUpperCase();
      const level = boundedText(location.level || location.geo_type, 40).toUpperCase();
      return (code === country || (!code && simplify(location.name) === expectedName))
        && (!level || level === "COUNTRY");
    });
    const id = boundedText(match?.location_id || match?.geo_id, 120);
    if (id) ids.push(id);
    else missing.push(country);
  }
  if (missing.length) {
    throw adsError(
      `TikTok Ads could not resolve country targeting for: ${missing.join(", ")}.`,
      409,
      "GOODADS_TIKTOK_COUNTRY_TARGET_INVALID"
    );
  }
  return ids;
}

async function resolveTikTokCountryLocations(row, accessToken) {
  const parameters = new URLSearchParams({
    advertiser_id: boundedText(row.provider_account_id, 120),
    placements: JSON.stringify(["PLACEMENT_TIKTOK"]),
    objective_type: "TRAFFIC",
    brand_safety_type: "EXPANDED_INVENTORY",
    level_range: "TO_COUNTRY",
  });
  const { payload } = await tiktokRequest(
    `/tool/region/?${parameters}`,
    accessToken,
    {},
    "TikTok country-target resolution"
  );
  return tiktokCountryLocationIds(payload, row.campaign_data?.targetCountries);
}

function tiktokEntityId(payload, key) {
  const id = boundedText(payload?.data?.[key], 120);
  if (!/^\d{2,30}$/.test(id)) {
    throw adsError(
      `TikTok Ads did not return a valid ${key.replaceAll("_", " ")}.`,
      502,
      "GOODADS_TIKTOK_RESPONSE_INVALID"
    );
  }
  return id;
}

async function uploadTikTokVideo(row, accessToken) {
  const videoUrl = providerCreativeVideoUrl(row.campaign_data, "tiktok");
  const form = new FormData();
  form.append("advertiser_id", boundedText(row.provider_account_id, 120));
  form.append("upload_type", "UPLOAD_BY_URL");
  form.append("video_url", videoUrl);
  form.append("file_name", boundedText(`${row.campaign_name}-${row.provider_campaign_record_id}.mp4`, 200));
  const { payload } = await tiktokRequest(
    "/file/video/ad/upload/",
    accessToken,
    { method: "POST", body: form },
    "TikTok video upload"
  );
  return tiktokEntityId(payload, "video_id");
}

async function createTikTokDelivery(row, accessToken) {
  let locationIds = Array.isArray(row.receipt?.locationIds) ? row.receipt.locationIds : [];
  if (!locationIds.length) {
    locationIds = await resolveTikTokCountryLocations(row, accessToken);
    await mergeProviderReceipt(row, { locationIds });
  }

  let videoId = boundedText(row.receipt?.videoId, 120);
  if (!videoId) {
    videoId = await uploadTikTokVideo(row, accessToken);
    await mergeProviderReceipt(row, { videoId });
  }

  let campaignId = boundedText(row.receipt?.campaignId || row.provider_campaign_id, 120);
  if (!campaignId) {
    const { payload } = await tiktokRequest(
      "/campaign/create/",
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tiktokCampaignPayload(row)),
      },
      "TikTok disabled-campaign creation"
    );
    campaignId = tiktokEntityId(payload, "campaign_id");
    await mergeProviderReceipt(
      row,
      { campaignId },
      { providerCampaignId: campaignId, providerResourceName: campaignId }
    );
  }

  let adGroupId = boundedText(row.receipt?.adGroupId || row.provider_budget_id, 120);
  if (!adGroupId) {
    const { payload } = await tiktokRequest(
      "/adgroup/create/",
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tiktokAdGroupPayload(row, campaignId, locationIds)),
      },
      "TikTok disabled-ad-group creation"
    );
    adGroupId = tiktokEntityId(payload, "adgroup_id");
    await mergeProviderReceipt(row, { adGroupId }, { providerBudgetId: adGroupId });
  }

  let adId = boundedText(row.receipt?.adId, 120);
  if (!adId) {
    const { payload } = await tiktokRequest(
      "/ad/create/",
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tiktokAdPayload(row, adGroupId, videoId)),
      },
      "TikTok disabled-ad creation"
    );
    adId = tiktokEntityId(payload, "ad_id");
    await mergeProviderReceipt(row, { adId });
  }

  return {
    providerCampaignId: campaignId,
    providerResourceName: campaignId,
    providerBudgetId: adGroupId,
    receipt: {
      ...(row.receipt || {}),
      campaignId,
      adGroupId,
      adId,
      videoId,
      locationIds,
      identityId: row.account_metadata?.identityId,
      identityType: row.account_metadata?.identityType,
      deliveryAdapter: "video",
      tiktokOnly: true,
      state: "DISABLE",
    },
  };
}

function xAdsStableName(row, resource, maximum = 255) {
  const record = boundedText(row.provider_campaign_record_id, 36).slice(0, 8);
  return boundedText(`[GoodAds ${record} ${resource}] ${row.campaign_name}`, maximum);
}

function xAdsSchedule(value, timezone, exclusiveEnd = false) {
  return zonedMidnightInstant(value, timezone, exclusiveEnd);
}

function xAdsBudget(row) {
  const data = row.campaign_data || {};
  const daily = Math.round(Number(data.dailyBudget) * 1_000_000);
  const start = new Date(`${data.startDate}T00:00:00.000Z`);
  const end = new Date(`${data.endDate}T00:00:00.000Z`);
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (!Number.isSafeInteger(daily) || daily < 1 || !Number.isInteger(days) || days < 1) {
    throw adsError("X Ads budget or schedule is invalid.", 409, "GOODADS_X_BUDGET_INVALID");
  }
  const total = daily * days;
  if (!Number.isSafeInteger(total)) throw adsError("X Ads total budget is too large.", 409, "GOODADS_X_BUDGET_INVALID");
  return { daily, total };
}

function xCampaignParameters(row) {
  const { daily, total } = xAdsBudget(row);
  return {
    funding_instrument_id: boundedText(row.account_metadata?.fundingInstrumentId, 120),
    name: xAdsStableName(row, "campaign"),
    daily_budget_amount_local_micro: daily,
    total_budget_amount_local_micro: total,
    budget_optimization: "LINE_ITEM",
    entity_status: "PAUSED",
  };
}

function xLineItemParameters(row, campaignId) {
  const { daily, total } = xAdsBudget(row);
  return {
    campaign_id: campaignId,
    name: xAdsStableName(row, "line item"),
    objective: "WEBSITE_CLICKS",
    product_type: "PROMOTED_TWEETS",
    placements: "ALL_ON_TWITTER",
    bid_strategy: "AUTO",
    goal: "LINK_CLICKS",
    entity_status: "PAUSED",
    standard_delivery: true,
    daily_budget_amount_local_micro: daily,
    total_budget_amount_local_micro: total,
    start_time: xAdsSchedule(row.campaign_data?.startDate, row.account_timezone),
    end_time: xAdsSchedule(row.campaign_data?.endDate, row.account_timezone, true),
  };
}

function xTweetParameters(row) {
  const creative = row.campaign_data?.creative || {};
  return {
    as_user_id: String(row.account_metadata?.advertiserUserId || ""),
    text: `${String(creative.primaryText || "").trim()}\n${String(creative.destinationUrl || "").trim()}`,
    name: xAdsStableName(row, "post", 80),
    nullcast: true,
    trim_user: true,
    tweet_mode: "extended",
  };
}

function xEntityId(payload, label, { array = false, tweet = false } = {}) {
  const entity = array ? payload?.data?.[0] : payload?.data;
  const id = boundedText(tweet ? entity?.id_str || entity?.tweet_id || entity?.id : entity?.id, 120);
  if (!ACCOUNT_ID_PATTERN.test(id)) {
    throw adsError(`X Ads did not return a valid ${label}.`, 502, "GOODADS_X_RESPONSE_INVALID");
  }
  return id;
}

async function findExistingXEntity(path, credentials, parameters, name) {
  const { payload } = await xAdsRequest(path, credentials, {
    parameters: { ...parameters, count: 1000 },
    fallback: "X Ads retry recovery",
  });
  return (Array.isArray(payload.data) ? payload.data : [])
    .find((item) => item.deleted !== true && String(item.name || "") === name) || null;
}

async function resolveXCountryTargets(row, credentials) {
  const targets = [];
  for (const value of row.campaign_data?.targetCountries || []) {
    const countryCode = boundedText(value, 2).toUpperCase();
    const { payload } = await xAdsRequest("/targeting_criteria/locations", credentials, {
      parameters: { country_code: countryCode, location_type: "COUNTRIES", count: 1000 },
      fallback: "X Ads country-target resolution",
    });
    const match = (Array.isArray(payload.data) ? payload.data : []).find((item) => (
      boundedText(item.country_code, 2).toUpperCase() === countryCode
      && boundedText(item.location_type, 30).toUpperCase() === "COUNTRIES"
      && boundedText(item.targeting_type, 30).toUpperCase() === "LOCATION"
    ));
    if (!match?.targeting_value) {
      throw adsError(
        `X Ads could not resolve country targeting for ${countryCode}.`,
        409,
        "GOODADS_X_COUNTRY_TARGET_INVALID"
      );
    }
    targets.push({ countryCode, targetingValue: boundedText(match.targeting_value, 120) });
  }
  return targets;
}

async function createXDelivery(row, credentials) {
  const accountId = boundedText(row.provider_account_id, 120);
  const accountPath = `/accounts/${encodeURIComponent(accountId)}`;
  let campaignId = boundedText(row.receipt?.campaignId || row.provider_campaign_id, 120);
  if (!campaignId) {
    const parameters = xCampaignParameters(row);
    const existing = await findExistingXEntity(`${accountPath}/campaigns`, credentials, {}, parameters.name);
    if (existing) campaignId = boundedText(existing.id, 120);
    else {
      const { payload } = await xAdsRequest(`${accountPath}/campaigns`, credentials, {
        method: "POST",
        parameters,
        fallback: "X Ads paused-campaign creation",
      });
      campaignId = xEntityId(payload, "campaign ID");
    }
    await mergeProviderReceipt(
      row,
      { campaignId, campaignRecovered: Boolean(existing) },
      { providerCampaignId: campaignId, providerResourceName: campaignId }
    );
  }

  let lineItemId = boundedText(row.receipt?.lineItemId || row.provider_budget_id, 120);
  if (!lineItemId) {
    const parameters = xLineItemParameters(row, campaignId);
    const existing = await findExistingXEntity(
      `${accountPath}/line_items`,
      credentials,
      { campaign_ids: campaignId },
      parameters.name
    );
    if (existing) lineItemId = boundedText(existing.id, 120);
    else {
      const { payload } = await xAdsRequest(`${accountPath}/line_items`, credentials, {
        method: "POST",
        parameters,
        fallback: "X Ads paused-line-item creation",
      });
      lineItemId = xEntityId(payload, "line-item ID");
    }
    await mergeProviderReceipt(row, { lineItemId, lineItemRecovered: Boolean(existing) }, { providerBudgetId: lineItemId });
  }

  let countryTargets = Array.isArray(row.receipt?.countryTargets) ? row.receipt.countryTargets : [];
  if (!countryTargets.length) {
    countryTargets = await resolveXCountryTargets(row, credentials);
    await mergeProviderReceipt(row, { countryTargets });
  }
  const { payload: currentTargeting } = await xAdsRequest(`${accountPath}/targeting_criteria`, credentials, {
    parameters: { line_item_ids: lineItemId, count: 1000 },
    fallback: "X Ads targeting retry recovery",
  });
  const installedTargets = Array.isArray(currentTargeting.data) ? currentTargeting.data : [];
  const targetingCriteria = Array.isArray(row.receipt?.targetingCriteria) ? [...row.receipt.targetingCriteria] : [];
  for (const target of countryTargets) {
    let criterion = installedTargets.find((item) => (
      item.deleted !== true
      && item.line_item_id === lineItemId
      && item.targeting_type === "LOCATION"
      && item.targeting_value === target.targetingValue
    ));
    if (!criterion) {
      const { payload } = await xAdsRequest(`${accountPath}/targeting_criteria`, credentials, {
        method: "POST",
        parameters: {
          line_item_id: lineItemId,
          operator_type: "EQ",
          targeting_type: "LOCATION",
          targeting_value: target.targetingValue,
        },
        fallback: "X Ads country-target creation",
      });
      criterion = payload.data;
    }
    const criterionId = boundedText(criterion?.id, 120);
    if (!ACCOUNT_ID_PATTERN.test(criterionId)) throw adsError("X Ads did not return a targeting-criterion ID.", 502, "GOODADS_X_RESPONSE_INVALID");
    if (!targetingCriteria.some((item) => item.id === criterionId)) {
      targetingCriteria.push({ ...target, id: criterionId });
      await mergeProviderReceipt(row, { targetingCriteria });
    }
  }

  let tweetId = boundedText(row.receipt?.tweetId, 120);
  if (!tweetId) {
    const parameters = xTweetParameters(row);
    const existing = await findExistingXEntity(
      `${accountPath}/tweets`,
      credentials,
      { tweet_type: "PUBLISHED", timeline_type: "NULLCAST", user_id: parameters.as_user_id },
      parameters.name
    );
    if (existing) tweetId = boundedText(existing.id_str || existing.tweet_id || existing.id, 120);
    else {
      const { payload } = await xAdsRequest(`${accountPath}/tweet`, credentials, {
        method: "POST",
        parameters,
        fallback: "X Ads promoted-only post creation",
      });
      tweetId = xEntityId(payload, "post ID", { tweet: true });
    }
    await mergeProviderReceipt(row, { tweetId, tweetRecovered: Boolean(existing) });
  }

  let promotedTweetId = boundedText(row.receipt?.promotedTweetId, 120);
  if (!promotedTweetId) {
    const { payload: promoted } = await xAdsRequest(`${accountPath}/promoted_tweets`, credentials, {
      parameters: { line_item_ids: lineItemId, count: 1000 },
      fallback: "X Ads promoted-post retry recovery",
    });
    const existing = (Array.isArray(promoted.data) ? promoted.data : []).find((item) => (
      item.deleted !== true && item.line_item_id === lineItemId && String(item.tweet_id) === tweetId
    ));
    if (existing) promotedTweetId = boundedText(existing.id, 120);
    else {
      const { payload } = await xAdsRequest(`${accountPath}/promoted_tweets`, credentials, {
        method: "POST",
        parameters: { line_item_id: lineItemId, tweet_ids: tweetId },
        fallback: "X Ads promoted-post association",
      });
      promotedTweetId = xEntityId(payload, "promoted-post ID", { array: true });
    }
    await mergeProviderReceipt(row, { promotedTweetId, promotedTweetRecovered: Boolean(existing) });
  }

  return {
    providerCampaignId: campaignId,
    providerResourceName: campaignId,
    providerBudgetId: lineItemId,
    receipt: {
      ...(row.receipt || {}),
      campaignId,
      lineItemId,
      tweetId,
      promotedTweetId,
      countryTargets,
      targetingCriteria,
      deliveryAdapter: "promoted_post",
      promotedOnly: true,
      state: "PAUSED",
    },
  };
}

function pinterestObjective(value) {
  const objective = String(value || "traffic").toLowerCase();
  return objective === "awareness"
    ? { objectiveType: "AWARENESS", billableEvent: "IMPRESSION" }
    : { objectiveType: "CONSIDERATION", billableEvent: "CLICKTHROUGH" };
}

function pinterestScheduleDate(value, timezone, exclusiveEnd = false) {
  return Math.floor(Date.parse(zonedMidnightInstant(value, timezone, exclusiveEnd)) / 1000);
}

function pinterestCampaignPayload(row) {
  const data = row.campaign_data || {};
  const { objectiveType } = pinterestObjective(data.objective);
  return {
    name: boundedText(row.campaign_name, 255),
    status: "PAUSED",
    objective_type: objectiveType,
    intended_promotion_type: "STANDARD_AD",
    daily_spend_cap: Math.round(Number(data.dailyBudget) * 1000000),
    is_campaign_budget_optimization: true,
    is_flexible_daily_budgets: false,
    is_automated_campaign: false,
    is_performance_plus: false,
    is_top_of_search: false,
    start_time: pinterestScheduleDate(data.startDate, row.account_timezone),
    end_time: pinterestScheduleDate(data.endDate, row.account_timezone, true),
  };
}

function pinterestAdGroupPayload(row, campaignId) {
  const data = row.campaign_data || {};
  const { billableEvent } = pinterestObjective(data.objective);
  const countries = [...new Set((data.targetCountries || [])
    .map((country) => boundedText(country, 2).toUpperCase())
    .filter((country) => /^[A-Z]{2}$/.test(country)))];
  return {
    name: boundedText(`${row.campaign_name} audience`, 255),
    campaign_id: campaignId,
    status: "PAUSED",
    billable_event: billableEvent,
    bid_in_micro_currency: Math.round(Math.max(Number(data.maxCpc || 1), 0.01) * 1000000),
    bid_strategy_type: "MAX_BID",
    budget_type: "DAILY",
    pacing_delivery_type: "STANDARD",
    placement_group: "ALL",
    auto_targeting_enabled: false,
    targeting_spec: { LOCATION: countries },
  };
}

function pinterestPinPayload(row) {
  const creative = row.campaign_data?.creative || {};
  return {
    link: boundedText(creative.destinationUrl, 2048),
    title: boundedText(creative.headline, 100),
    description: boundedText(creative.primaryText, 800),
    alt_text: boundedText(creative.description || creative.headline, 500),
    media_source: {
      source_type: "image_url",
      url: boundedText(creative.imageUrl, 4000),
      is_standard: true,
    },
    is_removable: true,
  };
}

function pinterestAdPayload(row, adGroupId, pinId) {
  const creative = row.campaign_data?.creative || {};
  const callToAction = {
    "Sign Up": "SIGN_UP",
    Download: "DOWNLOAD",
    "Shop Now": "SHOP_NOW",
    "Book Now": "BOOK_NOW",
    "Get Offer": "GET_OFFER",
  }[creative.callToAction] || "LEARN_MORE";
  return {
    ad_group_id: adGroupId,
    pin_id: pinId,
    name: boundedText(`${row.campaign_name} ad`, 255),
    status: "PAUSED",
    creative_type: "REGULAR",
    destination_url: boundedText(creative.destinationUrl, 2048),
    customizable_cta_type: callToAction,
    is_removable: true,
  };
}

function pinterestBatchEntity(payload, key) {
  const item = Array.isArray(payload?.items) ? payload.items[0] : null;
  const exceptions = Array.isArray(item?.exceptions) ? item.exceptions : [];
  const entity = item?.data;
  if (!entity || exceptions.length || !/^\d{2,18}$/.test(String(entity.id || ""))) {
    const message = boundedText(
      exceptions[0]?.message
        || exceptions[0]?.error_message
        || exceptions[0]?.details
        || `Pinterest did not return a valid ${key}.`,
      2000
    );
    throw adsError(message, 502, "GOODADS_PINTEREST_BATCH_FAILED", true);
  }
  return entity;
}

async function createPinterestDelivery(row, accessToken) {
  const accountId = boundedText(row.provider_account_id, 120);
  let campaignId = row.receipt?.campaignId || row.provider_campaign_id;
  if (!campaignId) {
    const { payload } = await pinterestRequest(
      `/ad_accounts/${encodeURIComponent(accountId)}/campaigns`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([pinterestCampaignPayload(row)]),
      },
      "Pinterest paused-campaign creation"
    );
    campaignId = pinterestBatchEntity(payload, "campaign").id;
    await mergeProviderReceipt(
      row,
      { campaignId },
      { providerCampaignId: campaignId, providerResourceName: campaignId }
    );
  }

  let adGroupId = row.receipt?.adGroupId || row.provider_budget_id;
  if (!adGroupId) {
    const { payload } = await pinterestRequest(
      `/ad_accounts/${encodeURIComponent(accountId)}/ad_groups`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([pinterestAdGroupPayload(row, campaignId)]),
      },
      "Pinterest paused-ad-group creation"
    );
    adGroupId = pinterestBatchEntity(payload, "ad group").id;
    await mergeProviderReceipt(row, { adGroupId }, { providerBudgetId: adGroupId });
  }

  let pinId = row.receipt?.pinId;
  if (!pinId) {
    const { payload } = await pinterestRequest(
      `/pins?ad_account_id=${encodeURIComponent(accountId)}`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pinterestPinPayload(row)),
      },
      "Pinterest ad-only Pin creation"
    );
    pinId = boundedText(payload?.id, 120);
    if (!/^\d{2,18}$/.test(pinId)) {
      throw adsError("Pinterest did not return a valid ad-only Pin ID.", 502, "GOODADS_PINTEREST_PIN_CREATE_FAILED");
    }
    await mergeProviderReceipt(row, { pinId, pinBoardId: boundedText(payload.board_id, 120) || null });
  }

  let adId = row.receipt?.adId;
  if (!adId) {
    const { payload } = await pinterestRequest(
      `/ad_accounts/${encodeURIComponent(accountId)}/ads`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([pinterestAdPayload(row, adGroupId, pinId)]),
      },
      "Pinterest paused-ad creation"
    );
    adId = pinterestBatchEntity(payload, "ad").id;
    await mergeProviderReceipt(row, { adId });
  }

  return {
    providerCampaignId: campaignId,
    providerResourceName: campaignId,
    providerBudgetId: adGroupId,
    receipt: {
      ...(row.receipt || {}),
      campaignId,
      adGroupId,
      pinId,
      adId,
      state: "PAUSED",
    },
  };
}

function linkedInObjective(value) {
  return {
    awareness: "BRAND_AWARENESS",
    engagement: "ENGAGEMENT",
    conversions: "WEBSITE_CONVERSIONS",
    sales: "WEBSITE_CONVERSIONS",
    traffic: "WEBSITE_VISITS",
  }[String(value || "").toLowerCase()] || "WEBSITE_VISITS";
}

function linkedInUrn(value, kind) {
  const decoded = decodeURIComponent(boundedText(value, 300));
  const match = decoded.match(new RegExp(`(?:urn:li:${kind}:)?(\\d+)$`));
  return match ? `urn:li:${kind}:${match[1]}` : "";
}

function linkedInResponseUrn(response, payload, kind) {
  return linkedInUrn(
    response.headers.get("x-restli-id")
      || payload?.id
      || payload?.value?.id
      || payload?.value
      || "",
    kind
  );
}

async function linkedInRequest(path, accessToken, options = {}, fallback = "LinkedIn Ads operation") {
  return requestJson(
    `https://api.linkedin.com${path}`,
    {
      ...options,
      headers: linkedInHeaders(accessToken, options.headers || {}),
    },
    fallback
  );
}

function linkedInScheduleDate(value, timezone, exclusiveEnd = false) {
  return Date.parse(zonedMidnightInstant(value, timezone, exclusiveEnd));
}

async function linkedInLocations(row, accessToken) {
  const countries = [...new Set((row.campaign_data?.targetCountries || [])
    .map((value) => boundedText(value, 2).toUpperCase())
    .filter((value) => /^[A-Z]{2}$/.test(value)))];
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const accountUrn = `urn:li:sponsoredAccount:${linkedInAccountId(row.provider_account_id)}`;
  const resolved = [];
  for (const country of countries) {
    const countryName = names.of(country);
    if (!countryName || countryName === country) {
      throw adsError(`LinkedIn targeting does not recognize country ${country}.`, 409, "GOODADS_LINKEDIN_COUNTRY_INVALID");
    }
    const parameters = new URLSearchParams({
      q: "TYPEAHEAD",
      queryVersion: "QUERY_USES_URNS",
      facet: "urn:li:adTargetingFacet:locations",
      query: countryName,
      "locale.language": "en",
      "locale.country": "US",
      lixEntity: accountUrn,
    });
    const { payload } = await linkedInRequest(
      `/rest/adTargetingEntities?${parameters}`,
      accessToken,
      {},
      "LinkedIn location targeting"
    );
    const choices = Array.isArray(payload.elements) ? payload.elements : [];
    const exact = choices.find((item) => (
      /^urn:li:geo:\d+$/.test(String(item.urn || ""))
      && boundedText(item.name, 200).toLocaleLowerCase("en") === countryName.toLocaleLowerCase("en")
    ));
    if (!exact) {
      throw adsError(
        `LinkedIn did not return an exact country target for ${countryName}.`,
        409,
        "GOODADS_LINKEDIN_COUNTRY_UNRESOLVED"
      );
    }
    resolved.push(exact.urn);
  }
  return resolved;
}

function linkedInCampaignPayload(row, { campaignGroupUrn, locationUrns }) {
  const data = row.campaign_data || {};
  const currency = boundedText(row.account_currency, 12).toUpperCase();
  const country = boundedText(data.targetCountries?.[0] || "US", 2).toUpperCase();
  const language = /^[a-z]{2}$/.test(String(data.language || "").toLowerCase())
    ? String(data.language).toLowerCase()
    : "en";
  return {
    account: `urn:li:sponsoredAccount:${linkedInAccountId(row.provider_account_id)}`,
    associatedEntity: boundedText(row.account_metadata?.organizationUrn, 200),
    campaignGroup: campaignGroupUrn,
    audienceExpansionEnabled: false,
    connectedTelevisionOnly: false,
    costType: "CPC",
    creativeSelection: "OPTIMIZED",
    dailyBudget: { amount: Number(data.dailyBudget).toFixed(2), currencyCode: currency },
    locale: { country, language },
    name: boundedText(row.campaign_name, 200),
    objectiveType: linkedInObjective(data.objective),
    offsiteDeliveryEnabled: false,
    politicalIntent: linkedInPolicyCompliance(data),
    runSchedule: {
      start: linkedInScheduleDate(data.startDate, row.account_timezone),
      end: linkedInScheduleDate(data.endDate, row.account_timezone, true),
    },
    targetingCriteria: {
      include: {
        and: [{
          or: { "urn:li:adTargetingFacet:locations": locationUrns },
        }],
      },
    },
    type: "SPONSORED_UPDATES",
    unitCost: {
      amount: Math.max(Number(data.maxCpc || 1), 0.01).toFixed(2),
      currencyCode: currency,
    },
    status: "PAUSED",
  };
}

function linkedInCreativePayload(row, { campaignUrn, imageUrn, organizationUrn }) {
  const creative = row.campaign_data?.creative || {};
  const callToAction = {
    "Sign Up": "SIGN_UP",
    Download: "DOWNLOAD",
    "Shop Now": "SHOP_NOW",
    "Get Offer": "GET_OFFER",
  }[creative.callToAction] || "LEARN_MORE";
  return {
    creative: {
      inlineContent: {
        post: {
          adContext: {
            dscAdAccount: `urn:li:sponsoredAccount:${linkedInAccountId(row.provider_account_id)}`,
            dscStatus: "ACTIVE",
          },
          author: organizationUrn,
          commentary: boundedText(creative.primaryText, 600),
          visibility: "PUBLIC",
          distribution: {
            feedDistribution: "NONE",
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
          contentCallToActionLabel: callToAction,
          contentLandingPage: creative.destinationUrl,
          content: {
            article: {
              source: creative.destinationUrl,
              thumbnail: imageUrn,
              title: boundedText(creative.headline, 200),
              description: boundedText(creative.description || creative.primaryText, 300),
            },
          },
        },
      },
      campaign: campaignUrn,
      intendedStatus: "DRAFT",
      name: boundedText(`${row.campaign_name} creative`, 200),
    },
  };
}

async function readBoundedBody(
  response,
  maximumBytes,
  message = "LinkedIn creative image exceeds 10 MB.",
  code = "GOODADS_LINKEDIN_IMAGE_TOO_LARGE"
) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maximumBytes) throw adsError(message, 413, code);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel().catch(() => {});
      throw adsError(message, 413, code);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function loadLinkedInCreativeImage(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw adsError("LinkedIn creative image URL is invalid.", 409, "GOODADS_LINKEDIN_IMAGE_INVALID");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || (hostname !== "goodos.app" && !hostname.endsWith(".goodos.app"))
  ) {
    throw adsError(
      "LinkedIn creative images must be stored on a managed GoodOS HTTPS address.",
      409,
      "GOODADS_LINKEDIN_IMAGE_HOST_INVALID"
    );
  }
  let response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
  } catch {
    throw adsError("LinkedIn creative image could not be downloaded.", 502, "GOODADS_LINKEDIN_IMAGE_DOWNLOAD_FAILED", true);
  }
  if (!response.ok) {
    throw adsError("LinkedIn creative image could not be downloaded.", 502, "GOODADS_LINKEDIN_IMAGE_DOWNLOAD_FAILED", response.status >= 500);
  }
  const mimeType = boundedText(response.headers.get("content-type"), 100).split(";")[0].toLowerCase();
  if (!LINKEDIN_IMAGE_MIME_TYPES.has(mimeType)) {
    throw adsError("LinkedIn creative image must be JPEG, PNG, or GIF.", 409, "GOODADS_LINKEDIN_IMAGE_TYPE_INVALID");
  }
  const buffer = await readBoundedBody(response, MAX_LINKEDIN_IMAGE_BYTES);
  if (!buffer.length) throw adsError("LinkedIn creative image is empty.", 409, "GOODADS_LINKEDIN_IMAGE_EMPTY");
  return { buffer, mimeType };
}

async function mergeProviderReceipt(row, patch, fields = {}) {
  await query(
    `UPDATE goodads_provider_campaigns
     SET provider_campaign_id = COALESCE($2, provider_campaign_id),
         provider_resource_name = COALESCE($3, provider_resource_name),
         provider_budget_id = COALESCE($4, provider_budget_id),
         receipt = receipt || $5::jsonb, updated_at = NOW()
     WHERE id = $1::uuid`,
    [
      row.provider_campaign_record_id,
      fields.providerCampaignId || null,
      fields.providerResourceName || null,
      fields.providerBudgetId || null,
      JSON.stringify(patch),
    ]
  );
  row.receipt = { ...(row.receipt || {}), ...patch };
  if (fields.providerCampaignId) row.provider_campaign_id = fields.providerCampaignId;
  if (fields.providerResourceName) row.provider_resource_name = fields.providerResourceName;
  if (fields.providerBudgetId) row.provider_budget_id = fields.providerBudgetId;
}

async function ensureLinkedInImage(row, accessToken, organizationUrn) {
  let imageUrn = row.receipt?.imageUrn;
  if (!imageUrn) {
    const accountUrn = `urn:li:sponsoredAccount:${linkedInAccountId(row.provider_account_id)}`;
    const { buffer, mimeType } = await loadLinkedInCreativeImage(row.campaign_data?.creative?.imageUrl);
    const { payload } = await linkedInRequest(
      "/rest/images?action=initializeUpload",
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          initializeUploadRequest: {
            owner: organizationUrn,
            mediaLibraryMetadata: {
              associatedAccount: accountUrn,
              assetName: boundedText(`${row.campaign_name} creative`, 200),
            },
          },
        }),
      },
      "LinkedIn image initialization"
    );
    imageUrn = boundedText(payload?.value?.image, 300);
    const uploadUrl = boundedText(payload?.value?.uploadUrl, 4000);
    if (!/^urn:li:image:[A-Za-z0-9_-]+$/.test(imageUrn) || !uploadUrl.startsWith("https://")) {
      throw adsError("LinkedIn did not return a valid image upload target.", 502, "GOODADS_LINKEDIN_IMAGE_INIT_FAILED");
    }
    let uploadResponse;
    try {
      uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        redirect: "error",
        headers: { "Content-Type": mimeType, "Content-Length": String(buffer.length) },
        body: buffer,
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw adsError("LinkedIn image upload could not be completed.", 502, "GOODADS_LINKEDIN_IMAGE_UPLOAD_FAILED", true);
    }
    if (!uploadResponse.ok) {
      throw adsError("LinkedIn rejected the creative image upload.", 502, "GOODADS_LINKEDIN_IMAGE_UPLOAD_FAILED", uploadResponse.status >= 500);
    }
    await mergeProviderReceipt(row, { imageUrn });
  }
  const { payload: image } = await linkedInRequest(
    `/rest/images/${encodeURIComponent(imageUrn)}`,
    accessToken,
    {},
    "LinkedIn image status"
  );
  if (String(image.status || "").toUpperCase() !== "AVAILABLE") {
    throw adsError("LinkedIn is still processing the creative image.", 409, "GOODADS_LINKEDIN_IMAGE_PROCESSING", true);
  }
  return imageUrn;
}

async function createLinkedInDelivery(row, accessToken) {
  const data = row.campaign_data || {};
  const organizationUrn = boundedText(row.account_metadata?.organizationUrn, 200);
  if (!/^urn:li:organization:\d+$/.test(organizationUrn)) {
    throw adsError("LinkedIn organization ownership is missing from this ad account.", 409, "GOODADS_LINKEDIN_ORGANIZATION_REQUIRED");
  }
  const accountId = linkedInAccountId(row.provider_account_id);
  const accountUrn = `urn:li:sponsoredAccount:${accountId}`;
  let campaignGroupUrn = row.receipt?.campaignGroupUrn || row.provider_budget_id;
  if (!campaignGroupUrn) {
    const { response, payload } = await linkedInRequest(
      `/rest/adAccounts/${encodeURIComponent(accountId)}/adCampaignGroups`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: accountUrn,
          name: boundedText(`${row.campaign_name} group`, 200),
          runSchedule: {
            start: linkedInScheduleDate(data.startDate, row.account_timezone),
            end: linkedInScheduleDate(data.endDate, row.account_timezone, true),
          },
          status: "ACTIVE",
        }),
      },
      "LinkedIn campaign-group creation"
    );
    campaignGroupUrn = linkedInResponseUrn(response, payload, "sponsoredCampaignGroup");
    if (!campaignGroupUrn) throw adsError("LinkedIn did not return a campaign-group ID.", 502, "GOODADS_LINKEDIN_GROUP_CREATE_FAILED");
    await mergeProviderReceipt(row, { campaignGroupUrn }, { providerBudgetId: campaignGroupUrn });
  }
  let campaignUrn = row.receipt?.campaignUrn || row.provider_resource_name;
  if (!campaignUrn) {
    const locationUrns = await linkedInLocations(row, accessToken);
    const campaignBody = linkedInCampaignPayload(row, { campaignGroupUrn, locationUrns });
    const { response, payload } = await linkedInRequest(
      `/rest/adAccounts/${encodeURIComponent(accountId)}/adCampaigns`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(campaignBody),
      },
      "LinkedIn paused-campaign creation"
    );
    campaignUrn = linkedInResponseUrn(response, payload, "sponsoredCampaign");
    if (!campaignUrn) throw adsError("LinkedIn did not return a campaign ID.", 502, "GOODADS_LINKEDIN_CAMPAIGN_CREATE_FAILED");
    await mergeProviderReceipt(
      row,
      { campaignUrn, locationUrns, politicalIntent: campaignBody.politicalIntent },
      {
        providerCampaignId: campaignUrn.split(":").pop(),
        providerResourceName: campaignUrn,
      }
    );
  }
  const imageUrn = await ensureLinkedInImage(row, accessToken, organizationUrn);
  let creativeUrn = row.receipt?.creativeUrn;
  if (!creativeUrn) {
    const creativeBody = linkedInCreativePayload(row, { campaignUrn, imageUrn, organizationUrn });
    const { response, payload } = await linkedInRequest(
      `/rest/adAccounts/${encodeURIComponent(accountId)}/creatives?action=createInline`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creativeBody),
      },
      "LinkedIn draft-creative creation"
    );
    creativeUrn = linkedInResponseUrn(response, payload, "sponsoredCreative");
    if (!creativeUrn) throw adsError("LinkedIn did not return a creative ID.", 502, "GOODADS_LINKEDIN_CREATIVE_CREATE_FAILED");
    await mergeProviderReceipt(row, { creativeUrn });
  }
  return {
    providerCampaignId: campaignUrn.split(":").pop(),
    providerResourceName: campaignUrn,
    providerBudgetId: campaignGroupUrn,
    receipt: {
      ...(row.receipt || {}),
      campaignGroupUrn,
      campaignUrn,
      creativeUrn,
      imageUrn,
      accountUrn,
      organizationUrn,
      state: "PAUSED",
      politicalIntent: linkedInPolicyCompliance(data),
      activationSupported: true,
    },
  };
}

async function updateLinkedInStatus(row, accessToken, status) {
  if (status === "ACTIVE") linkedInPolicyCompliance(row.campaign_data || {});
  const accountId = linkedInAccountId(row.provider_account_id);
  const campaignId = linkedInNumericId(row.provider_campaign_id || row.provider_resource_name);
  if (!campaignId) throw adsError("LinkedIn campaign ID is invalid.", 409, "GOODADS_LINKEDIN_CAMPAIGN_ID_INVALID");
  if (status === "ACTIVE") {
    const creativeUrn = boundedText(row.receipt?.creativeUrn, 300);
    if (!/^urn:li:sponsoredCreative:\d+$/.test(creativeUrn)) {
      throw adsError(
        "LinkedIn activation requires the exact draft creative created with this campaign.",
        409,
        "GOODADS_LINKEDIN_CREATIVE_REQUIRED"
      );
    }
    await linkedInRequest(
      `/rest/adAccounts/${encodeURIComponent(accountId)}/creatives/${encodeURIComponent(creativeUrn)}`,
      accessToken,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-RestLi-Method": "PARTIAL_UPDATE",
        },
        body: JSON.stringify({ patch: { $set: { intendedStatus: "ACTIVE" } } }),
      },
      "LinkedIn creative activation"
    );
  }
  await linkedInRequest(
    `/rest/adAccounts/${encodeURIComponent(accountId)}/adCampaigns/${encodeURIComponent(campaignId)}`,
    accessToken,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-RestLi-Method": "PARTIAL_UPDATE",
      },
      body: JSON.stringify({ patch: { $set: { status } } }),
    },
    "LinkedIn campaign status update"
  );
  return {
    ...row.receipt,
    creativeIntendedStatus: status === "ACTIVE" ? "ACTIVE" : row.receipt?.creativeIntendedStatus || "DRAFT",
    state: status,
  };
}

async function syncLinkedInStatus(row, accessToken) {
  const accountId = linkedInAccountId(row.provider_account_id);
  const campaignId = linkedInNumericId(row.provider_campaign_id || row.provider_resource_name);
  if (!campaignId) throw adsError("LinkedIn campaign ID is invalid.", 409, "GOODADS_LINKEDIN_CAMPAIGN_ID_INVALID");
  const { payload } = await linkedInRequest(
    `/rest/adAccounts/${encodeURIComponent(accountId)}/adCampaigns/${encodeURIComponent(campaignId)}`,
    accessToken,
    {},
    "LinkedIn campaign status"
  );
  const providerStatus = boundedText(payload.status, 40).toUpperCase();
  const status = providerStatus === "ACTIVE"
    ? "active"
    : ["ARCHIVED", "CANCELED", "PENDING_DELETION", "REMOVED"].includes(providerStatus)
      ? "archived"
      : ["DRAFT", "PAUSED", "COMPLETED"].includes(providerStatus)
        ? "paused"
        : row.status;
  return { receipt: { ...row.receipt, providerStatus, state: providerStatus }, status };
}

function snapchatObjective(value) {
  const objective = String(value || "traffic").toLowerCase();
  if (objective === "awareness") {
    return { objectiveV2Type: "AWARENESS_AND_ENGAGEMENT", optimizationGoal: "IMPRESSIONS" };
  }
  if (objective === "engagement") {
    return { objectiveV2Type: "AWARENESS_AND_ENGAGEMENT", optimizationGoal: "SWIPES" };
  }
  return { objectiveV2Type: "TRAFFIC", optimizationGoal: "SWIPES" };
}

function snapchatScheduleDate(value, timezone, exclusiveEnd = false) {
  return zonedMidnightInstant(value, timezone, exclusiveEnd);
}

function snapchatCampaignPayload(row) {
  const data = row.campaign_data || {};
  const { objectiveV2Type } = snapchatObjective(data.objective);
  return {
    ad_account_id: boundedText(row.provider_account_id, 120),
    name: boundedText(row.campaign_name, 375),
    status: "PAUSED",
    buy_model: "AUCTION",
    start_time: snapchatScheduleDate(data.startDate, row.account_timezone),
    end_time: snapchatScheduleDate(data.endDate, row.account_timezone, true),
    objective_v2_properties: { objective_v2_type: objectiveV2Type },
  };
}

function snapchatAdSquadPayload(row, campaignId) {
  const data = row.campaign_data || {};
  const { optimizationGoal } = snapchatObjective(data.objective);
  const countries = [...new Set((data.targetCountries || [])
    .map((country) => boundedText(country, 2).toLowerCase())
    .filter((country) => /^[a-z]{2}$/.test(country)))];
  return {
    campaign_id: campaignId,
    name: boundedText(`${row.campaign_name} audience`, 375),
    status: "PAUSED",
    type: "SNAP_ADS",
    placement_v2: { config: "AUTOMATIC" },
    billing_event: "IMPRESSION",
    bid_strategy: "AUTO_BID",
    daily_budget_micro: Math.round(Number(data.dailyBudget) * 1000000),
    start_time: snapchatScheduleDate(data.startDate, row.account_timezone),
    end_time: snapchatScheduleDate(data.endDate, row.account_timezone, true),
    optimization_goal: optimizationGoal,
    conversion_window: "SWIPE_28DAY_VIEW_1DAY",
    delivery_constraint: "DAILY_BUDGET",
    pacing_type: "STANDARD",
    targeting: {
      regulated_content: false,
      geos: countries.map((country_code) => ({ country_code })),
    },
  };
}

function snapchatCreativePayload(row, mediaId) {
  const creative = row.campaign_data?.creative || {};
  const callToAction = {
    "Sign Up": "SIGN_UP",
    Download: "DOWNLOAD",
    "Shop Now": "SHOP_NOW",
    "Book Now": "BOOK_NOW",
    "Get Offer": "GET_OFFER",
  }[creative.callToAction] || "LEARN_MORE";
  return {
    ad_account_id: boundedText(row.provider_account_id, 120),
    name: boundedText(`${row.campaign_name} creative`, 375),
    type: "WEB_VIEW",
    brand_name: boundedText(row.account_metadata?.profileName || "GoodAds", 32),
    headline: boundedText(creative.headline, 34),
    call_to_action: callToAction,
    shareable: true,
    forced_view_eligibility: "NONE",
    top_snap_media_id: mediaId,
    top_snap_crop_position: "OPTIMIZED",
    web_view_properties: {
      url: boundedText(creative.destinationUrl, 2048),
      block_preload: false,
    },
    profile_properties: { profile_id: boundedText(row.account_metadata?.profileId, 120) },
  };
}

function snapchatAdPayload(row, adSquadId, creativeId) {
  return {
    ad_squad_id: adSquadId,
    creative_id: creativeId,
    name: boundedText(`${row.campaign_name} ad`, 375),
    type: "REMOTE_WEBPAGE",
    status: "PAUSED",
  };
}

function snapchatMediaSource(row) {
  const creative = row.campaign_data?.creative || {};
  const candidates = [creative.videoUrl, creative.imageUrl].filter(Boolean);
  const url = candidates.find(isManagedGoodOsHttpsUrl) || candidates[0];
  if (!isManagedGoodOsHttpsUrl(url)) {
    throw adsError(
      "Snapchat creative media must be stored on a managed GoodOS HTTPS address.",
      409,
      "GOODADS_SNAPCHAT_MEDIA_HOST_INVALID"
    );
  }
  return url;
}

function validSnapchatMediaSignature(buffer, mimeType) {
  if (mimeType === "image/jpeg") return buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (mimeType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
}

async function loadSnapchatMedia(row) {
  const url = snapchatMediaSource(row);
  let response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
  } catch {
    throw adsError("Snapchat creative media could not be downloaded.", 502, "GOODADS_SNAPCHAT_MEDIA_DOWNLOAD_FAILED", true);
  }
  if (!response.ok) {
    throw adsError(
      "Snapchat creative media could not be downloaded.",
      502,
      "GOODADS_SNAPCHAT_MEDIA_DOWNLOAD_FAILED",
      response.status >= 500
    );
  }
  const mimeType = boundedText(response.headers.get("content-type"), 100).split(";")[0].toLowerCase();
  const mediaType = SNAPCHAT_MEDIA_TYPES[mimeType];
  if (!mediaType) {
    throw adsError(
      "Snapchat creative media must be JPEG, PNG, MP4, or MOV.",
      409,
      "GOODADS_SNAPCHAT_MEDIA_TYPE_INVALID"
    );
  }
  const buffer = await readBoundedBody(
    response,
    mediaType.maximumBytes,
    `Snapchat ${mediaType.type.toLowerCase()} exceeds the direct-upload size limit.`,
    "GOODADS_SNAPCHAT_MEDIA_TOO_LARGE"
  );
  if (!buffer.length || !validSnapchatMediaSignature(buffer, mimeType)) {
    throw adsError("Snapchat creative media content is invalid.", 409, "GOODADS_SNAPCHAT_MEDIA_CONTENT_INVALID");
  }
  return {
    buffer,
    mimeType,
    mediaType: mediaType.type,
    filename: `goodads-${crypto.randomUUID()}.${mediaType.extension}`,
  };
}

async function getSnapchatMedia(mediaId, accessToken) {
  const { payload } = await snapchatRequest(
    `/v1/media/${encodeURIComponent(mediaId)}`,
    accessToken,
    {},
    "Snapchat media status"
  );
  return snapchatEntity(payload, "media", "media");
}

async function ensureSnapchatMedia(row, accessToken) {
  const accountId = boundedText(row.provider_account_id, 120);
  let mediaId = row.receipt?.mediaId;
  let loaded;
  if (!mediaId) {
    loaded = await loadSnapchatMedia(row);
    const { payload } = await snapchatRequest(
      `/v1/adaccounts/${encodeURIComponent(accountId)}/media`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media: [{
            name: boundedText(`${row.campaign_name} media`, 375),
            type: loaded.mediaType,
            ad_account_id: accountId,
          }],
        }),
      },
      "Snapchat media creation"
    );
    const media = snapchatEntity(payload, "media", "media");
    mediaId = media.id;
    await mergeProviderReceipt(row, { mediaId, mediaType: loaded.mediaType, mediaUploadSubmitted: false });
  }

  let media = await getSnapchatMedia(mediaId, accessToken);
  let mediaStatus = boundedText(media.media_status, 40).toUpperCase();
  if (mediaStatus === "READY") return mediaId;
  if (row.receipt?.mediaUploadSubmitted || ["PROCESSING", "UPLOADED"].includes(mediaStatus)) {
    throw adsError("Snapchat is still processing the creative media.", 409, "GOODADS_SNAPCHAT_MEDIA_PROCESSING", true);
  }

  loaded ||= await loadSnapchatMedia(row);
  const form = new FormData();
  form.append("file", new Blob([loaded.buffer], { type: loaded.mimeType }), loaded.filename);
  const { payload: uploadPayload } = await snapchatRequest(
    `/v1/media/${encodeURIComponent(mediaId)}/upload`,
    accessToken,
    { method: "POST", body: form },
    "Snapchat media upload"
  );
  media = uploadPayload?.result || {};
  if (!UUID_PATTERN.test(String(media.id || "")) || media.id !== mediaId) {
    throw adsError("Snapchat did not confirm the media upload.", 502, "GOODADS_SNAPCHAT_MEDIA_UPLOAD_FAILED", true);
  }
  mediaStatus = boundedText(media.media_status, 40).toUpperCase();
  await mergeProviderReceipt(row, { mediaUploadSubmitted: true, mediaStatus: mediaStatus || "PROCESSING" });
  if (mediaStatus !== "READY") {
    throw adsError("Snapchat is still processing the creative media.", 409, "GOODADS_SNAPCHAT_MEDIA_PROCESSING", true);
  }
  return mediaId;
}

async function createSnapchatDelivery(row, accessToken) {
  const accountId = boundedText(row.provider_account_id, 120);
  const mediaId = await ensureSnapchatMedia(row, accessToken);

  let creativeId = row.receipt?.creativeId;
  if (!creativeId) {
    const { payload } = await snapchatRequest(
      `/v1/adaccounts/${encodeURIComponent(accountId)}/creatives`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creatives: [snapchatCreativePayload(row, mediaId)] }),
      },
      "Snapchat creative creation"
    );
    creativeId = snapchatEntity(payload, "creatives", "creative").id;
    await mergeProviderReceipt(row, { creativeId });
  }

  let campaignId = row.receipt?.campaignId || row.provider_campaign_id;
  if (!campaignId) {
    const { payload } = await snapchatRequest(
      `/v1/adaccounts/${encodeURIComponent(accountId)}/campaigns`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaigns: [snapchatCampaignPayload(row)] }),
      },
      "Snapchat paused-campaign creation"
    );
    campaignId = snapchatEntity(payload, "campaigns", "campaign").id;
    await mergeProviderReceipt(
      row,
      { campaignId },
      { providerCampaignId: campaignId, providerResourceName: campaignId }
    );
  }

  let adSquadId = row.receipt?.adSquadId || row.provider_budget_id;
  if (!adSquadId) {
    const { payload } = await snapchatRequest(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/adsquads`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adsquads: [snapchatAdSquadPayload(row, campaignId)] }),
      },
      "Snapchat paused-ad-squad creation"
    );
    adSquadId = snapchatEntity(payload, "adsquads", "adsquad").id;
    await mergeProviderReceipt(row, { adSquadId }, { providerBudgetId: adSquadId });
  }

  let adId = row.receipt?.adId;
  if (!adId) {
    const { payload } = await snapchatRequest(
      `/v1/adsquads/${encodeURIComponent(adSquadId)}/ads`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ads: [snapchatAdPayload(row, adSquadId, creativeId)] }),
      },
      "Snapchat paused-ad creation"
    );
    adId = snapchatEntity(payload, "ads", "ad").id;
    await mergeProviderReceipt(row, { adId });
  }

  return {
    providerCampaignId: campaignId,
    providerResourceName: campaignId,
    providerBudgetId: adSquadId,
    receipt: {
      ...(row.receipt || {}),
      mediaId,
      creativeId,
      campaignId,
      adSquadId,
      adId,
      profileId: row.account_metadata?.profileId,
      state: "PAUSED",
    },
  };
}

async function patchSnapchatStatus(path, collection, key, accessToken, status) {
  const { payload } = await snapchatRequest(
    path,
    accessToken,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json-patch+json" },
      body: JSON.stringify([{ op: "replace", path: "/status", value: status }]),
    },
    "Snapchat campaign status update"
  );
  return snapchatEntity(payload, collection, key);
}

async function updateSnapchatStatus(row, accessToken, requestedStatus) {
  const accountId = boundedText(row.provider_account_id, 120);
  const campaignId = boundedText(row.provider_campaign_id || row.receipt?.campaignId, 120);
  const adSquadId = boundedText(row.receipt?.adSquadId || row.provider_budget_id, 120);
  const adId = boundedText(row.receipt?.adId, 120);
  if (![campaignId, adSquadId, adId].every((id) => UUID_PATTERN.test(id))) {
    throw adsError("Snapchat campaign resources are incomplete.", 409, "GOODADS_SNAPCHAT_RESOURCES_INCOMPLETE");
  }
  const status = requestedStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const campaignPath = `/v1/adaccounts/${encodeURIComponent(accountId)}/campaigns/${encodeURIComponent(campaignId)}`;
  const adSquadPath = `/v1/campaigns/${encodeURIComponent(campaignId)}/adsquads/${encodeURIComponent(adSquadId)}`;
  const adPath = `/v1/adsquads/${encodeURIComponent(adSquadId)}/ads/${encodeURIComponent(adId)}`;
  if (status === "ACTIVE") {
    await patchSnapchatStatus(adPath, "ads", "ad", accessToken, status);
    await patchSnapchatStatus(adSquadPath, "adsquads", "adsquad", accessToken, status);
    await patchSnapchatStatus(campaignPath, "campaigns", "campaign", accessToken, status);
  } else {
    await patchSnapchatStatus(campaignPath, "campaigns", "campaign", accessToken, status);
    await patchSnapchatStatus(adSquadPath, "adsquads", "adsquad", accessToken, status);
    await patchSnapchatStatus(adPath, "ads", "ad", accessToken, status);
  }
  return {
    ...row.receipt,
    state: status,
    ...(requestedStatus === "ARCHIVED"
      ? { remoteArchived: false, remoteArchiveState: "PAUSED", archivedAt: new Date().toISOString() }
      : {}),
  };
}

async function syncSnapchatStatus(row, accessToken) {
  const campaignId = boundedText(row.provider_campaign_id || row.receipt?.campaignId, 120);
  if (!UUID_PATTERN.test(campaignId)) {
    throw adsError("Snapchat campaign ID is invalid.", 409, "GOODADS_SNAPCHAT_CAMPAIGN_ID_INVALID");
  }
  const { payload } = await snapchatRequest(
    `/v1/campaigns/${encodeURIComponent(campaignId)}`,
    accessToken,
    {},
    "Snapchat campaign status"
  );
  const campaign = snapchatEntity(payload, "campaigns", "campaign");
  const providerStatus = boundedText(campaign.status, 40).toUpperCase();
  const status = providerStatus === "ACTIVE"
    ? "active"
    : campaign.deleted === true || (providerStatus === "PAUSED" && row.receipt?.archivedAt)
      ? "archived"
      : providerStatus === "PAUSED"
        ? "paused"
        : row.status;
  return { receipt: { ...row.receipt, providerStatus, state: providerStatus }, status };
}

async function updateTikTokEntityStatus(path, body, accessToken, fallback) {
  await tiktokRequest(
    path,
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    fallback
  );
}

async function updateTikTokStatus(row, accessToken, requestedStatus) {
  const advertiserId = boundedText(row.provider_account_id, 120);
  const campaignId = boundedText(row.provider_campaign_id || row.receipt?.campaignId, 120);
  const adGroupId = boundedText(row.receipt?.adGroupId || row.provider_budget_id, 120);
  const adId = boundedText(row.receipt?.adId, 120);
  if (![advertiserId, campaignId, adGroupId, adId].every((id) => /^\d{2,30}$/.test(id))) {
    throw adsError("TikTok campaign resources are incomplete.", 409, "GOODADS_TIKTOK_RESOURCES_INCOMPLETE");
  }
  const campaign = () => updateTikTokEntityStatus(
    "/campaign/status/update/",
    { advertiser_id: advertiserId, campaign_ids: [campaignId], operation_status: requestedStatus },
    accessToken,
    "TikTok campaign status update"
  );
  const adGroup = () => updateTikTokEntityStatus(
    "/adgroup/status/update/",
    { advertiser_id: advertiserId, adgroup_ids: [adGroupId], operation_status: requestedStatus },
    accessToken,
    "TikTok ad-group status update"
  );
  const ad = () => updateTikTokEntityStatus(
    "/ad/status/update/",
    { advertiser_id: advertiserId, ad_ids: [adId], operation_status: requestedStatus },
    accessToken,
    "TikTok ad status update"
  );
  if (requestedStatus === "ENABLE") {
    await ad();
    await adGroup();
    await campaign();
  } else if (requestedStatus === "DELETE") {
    await ad();
    await adGroup();
    await campaign();
  } else {
    await campaign();
    await adGroup();
    await ad();
  }
  return {
    ...row.receipt,
    state: requestedStatus,
    ...(requestedStatus === "DELETE" ? { remoteArchived: true, archivedAt: new Date().toISOString() } : {}),
  };
}

async function syncTikTokStatus(row, accessToken) {
  const advertiserId = boundedText(row.provider_account_id, 120);
  const campaignId = boundedText(row.provider_campaign_id || row.receipt?.campaignId, 120);
  if (![advertiserId, campaignId].every((id) => /^\d{2,30}$/.test(id))) {
    throw adsError("TikTok campaign ID is invalid.", 409, "GOODADS_TIKTOK_CAMPAIGN_ID_INVALID");
  }
  const parameters = new URLSearchParams({
    advertiser_id: advertiserId,
    filtering: JSON.stringify({ campaign_ids: [campaignId] }),
    fields: JSON.stringify(["campaign_id", "operation_status", "secondary_status"]),
    page: "1",
    page_size: "1",
  });
  const { payload } = await tiktokRequest(
    `/campaign/get/?${parameters}`,
    accessToken,
    {},
    "TikTok campaign status"
  );
  const campaign = Array.isArray(payload.data?.list) ? payload.data.list[0] : null;
  if (!campaign || String(campaign.campaign_id) !== campaignId) {
    throw adsError("TikTok Ads did not return this campaign.", 502, "GOODADS_TIKTOK_CAMPAIGN_NOT_FOUND");
  }
  const operationStatus = boundedText(campaign.operation_status, 60).toUpperCase();
  const secondaryStatus = boundedText(campaign.secondary_status, 100).toUpperCase();
  const status = operationStatus === "ENABLE" || secondaryStatus === "CAMPAIGN_STATUS_ENABLE"
    ? "active"
    : operationStatus === "DELETE" || secondaryStatus.includes("DELETE")
      ? "archived"
      : operationStatus === "DISABLE" || secondaryStatus.includes("DISABLE")
        ? "paused"
        : row.status;
  const providerStatus = secondaryStatus || operationStatus;
  return { receipt: { ...row.receipt, providerStatus, state: operationStatus || providerStatus }, status };
}

async function updateXStatus(row, credentials, requestedStatus) {
  const accountId = boundedText(row.provider_account_id, 120);
  const campaignId = boundedText(row.provider_campaign_id || row.receipt?.campaignId, 120);
  const lineItemId = boundedText(row.receipt?.lineItemId || row.provider_budget_id, 120);
  if (![accountId, campaignId, lineItemId].every((id) => ACCOUNT_ID_PATTERN.test(id))) {
    throw adsError("X Ads campaign resources are incomplete.", 409, "GOODADS_X_RESOURCES_INCOMPLETE");
  }
  const accountPath = `/accounts/${encodeURIComponent(accountId)}`;
  const setCampaign = (status) => xAdsRequest(`${accountPath}/campaigns/${encodeURIComponent(campaignId)}`, credentials, {
    method: "PUT",
    parameters: { entity_status: status },
    fallback: "X Ads campaign status update",
  });
  const setLineItem = (status) => xAdsRequest(`${accountPath}/line_items/${encodeURIComponent(lineItemId)}`, credentials, {
    method: "PUT",
    parameters: { entity_status: status },
    fallback: "X Ads line-item status update",
  });
  if (requestedStatus === "ACTIVE") {
    const promotedTweetId = boundedText(row.receipt?.promotedTweetId, 120);
    if (!ACCOUNT_ID_PATTERN.test(promotedTweetId)) {
      throw adsError("X Ads promoted-post approval cannot be verified.", 409, "GOODADS_X_CREATIVE_NOT_APPROVED");
    }
    const { payload } = await xAdsRequest(
      `${accountPath}/promoted_tweets/${encodeURIComponent(promotedTweetId)}`,
      credentials,
      { fallback: "X Ads promoted-post approval verification" }
    );
    if (payload.data?.deleted === true || boundedText(payload.data?.approval_status, 40).toUpperCase() !== "ACCEPTED") {
      throw adsError(
        "X Ads has not approved the promoted post. The campaign remains paused.",
        409,
        "GOODADS_X_CREATIVE_NOT_APPROVED"
      );
    }
    await setLineItem("ACTIVE");
    await setCampaign("ACTIVE");
  } else {
    await setCampaign("PAUSED");
    await setLineItem("PAUSED");
  }
  if (requestedStatus === "ARCHIVED") {
    const promotedTweetId = boundedText(row.receipt?.promotedTweetId, 120);
    if (promotedTweetId) {
      await xAdsRequest(`${accountPath}/promoted_tweets/${encodeURIComponent(promotedTweetId)}`, credentials, {
        method: "DELETE",
        fallback: "X Ads promoted-post removal",
        allowNotFound: true,
      });
    }
    await xAdsRequest(`${accountPath}/line_items/${encodeURIComponent(lineItemId)}`, credentials, {
      method: "DELETE",
      fallback: "X Ads line-item removal",
      allowNotFound: true,
    });
    await xAdsRequest(`${accountPath}/campaigns/${encodeURIComponent(campaignId)}`, credentials, {
      method: "DELETE",
      fallback: "X Ads campaign removal",
      allowNotFound: true,
    });
  }
  return {
    ...row.receipt,
    state: requestedStatus,
    ...(requestedStatus === "ARCHIVED" ? { remoteArchived: true, archivedAt: new Date().toISOString() } : {}),
  };
}

async function syncXStatus(row, credentials) {
  const accountId = boundedText(row.provider_account_id, 120);
  const campaignId = boundedText(row.provider_campaign_id || row.receipt?.campaignId, 120);
  if (![accountId, campaignId].every((id) => ACCOUNT_ID_PATTERN.test(id))) {
    throw adsError("X Ads campaign ID is invalid.", 409, "GOODADS_X_CAMPAIGN_ID_INVALID");
  }
  const { payload } = await xAdsRequest(
    `/accounts/${encodeURIComponent(accountId)}/campaigns/${encodeURIComponent(campaignId)}`,
    credentials,
    { parameters: { with_deleted: true }, fallback: "X Ads campaign status" }
  );
  const campaign = payload.data || {};
  const providerStatus = campaign.deleted === true
    ? "DELETED"
    : boundedText(campaign.effective_status || campaign.entity_status, 60).toUpperCase();
  const status = providerStatus === "ACTIVE"
    ? "active"
    : providerStatus === "DELETED"
      ? "archived"
      : ["PAUSED", "UNKNOWN"].includes(providerStatus)
        ? "paused"
        : row.status;
  return { receipt: { ...row.receipt, providerStatus, state: providerStatus }, status };
}

async function patchPinterestStatus(row, accessToken, resource, id, status) {
  const accountId = boundedText(row.provider_account_id, 120);
  const { payload } = await pinterestRequest(
    `/ad_accounts/${encodeURIComponent(accountId)}/${resource}`,
    accessToken,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ id, status }]),
    },
    `Pinterest ${resource} status update`
  );
  return pinterestBatchEntity(payload, resource);
}

async function updatePinterestStatus(row, accessToken, requestedStatus) {
  const campaignId = boundedText(row.provider_campaign_id || row.receipt?.campaignId, 120);
  const adGroupId = boundedText(row.receipt?.adGroupId || row.provider_budget_id, 120);
  const adId = boundedText(row.receipt?.adId, 120);
  if (![campaignId, adGroupId, adId].every((id) => /^\d{2,18}$/.test(id))) {
    throw adsError("Pinterest campaign resources are incomplete.", 409, "GOODADS_PINTEREST_RESOURCES_INCOMPLETE");
  }
  const status = ["ACTIVE", "ARCHIVED"].includes(requestedStatus) ? requestedStatus : "PAUSED";
  if (status === "ACTIVE") {
    await patchPinterestStatus(row, accessToken, "ads", adId, status);
    await patchPinterestStatus(row, accessToken, "ad_groups", adGroupId, status);
    await patchPinterestStatus(row, accessToken, "campaigns", campaignId, status);
  } else if (status === "ARCHIVED") {
    await patchPinterestStatus(row, accessToken, "ads", adId, status);
    await patchPinterestStatus(row, accessToken, "ad_groups", adGroupId, status);
    await patchPinterestStatus(row, accessToken, "campaigns", campaignId, status);
  } else {
    await patchPinterestStatus(row, accessToken, "campaigns", campaignId, status);
    await patchPinterestStatus(row, accessToken, "ad_groups", adGroupId, status);
    await patchPinterestStatus(row, accessToken, "ads", adId, status);
  }
  return {
    ...row.receipt,
    state: status,
    ...(status === "ARCHIVED" ? { remoteArchived: true, archivedAt: new Date().toISOString() } : {}),
  };
}

async function syncPinterestStatus(row, accessToken) {
  const accountId = boundedText(row.provider_account_id, 120);
  const campaignId = boundedText(row.provider_campaign_id || row.receipt?.campaignId, 120);
  if (!/^\d{2,18}$/.test(campaignId)) {
    throw adsError("Pinterest campaign ID is invalid.", 409, "GOODADS_PINTEREST_CAMPAIGN_ID_INVALID");
  }
  const { payload } = await pinterestRequest(
    `/ad_accounts/${encodeURIComponent(accountId)}/campaigns/${encodeURIComponent(campaignId)}`,
    accessToken,
    {},
    "Pinterest campaign status"
  );
  const providerStatus = boundedText(payload.status, 40).toUpperCase();
  const status = providerStatus === "ACTIVE"
    ? "active"
    : ["ARCHIVED", "DELETED_DRAFT"].includes(providerStatus)
      ? "archived"
      : ["PAUSED", "DRAFT"].includes(providerStatus)
        ? "paused"
        : row.status;
  return { receipt: { ...row.receipt, providerStatus, state: providerStatus }, status };
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

function nativeAdapter(provider) {
  const adapters = {
    meta: {
      create: createMetaDelivery,
      updateStatus: updateMetaStatus,
      sync: syncMetaStatus,
      statuses: { pause: "PAUSED", activate: "ACTIVE", archive: "ARCHIVED" },
    },
    google: {
      create: createGoogleDelivery,
      updateStatus: updateGoogleStatus,
      sync: syncGoogleStatus,
      statuses: { pause: "PAUSED", activate: "ENABLED", archive: "REMOVED" },
    },
    youtube: {
      create: createYouTubeDelivery,
      updateStatus: updateGoogleStatus,
      sync: syncGoogleStatus,
      statuses: { pause: "PAUSED", activate: "ENABLED", archive: "REMOVED" },
    },
    linkedin: {
      create: createLinkedInDelivery,
      updateStatus: updateLinkedInStatus,
      sync: syncLinkedInStatus,
      statuses: { pause: "PAUSED", activate: "ACTIVE", archive: "ARCHIVED" },
    },
    pinterest: {
      create: createPinterestDelivery,
      updateStatus: updatePinterestStatus,
      sync: syncPinterestStatus,
      statuses: { pause: "PAUSED", activate: "ACTIVE", archive: "ARCHIVED" },
    },
    snapchat: {
      create: createSnapchatDelivery,
      updateStatus: updateSnapchatStatus,
      sync: syncSnapchatStatus,
      statuses: { pause: "PAUSED", activate: "ACTIVE", archive: "ARCHIVED" },
    },
    tiktok: {
      create: createTikTokDelivery,
      updateStatus: updateTikTokStatus,
      sync: syncTikTokStatus,
      statuses: { pause: "DISABLE", activate: "ENABLE", archive: "DELETE" },
    },
    x: {
      create: createXDelivery,
      updateStatus: updateXStatus,
      sync: syncXStatus,
      statuses: { pause: "PAUSED", activate: "ACTIVE", archive: "ARCHIVED" },
    },
  };
  const adapter = adapters[provider];
  if (!adapter) {
    const name = PROVIDERS[provider]?.name || "This provider";
    throw adsError(
      `${name} native delivery adapter is not installed.`,
      503,
      "GOODADS_ADAPTER_NOT_INSTALLED"
    );
  }
  return adapter;
}

function bindCreateOperationSnapshot(row) {
  if (row.operation_type !== "create") return row;
  const snapshot = row.operation_payload?.snapshot;
  const expectedHash = boundedText(row.operation_payload?.snapshotHash, 64).toLowerCase();
  if (
    !snapshot
    || typeof snapshot !== "object"
    || Array.isArray(snapshot)
    || !/^[a-f0-9]{64}$/.test(expectedHash)
    || snapshotHash(snapshot) !== expectedHash
    || boundedText(row.snapshot_hash, 64).toLowerCase() !== expectedHash
  ) {
    throw adsError(
      "The queued provider creation no longer matches its immutable campaign snapshot.",
      409,
      "GOODADS_AD_CAMPAIGN_VERSION_CHANGED"
    );
  }
  return {
    ...row,
    campaign_id: snapshot.id,
    campaign_version: Number(snapshot.version),
    campaign_name: boundedText(snapshot.name, 240),
    campaign_status: boundedText(snapshot.status, 40),
    campaign_data: snapshot.data && typeof snapshot.data === "object" && !Array.isArray(snapshot.data)
      ? snapshot.data
      : {},
  };
}

function validateCreateExecution(row) {
  if (row.operation_type !== "create") return;
  const availability = providerAvailability(row.provider);
  if (!availability.available) {
    throw adsError(
      `${availability.name} is no longer fully configured in GoodBase.`,
      503,
      "GOODADS_AD_PROVIDER_NOT_CONFIGURED"
    );
  }
  validateCampaignForAccount({
    id: row.campaign_id,
    version: row.campaign_version,
    name: row.campaign_name,
    status: row.campaign_status,
    data: row.campaign_data,
  }, {
    provider: row.provider,
    status: row.account_status,
    currency: row.account_currency,
    timezone: row.account_timezone,
    metadata: row.account_metadata || {},
  });
}

function validateActivationExecution(row) {
  if (row.operation_type !== "activate") return;
  if (emergencyPauseMarker(row.receipt)) {
    throw adsError(
      "Workspace emergency pause is active for this provider campaign.",
      409,
      "GOODADS_EMERGENCY_PAUSE_ACTIVE"
    );
  }
  const availability = providerAvailability(row.provider);
  if (!availability.available) {
    throw adsError(
      `${availability.name} is no longer fully configured in GoodBase.`,
      503,
      "GOODADS_AD_PROVIDER_NOT_CONFIGURED"
    );
  }
  if (row.account_status !== "verified") {
    throw adsError(
      "The provider ad account is no longer verified for activation.",
      409,
      "GOODADS_AD_ACCOUNT_NOT_VERIFIED"
    );
  }
  if (row.connection_status !== "connected") {
    throw adsError(
      "The provider authorization is no longer connected.",
      409,
      "GOODADS_CONNECTION_EXPIRED"
    );
  }
  if (row.status !== "paused") {
    throw adsError(
      "The provider campaign is no longer paused and eligible for activation.",
      409,
      "GOODADS_AD_CAMPAIGN_NOT_PAUSED"
    );
  }
  const currentSnapshot = {
    id: row.campaign_id,
    version: Number(row.current_version || 1),
    name: boundedText(row.campaign_name, 240),
    status: row.campaign_status,
    data: row.campaign_data || {},
  };
  if (snapshotHash(currentSnapshot) !== row.snapshot_hash) {
    throw adsError(
      "The campaign changed before activation executed. Create a fresh paused provider campaign and approval.",
      409,
      "GOODADS_AD_CAMPAIGN_VERSION_CHANGED"
    );
  }
  if (row.provider === "linkedin") linkedInPolicyCompliance(currentSnapshot.data);
  const approvalId = boundedText(row.operation_payload?.approvalId, 64);
  const approvalData = row.approval_data || {};
  if (
    !UUID_PATTERN.test(approvalId)
    || row.approval_status !== "approved"
    || approvalData.reviewType !== "paid_campaign_activation"
    || approvalData.campaignId !== row.campaign_id
    || approvalData.providerCampaignId !== row.provider_campaign_record_id
    || approvalData.snapshotHash !== row.snapshot_hash
  ) {
    throw adsError(
      "The activation approval is no longer valid for this exact campaign and provider account.",
      409,
      "GOODADS_AD_ACTIVATION_APPROVAL_MISMATCH"
    );
  }
}

async function executeOperation(row) {
  const executionRow = bindCreateOperationSnapshot(row);
  validateCreateExecution(executionRow);
  validateActivationExecution(executionRow);
  if (executionRow.operation_type === "activate") {
    await validateStoredCampaignExposure({
      organizationId: executionRow.organization_id,
      campaignId: executionRow.campaign_id,
      campaignData: executionRow.campaign_data,
    });
  }
  const adapter = nativeAdapter(executionRow.provider);
  const accessToken = executionRow.provider === "x"
    ? await social.oauth1CredentialsForConnection(executionRow)
    : await social.accessTokenForConnection(executionRow);
  if (executionRow.operation_type === "create") {
    return adapter.create(executionRow, accessToken);
  }
  if (!executionRow.provider_campaign_id) throw adsError("The provider campaign has not been created.");
  if (executionRow.operation_type === "pause") {
    const receipt = await adapter.updateStatus(executionRow, accessToken, adapter.statuses.pause);
    return { receipt, status: "paused" };
  }
  if (executionRow.operation_type === "activate") {
    const receipt = await adapter.updateStatus(executionRow, accessToken, adapter.statuses.activate);
    const emergencyPause = await emergencyPauseMarkerForProviderCampaign(executionRow.provider_campaign_record_id);
    if (emergencyPause) {
      const appliedAt = new Date().toISOString();
      const pausedReceipt = await adapter.updateStatus({
        ...executionRow,
        receipt: {
          ...(receipt || executionRow.receipt || {}),
          emergencyPause: { ...emergencyPause, appliedAt },
        },
      }, accessToken, adapter.statuses.pause);
      return {
        receipt: {
          ...(pausedReceipt || {}),
          emergencyPause: { ...emergencyPause, appliedAt },
        },
        status: "paused",
      };
    }
    return { receipt, status: "active" };
  }
  if (executionRow.operation_type === "archive") {
    const receipt = await adapter.updateStatus(executionRow, accessToken, adapter.statuses.archive);
    return { receipt, status: "archived" };
  }
  return adapter.sync(executionRow, accessToken);
}

function providerReconciliationMinutes() {
  return Math.min(
    Math.max(Math.round(positiveEnvironmentNumber(
      "GOODADS_PROVIDER_RECONCILIATION_MINUTES",
      DEFAULT_PROVIDER_RECONCILIATION_MINUTES
    )), 1),
    60
  );
}

function shouldPauseUnexpectedActivation({ operationType, providerStatus, storedStatus, activationPending = false }) {
  return operationType === "sync"
    && providerStatus === "active"
    && storedStatus !== "active"
    && storedStatus !== "activating"
    && activationPending !== true;
}

async function queueStaleProviderReconciliations(limit = 25) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const intervalMinutes = providerReconciliationMinutes();
  const queued = await query(
    `WITH candidates AS (
       SELECT provider_campaign.id, provider_campaign.organization_id
       FROM goodads_provider_campaigns provider_campaign
       JOIN goodads_ad_accounts account ON account.id = provider_campaign.ad_account_id
       JOIN goodads_social_connections connection ON connection.id = account.connection_id
       WHERE provider_campaign.provider_campaign_id IS NOT NULL
         AND provider_campaign.status <> 'archived'
         AND account.status = 'verified'
         AND connection.status = 'connected'
         AND (
           provider_campaign.last_synced_at IS NULL
           OR provider_campaign.last_synced_at < NOW() - ($2::text || ' minutes')::interval
         )
         AND NOT EXISTS (
           SELECT 1 FROM goodads_ad_operations open_operation
           WHERE open_operation.provider_campaign_id = provider_campaign.id
             AND open_operation.status IN ('queued','processing','retrying')
         )
         AND NOT EXISTS (
           SELECT 1 FROM goodads_ad_operations recent_failed_sync
           WHERE recent_failed_sync.provider_campaign_id = provider_campaign.id
             AND recent_failed_sync.operation_type = 'sync'
             AND recent_failed_sync.status IN ('failed','dead_letter')
             AND recent_failed_sync.updated_at > NOW() - INTERVAL '1 hour'
         )
       ORDER BY provider_campaign.last_synced_at ASC NULLS FIRST, provider_campaign.created_at ASC
       FOR UPDATE OF provider_campaign SKIP LOCKED
       LIMIT $1
     )
     INSERT INTO goodads_ad_operations (
       organization_id, provider_campaign_id, requested_by_user_id,
       operation_type, idempotency_key, payload
     )
     SELECT candidates.organization_id, candidates.id, NULL, 'sync',
       'automatic-reconcile:' || candidates.id::text || ':'
         || FLOOR(EXTRACT(EPOCH FROM NOW()) / ($2::integer * 60))::bigint::text,
       jsonb_build_object('automaticReconciliation', TRUE, 'intervalMinutes', $2)
     FROM candidates
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [safeLimit, intervalMinutes]
  );
  return queued.rows.length;
}

async function processOperation(row) {
  try {
    const result = await executeOperation(row);
    const providerStatus = result.status || "paused";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query(
        `SELECT status
         FROM goodads_provider_campaigns
         WHERE id = $1::uuid
         FOR UPDATE`,
        [row.provider_campaign_record_id]
      );
      const currentStatus = currentResult.rows[0]?.status || row.status;
      const mutationResult = await client.query(
        `SELECT operation_type
         FROM goodads_ad_operations
         WHERE provider_campaign_id = $1::uuid
           AND id <> $2::uuid
           AND operation_type IN ('create','pause','activate','archive')
           AND status IN ('queued','processing','retrying')
         ORDER BY created_at ASC
         LIMIT 1`,
        [row.provider_campaign_record_id, row.operation_id]
      );
      const pendingMutation = mutationResult.rows[0]?.operation_type || null;
      const unexpectedActivation = shouldPauseUnexpectedActivation({
        operationType: row.operation_type,
        providerStatus,
        storedStatus: currentStatus,
        activationPending: pendingMutation === "activate",
      });
      let automaticPauseQueued = false;
      let pauseSecured = false;
      let receipt = result.receipt || {};
      let status = providerStatus;
      if (unexpectedActivation) {
        const detectedAt = new Date().toISOString();
        pauseSecured = pendingMutation === "pause";
        if (!pendingMutation) {
          const pause = await client.query(
            `INSERT INTO goodads_ad_operations (
               organization_id, provider_campaign_id, requested_by_user_id,
               operation_type, idempotency_key, payload
             ) VALUES ($1, $2::uuid, NULL, 'pause', $3, $4::jsonb)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [
              row.organization_id,
              row.provider_campaign_record_id,
              `automatic-drift-pause:${row.provider_campaign_record_id}:${Math.floor(Date.now() / 60000)}`,
              JSON.stringify({
                automaticSafetyPause: true,
                reason: "unexpected_provider_activation",
                detectedAt,
                priorStatus: currentStatus,
              }),
            ]
          );
          automaticPauseQueued = pause.rows.length > 0;
          pauseSecured = automaticPauseQueued;
        }
        receipt = {
          ...receipt,
          safetyDrift: {
            type: "unexpected_provider_activation",
            detectedAt,
            priorStatus: currentStatus,
            automaticPauseQueued,
            pauseSecured,
          },
        };
        if (pauseSecured) status = "pausing";
      }
      await client.query(
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
          JSON.stringify(receipt),
        ]
      );
      await client.query(
        `UPDATE goodads_ad_operations
         SET status = 'completed', receipt = $2::jsonb, last_error = NULL,
             completed_at = NOW(), locked_by = NULL, locked_until = NULL, updated_at = NOW()
         WHERE id = $1::uuid`,
        [row.operation_id, JSON.stringify(receipt || result)]
      );
      await client.query("COMMIT");
      return { id: row.operation_id, status: "completed", automaticPauseQueued };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const attempts = Number(row.attempts || 1);
    const emergencyPause = row.operation_type === "activate"
      ? await emergencyPauseMarkerForProviderCampaign(row.provider_campaign_record_id)
      : null;
    const retry = !emergencyPause && error.retryable === true && attempts < Number(row.max_attempts || 5);
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
      [
        row.provider_campaign_record_id,
        emergencyPause ? "pausing" : row.operation_type === "sync" || retry ? row.status : "failed",
        boundedText(error.message, 2000),
      ]
    );
    if (emergencyPause) {
      await query(
        `INSERT INTO goodads_ad_operations (
           organization_id, provider_campaign_id, requested_by_user_id,
           operation_type, idempotency_key, payload
         ) VALUES ($1, $2::uuid, $3::uuid, 'pause', $4, $5::jsonb)
         ON CONFLICT DO NOTHING`,
        [
          row.organization_id,
          row.provider_campaign_record_id,
          UUID_PATTERN.test(String(emergencyPause.requestedByUserId || ""))
            ? emergencyPause.requestedByUserId
            : null,
          `${boundedText(emergencyPause.requestKey, 180)}:${row.provider_campaign_record_id}:emergency-pause`,
          JSON.stringify({ emergencyPause }),
        ]
      );
    }
    return {
      id: row.operation_id,
      status: nextStatus,
      error: boundedText(error.message, 2000),
      emergencyPauseQueued: Boolean(emergencyPause),
    };
  }
}

async function processDueOperations(limit = 10, workerId = `goodads-ads-${process.pid}`) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const reconciliationsQueued = await queueStaleProviderReconciliations(Math.max(safeLimit, 25));
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
      `SELECT operation.id AS operation_id, operation.organization_id, operation.operation_type, operation.attempts,
         operation.max_attempts, operation.payload AS operation_payload,
         provider_campaign.id AS provider_campaign_record_id, provider_campaign.campaign_id,
         provider_campaign.provider_campaign_id, provider_campaign.provider_resource_name,
         provider_campaign.provider_budget_id, provider_campaign.status,
         provider_campaign.receipt, provider_campaign.provider, provider_campaign.snapshot_hash,
         account.provider_account_id, account.status AS account_status, account.currency AS account_currency,
         account.timezone AS account_timezone, account.metadata AS account_metadata,
         connection.*,
         connection.status AS connection_status, provider_campaign.status AS status,
         campaign.name AS campaign_name, campaign.status AS campaign_status,
         campaign.version AS current_version, campaign.data AS campaign_data,
         approval.status AS approval_status, approval.data AS approval_data
       FROM goodads_ad_operations operation
       JOIN goodads_provider_campaigns provider_campaign ON provider_campaign.id = operation.provider_campaign_id
       JOIN goodads_ad_accounts account ON account.id = provider_campaign.ad_account_id
       JOIN goodads_social_connections connection ON connection.id = account.connection_id
       JOIN goodads_resources campaign ON campaign.id = provider_campaign.campaign_id
       LEFT JOIN goodads_resources approval
         ON approval.id::text = operation.payload->>'approvalId'
         AND approval.organization_id = provider_campaign.organization_id
         AND approval.resource_type = 'approvals'
       WHERE operation.id = $1::uuid`,
      [operation.id]
    );
    if (selected.rows[0]) results.push(await processOperation(selected.rows[0]));
  }
  return { reconciliationsQueued, claimed: claimed.rows.length, results };
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
       AND (
         operation.operation_type = 'sync'
         OR NOT EXISTS (
           SELECT 1 FROM goodads_ad_operations active_operation
           WHERE active_operation.provider_campaign_id = operation.provider_campaign_id
             AND active_operation.id <> operation.id
             AND active_operation.operation_type IN ('create','pause','activate','archive')
             AND active_operation.status IN ('queued','processing','retrying')
         )
       )
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
      immutableLaunchSnapshots: true,
      executionTimeRevalidation: true,
      objectiveContracts: true,
      oneOpenMutationPerProviderCampaign: true,
      emergencyPauseAll: true,
      automaticStateReconciliation: true,
      unexpectedActivationAutoPause: true,
      providerReconciliationMinutes: providerReconciliationMinutes(),
      campaignWideExposureLimits: true,
      maximumAccountsPerLaunch: MAX_ACCOUNTS_PER_LAUNCH,
      exposureLimits: campaignExposurePolicy(),
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
  preflightCampaign,
  launchCampaign,
  queueLifecycleOperation,
  emergencyPauseAll,
  requestActivationApproval,
  processDueOperations,
  retryOperation,
  _test: {
    providerAvailability,
    normalizeMetaAccount,
    metaPublisherPlatforms,
    normalizeGoogleCustomer,
    youtubeVideoId,
    providerCreativeVideoUrl,
    googlePoliticalAdvertisingStatus,
    linkedInPolicyCompliance,
    googleDemandGenNames,
    googleDemandGenOperations,
    googleLogoDimensions,
    normalizeLinkedInAccount,
    normalizePinterestAccount,
    normalizeSnapchatAccount,
    normalizeTikTokAccount,
    normalizeTikTokIdentity,
    normalizeXAccount,
    metaObjective,
    linkedInObjective,
    linkedInCampaignPayload,
    linkedInCreativePayload,
    linkedInVersion,
    pinterestObjective,
    pinterestCampaignPayload,
    pinterestAdGroupPayload,
    pinterestPinPayload,
    pinterestAdPayload,
    snapchatObjective,
    snapchatCampaignPayload,
    snapchatAdSquadPayload,
    snapchatCreativePayload,
    snapchatAdPayload,
    tiktokCampaignPayload,
    tiktokAdGroupPayload,
    tiktokAdPayload,
    tiktokCountryLocationIds,
    xAdsStableName,
    xAdsBudget,
    xCampaignParameters,
    xLineItemParameters,
    xTweetParameters,
    nativeAdapter,
    bindCreateOperationSnapshot,
    snapshotHash,
    validateCampaignForAccount,
    validateProviderObjective,
    validateCreateExecution,
    validateActivationExecution,
    providerReconciliationMinutes,
    shouldPauseUnexpectedActivation,
    campaignExposure,
    campaignExposureIssues,
    campaignExposurePolicy,
    validateCampaignExposure,
    emergencyPauseMarker,
    campaignPreflightReport,
    campaignScheduleBounds,
  },
};
