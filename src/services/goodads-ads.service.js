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
  },
  meta: {
    name: "Meta Ads",
    connectionProviders: ["facebook", "instagram"],
    requiredEnvironment: [],
    platforms: ["facebook", "instagram", "meta"],
    safePausedCreation: true,
    deliveryAdapter: "link_ad",
    adapterType: "native",
  },
  youtube: {
    name: "YouTube Ads",
    connectionProviders: ["google"],
    requiredEnvironment: [],
    platforms: ["youtube"],
    safePausedCreation: true,
    deliveryAdapter: "video",
    adapterType: "not_installed",
  },
  tiktok: {
    name: "TikTok Ads",
    connectionProviders: ["tiktok"],
    requiredEnvironment: [],
    platforms: ["tiktok"],
    safePausedCreation: true,
    deliveryAdapter: "video",
    adapterType: "not_installed",
  },
  linkedin: {
    name: "LinkedIn Ads",
    connectionProviders: ["linkedin"],
    requiredEnvironment: [],
    requiredOAuthScopes: ["r_ads", "rw_ads"],
    platforms: ["linkedin"],
    safePausedCreation: true,
    deliveryAdapter: "sponsored_content",
    adapterType: "native",
    activationSupported: false,
  },
  x: {
    name: "X Ads",
    connectionProviders: ["x"],
    requiredEnvironment: [],
    platforms: ["x", "twitter"],
    safePausedCreation: true,
    deliveryAdapter: "promoted_post",
    adapterType: "not_installed",
  },
  pinterest: {
    name: "Pinterest Ads",
    connectionProviders: ["pinterest"],
    requiredEnvironment: [],
    platforms: ["pinterest"],
    safePausedCreation: true,
    deliveryAdapter: "promoted_pin",
    adapterType: "not_installed",
  },
  snapchat: {
    name: "Snapchat Ads",
    connectionProviders: ["snapchat"],
    requiredEnvironment: [],
    platforms: ["snapchat"],
    safePausedCreation: true,
    deliveryAdapter: "snap_ad",
    adapterType: "native",
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
    platforms: [...definition.platforms],
    safePausedCreation: definition.safePausedCreation && adapterConfigured,
    activationSupported: definition.activationSupported !== false && adapterConfigured,
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
      || payload?.display_message
      || payload?.debug_message
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
  const accessToken = await social.accessTokenForConnection(connection);
  const discovered = id === "meta"
    ? await discoverMetaAccounts(accessToken)
    : id === "google"
      ? await discoverGoogleAccounts(accessToken)
      : id === "linkedin"
        ? await discoverLinkedInAccounts(accessToken)
        : id === "snapchat"
          ? await discoverSnapchatAccounts(accessToken)
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
  const selectedPage = ["meta", "snapchat"].includes(provider) && pageId
    ? discovered.pages.find((page) => (
        page.id === pageId
        && (provider !== "snapchat" || page.providerAccountId === providerAccountId)
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
      : provider === "snapchat"
        ? {
            ...(account.metadata || {}),
            profileId: selectedPage.id,
            profileName: selectedPage.name,
            deliveryReady: true,
            channelType: "SNAP_AD",
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
  const definition = PROVIDERS[account.provider];
  const matchesProvider = definition.platforms.some((provider) => platforms.includes(provider));
  if (!matchesProvider) {
    throw adsError(`${definition.name} is not selected on this campaign.`, 409, "GOODADS_AD_ACCOUNT_NOT_SELECTED");
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
  if (!account.currency || !account.timezone) {
    throw adsError(
      `Refresh ${definition.name} account verification to load its currency and time zone before setup.`,
      409,
      "GOODADS_AD_ACCOUNT_LOCALE_REQUIRED"
    );
  }
  const creative = data.creative || {};
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
  if (["youtube", "tiktok"].includes(account.provider) && !isPublicHttpsUrl(creative.videoUrl)) {
    throw adsError(
      `${definition.name} delivery requires a public HTTPS creative video.`,
      409,
      "GOODADS_VIDEO_REQUIRED"
    );
  }
  if (["linkedin", "pinterest"].includes(account.provider) && !isPublicHttpsUrl(creative.imageUrl)) {
    throw adsError(
      `${definition.name} delivery requires a public HTTPS creative image.`,
      409,
      "GOODADS_IMAGE_REQUIRED"
    );
  }
  if (account.provider === "linkedin") {
    if (!account.metadata?.deliveryReady || !/^urn:li:organization:\d+$/.test(account.metadata?.organizationUrn || "")) {
      throw adsError(
        "LinkedIn delivery requires an active organization-backed ad account and campaign-manager access.",
        409,
        "GOODADS_LINKEDIN_ORGANIZATION_REQUIRED"
      );
    }
    if (String(data.objective || "traffic").toLowerCase() === "leads") {
      throw adsError(
        "LinkedIn lead-generation campaigns require a verified LinkedIn lead form before setup.",
        409,
        "GOODADS_LINKEDIN_LEAD_FORM_REQUIRED"
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
    const objective = String(data.objective || "traffic").toLowerCase();
    if (!["traffic", "awareness", "engagement"].includes(objective)) {
      throw adsError(
        "Snapchat one-click setup currently supports traffic, awareness, and engagement campaigns. Sales, conversion, and lead campaigns require a verified Pixel or lead form.",
        409,
        "GOODADS_SNAPCHAT_EVENT_SOURCE_REQUIRED"
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
  if (["x", "snapchat"].includes(account.provider)
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
  const accountLocales = new Set(accountResult.rows.map((account) => (
    `${boundedText(account.currency, 12).toUpperCase()}|${boundedText(account.timezone, 120)}`
  )));
  if (accountLocales.size !== 1 || [...accountLocales][0].startsWith("|")) {
    throw adsError(
      "One-click setup requires every selected ad account to use the same currency and time zone.",
      409,
      "GOODADS_AD_ACCOUNT_LOCALE_MISMATCH"
    );
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
  if (PROVIDERS[campaign.provider]?.activationSupported === false) {
    throw adsError(
      `${PROVIDERS[campaign.provider].name} activation review is unavailable until its provider-specific policy confirmation is installed.`,
      409,
      "GOODADS_AD_ACTIVATION_NOT_SUPPORTED"
    );
  }
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

function linkedInScheduleDate(value, exclusiveEnd = false) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw adsError("LinkedIn campaign schedule is invalid.");
  if (exclusiveEnd) date.setUTCDate(date.getUTCDate() + 1);
  return date.getTime();
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
    politicalIntent: "NOT_DECLARED",
    runSchedule: {
      start: linkedInScheduleDate(data.startDate),
      end: linkedInScheduleDate(data.endDate, true),
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
            start: linkedInScheduleDate(data.startDate),
            end: linkedInScheduleDate(data.endDate, true),
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
      { campaignUrn, locationUrns, politicalIntent: "NOT_DECLARED" },
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
      activationSupported: false,
    },
  };
}

async function updateLinkedInStatus(row, accessToken, status) {
  if (status === "ACTIVE") {
    throw adsError(
      "LinkedIn activation is disabled until policy confirmation is installed.",
      409,
      "GOODADS_AD_ACTIVATION_NOT_SUPPORTED"
    );
  }
  const accountId = linkedInAccountId(row.provider_account_id);
  const campaignId = linkedInNumericId(row.provider_campaign_id || row.provider_resource_name);
  if (!campaignId) throw adsError("LinkedIn campaign ID is invalid.", 409, "GOODADS_LINKEDIN_CAMPAIGN_ID_INVALID");
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
  return { ...row.receipt, state: status };
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

function snapchatScheduleDate(value, exclusiveEnd = false) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw adsError("Snapchat campaign schedule is invalid.");
  if (exclusiveEnd) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function snapchatCampaignPayload(row) {
  const data = row.campaign_data || {};
  const { objectiveV2Type } = snapchatObjective(data.objective);
  return {
    ad_account_id: boundedText(row.provider_account_id, 120),
    name: boundedText(row.campaign_name, 375),
    status: "PAUSED",
    buy_model: "AUCTION",
    start_time: snapchatScheduleDate(data.startDate),
    end_time: snapchatScheduleDate(data.endDate, true),
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
    start_time: snapchatScheduleDate(data.startDate),
    end_time: snapchatScheduleDate(data.endDate, true),
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
    linkedin: {
      create: createLinkedInDelivery,
      updateStatus: updateLinkedInStatus,
      sync: syncLinkedInStatus,
      statuses: { pause: "PAUSED", activate: "ACTIVE", archive: "ARCHIVED" },
    },
    snapchat: {
      create: createSnapchatDelivery,
      updateStatus: updateSnapchatStatus,
      sync: syncSnapchatStatus,
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

async function executeOperation(row) {
  const adapter = nativeAdapter(row.provider);
  const accessToken = await social.accessTokenForConnection(row);
  if (row.operation_type === "create") {
    return adapter.create(row, accessToken);
  }
  if (!row.provider_campaign_id) throw adsError("The provider campaign has not been created.");
  if (row.operation_type === "pause") {
    const receipt = await adapter.updateStatus(row, accessToken, adapter.statuses.pause);
    return { receipt, status: "paused" };
  }
  if (row.operation_type === "activate") {
    const receipt = await adapter.updateStatus(row, accessToken, adapter.statuses.activate);
    return { receipt, status: "active" };
  }
  if (row.operation_type === "archive") {
    const receipt = await adapter.updateStatus(row, accessToken, adapter.statuses.archive);
    return { receipt, status: "archived" };
  }
  return adapter.sync(row, accessToken);
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
         account.provider_account_id, account.currency AS account_currency,
         account.timezone AS account_timezone, account.metadata AS account_metadata,
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
    normalizeGoogleCustomer,
    normalizeLinkedInAccount,
    normalizeSnapchatAccount,
    metaObjective,
    linkedInObjective,
    linkedInCampaignPayload,
    linkedInCreativePayload,
    linkedInVersion,
    snapchatObjective,
    snapchatCampaignPayload,
    snapchatAdSquadPayload,
    snapchatCreativePayload,
    snapchatAdPayload,
    nativeAdapter,
    snapshotHash,
    validateCampaignForAccount,
  },
};
