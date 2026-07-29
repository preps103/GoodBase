"use strict";

const crypto = require("node:crypto");
const { query } = require("../config/database");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGEMENT_ROLES = new Set(["owner", "admin", "manager"]);
const MUTATING_ROLES = new Set(["owner", "admin", "manager", "editor", "member"]);
const COMPETITOR_STATUSES = new Set(["active", "paused"]);
const SOURCE_PROVIDERS = new Set([
  "manual", "similarweb", "meta_library", "google_transparency",
  "tiktok_creative_center", "linkedin_ad_library",
]);
const PROVENANCE = new Set(["user_observed", "licensed_api", "public_library"]);
const CHANNELS = new Set(["search", "display", "video", "social", "product", "other"]);
const FORMATS = new Set(["text", "image", "video", "carousel", "html5", "native", "product", "other"]);

function intelligenceError(message, statusCode = 400, code = "GOODADS_COMPETITOR_INTELLIGENCE_ERROR", retryable = false) {
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
  const id = boundedText(value, 80).toLowerCase();
  if (!UUID_PATTERN.test(id)) throw intelligenceError(`A valid ${label} is required.`);
  return id;
}

function role(context) {
  return boundedText(context?.organization?.membershipRole, 40).toLowerCase();
}

function requireWrite(context) {
  if (!MUTATING_ROLES.has(role(context))) {
    throw intelligenceError(
      "Your organization role cannot update competitor intelligence.",
      403,
      "GOODADS_COMPETITOR_WRITE_FORBIDDEN"
    );
  }
}

function requireManagement(context) {
  if (!MANAGEMENT_ROLES.has(role(context))) {
    throw intelligenceError(
      "Owner, admin, or manager access is required to refresh licensed intelligence.",
      403,
      "GOODADS_COMPETITOR_SYNC_FORBIDDEN"
    );
  }
}

function normalizeDomain(value) {
  let text = boundedText(value, 253).toLowerCase();
  if (!text) throw intelligenceError("A competitor website is required.");
  if (!text.includes("://")) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw intelligenceError("Enter a valid competitor website.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw intelligenceError("Enter a public website without credentials or a custom port.");
  }
  const domain = url.hostname.replace(/^www\./, "").replace(/\.$/, "");
  if (!domain.includes(".") || domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain)) {
    throw intelligenceError("Enter a valid public website domain.");
  }
  return domain;
}

function optionalHttpsUrl(value, label = "URL") {
  const text = boundedText(value, 2048);
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw intelligenceError(`${label} must be a complete HTTPS address.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw intelligenceError(`${label} must use HTTPS without embedded credentials.`);
  }
  return url.toString();
}

function uniqueStrings(value, limit, length) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => boundedText(item, length)).filter(Boolean))].slice(0, limit);
}

function optionalDate(value, label) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw intelligenceError(`${label} is invalid.`);
  return date.toISOString();
}

function normalizeCompetitorPayload(payload = {}) {
  const domain = normalizeDomain(payload.domain || payload.website);
  const status = boundedText(payload.status || "active", 20).toLowerCase();
  if (!COMPETITOR_STATUSES.has(status)) throw intelligenceError("Competitor status must be active or paused.");
  return {
    domain,
    displayName: boundedText(payload.displayName || payload.name || domain, 160),
    industry: boundedText(payload.industry, 160),
    country: boundedText(payload.country || "US", 2).toUpperCase().replace(/[^A-Z]/g, "") || "US",
    notes: boundedText(payload.notes, 5000),
    status,
  };
}

function normalizeCreativePayload(payload = {}) {
  const sourceProvider = boundedText(payload.sourceProvider || "manual", 40).toLowerCase();
  const provenance = boundedText(
    payload.provenance || (sourceProvider === "manual" ? "user_observed" : "public_library"),
    40
  ).toLowerCase();
  const channel = boundedText(payload.channel || "other", 30).toLowerCase();
  const adFormat = boundedText(payload.adFormat || "other", 30).toLowerCase();
  if (!SOURCE_PROVIDERS.has(sourceProvider)) throw intelligenceError("Select a supported research source.");
  if (!PROVENANCE.has(provenance)) throw intelligenceError("Select a supported source attribution.");
  if (!CHANNELS.has(channel)) throw intelligenceError("Select a supported advertising channel.");
  if (!FORMATS.has(adFormat)) throw intelligenceError("Select a supported ad format.");
  if (sourceProvider === "similarweb" && provenance !== "licensed_api") {
    throw intelligenceError("Similarweb records must be attributed to licensed API data.");
  }
  return {
    sourceProvider,
    provenance,
    sourceAdId: boundedText(payload.sourceAdId, 500) || null,
    sourceUrl: optionalHttpsUrl(payload.sourceUrl, "Source URL"),
    channel,
    adFormat,
    headline: boundedText(payload.headline, 500),
    body: boundedText(payload.body, 10000),
    callToAction: boundedText(payload.callToAction, 160),
    landingUrl: optionalHttpsUrl(payload.landingUrl, "Landing URL"),
    creativeUrl: optionalHttpsUrl(payload.creativeUrl, "Creative URL"),
    previewImageUrl: optionalHttpsUrl(payload.previewImageUrl, "Preview image URL"),
    keywords: uniqueStrings(payload.keywords, 50, 160),
    countries: uniqueStrings(payload.countries, 30, 2).map((item) => item.toUpperCase()),
    tags: uniqueStrings(payload.tags, 30, 80),
    firstSeenAt: optionalDate(payload.firstSeenAt, "First-seen date"),
    lastSeenAt: optionalDate(payload.lastSeenAt, "Last-seen date"),
    isActive: payload.isActive !== false,
    isFavorite: payload.isFavorite === true,
    notes: boundedText(payload.notes, 5000),
  };
}

function rowToCompetitor(row) {
  return {
    id: row.id,
    domain: row.domain,
    displayName: row.display_name,
    industry: row.industry,
    country: row.country,
    notes: row.notes,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    creativeCount: Number(row.creative_count || 0),
    activeCreativeCount: Number(row.active_creative_count || 0),
    unacknowledgedAlerts: Number(row.unacknowledged_alerts || 0),
  };
}

function rowToCreative(row) {
  return {
    id: row.id,
    competitorId: row.competitor_id,
    sourceProvider: row.source_provider,
    provenance: row.provenance,
    sourceAdId: row.source_ad_id,
    sourceUrl: row.source_url,
    channel: row.channel,
    adFormat: row.ad_format,
    headline: row.headline,
    body: row.body,
    callToAction: row.call_to_action,
    landingUrl: row.landing_url,
    creativeUrl: row.creative_url,
    previewImageUrl: row.preview_image_url,
    keywords: row.keywords || [],
    countries: row.countries || [],
    tags: row.tags || [],
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    isActive: row.is_active,
    isFavorite: row.is_favorite,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function researchLinks(domain) {
  const safeDomain = normalizeDomain(domain);
  return [
    {
      id: "google_transparency",
      name: "Google Ads Transparency Center",
      coverage: "Search, Display, Gmail, and YouTube",
      url: `https://adstransparency.google.com/?region=anywhere&domain=${encodeURIComponent(safeDomain)}`,
    },
    {
      id: "meta_library",
      name: "Meta Ad Library",
      coverage: "Facebook, Instagram, Messenger, and Audience Network",
      url: "https://www.facebook.com/ads/library/",
    },
    {
      id: "tiktok_creative_center",
      name: "TikTok Creative Center",
      coverage: "Top TikTok ads and creative patterns",
      url: "https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en",
    },
    {
      id: "linkedin_ad_library",
      name: "LinkedIn Ad Library",
      coverage: "LinkedIn sponsored content",
      url: "https://www.linkedin.com/ad-library/home",
    },
  ];
}

async function listCompetitors({ context, search = "", status = null, limit = 100 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const safeSearch = boundedText(search, 160);
  const values = [context.organizationId, safeLimit];
  let statusClause = "";
  if (status && COMPETITOR_STATUSES.has(String(status).toLowerCase())) {
    values.push(String(status).toLowerCase());
    statusClause = ` AND competitor.status = $${values.length}`;
  }
  values.push(`%${safeSearch}%`);
  const searchPosition = values.length;
  const result = await query(
    `SELECT competitor.*,
       COUNT(DISTINCT creative.id)::integer AS creative_count,
       COUNT(DISTINCT creative.id) FILTER (WHERE creative.is_active)::integer AS active_creative_count,
       COUNT(DISTINCT alert.id) FILTER (WHERE alert.acknowledged_at IS NULL)::integer AS unacknowledged_alerts
     FROM goodads_competitors competitor
     LEFT JOIN goodads_competitor_creatives creative
       ON creative.competitor_id = competitor.id AND creative.archived_at IS NULL
     LEFT JOIN goodads_competitor_alerts alert ON alert.competitor_id = competitor.id
     WHERE competitor.organization_id = $1
       AND competitor.archived_at IS NULL${statusClause}
       AND ($${searchPosition} = '%%' OR competitor.domain ILIKE $${searchPosition}
         OR competitor.display_name ILIKE $${searchPosition})
     GROUP BY competitor.id
     ORDER BY competitor.updated_at DESC
     LIMIT $2`,
    values
  );
  return {
    items: result.rows.map((row) => ({
      ...rowToCompetitor(row),
      researchLinks: researchLinks(row.domain),
    })),
  };
}

async function getCompetitor({ id, context }) {
  const competitorId = requireUuid(id, "competitor ID");
  const result = await query(
    `SELECT competitor.*,
       COUNT(DISTINCT creative.id)::integer AS creative_count,
       COUNT(DISTINCT creative.id) FILTER (WHERE creative.is_active)::integer AS active_creative_count,
       COUNT(DISTINCT alert.id) FILTER (WHERE alert.acknowledged_at IS NULL)::integer AS unacknowledged_alerts
     FROM goodads_competitors competitor
     LEFT JOIN goodads_competitor_creatives creative
       ON creative.competitor_id = competitor.id AND creative.archived_at IS NULL
     LEFT JOIN goodads_competitor_alerts alert ON alert.competitor_id = competitor.id
     WHERE competitor.id = $1 AND competitor.organization_id = $2 AND competitor.archived_at IS NULL
     GROUP BY competitor.id`,
    [competitorId, context.organizationId]
  );
  if (!result.rows[0]) throw intelligenceError("Competitor was not found.", 404, "GOODADS_COMPETITOR_NOT_FOUND");
  return { ...rowToCompetitor(result.rows[0]), researchLinks: researchLinks(result.rows[0].domain) };
}

async function saveCompetitor({ id = null, payload, context, userId }) {
  requireWrite(context);
  const input = normalizeCompetitorPayload(payload);
  let result;
  if (id) {
    result = await query(
      `UPDATE goodads_competitors SET
         domain = $3, display_name = $4, industry = $5, country = $6,
         notes = $7, status = $8, updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL
       RETURNING *`,
      [requireUuid(id, "competitor ID"), context.organizationId, input.domain, input.displayName,
        input.industry, input.country, input.notes, input.status]
    );
    if (!result.rows[0]) throw intelligenceError("Competitor was not found.", 404, "GOODADS_COMPETITOR_NOT_FOUND");
  } else {
    result = await query(
      `INSERT INTO goodads_competitors (
         organization_id, project_id, environment_id, owner_user_id,
         domain, display_name, industry, country, notes, status
       ) VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [context.organizationId, context.projectId, context.environmentId, userId,
        input.domain, input.displayName, input.industry, input.country, input.notes, input.status]
    ).catch((error) => {
      if (error.code === "23505") {
        throw intelligenceError("This competitor is already tracked.", 409, "GOODADS_COMPETITOR_EXISTS");
      }
      throw error;
    });
    await query(
      `INSERT INTO goodads_competitor_alerts (
         competitor_id, organization_id, alert_type, severity, title, description
       ) VALUES ($1,$2,'new_competitor','info',$3,$4)`,
      [result.rows[0].id, context.organizationId, `${input.displayName} is now tracked`,
        "Add observed ads or connect licensed Similarweb data to build the intelligence history."]
    );
  }
  return { ...rowToCompetitor(result.rows[0]), researchLinks: researchLinks(result.rows[0].domain) };
}

async function archiveCompetitor({ id, context }) {
  requireWrite(context);
  const result = await query(
    `UPDATE goodads_competitors
     SET status = 'archived', archived_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL
     RETURNING id`,
    [requireUuid(id, "competitor ID"), context.organizationId]
  );
  if (!result.rows[0]) throw intelligenceError("Competitor was not found.", 404, "GOODADS_COMPETITOR_NOT_FOUND");
  return { id: result.rows[0].id, archived: true };
}

async function listCreatives({
  context, competitorId = null, channel = null, sourceProvider = null,
  favorite = null, search = "", limit = 100, offset = 0,
}) {
  const values = [context.organizationId];
  const clauses = ["creative.organization_id = $1", "creative.archived_at IS NULL"];
  if (competitorId) {
    values.push(requireUuid(competitorId, "competitor ID"));
    clauses.push(`creative.competitor_id = $${values.length}`);
  }
  if (channel && CHANNELS.has(String(channel).toLowerCase())) {
    values.push(String(channel).toLowerCase());
    clauses.push(`creative.channel = $${values.length}`);
  }
  if (sourceProvider && SOURCE_PROVIDERS.has(String(sourceProvider).toLowerCase())) {
    values.push(String(sourceProvider).toLowerCase());
    clauses.push(`creative.source_provider = $${values.length}`);
  }
  if (favorite === true || favorite === "true") clauses.push("creative.is_favorite = TRUE");
  const safeSearch = boundedText(search, 160);
  if (safeSearch) {
    values.push(`%${safeSearch}%`);
    clauses.push(`(creative.headline ILIKE $${values.length} OR creative.body ILIKE $${values.length}
      OR creative.call_to_action ILIKE $${values.length} OR competitor.display_name ILIKE $${values.length})`);
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  values.push(safeLimit, safeOffset);
  const result = await query(
    `SELECT creative.*, competitor.display_name AS competitor_name, competitor.domain AS competitor_domain
     FROM goodads_competitor_creatives creative
     JOIN goodads_competitors competitor ON competitor.id = creative.competitor_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY creative.is_favorite DESC, COALESCE(creative.last_seen_at, creative.created_at) DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return {
    items: result.rows.map((row) => ({
      ...rowToCreative(row),
      competitorName: row.competitor_name,
      competitorDomain: row.competitor_domain,
    })),
  };
}

async function saveCreative({ id = null, competitorId, payload, context, userId }) {
  requireWrite(context);
  const input = normalizeCreativePayload(payload);
  const safeCompetitorId = requireUuid(competitorId || payload?.competitorId, "competitor ID");
  const competitor = await getCompetitor({ id: safeCompetitorId, context });
  let result;
  if (id) {
    result = await query(
      `UPDATE goodads_competitor_creatives SET
         competitor_id=$3, source_provider=$4, provenance=$5, source_ad_id=$6,
         source_url=$7, channel=$8, ad_format=$9, headline=$10, body=$11,
         call_to_action=$12, landing_url=$13, creative_url=$14, preview_image_url=$15,
         keywords=$16::text[], countries=$17::text[], tags=$18::text[],
         first_seen_at=$19, last_seen_at=$20, is_active=$21, is_favorite=$22,
         notes=$23, updated_at=NOW()
       WHERE id=$1 AND organization_id=$2 AND archived_at IS NULL
       RETURNING *`,
      [requireUuid(id, "creative ID"), context.organizationId, safeCompetitorId,
        input.sourceProvider, input.provenance, input.sourceAdId, input.sourceUrl,
        input.channel, input.adFormat, input.headline, input.body, input.callToAction,
        input.landingUrl, input.creativeUrl, input.previewImageUrl, input.keywords,
        input.countries, input.tags, input.firstSeenAt, input.lastSeenAt, input.isActive,
        input.isFavorite, input.notes]
    );
    if (!result.rows[0]) throw intelligenceError("Creative was not found.", 404, "GOODADS_CREATIVE_NOT_FOUND");
  } else {
    result = await query(
      `INSERT INTO goodads_competitor_creatives (
         competitor_id, organization_id, project_id, environment_id, captured_by_user_id,
         source_provider, provenance, source_ad_id, source_url, channel, ad_format,
         headline, body, call_to_action, landing_url, creative_url, preview_image_url,
         keywords, countries, tags, first_seen_at, last_seen_at, is_active, is_favorite, notes
       ) VALUES (
         $1,$2,$3,$4,$5::uuid,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18::text[],$19::text[],$20::text[],$21,$22,$23,$24,$25
       ) RETURNING *`,
      [safeCompetitorId, context.organizationId, context.projectId, context.environmentId, userId,
        input.sourceProvider, input.provenance, input.sourceAdId, input.sourceUrl,
        input.channel, input.adFormat, input.headline, input.body, input.callToAction,
        input.landingUrl, input.creativeUrl, input.previewImageUrl, input.keywords,
        input.countries, input.tags, input.firstSeenAt, input.lastSeenAt, input.isActive,
        input.isFavorite, input.notes]
    ).catch((error) => {
      if (error.code === "23505") {
        throw intelligenceError("This provider ad is already in the creative library.", 409, "GOODADS_CREATIVE_EXISTS");
      }
      throw error;
    });
  }
  return { ...rowToCreative(result.rows[0]), competitorName: competitor.displayName, competitorDomain: competitor.domain };
}

async function archiveCreative({ id, context }) {
  requireWrite(context);
  const result = await query(
    `UPDATE goodads_competitor_creatives
     SET archived_at=NOW(), is_active=FALSE, updated_at=NOW()
     WHERE id=$1 AND organization_id=$2 AND archived_at IS NULL
     RETURNING id`,
    [requireUuid(id, "creative ID"), context.organizationId]
  );
  if (!result.rows[0]) throw intelligenceError("Creative was not found.", 404, "GOODADS_CREATIVE_NOT_FOUND");
  return { id: result.rows[0].id, archived: true };
}

function extractRows(value, depth = 0) {
  if (depth > 3 || value == null) return [];
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object").slice(0, 100);
  if (typeof value !== "object") return [];
  for (const key of ["data", "records", "results", "items", "publishers", "networks", "competitors"]) {
    const rows = extractRows(value[key], depth + 1);
    if (rows.length) return rows;
  }
  for (const nested of Object.values(value)) {
    const rows = extractRows(nested, depth + 1);
    if (rows.length) return rows;
  }
  return [];
}

function numberFrom(item, keys) {
  for (const key of keys) {
    const value = Number(item?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function textFrom(item, keys) {
  for (const key of keys) {
    const value = boundedText(item?.[key], 500);
    if (value) return value;
  }
  return "";
}

function normalizeProviderMetrics(payloads) {
  const ppcRows = extractRows(payloads.ppcSpend);
  const competitorRows = extractRows(payloads.paidCompetitors);
  const publisherRows = extractRows(payloads.publishers);
  const networkRows = extractRows(payloads.adNetworks);
  const ppcTotal = ppcRows.reduce((total, item) => total + Math.max(numberFrom(item, [
    "ppc_spend", "spend", "value", "amount", "total",
  ]), 0), 0);
  return {
    methodology: "Licensed Similarweb API estimates. These values are not advertiser-verified results.",
    ppcSpend: {
      total: ppcTotal,
      currency: textFrom(ppcRows[0] || {}, ["currency", "currency_code"]) || "USD",
    },
    paidCompetitors: competitorRows.map((item) => ({
      domain: textFrom(item, ["domain", "website", "site", "competitor"]),
      overlapScore: numberFrom(item, ["score", "overlap", "overlap_score", "similarity"]),
      sharedKeywords: numberFrom(item, ["shared_keywords", "sharedKeywords", "keywords"]),
    })).filter((item) => item.domain).slice(0, 50),
    publishers: publisherRows.map((item) => ({
      domain: textFrom(item, ["domain", "publisher", "website", "site"]),
      share: numberFrom(item, ["share", "traffic_share", "trafficShare", "percentage"]),
      visits: numberFrom(item, ["visits", "traffic", "value"]),
    })).filter((item) => item.domain).slice(0, 50),
    adNetworks: networkRows.map((item) => ({
      name: textFrom(item, ["name", "network", "domain", "ad_network"]),
      share: numberFrom(item, ["share", "traffic_share", "trafficShare", "percentage"]),
    })).filter((item) => item.name).slice(0, 50),
  };
}

async function similarwebRequest(pathname, parameters = {}) {
  const apiKey = boundedText(process.env.GOODADS_SIMILARWEB_API_KEY, 2000);
  if (!apiKey) {
    throw intelligenceError(
      "Licensed Similarweb intelligence is not configured. Add a Similarweb API key in GoodBase.",
      503,
      "GOODADS_SIMILARWEB_NOT_CONFIGURED"
    );
  }
  const url = new URL(`https://api.similarweb.com${pathname}`);
  url.searchParams.set("api_key", apiKey);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "GoodAds/1.0" },
      signal: AbortSignal.timeout(25000),
    });
  } catch (error) {
    throw intelligenceError(
      error.name === "TimeoutError"
        ? "Similarweb intelligence timed out."
        : "GoodBase could not reach Similarweb intelligence.",
      502,
      "GOODADS_SIMILARWEB_UNREACHABLE",
      true
    );
  }
  const text = await response.text();
  if (text.length > 2_000_000) {
    throw intelligenceError("Similarweb returned an oversized response.", 502, "GOODADS_SIMILARWEB_RESPONSE_TOO_LARGE");
  }
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw intelligenceError("Similarweb returned an unreadable response.", 502, "GOODADS_SIMILARWEB_RESPONSE_INVALID");
  }
  if (!response.ok) {
    throw intelligenceError(
      boundedText(payload?.meta?.error || payload?.message || "Similarweb rejected the intelligence request.", 1000),
      response.status === 401 || response.status === 403 ? 409 : 502,
      "GOODADS_SIMILARWEB_REQUEST_FAILED",
      response.status === 429 || response.status >= 500
    );
  }
  return payload;
}

async function fetchSimilarweb(domain, country) {
  const end = new Date();
  const start = new Date(end.getTime() - 89 * 86400000);
  const common = {
    start_date: start.toISOString().slice(0, 7),
    end_date: end.toISOString().slice(0, 7),
    country,
    granularity: "monthly",
    main_domain_only: "false",
    format: "json",
  };
  const encodedDomain = encodeURIComponent(domain);
  const [ppcSpend, paidCompetitors, publishers, adNetworks] = await Promise.all([
    similarwebRequest(`/v1/website/${encodedDomain}/ppc-spend/total`, common),
    similarwebRequest(`/v4/website/${encodedDomain}/search-competitors/paidsearchcompetitors`, common),
    similarwebRequest(`/v4/website/${encodedDomain}/traffic-sources/publishers`, common),
    similarwebRequest(`/v4/website/${encodedDomain}/traffic-sources/ad-networks`, common),
  ]);
  return { ppcSpend, paidCompetitors, publishers, adNetworks };
}

function compactProviderPayload(payloads) {
  const compact = {};
  for (const [key, payload] of Object.entries(payloads)) {
    const serialized = JSON.stringify(payload);
    compact[key] = serialized.length <= 250000
      ? payload
      : { truncated: true, byteLength: Buffer.byteLength(serialized), rows: extractRows(payload).slice(0, 25) };
  }
  return compact;
}

async function performSync({ competitor, organizationId }) {
  try {
    const providerPayload = await fetchSimilarweb(competitor.domain, competitor.country);
    const metrics = normalizeProviderMetrics(providerPayload);
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(metrics)).digest("hex");
    const previous = await query(
      `SELECT fingerprint FROM goodads_competitor_snapshots
       WHERE competitor_id=$1 AND status='completed'
       ORDER BY captured_at DESC LIMIT 1`,
      [competitor.id]
    );
    await query(
      `INSERT INTO goodads_competitor_snapshots (
         competitor_id, organization_id, source_provider, country, status,
         metrics, provider_payload, fingerprint
       ) VALUES ($1,$2,'similarweb',$3,'completed',$4::jsonb,$5::jsonb,$6)`,
      [competitor.id, organizationId, competitor.country, JSON.stringify(metrics),
        JSON.stringify(compactProviderPayload(providerPayload)), fingerprint]
    );
    await query(
      `UPDATE goodads_competitors SET last_synced_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [competitor.id]
    );
    if (previous.rows[0]?.fingerprint && previous.rows[0].fingerprint !== fingerprint) {
      await query(
        `INSERT INTO goodads_competitor_alerts (
           competitor_id, organization_id, alert_type, severity, title, description, details
         ) VALUES ($1,$2,'strategy_change','notice',$3,$4,$5::jsonb)`,
        [competitor.id, organizationId, `${competitor.display_name} intelligence changed`,
          "Licensed paid-search, publisher, ad-network, or spend signals changed since the prior snapshot.",
          JSON.stringify({ previousFingerprint: previous.rows[0].fingerprint, fingerprint })]
      );
    }
    return { status: "completed", capturedAt: new Date().toISOString(), metrics };
  } catch (error) {
    await query(
      `INSERT INTO goodads_competitor_snapshots (
         competitor_id, organization_id, source_provider, country, status, error_message
       ) VALUES ($1,$2,'similarweb',$3,'failed',$4)`,
      [competitor.id, organizationId, competitor.country, boundedText(error.message, 2000)]
    ).catch(() => {});
    await query(
      `INSERT INTO goodads_competitor_alerts (
         competitor_id, organization_id, alert_type, severity, title, description, details
       ) VALUES ($1,$2,'sync_failed','warning',$3,$4,$5::jsonb)`,
      [competitor.id, organizationId, `${competitor.display_name} sync needs attention`,
        boundedText(error.message, 2000), JSON.stringify({ retryable: error.retryable === true })]
    ).catch(() => {});
    throw error;
  }
}

async function syncCompetitor({ id, context }) {
  requireManagement(context);
  const competitor = await getCompetitor({ id, context });
  return performSync({
    competitor: {
      id: competitor.id,
      domain: competitor.domain,
      country: competitor.country,
      display_name: competitor.displayName,
    },
    organizationId: context.organizationId,
  });
}

async function syncDueCompetitors(limit = 10) {
  if (!boundedText(process.env.GOODADS_SIMILARWEB_API_KEY, 2000)) {
    return { skipped: true, reason: "Licensed Similarweb API is not configured.", attempted: 0, results: [] };
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const result = await query(
    `SELECT * FROM goodads_competitors
     WHERE status='active' AND archived_at IS NULL
       AND (last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL '6 hours')
     ORDER BY COALESCE(last_synced_at, created_at) ASC LIMIT $1`,
    [safeLimit]
  );
  const outcomes = [];
  for (const competitor of result.rows) {
    try {
      const synced = await performSync({ competitor, organizationId: competitor.organization_id });
      outcomes.push({ competitorId: competitor.id, status: synced.status });
    } catch (error) {
      outcomes.push({
        competitorId: competitor.id,
        status: "failed",
        retryable: error.retryable === true,
        error: boundedText(error.message, 500),
      });
    }
  }
  return { skipped: false, attempted: outcomes.length, results: outcomes };
}

async function listAlerts({ context, limit = 50 }) {
  const result = await query(
    `SELECT alert.*, competitor.display_name AS competitor_name, competitor.domain AS competitor_domain
     FROM goodads_competitor_alerts alert
     JOIN goodads_competitors competitor ON competitor.id=alert.competitor_id
     WHERE alert.organization_id=$1
     ORDER BY (alert.acknowledged_at IS NULL) DESC, alert.created_at DESC
     LIMIT $2`,
    [context.organizationId, Math.min(Math.max(Number(limit) || 50, 1), 100)]
  );
  return {
    items: result.rows.map((row) => ({
      id: row.id,
      competitorId: row.competitor_id,
      competitorName: row.competitor_name,
      competitorDomain: row.competitor_domain,
      alertType: row.alert_type,
      severity: row.severity,
      title: row.title,
      description: row.description,
      details: row.details || {},
      acknowledgedAt: row.acknowledged_at,
      createdAt: row.created_at,
    })),
  };
}

async function acknowledgeAlert({ id, context, userId }) {
  requireWrite(context);
  const result = await query(
    `UPDATE goodads_competitor_alerts
     SET acknowledged_at=COALESCE(acknowledged_at,NOW()),
       acknowledged_by_user_id=COALESCE(acknowledged_by_user_id,$3::uuid)
     WHERE id=$1 AND organization_id=$2 RETURNING id, acknowledged_at`,
    [requireUuid(id, "alert ID"), context.organizationId, userId]
  );
  if (!result.rows[0]) throw intelligenceError("Alert was not found.", 404, "GOODADS_COMPETITOR_ALERT_NOT_FOUND");
  return { id: result.rows[0].id, acknowledgedAt: result.rows[0].acknowledged_at };
}

async function overview({ context }) {
  const [counts, channelMix, formatMix, ctaMix, landingDomains, latestSnapshot] = await Promise.all([
    query(
      `SELECT
         COUNT(DISTINCT competitor.id)::integer AS competitors,
         COUNT(DISTINCT creative.id)::integer AS creatives,
         COUNT(DISTINCT creative.id) FILTER (WHERE creative.is_active)::integer AS active_creatives,
         COUNT(DISTINCT alert.id) FILTER (WHERE alert.acknowledged_at IS NULL)::integer AS open_alerts,
         MAX(COALESCE(creative.last_seen_at, creative.created_at)) AS latest_observation
       FROM goodads_competitors competitor
       LEFT JOIN goodads_competitor_creatives creative
         ON creative.competitor_id=competitor.id AND creative.archived_at IS NULL
       LEFT JOIN goodads_competitor_alerts alert ON alert.competitor_id=competitor.id
       WHERE competitor.organization_id=$1 AND competitor.archived_at IS NULL`,
      [context.organizationId]
    ),
    query(
      `SELECT channel AS label, COUNT(*)::integer AS value
       FROM goodads_competitor_creatives
       WHERE organization_id=$1 AND archived_at IS NULL GROUP BY channel ORDER BY value DESC`,
      [context.organizationId]
    ),
    query(
      `SELECT ad_format AS label, COUNT(*)::integer AS value
       FROM goodads_competitor_creatives
       WHERE organization_id=$1 AND archived_at IS NULL GROUP BY ad_format ORDER BY value DESC`,
      [context.organizationId]
    ),
    query(
      `SELECT call_to_action AS label, COUNT(*)::integer AS value
       FROM goodads_competitor_creatives
       WHERE organization_id=$1 AND archived_at IS NULL AND call_to_action <> ''
       GROUP BY call_to_action ORDER BY value DESC LIMIT 10`,
      [context.organizationId]
    ),
    query(
      `SELECT LOWER(SPLIT_PART(REGEXP_REPLACE(landing_url, '^https?://', ''), '/', 1)) AS label,
         COUNT(*)::integer AS value
       FROM goodads_competitor_creatives
       WHERE organization_id=$1 AND archived_at IS NULL AND landing_url IS NOT NULL
       GROUP BY 1 ORDER BY value DESC LIMIT 10`,
      [context.organizationId]
    ),
    query(
      `SELECT snapshot.metrics, snapshot.captured_at, competitor.display_name AS competitor_name
       FROM goodads_competitor_snapshots snapshot
       JOIN goodads_competitors competitor ON competitor.id=snapshot.competitor_id
       WHERE snapshot.organization_id=$1 AND snapshot.status='completed'
       ORDER BY snapshot.captured_at DESC LIMIT 1`,
      [context.organizationId]
    ),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      competitors: Number(counts.rows[0]?.competitors || 0),
      creatives: Number(counts.rows[0]?.creatives || 0),
      activeCreatives: Number(counts.rows[0]?.active_creatives || 0),
      openAlerts: Number(counts.rows[0]?.open_alerts || 0),
      latestObservation: counts.rows[0]?.latest_observation || null,
    },
    observedPatterns: {
      channelMix: channelMix.rows,
      formatMix: formatMix.rows,
      callsToAction: ctaMix.rows,
      landingDomains: landingDomains.rows,
    },
    latestLicensedSnapshot: latestSnapshot.rows[0]
      ? {
        competitorName: latestSnapshot.rows[0].competitor_name,
        metrics: latestSnapshot.rows[0].metrics,
        capturedAt: latestSnapshot.rows[0].captured_at,
      }
      : null,
    methodology: {
      observed: "Creative patterns use only ads captured by your workspace from identified public sources.",
      licensed: "Provider metrics are estimates from a licensed API and are labeled separately.",
    },
  };
}

function capabilities() {
  const similarwebConfigured = Boolean(boundedText(process.env.GOODADS_SIMILARWEB_API_KEY, 2000));
  return {
    competitorIntelligence: {
      available: true,
      durableHistory: true,
      monitoringAlerts: true,
      licensedProvider: "similarweb",
      licensedProviderConfigured: similarwebConfigured,
      researchSources: [
        "google_transparency", "meta_library", "tiktok_creative_center", "linkedin_ad_library",
      ],
      reason: similarwebConfigured
        ? undefined
        : "Creative capture and public research are available. Add a Similarweb API key to enable licensed traffic and spend estimates.",
    },
  };
}

module.exports = {
  listCompetitors,
  getCompetitor,
  saveCompetitor,
  archiveCompetitor,
  listCreatives,
  saveCreative,
  archiveCreative,
  syncCompetitor,
  syncDueCompetitors,
  listAlerts,
  acknowledgeAlert,
  overview,
  capabilities,
  _test: {
    normalizeDomain,
    optionalHttpsUrl,
    normalizeCompetitorPayload,
    normalizeCreativePayload,
    normalizeProviderMetrics,
    researchLinks,
  },
};
