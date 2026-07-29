"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");
const { pool, query } = require("../config/database");

const RESOURCE_TYPES = new Set([
  "campaigns", "content", "approvals", "calendar", "connections",
  "publishing_jobs", "analytics", "media", "link_hubs", "automations",
  "notifications", "email_campaigns", "designs", "flyers",
  "business_cards", "qr_codes", "videos", "brand", "audit_events",
  "funnels", "lead_forms", "leads", "rss_feeds",
]);
const RESOURCE_STATUSES = new Set([
  "draft", "ready", "pending", "approved", "rejected", "scheduled",
  "queued", "processing", "active", "paused", "completed", "failed",
  "connected", "disconnected", "expired", "archived",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MUTATING_ROLES = new Set(["owner", "admin", "manager", "editor", "member"]);
const DESTRUCTIVE_ROLES = new Set(["owner", "admin", "manager"]);

function serviceError(message, statusCode = 400, code = "GOODADS_REQUEST_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function requireResourceType(type) {
  if (!RESOURCE_TYPES.has(type)) throw serviceError("Unsupported GoodAds resource.", 404, "GOODADS_RESOURCE_NOT_FOUND");
  return type;
}

function requireResourceStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (!RESOURCE_STATUSES.has(status)) {
    throw serviceError("Unsupported GoodAds resource status.", 400, "GOODADS_STATUS_INVALID");
  }
  return status;
}

function normalizePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError("A JSON object is required.");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 262144) {
    throw serviceError("Resource payload exceeds 256 KB.", 413, "GOODADS_PAYLOAD_TOO_LARGE");
  }
  return JSON.parse(encoded);
}

function requireUuid(value) {
  const id = String(value || "").trim();
  if (!UUID_PATTERN.test(id)) throw serviceError("A valid resource ID is required.");
  return id;
}

function requirePublicSlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  if (!PUBLIC_SLUG_PATTERN.test(slug)) {
    throw serviceError("A valid lead form address is required.", 400, "GOODADS_FORM_SLUG_INVALID");
  }
  return slug;
}

function boundedText(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function requireHttpsUrl(value, label = "URL") {
  const text = boundedText(value, 2048);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw serviceError(`${label} must be a complete HTTPS address.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw serviceError(`${label} must use HTTPS without embedded credentials or a custom port.`);
  }
  return url;
}

function blockedIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  );
}

function blockedIp(address) {
  const family = net.isIP(address);
  if (family === 4) return blockedIpv4(address);
  if (family !== 6) return true;
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:")) return blockedIpv4(normalized.slice(7));
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8");
}

async function requirePublicFeedUrl(value) {
  const url = requireHttpsUrl(value, "Feed URL");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname === "metadata.google.internal"
  ) {
    throw serviceError("Feed URL must use a public internet host.", 400, "GOODADS_FEED_HOST_BLOCKED");
  }
  const directIp = net.isIP(hostname);
  const addresses = directIp
    ? [{ address: hostname, family: directIp }]
    : await dns.lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some((entry) => blockedIp(entry.address))) {
    throw serviceError("Feed URL must resolve only to public internet addresses.", 400, "GOODADS_FEED_HOST_BLOCKED");
  }
  return { url, addresses };
}

function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    const requestedFamily = Number(options?.family || 0);
    const eligible = requestedFamily
      ? addresses.filter((entry) => entry.family === requestedFamily)
      : addresses;
    const selected = eligible[0] || addresses[0];
    if (!selected) return callback(new Error("No validated feed address is available."));
    if (options?.all) return callback(null, eligible.length ? eligible : addresses);
    return callback(null, selected.address, selected.family);
  };
}

function requestPinnedFeed(resolved, maximumBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: "https:",
      hostname: resolved.url.hostname,
      port: 443,
      method: "GET",
      path: `${resolved.url.pathname}${resolved.url.search}`,
      servername: resolved.url.hostname,
      lookup: pinnedLookup(resolved.addresses),
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        "User-Agent": "GoodAds-FeedFetcher/1.0",
      },
    }, (response) => {
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > maximumBytes) {
        response.destroy();
        reject(serviceError("RSS response exceeds 2 MB.", 413, "GOODADS_FEED_TOO_LARGE"));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maximumBytes) {
          response.destroy(serviceError("RSS response exceeds 2 MB.", 413, "GOODADS_FEED_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: Number(response.statusCode || 0),
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", reject);
    });
    request.setTimeout(15000, () => request.destroy(
      serviceError("The RSS provider timed out.", 502, "GOODADS_FEED_UNAVAILABLE")
    ));
    request.on("error", (error) => reject(
      Number.isInteger(error.statusCode)
        ? error
        : serviceError("The RSS provider could not be reached.", 502, "GOODADS_FEED_UNAVAILABLE")
    ));
    request.end();
  });
}

async function fetchPublicFeed(value) {
  let resolved = await requirePublicFeedUrl(value);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await requestPinnedFeed(resolved);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location || redirect === 3) {
        throw serviceError("RSS feed redirected too many times.", 502, "GOODADS_FEED_REDIRECT_INVALID");
      }
      resolved = await requirePublicFeedUrl(new URL(location, resolved.url).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw serviceError(`RSS provider returned HTTP ${response.status}.`, 502, "GOODADS_FEED_PROVIDER_REJECTED");
    }
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    if (contentType && !/(?:xml|rss|atom|text\/plain)/.test(contentType)) {
      throw serviceError("RSS provider returned an unsupported content type.", 422, "GOODADS_FEED_CONTENT_INVALID");
    }
    return { xml: response.body, sourceUrl: resolved.url.toString() };
  }
  throw serviceError("RSS feed could not be loaded.", 502, "GOODADS_FEED_UNAVAILABLE");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Math.min(Number(code) || 0, 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Math.min(Number.parseInt(code, 16) || 0, 0x10ffff)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function textFromXml(value, maximum = 4000) {
  return boundedText(decodeXml(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " "), maximum);
}

function tagValue(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match) return match[1];
  }
  return "";
}

function parseFeedXml(xml) {
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(xml)) {
    throw serviceError("The response is not a valid RSS or Atom feed.", 422, "GOODADS_FEED_CONTENT_INVALID");
  }
  const title = textFromXml(tagValue(xml, ["title"]), 240) || "RSS feed";
  const blocks = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
  const items = blocks.slice(0, 50).map((block, index) => {
    const atomHref = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1];
    const linkValue = decodeXml(atomHref || textFromXml(tagValue(block, ["link"]), 2048));
    let link = null;
    try {
      link = requireHttpsUrl(linkValue, "Feed item link").toString();
    } catch {
      link = null;
    }
    const externalId = textFromXml(tagValue(block, ["guid", "id"]), 500)
      || link
      || crypto.createHash("sha256").update(block).digest("hex");
    const publishedValue = textFromXml(tagValue(block, ["pubDate", "published", "updated", "dc:date"]), 120);
    const publishedDate = publishedValue ? new Date(publishedValue) : null;
    return {
      id: crypto.createHash("sha256").update(externalId).digest("hex").slice(0, 32),
      externalId,
      title: textFromXml(tagValue(block, ["title"]), 500) || `Feed item ${index + 1}`,
      summary: textFromXml(tagValue(block, ["description", "summary", "content", "content:encoded"]), 4000),
      url: link,
      publishedAt: publishedDate && !Number.isNaN(publishedDate.getTime())
        ? publishedDate.toISOString()
        : null,
    };
  });
  return { title, items };
}

function normalizeHubLinks(value, primaryDestination = "", skipInvalid = false) {
  const links = [];
  const values = Array.isArray(value) ? value.slice(0, 25) : [];
  if (!values.length && primaryDestination) {
    values.push({ id: "primary", label: "Visit now", url: primaryDestination });
  }
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item || typeof item !== "object") continue;
    let url;
    try {
      url = requireHttpsUrl(item.url || item.destinationUrl, `Link ${index + 1}`).toString();
    } catch (error) {
      if (skipInvalid) continue;
      throw error;
    }
    links.push({
      id: boundedText(item.id, 80) || crypto.randomUUID(),
      label: boundedText(item.label || item.title, 120) || `Link ${index + 1}`,
      url,
      description: boundedText(item.description, 300),
    });
  }
  return links;
}

function normalizeGenerationInput(value) {
  const data = normalizePayload(value);
  const businessName = boundedText(data.businessName, 160);
  if (businessName.length < 2) {
    throw serviceError("A business name is required for content generation.", 400, "GOODADS_GENERATION_BUSINESS_REQUIRED");
  }
  return {
    type: boundedText(data.type || "social_post", 80),
    businessName,
    audience: boundedText(data.audience, 1000),
    goal: boundedText(data.goal, 1000),
    tone: boundedText(data.tone || "Professional", 80),
    platform: boundedText(data.platform, 80),
    format: boundedText(data.format, 80),
    offer: boundedText(data.offer, 1000),
    callToAction: boundedText(data.callToAction, 240),
    additionalInfo: boundedText(data.additionalInfo, 3000),
  };
}

async function generateContent({ payload, context }) {
  requireMutationRole(context);
  const input = normalizeGenerationInput(payload);
  const apiKey = boundedText(
    process.env.GOODADS_GEMINI_API_KEY
      || process.env.GEMINI_API_KEY
      || process.env.GOOGLE_AI_API_KEY,
    500
  );
  const model = boundedText(process.env.GOODADS_GEMINI_MODEL || "gemini-2.5-flash", 120);
  if (!apiKey) {
    throw serviceError(
      "GoodAds AI generation is not configured in GoodBase.",
      503,
      "GOODADS_GENERATION_NOT_CONFIGURED"
    );
  }

  const instructions = [
    "Create production-ready marketing content. Return only the requested content without analysis or markdown fences.",
    `Asset type: ${input.type}`,
    `Business: ${input.businessName}`,
    input.audience && `Audience: ${input.audience}`,
    input.goal && `Goal: ${input.goal}`,
    `Tone: ${input.tone}`,
    input.platform && `Platform: ${input.platform}`,
    input.format && `Format: ${input.format}`,
    input.offer && `Offer: ${input.offer}`,
    input.callToAction && `Call to action: ${input.callToAction}`,
    input.additionalInfo && `Additional requirements: ${input.additionalInfo}`,
    "Do not invent prices, statistics, testimonials, guarantees, or regulatory claims.",
  ].filter(Boolean).join("\n");

  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: instructions }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
        }),
        signal: AbortSignal.timeout(45000),
      }
    );
  } catch {
    throw serviceError(
      "The configured AI provider could not be reached.",
      502,
      "GOODADS_GENERATION_PROVIDER_UNAVAILABLE"
    );
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerMessage = boundedText(body?.error?.message, 300);
    throw serviceError(
      providerMessage || "The configured AI provider rejected the request.",
      502,
      "GOODADS_GENERATION_PROVIDER_REJECTED"
    );
  }
  const content = boundedText(
    (body?.candidates?.[0]?.content?.parts || [])
      .map((part) => part?.text || "")
      .join("\n"),
    20000
  );
  if (!content) {
    throw serviceError("The AI provider returned no content.", 502, "GOODADS_GENERATION_EMPTY");
  }
  return { content, provider: "google-gemini", model };
}

function normalizeLeadSubmission(value) {
  const data = normalizePayload(value);
  if (boundedText(data.website, 200)) {
    throw serviceError("The lead submission was rejected.", 400, "GOODADS_LEAD_SPAM_REJECTED");
  }

  const email = boundedText(data.email, 320).toLowerCase();
  const phone = boundedText(data.phone, 40);
  if (!email && !phone) {
    throw serviceError(
      "An email address or phone number is required.",
      400,
      "GOODADS_LEAD_CONTACT_REQUIRED"
    );
  }
  if (email && !EMAIL_PATTERN.test(email)) {
    throw serviceError("Enter a valid email address.", 400, "GOODADS_LEAD_EMAIL_INVALID");
  }

  return {
    firstName: boundedText(data.firstName, 100),
    lastName: boundedText(data.lastName, 100),
    email,
    phone,
    company: boundedText(data.company, 160),
    message: boundedText(data.message, 4000),
    consent: data.consent === true,
    source: boundedText(data.source || "lead-form", 120),
    pageUrl: boundedText(data.pageUrl, 2048),
    utm: {
      source: boundedText(data.utm?.source, 120),
      medium: boundedText(data.utm?.medium, 120),
      campaign: boundedText(data.utm?.campaign, 120),
      content: boundedText(data.utm?.content, 120),
      term: boundedText(data.utm?.term, 120),
    },
  };
}

function roleFromContext(context) {
  return String(context?.organization?.membershipRole || "").toLowerCase();
}

function requireMutationRole(context) {
  if (!MUTATING_ROLES.has(roleFromContext(context))) {
    throw serviceError("Your organization role cannot modify GoodAds resources.", 403, "GOODADS_WRITE_FORBIDDEN");
  }
}

function requireDestructiveRole(context) {
  if (!DESTRUCTIVE_ROLES.has(roleFromContext(context))) {
    throw serviceError("Owner, admin, or manager access is required.", 403, "GOODADS_DELETE_FORBIDDEN");
  }
}

function rowToResource(row) {
  return {
    ...(row.data || {}),
    id: row.id,
    resourceType: row.resource_type,
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listResources({ type, context, limit = 50, offset = 0, status = null }) {
  requireResourceType(type);
  const statusFilter = status ? requireResourceStatus(status) : null;
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const boundedOffset = Math.max(Number(offset) || 0, 0);
  const result = await query(
    `SELECT * FROM goodads_resources
     WHERE organization_id = $1 AND resource_type = $2
       AND archived_at IS NULL
       AND ($3::text IS NULL OR status = $3)
     ORDER BY updated_at DESC
     LIMIT $4 OFFSET $5`,
    [context.organizationId, type, statusFilter, boundedLimit, boundedOffset]
  );
  const count = await query(
    `SELECT COUNT(*)::integer AS count FROM goodads_resources
     WHERE organization_id = $1 AND resource_type = $2
       AND archived_at IS NULL AND ($3::text IS NULL OR status = $3)`,
    [context.organizationId, type, statusFilter]
  );
  return { items: result.rows.map(rowToResource), total: count.rows[0]?.count || 0, limit: boundedLimit, offset: boundedOffset };
}

async function getResource({ type, id, context }) {
  requireResourceType(type);
  const result = await query(
    `SELECT * FROM goodads_resources
     WHERE id = $1::uuid AND organization_id = $2 AND resource_type = $3
       AND archived_at IS NULL`,
    [requireUuid(id), context.organizationId, type]
  );
  if (!result.rows[0]) throw serviceError("GoodAds resource not found.", 404, "GOODADS_RECORD_NOT_FOUND");
  return rowToResource(result.rows[0]);
}

async function upsertResource({ type, id, payload, context, userId }) {
  requireMutationRole(context);
  requireResourceType(type);
  const data = normalizePayload(payload);
  const resourceId = id ? requireUuid(id) : (data.id && UUID_PATTERN.test(String(data.id)) ? String(data.id) : null);
  const name = String(data.name || data.title || "").trim().slice(0, 240);
  const status = requireResourceStatus(data.status || "draft");
  if (["lead_forms", "link_hubs"].includes(type) && data.publicSlug) {
    data.publicSlug = requirePublicSlug(data.publicSlug);
  }
  if (type === "lead_forms" && status === "active" && !data.publicSlug) {
    throw serviceError(
      "A public lead form address is required before publishing.",
      400,
      "GOODADS_FORM_SLUG_REQUIRED"
    );
  }
  if (type === "link_hubs") {
    if (status === "active" && !data.publicSlug) {
      throw serviceError(
        "A public link-hub address is required before publishing.",
        400,
        "GOODADS_LINK_HUB_SLUG_REQUIRED"
      );
    }
    if (data.destinationUrl) {
      data.destinationUrl = requireHttpsUrl(data.destinationUrl, "Primary destination").toString();
    }
    const formLinks = [
      data.destinationUrl && {
        id: "primary",
        label: data.destinationLabel || "Visit now",
        description: data.destinationDescription,
        url: data.destinationUrl,
      },
      ...[1, 2, 3, 4].map((index) => data[`linkUrl${index}`] && ({
        id: `link-${index}`,
        label: data[`linkLabel${index}`] || `Link ${index + 1}`,
        description: data[`linkDescription${index}`],
        url: data[`linkUrl${index}`],
      })),
    ].filter(Boolean);
    data.links = normalizeHubLinks(formLinks.length ? formLinks : data.links, data.destinationUrl);
    if (status === "active" && !data.links.length) {
      throw serviceError(
        "Add at least one HTTPS destination before publishing.",
        400,
        "GOODADS_LINK_HUB_DESTINATION_REQUIRED"
      );
    }
  }
  if (type === "rss_feeds") {
    data.feedUrl = requireHttpsUrl(data.feedUrl, "Feed URL").toString();
  }
  const result = await query(
    `INSERT INTO goodads_resources (
       id, resource_type, organization_id, project_id, environment_id,
       owner_user_id, name, status, data
     ) VALUES (
       COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6::uuid, $7, $8, $9::jsonb
     )
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       data = EXCLUDED.data,
       version = goodads_resources.version + 1,
       updated_at = NOW()
     WHERE goodads_resources.organization_id = EXCLUDED.organization_id
       AND goodads_resources.resource_type = EXCLUDED.resource_type
     RETURNING *`,
    [resourceId, type, context.organizationId, context.projectId, context.environmentId, userId, name, status, JSON.stringify(data)]
  );
  if (!result.rows[0]) throw serviceError("The resource belongs to another tenant.", 409, "GOODADS_TENANT_CONFLICT");
  await recordEvent({
    resourceId: result.rows[0].id,
    context,
    userId,
    eventType: resourceId ? `${type}.updated` : `${type}.created`,
    nextStatus: result.rows[0].status,
  });
  return rowToResource(result.rows[0]);
}

function publicLinkHubFromRow(row) {
  const data = row.data || {};
  return {
    id: row.id,
    name: row.name,
    publicSlug: boundedText(data.publicSlug, 64),
    description: boundedText(data.description, 1000),
    audience: boundedText(data.audience, 240),
    campaignName: boundedText(data.campaignName, 240),
    avatarUrl: (() => {
      try {
        return data.avatarUrl ? requireHttpsUrl(data.avatarUrl, "Avatar").toString() : null;
      } catch {
        return null;
      }
    })(),
    links: normalizeHubLinks(data.links, data.destinationUrl, true),
    theme: {
      backgroundColor: /^#[0-9a-f]{6}$/i.test(String(data.backgroundColor || data.theme?.backgroundColor || ""))
        ? (data.backgroundColor || data.theme.backgroundColor)
        : "#171125",
      cardColor: /^#[0-9a-f]{6}$/i.test(String(data.cardColor || data.theme?.cardColor || ""))
        ? (data.cardColor || data.theme.cardColor)
        : "#ffffff",
      accentColor: /^#[0-9a-f]{6}$/i.test(String(data.accentColor || data.theme?.accentColor || ""))
        ? (data.accentColor || data.theme.accentColor)
        : "#7c3aed",
    },
  };
}

async function getPublicLinkHub(slug) {
  const result = await query(
    `SELECT * FROM goodads_resources
     WHERE resource_type = 'link_hubs' AND status = 'active'
       AND archived_at IS NULL AND data->>'publicSlug' = $1
     LIMIT 1`,
    [requirePublicSlug(slug)]
  );
  if (!result.rows[0]) {
    throw serviceError("This link hub is not available.", 404, "GOODADS_LINK_HUB_NOT_FOUND");
  }
  return publicLinkHubFromRow(result.rows[0]);
}

async function recordLinkHubClick({ slug, linkId, userAgent = "", referrer = "" }) {
  const normalizedSlug = requirePublicSlug(slug);
  const normalizedLinkId = boundedText(linkId, 80);
  if (!normalizedLinkId) throw serviceError("Select a valid link.", 400, "GOODADS_LINK_ID_REQUIRED");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT * FROM goodads_resources
       WHERE resource_type = 'link_hubs' AND status = 'active'
         AND archived_at IS NULL AND data->>'publicSlug' = $1
       LIMIT 1 FOR UPDATE`,
      [normalizedSlug]
    );
    const hub = selected.rows[0];
    if (!hub) throw serviceError("This link hub is not available.", 404, "GOODADS_LINK_HUB_NOT_FOUND");
    const publicHub = publicLinkHubFromRow(hub);
    const link = publicHub.links.find((item) => item.id === normalizedLinkId);
    if (!link) throw serviceError("This link is not available.", 404, "GOODADS_LINK_NOT_FOUND");
    await client.query(
      `UPDATE goodads_resources
       SET data = jsonb_set(
             data,
             '{clickCount}',
             to_jsonb(CASE WHEN COALESCE(data->>'clickCount', '') ~ '^[0-9]+$'
               THEN (data->>'clickCount')::integer + 1 ELSE 1 END),
             true
           ),
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1::uuid`,
      [hub.id]
    );
    await client.query(
      `INSERT INTO goodads_resource_events (
         resource_id, organization_id, actor_user_id, event_type, metadata
       ) VALUES ($1::uuid, $2, NULL, 'link_hubs.clicked', $3::jsonb)`,
      [
        hub.id,
        hub.organization_id,
        JSON.stringify({
          linkId: link.id,
          userAgent: boundedText(userAgent, 400),
          referrer: boundedText(referrer, 2048),
        }),
      ]
    );
    await client.query("COMMIT");
    return { url: link.url };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function syncRssFeed({ id, context, userId }) {
  requireMutationRole(context);
  const feed = await getResource({ type: "rss_feeds", id, context });
  try {
    const loaded = await fetchPublicFeed(feed.feedUrl);
    const parsed = parseFeedXml(loaded.xml);
    const syncedAt = new Date().toISOString();
    const result = await query(
      `UPDATE goodads_resources SET
         data = data || $1::jsonb,
         version = version + 1,
         updated_at = NOW()
       WHERE id = $2::uuid AND organization_id = $3 AND resource_type = 'rss_feeds'
         AND archived_at IS NULL
       RETURNING *`,
      [
        JSON.stringify({
          feedTitle: parsed.title,
          sourceUrl: loaded.sourceUrl,
          items: parsed.items,
          itemCount: parsed.items.length,
          lastSyncAt: syncedAt,
          syncStatus: "completed",
          lastError: null,
        }),
        requireUuid(id),
        context.organizationId,
      ]
    );
    await recordEvent({
      resourceId: id,
      context,
      userId,
      eventType: "rss_feeds.synced",
      metadata: { itemCount: parsed.items.length, sourceUrl: loaded.sourceUrl },
    });
    return rowToResource(result.rows[0]);
  } catch (error) {
    await query(
      `UPDATE goodads_resources SET
         data = data || $1::jsonb,
         version = version + 1,
         updated_at = NOW()
       WHERE id = $2::uuid AND organization_id = $3 AND resource_type = 'rss_feeds'
         AND archived_at IS NULL`,
      [
        JSON.stringify({
          syncStatus: "failed",
          lastError: boundedText(error.message || "RSS sync failed.", 500),
          lastSyncAt: new Date().toISOString(),
        }),
        requireUuid(id),
        context.organizationId,
      ]
    ).catch(() => {});
    throw error;
  }
}

async function repurposeRssItem({ id, itemId, payload, context, userId }) {
  requireMutationRole(context);
  const feed = await getResource({ type: "rss_feeds", id, context });
  const item = (Array.isArray(feed.items) ? feed.items : [])
    .find((candidate) => candidate && candidate.id === boundedText(itemId, 80));
  if (!item) throw serviceError("RSS item was not found.", 404, "GOODADS_FEED_ITEM_NOT_FOUND");
  const generated = await generateContent({
    payload: {
      ...normalizePayload(payload),
      type: payload?.type || "social_post",
      additionalInfo: [
        boundedText(payload?.additionalInfo, 2000),
        `Source title: ${boundedText(item.title, 500)}`,
        `Source summary: ${boundedText(item.summary, 4000)}`,
        item.url ? `Source URL: ${item.url}` : "",
        "Create original marketing copy. Do not copy sentences from the source.",
      ].filter(Boolean).join("\n"),
    },
    context,
  });
  const now = new Date().toISOString();
  const content = await upsertResource({
    type: "content",
    payload: {
      name: `${boundedText(item.title, 180)} — repurposed`,
      status: "draft",
      content: generated.content,
      sourceType: "rss",
      sourceFeedId: feed.id,
      sourceItemId: item.id,
      sourceUrl: item.url,
      provider: generated.provider,
      model: generated.model,
      createdAt: now,
      updatedAt: now,
    },
    context,
    userId,
  });
  return { content, generated };
}

async function archiveResource({ type, id, context, userId }) {
  requireDestructiveRole(context);
  requireResourceType(type);
  const current = await getResource({ type, id, context });
  const result = await query(
    `UPDATE goodads_resources
     SET status = 'archived', archived_at = NOW(), updated_at = NOW(), version = version + 1
     WHERE id = $1::uuid AND organization_id = $2 AND resource_type = $3
       AND archived_at IS NULL RETURNING *`,
    [requireUuid(id), context.organizationId, type]
  );
  if (!result.rows[0]) throw serviceError("GoodAds resource not found.", 404, "GOODADS_RECORD_NOT_FOUND");
  await recordEvent({ resourceId: result.rows[0].id, context, userId, eventType: `${type}.archived`, previousStatus: current.status, nextStatus: "archived" });
  return rowToResource(result.rows[0]);
}

async function transitionResource({ type, id, nextStatus, context, userId, eventType }) {
  requireMutationRole(context);
  requireResourceType(type);
  const normalizedNextStatus = requireResourceStatus(nextStatus);
  const current = await getResource({ type, id, context });
  const result = await query(
    `UPDATE goodads_resources
     SET status = $1, updated_at = NOW(), version = version + 1,
         data = data || jsonb_build_object('status', $1::text, 'updatedAt', NOW()::text)
     WHERE id = $2::uuid AND organization_id = $3 AND resource_type = $4
       AND archived_at IS NULL RETURNING *`,
    [normalizedNextStatus, requireUuid(id), context.organizationId, type]
  );
  await recordEvent({ resourceId: id, context, userId, eventType, previousStatus: current.status, nextStatus: normalizedNextStatus });
  return rowToResource(result.rows[0]);
}

async function recordEvent({ resourceId, context, userId, eventType, previousStatus = null, nextStatus = null, metadata = {} }) {
  await query(
    `INSERT INTO goodads_resource_events (
       resource_id, organization_id, actor_user_id, event_type,
       previous_status, next_status, metadata
     ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb)`,
    [resourceId, context.organizationId, userId, eventType, previousStatus, nextStatus, JSON.stringify(metadata)]
  );
}

async function dashboard(context) {
  const [
    resourceCounts,
    connectionCounts,
    publishingCounts,
    recentResources,
    wonLeads,
  ] = await Promise.all([
    query(
      `SELECT resource_type, status, COUNT(*)::integer AS count
     FROM goodads_resources
     WHERE organization_id = $1 AND archived_at IS NULL
     GROUP BY resource_type, status ORDER BY resource_type, status`,
      [context.organizationId]
    ),
    query(
      `SELECT status, COUNT(*)::integer AS count
       FROM goodads_social_connections
       WHERE organization_id = $1
       GROUP BY status ORDER BY status`,
      [context.organizationId]
    ),
    query(
      `SELECT status, COUNT(*)::integer AS count
       FROM goodads_publish_jobs
       WHERE organization_id = $1
       GROUP BY status ORDER BY status`,
      [context.organizationId]
    ),
    query(
      `SELECT *
       FROM goodads_resources
       WHERE organization_id = $1 AND archived_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 12`,
      [context.organizationId]
    ),
    query(
      `SELECT COUNT(*)::integer AS count
       FROM goodads_resources
       WHERE organization_id = $1 AND resource_type = 'leads'
         AND archived_at IS NULL AND data->>'stage' = 'won'`,
      [context.organizationId]
    ),
  ]);

  const totalFor = (rows, predicate = () => true) => rows
    .filter(predicate)
    .reduce((total, row) => total + Number(row.count || 0), 0);
  const resourceRows = resourceCounts.rows;
  const connectionRows = connectionCounts.rows;
  const publishingRows = publishingCounts.rows;

  return {
    organization: context.organization,
    project: context.project,
    environment: context.environment,
    metrics: {
      campaigns: totalFor(resourceRows, (row) => row.resource_type === "campaigns"),
      activeCampaigns: totalFor(resourceRows, (row) => row.resource_type === "campaigns" && row.status === "active"),
      content: totalFor(resourceRows, (row) => row.resource_type === "content"),
      scheduled: totalFor(resourceRows, (row) => row.status === "scheduled"),
      pendingApprovals: totalFor(resourceRows, (row) => row.resource_type === "approvals" && row.status === "pending"),
      connectedAccounts: totalFor(connectionRows, (row) => row.status === "connected"),
      publishingJobs: totalFor(publishingRows),
      publishingFailures: totalFor(publishingRows, (row) => row.status === "failed"),
      funnels: totalFor(resourceRows, (row) => row.resource_type === "funnels"),
      liveForms: totalFor(resourceRows, (row) => (
        row.resource_type === "lead_forms" && row.status === "active"
      )),
      leads: totalFor(resourceRows, (row) => row.resource_type === "leads"),
      wonLeads: wonLeads.rows[0]?.count || 0,
    },
    counts: {
      resources: resourceRows,
      connections: connectionRows,
      publishing: publishingRows,
    },
    recent: recentResources.rows.map(rowToResource),
    generatedAt: new Date().toISOString(),
  };
}

async function workspace(context) {
  const brand = await listResources({ type: "brand", context, limit: 1 });
  return {
    id: context.organization.id,
    name: context.organization.name,
    slug: context.organization.slug,
    plan: context.organization.plan,
    status: context.organization.status,
    role: context.organization.membershipRole,
    project: context.project,
    environment: context.environment,
    brand: brand.items[0] || null,
  };
}

function publicFormFromRow(row) {
  const data = row.data || {};
  const allowedFields = new Set([
    "firstName",
    "lastName",
    "email",
    "phone",
    "company",
    "message",
  ]);
  const fields = Array.isArray(data.fields)
    ? data.fields
      .filter((field) => (
        field
        && typeof field === "object"
        && allowedFields.has(String(field.id))
      ))
      .slice(0, 12)
      .map((field) => ({
        id: String(field.id),
        label: boundedText(field.label, 80) || String(field.id),
        type: ["text", "email", "tel", "textarea"].includes(String(field.type))
          ? String(field.type)
          : "text",
        required: field.required === true,
      }))
    : [];
  return {
    id: row.id,
    name: row.name,
    publicSlug: boundedText(data.publicSlug, 64),
    headline: boundedText(data.headline, 180),
    description: boundedText(data.description, 800),
    buttonLabel: boundedText(data.buttonLabel, 80) || "Get started",
    successMessage: boundedText(data.successMessage, 500)
      || "Thank you. We received your information.",
    fields,
    requireConsent: data.requireConsent === true,
    consentText: boundedText(data.consentText, 500),
    funnelId: UUID_PATTERN.test(String(data.funnelId || ""))
      ? String(data.funnelId)
      : null,
    theme: {
      backgroundColor: boundedText(data.theme?.backgroundColor, 20) || "#f8fafc",
      cardColor: boundedText(data.theme?.cardColor, 20) || "#ffffff",
      accentColor: boundedText(data.theme?.accentColor, 20) || "#4f46e5",
    },
  };
}

async function getPublicLeadForm(slug) {
  const result = await query(
    `SELECT * FROM goodads_resources
     WHERE resource_type = 'lead_forms' AND status = 'active'
       AND archived_at IS NULL AND data->>'publicSlug' = $1
     LIMIT 1`,
    [requirePublicSlug(slug)]
  );
  if (!result.rows[0]) {
    throw serviceError("This lead form is not available.", 404, "GOODADS_FORM_NOT_FOUND");
  }
  return publicFormFromRow(result.rows[0]);
}

async function recordLeadFormView(slug) {
  const result = await query(
    `UPDATE goodads_resources
     SET data = jsonb_set(
           data,
           '{viewCount}',
           to_jsonb(CASE WHEN COALESCE(data->>'viewCount', '') ~ '^[0-9]+$'
             THEN (data->>'viewCount')::integer + 1 ELSE 1 END),
           true
         ),
         version = version + 1,
         updated_at = NOW()
     WHERE resource_type = 'lead_forms' AND status = 'active'
       AND archived_at IS NULL AND data->>'publicSlug' = $1
     RETURNING id`,
    [requirePublicSlug(slug)]
  );
  if (!result.rows[0]) {
    throw serviceError("This lead form is not available.", 404, "GOODADS_FORM_NOT_FOUND");
  }
  return { recorded: true };
}

async function captureLead({ slug, payload, idempotencyKey, userAgent = "" }) {
  const normalizedSlug = requirePublicSlug(slug);
  const submission = normalizeLeadSubmission(payload);
  const requestKey = boundedText(idempotencyKey, 128);
  if (!requestKey) {
    throw serviceError(
      "An idempotency key is required.",
      400,
      "GOODADS_IDEMPOTENCY_REQUIRED"
    );
  }

  const client = await pool.connect();
  let organizationId = null;
  try {
    await client.query("BEGIN");
    const formResult = await client.query(
      `SELECT * FROM goodads_resources
       WHERE resource_type = 'lead_forms' AND status = 'active'
         AND archived_at IS NULL AND data->>'publicSlug' = $1
       LIMIT 1 FOR UPDATE`,
      [normalizedSlug]
    );
    const form = formResult.rows[0];
    if (!form) {
      throw serviceError("This lead form is not available.", 404, "GOODADS_FORM_NOT_FOUND");
    }
    if (form.data?.requireConsent === true && !submission.consent) {
      throw serviceError(
        "Consent is required before submitting this form.",
        400,
        "GOODADS_LEAD_CONSENT_REQUIRED"
      );
    }
    organizationId = form.organization_id;

    const duplicateRequest = await client.query(
      `SELECT resource_id FROM goodads_resource_events
       WHERE organization_id = $1 AND event_type = 'leads.captured'
         AND metadata->>'idempotencyKey' = $2
       LIMIT 1`,
      [form.organization_id, requestKey]
    );
    if (duplicateRequest.rows[0]) {
      await client.query("COMMIT");
      return {
        leadId: duplicateRequest.rows[0].resource_id,
        status: "received",
        duplicate: true,
      };
    }

    const identityClause = submission.email
      ? "LOWER(data->>'email') = $2"
      : "data->>'phone' = $2";
    const identityValue = submission.email || submission.phone;
    const existingResult = await client.query(
      `SELECT * FROM goodads_resources
       WHERE organization_id = $1 AND resource_type = 'leads'
         AND archived_at IS NULL AND ${identityClause}
       ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
      [form.organization_id, identityValue]
    );

    const now = new Date().toISOString();
    const funnelId = UUID_PATTERN.test(String(form.data?.funnelId || ""))
      ? String(form.data.funnelId)
      : null;
    const formId = String(form.id);
    const previous = existingResult.rows[0];
    const name = [submission.firstName, submission.lastName].filter(Boolean).join(" ")
      || submission.company
      || submission.email
      || submission.phone;
    let lead;

    if (previous) {
      const previousData = previous.data || {};
      const nextData = {
        ...previousData,
        ...submission,
        stage: previousData.stage || "new",
        score: Number(previousData.score) || 0,
        formId,
        funnelId,
        submissionCount: (Number(previousData.submissionCount) || 1) + 1,
        lastSubmittedAt: now,
        updatedAt: now,
      };
      const updated = await client.query(
        `UPDATE goodads_resources
         SET name = $1, data = $2::jsonb, version = version + 1, updated_at = NOW()
         WHERE id = $3::uuid RETURNING *`,
        [name, JSON.stringify(nextData), previous.id]
      );
      lead = updated.rows[0];
    } else {
      const leadData = {
        ...submission,
        stage: "new",
        score: 0,
        tags: [],
        notes: "",
        formId,
        funnelId,
        submissionCount: 1,
        firstSubmittedAt: now,
        lastSubmittedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const inserted = await client.query(
        `INSERT INTO goodads_resources (
           resource_type, organization_id, project_id, environment_id,
           owner_user_id, name, status, data
         ) VALUES ('leads', $1, $2, $3, $4::uuid, $5, 'active', $6::jsonb)
         RETURNING *`,
        [
          form.organization_id,
          form.project_id,
          form.environment_id,
          form.owner_user_id,
          name,
          JSON.stringify(leadData),
        ]
      );
      lead = inserted.rows[0];
    }

    await client.query(
      `UPDATE goodads_resources
       SET data = jsonb_set(
             data,
             '{submissionCount}',
             to_jsonb(CASE WHEN COALESCE(data->>'submissionCount', '') ~ '^[0-9]+$'
               THEN (data->>'submissionCount')::integer + 1 ELSE 1 END),
             true
           ),
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1::uuid`,
      [form.id]
    );
    await client.query(
      `INSERT INTO goodads_resource_events (
         resource_id, organization_id, actor_user_id, event_type, next_status, metadata
       ) VALUES ($1::uuid, $2, NULL, 'leads.captured', 'active', $3::jsonb)`,
      [lead.id, form.organization_id, JSON.stringify({
        formId,
        funnelId,
        idempotencyKey: requestKey,
        userAgent: boundedText(userAgent, 400),
      })]
    );
    await client.query("COMMIT");
    return { leadId: lead.id, status: "received", duplicate: Boolean(previous) };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505" && organizationId) {
      const duplicateRequest = await query(
        `SELECT resource_id FROM goodads_resource_events
         WHERE organization_id = $1 AND event_type = 'leads.captured'
           AND metadata->>'idempotencyKey' = $2
         LIMIT 1`,
        [organizationId, requestKey]
      );
      if (duplicateRequest.rows[0]) {
        return {
          leadId: duplicateRequest.rows[0].resource_id,
          status: "received",
          duplicate: true,
        };
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  RESOURCE_TYPES,
  RESOURCE_STATUSES,
  normalizePayload,
  requireResourceStatus,
  rowToResource,
  requireUuid,
  requirePublicSlug,
  normalizeLeadSubmission,
  normalizeGenerationInput,
  requireHttpsUrl,
  blockedIp,
  parseFeedXml,
  generateContent,
  dashboard,
  workspace,
  listResources,
  getResource,
  upsertResource,
  archiveResource,
  transitionResource,
  getPublicLeadForm,
  recordLeadFormView,
  captureLead,
  getPublicLinkHub,
  recordLinkHubClick,
  syncRssFeed,
  repurposeRssItem,
};
