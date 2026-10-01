"use strict";

const crypto = require("node:crypto");
const { query } = require("../config/database");
const social = require("./goodads-social.service");

const MANAGEMENT_ROLES = new Set(["owner", "admin", "manager"]);
const ATTRIBUTION_TOKEN_VERSION = "v1";
const ATTRIBUTION_EVENTS = new Set(["page_view", "lead", "purchase", "complete_registration", "subscribe"]);
const ATTRIBUTION_CONVERSIONS = new Set(["lead", "purchase", "complete_registration", "subscribe"]);
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,119}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function analyticsError(message, statusCode = 400, code = "GOODADS_ANALYTICS_ERROR", retryable = false) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function boundedText(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function requireManagement(context) {
  const role = String(context?.organization?.membershipRole || context?.membershipRole || "").toLowerCase();
  if (!MANAGEMENT_ROLES.has(role)) {
    throw analyticsError(
      "Owner, admin, or manager access is required to refresh provider analytics.",
      403,
      "GOODADS_ANALYTICS_MANAGEMENT_REQUIRED"
    );
  }
}

function attributionSigningKey(explicitKey) {
  const key = boundedText(
    explicitKey || process.env.GOODADS_ATTRIBUTION_SIGNING_KEY || process.env.JWT_SECRET,
    10000
  );
  if (key.length < 32) {
    throw analyticsError(
      "First-party attribution signing is not configured.",
      503,
      "GOODADS_ATTRIBUTION_SIGNING_NOT_CONFIGURED"
    );
  }
  return key;
}

function encodeAttributionToken(payload, explicitKey) {
  const body = Buffer.from(JSON.stringify({
    campaignId: boundedText(payload.campaignId, 64),
    organizationId: boundedText(payload.organizationId, 160),
  })).toString("base64url");
  const unsigned = `${ATTRIBUTION_TOKEN_VERSION}.${body}`;
  const signature = crypto.createHmac("sha256", attributionSigningKey(explicitKey))
    .update(`goodads:first-party-attribution:${unsigned}`)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

function decodeAttributionToken(token, explicitKey) {
  const [version, body, signature, extra] = boundedText(token, 1200).split(".");
  if (version !== ATTRIBUTION_TOKEN_VERSION || !body || !signature || extra) {
    throw analyticsError("The attribution token is invalid.", 404, "GOODADS_ATTRIBUTION_TOKEN_INVALID");
  }
  const unsigned = `${version}.${body}`;
  const expected = crypto.createHmac("sha256", attributionSigningKey(explicitKey))
    .update(`goodads:first-party-attribution:${unsigned}`)
    .digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    supplied = Buffer.alloc(0);
  }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw analyticsError("The attribution token is invalid.", 404, "GOODADS_ATTRIBUTION_TOKEN_INVALID");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw analyticsError("The attribution token is invalid.", 404, "GOODADS_ATTRIBUTION_TOKEN_INVALID");
  }
  if (!UUID_PATTERN.test(String(payload.campaignId || "")) || !boundedText(payload.organizationId, 160)) {
    throw analyticsError("The attribution token is invalid.", 404, "GOODADS_ATTRIBUTION_TOKEN_INVALID");
  }
  return {
    campaignId: payload.campaignId,
    organizationId: boundedText(payload.organizationId, 160),
  };
}

function normalizedAttributionEvent(value) {
  const event = boundedText(value, 40).toLowerCase();
  if (!ATTRIBUTION_EVENTS.has(event)) {
    throw analyticsError("This first-party attribution event is not supported.", 400, "GOODADS_ATTRIBUTION_EVENT_INVALID");
  }
  return event;
}

function normalizedPageOrigin(value) {
  try {
    const url = new URL(boundedText(value, 2000));
    if (url.protocol !== "https:") throw new Error("HTTPS required");
    return url.origin;
  } catch {
    throw analyticsError("A valid HTTPS page origin is required.", 400, "GOODADS_ATTRIBUTION_ORIGIN_INVALID");
  }
}

function destinationOrigin(campaignData) {
  return normalizedPageOrigin(campaignData?.creative?.destinationUrl);
}

function attributionScript(token, publicOrigin = "https://base.goodos.app") {
  const collector = `${publicOrigin}/api/apps/goodads/v1/public/attribution/${encodeURIComponent(token)}/pixel.gif`;
  return `(()=>{const endpoint=${JSON.stringify(collector)};const send=(event,options={})=>{const id=String(options.eventId||((globalThis.crypto&&crypto.randomUUID)?crypto.randomUUID():Date.now()+"-"+Math.random())).slice(0,120);const query=new URLSearchParams({event,event_id:id,page_origin:location.origin});if(options.valueMinor!=null)query.set("value_minor",String(options.valueMinor));if(options.currency)query.set("currency",String(options.currency));const pixel=new Image();pixel.referrerPolicy="strict-origin-when-cross-origin";pixel.src=endpoint+"?"+query.toString();return id};globalThis.goodAdsTrack=send;send("page_view")})();`;
}

function publicAttributionScript(token) {
  decodeAttributionToken(token);
  return attributionScript(token);
}

async function attributionInstallation({ campaignId, context }) {
  const result = await query(
    `SELECT id, name, data
     FROM goodads_resources
     WHERE id = $1::uuid AND organization_id = $2
       AND resource_type = 'campaigns' AND archived_at IS NULL`,
    [campaignId, context.organizationId]
  );
  const campaign = result.rows[0];
  if (!campaign) throw analyticsError("Campaign was not found.", 404, "GOODADS_CAMPAIGN_NOT_FOUND");
  const token = encodeAttributionToken({ campaignId: campaign.id, organizationId: context.organizationId });
  const root = "https://base.goodos.app/api/apps/goodads/v1/public/attribution";
  const scriptUrl = `${root}/${encodeURIComponent(token)}/tracker.js`;
  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    destinationOrigin: destinationOrigin(campaign.data),
    scriptUrl,
    snippet: `<script async src="${scriptUrl}"></script>`,
    eventTypes: [...ATTRIBUTION_EVENTS],
    conversionEvents: [...ATTRIBUTION_CONVERSIONS],
    browserObserved: true,
    providerVerified: false,
  };
}

async function recordAttributionEvent({
  token,
  event: requestedEvent,
  eventId,
  valueMinor,
  currency,
  pageOrigin,
  referrer,
  userAgent,
}) {
  const tokenPayload = decodeAttributionToken(token);
  const event = normalizedAttributionEvent(requestedEvent);
  const safeEventId = boundedText(eventId, 120);
  if (!EVENT_ID_PATTERN.test(safeEventId)) {
    throw analyticsError("A valid unique event ID is required.", 400, "GOODADS_ATTRIBUTION_EVENT_ID_INVALID");
  }
  const safePageOrigin = normalizedPageOrigin(pageOrigin);
  const campaignResult = await query(
    `SELECT id, data
     FROM goodads_resources
     WHERE id = $1::uuid AND organization_id = $2
       AND resource_type = 'campaigns' AND archived_at IS NULL`,
    [tokenPayload.campaignId, tokenPayload.organizationId]
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) throw analyticsError("Campaign was not found.", 404, "GOODADS_CAMPAIGN_NOT_FOUND");
  const expectedOrigin = destinationOrigin(campaign.data);
  if (safePageOrigin !== expectedOrigin) {
    throw analyticsError("The attribution event did not originate from this campaign destination.", 403, "GOODADS_ATTRIBUTION_ORIGIN_MISMATCH");
  }
  let referrerOrigin = null;
  if (boundedText(referrer, 2000)) {
    try {
      referrerOrigin = new URL(boundedText(referrer, 2000)).origin;
    } catch {}
    if (referrerOrigin && referrerOrigin !== expectedOrigin) {
      throw analyticsError("The attribution referrer did not match this campaign destination.", 403, "GOODADS_ATTRIBUTION_REFERRER_MISMATCH");
    }
  }
  const rawValueMinor = boundedText(valueMinor, 40);
  const parsedValue = Number(rawValueMinor);
  if (rawValueMinor && (!Number.isSafeInteger(parsedValue) || parsedValue < 0 || parsedValue > 100000000000)) {
    throw analyticsError("Purchase value must be a bounded non-negative integer in minor currency units.", 400, "GOODADS_ATTRIBUTION_VALUE_INVALID");
  }
  const safeValueMinor = rawValueMinor ? parsedValue : 0;
  const safeCurrency = boundedText(currency, 3).toUpperCase();
  if (safeCurrency && !/^[A-Z]{3}$/.test(safeCurrency)) {
    throw analyticsError("Currency must use a three-letter code.", 400, "GOODADS_ATTRIBUTION_CURRENCY_INVALID");
  }
  if (event !== "purchase" && (safeValueMinor || safeCurrency)) {
    throw analyticsError("Only purchase events may include value and currency.", 400, "GOODADS_ATTRIBUTION_VALUE_INVALID");
  }
  if (event === "purchase" && ((safeValueMinor > 0) !== Boolean(safeCurrency))) {
    throw analyticsError("Purchase value and currency must be supplied together.", 400, "GOODADS_ATTRIBUTION_VALUE_INVALID");
  }
  const inserted = await query(
    `INSERT INTO goodads_resource_events (
       resource_id, organization_id, actor_user_id, event_type, metadata
     ) VALUES ($1::uuid, $2, NULL, $3, $4::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      campaign.id,
      tokenPayload.organizationId,
      `attribution.${event}`,
      JSON.stringify({
        eventId: safeEventId,
        pageOrigin: safePageOrigin,
        referrerOrigin,
        referrerVerified: referrerOrigin === expectedOrigin,
        valueMinor: safeValueMinor,
        currency: safeCurrency || null,
        userAgent: boundedText(userAgent, 300),
        browserObserved: true,
        providerVerified: false,
      }),
    ]
  );
  return { recorded: Boolean(inserted.rows[0]), event, eventId: safeEventId };
}

function normalizePeriod(from, to) {
  const end = to ? new Date(`${to}T00:00:00.000Z`) : new Date();
  const start = from ? new Date(`${from}T00:00:00.000Z`) : new Date(end.getTime() - 29 * 86400000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw analyticsError("Select a valid analytics date range.");
  }
  const days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  if (days > 93) throw analyticsError("Analytics date ranges cannot exceed 93 days.");
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function googleHeaders(accessToken) {
  const developerToken = boundedText(process.env.GOODADS_GOOGLE_ADS_DEVELOPER_TOKEN, 1000);
  if (!developerToken) {
    throw analyticsError(
      "Google Ads developer access is not configured.",
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

async function requestJson(url, options, label) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(25000) });
  } catch (error) {
    throw analyticsError(
      error.name === "TimeoutError" ? `${label} timed out.` : `${label} could not reach the provider.`,
      502,
      "GOODADS_ANALYTICS_PROVIDER_UNREACHABLE",
      true
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw analyticsError(
      boundedText(payload?.error?.message || payload?.message || `${label} was rejected.`, 2000),
      response.status === 401 || response.status === 403 ? 409 : 502,
      "GOODADS_ANALYTICS_PROVIDER_FAILED",
      response.status === 429 || response.status >= 500
    );
  }
  return payload;
}

function actionTotal(actions, accepted) {
  if (!Array.isArray(actions)) return 0;
  return actions.reduce((total, action) => (
    accepted.has(String(action.action_type || "").toLowerCase())
      ? total + Math.max(Number(action.value) || 0, 0)
      : total
  ), 0);
}

function metricTotal(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.reduce((total, item) => total + Math.max(Number(item) || 0, 0), 0);
}

function xMetricsFromPayload(payload, period) {
  const records = Array.isArray(payload?.data) ? payload.data : [];
  const metrics = records.flatMap((record) => (
    Array.isArray(record?.id_data) ? record.id_data : []
  )).reduce((totals, item) => {
    const values = item?.metrics && typeof item.metrics === "object" ? item.metrics : {};
    totals.impressions += metricTotal(values.impressions);
    totals.clicks += metricTotal(values.clicks);
    totals.spendMicros += metricTotal(values.billed_charge_local_micro);
    totals.conversions += [
      "conversion_purchases",
      "conversion_sign_ups",
      "conversion_site_visits",
      "conversion_custom",
    ].reduce((total, key) => total + metricTotal(values[key]), 0);
    totals.conversionValueMicros += metricTotal(values.conversion_purchases_sale_amount_local_micro);
    return totals;
  }, {
    impressions: 0,
    clicks: 0,
    conversions: 0,
    spendMicros: 0,
    conversionValueMicros: 0,
  });
  return {
    ...metrics,
    raw: {
      dateStart: period.start,
      dateEnd: period.end,
      entity: "CAMPAIGN",
      granularity: "TOTAL",
      recordCount: records.length,
    },
  };
}

function snapchatMetricsFromPayload(payload, period) {
  const requestStatus = boundedText(payload?.request_status, 40).toLowerCase();
  if (requestStatus && requestStatus !== "success") {
    throw analyticsError(
      "Snapchat rejected the campaign metrics request.",
      502,
      "GOODADS_ANALYTICS_PROVIDER_FAILED"
    );
  }
  const records = Array.isArray(payload?.total_stats) ? payload.total_stats : [];
  const metrics = records.reduce((totals, record) => {
    const subRequestStatus = boundedText(record?.sub_request_status, 40).toLowerCase();
    if (subRequestStatus && subRequestStatus !== "success") {
      throw analyticsError(
        "Snapchat could not produce verified metrics for this campaign.",
        502,
        "GOODADS_ANALYTICS_PROVIDER_FAILED"
      );
    }
    const values = record?.total_stat?.stats && typeof record.total_stat.stats === "object"
      ? record.total_stat.stats
      : {};
    totals.impressions += metricTotal(values.impressions);
    totals.clicks += metricTotal(values.swipes);
    totals.spendMicros += metricTotal(values.spend);
    totals.conversions += metricTotal(values.conversion_purchases)
      + metricTotal(values.conversion_sign_ups);
    totals.conversionValueMicros += metricTotal(values.conversion_purchases_value);
    return totals;
  }, {
    impressions: 0,
    clicks: 0,
    conversions: 0,
    spendMicros: 0,
    conversionValueMicros: 0,
  });
  return {
    ...metrics,
    raw: {
      dateStart: period.start,
      dateEnd: period.end,
      entity: "CAMPAIGN",
      granularity: "TOTAL",
      recordCount: records.length,
      requestId: boundedText(payload?.request_id, 200) || null,
    },
  };
}

function pinterestMetricsFromPayload(payload, period) {
  const records = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.items) ? payload.items : []);
  const metrics = records.reduce((totals, values) => {
    const row = values && typeof values === "object" ? values : {};
    totals.impressions += metricTotal(row.IMPRESSION_1);
    totals.clicks += metricTotal(row.CLICKTHROUGH_1);
    totals.spendMicros += metricTotal(row.SPEND_IN_MICRO_DOLLAR);
    totals.conversions += metricTotal(row.TOTAL_CONVERSIONS);
    totals.conversionValueMicros += metricTotal(row.TOTAL_CONVERSIONS_VALUE_IN_MICRO_DOLLAR);
    return totals;
  }, {
    impressions: 0,
    clicks: 0,
    conversions: 0,
    spendMicros: 0,
    conversionValueMicros: 0,
  });
  return {
    ...metrics,
    raw: {
      dateStart: period.start,
      dateEnd: period.end,
      entity: "CAMPAIGN",
      granularity: "TOTAL",
      recordCount: records.length,
    },
  };
}

function splitPeriod(period, maximumDays) {
  const chunks = [];
  let cursor = new Date(`${period.start}T00:00:00.000Z`);
  const end = new Date(`${period.end}T00:00:00.000Z`);
  while (cursor <= end) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maximumDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({
      start: chunkStart.toISOString().slice(0, 10),
      end: chunkEnd.toISOString().slice(0, 10),
    });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

function decimalToMicros(value) {
  const normalized = String(value ?? "").trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return 0;
  const whole = BigInt(match[1]);
  const fraction = `${match[2] || ""}000000`.slice(0, 6);
  const micros = whole * 1000000n + BigInt(fraction || "0");
  return micros > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(micros);
}

function tiktokMetricsFromPayload(payload, period) {
  if (Number(payload?.code) !== 0) {
    throw analyticsError(
      boundedText(payload?.message || "TikTok rejected the campaign metrics request.", 1000),
      502,
      "GOODADS_ANALYTICS_PROVIDER_FAILED"
    );
  }
  const records = Array.isArray(payload?.data?.list) ? payload.data.list : [];
  const metrics = records.reduce((totals, record) => {
    const values = record?.metrics && typeof record.metrics === "object" ? record.metrics : {};
    totals.impressions += metricTotal(values.impressions);
    totals.clicks += metricTotal(values.clicks);
    totals.conversions += metricTotal(values.conversion);
    totals.spendMicros += decimalToMicros(values.spend);
    return totals;
  }, {
    impressions: 0,
    clicks: 0,
    conversions: 0,
    spendMicros: 0,
    conversionValueMicros: 0,
  });
  return {
    ...metrics,
    raw: {
      dateStart: period.start,
      dateEnd: period.end,
      entity: "AUCTION_CAMPAIGN",
      granularity: "TOTAL",
      recordCount: records.length,
      requestId: boundedText(payload?.request_id, 200) || null,
    },
  };
}

function linkedInVersion() {
  const value = boundedText(process.env.GOODADS_LINKEDIN_API_VERSION || "202608", 6);
  if (!/^20\d{4}$/.test(value)) {
    throw analyticsError(
      "LinkedIn Marketing API version must use YYYYMM format.",
      503,
      "GOODADS_LINKEDIN_VERSION_INVALID"
    );
  }
  return value;
}

function linkedInDate(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return `(year:${year},month:${month},day:${day})`;
}

function linkedInMetricsFromPayload(payload, period) {
  const records = Array.isArray(payload?.elements) ? payload.elements : [];
  const metrics = records.reduce((totals, record) => {
    totals.impressions += metricTotal(record?.impressions);
    totals.clicks += metricTotal(record?.clicks);
    totals.conversions += metricTotal(record?.externalWebsiteConversions);
    totals.spendMicros += decimalToMicros(record?.costInLocalCurrency);
    totals.conversionValueMicros += decimalToMicros(record?.conversionValueInLocalCurrency);
    return totals;
  }, {
    impressions: 0,
    clicks: 0,
    conversions: 0,
    spendMicros: 0,
    conversionValueMicros: 0,
  });
  return {
    ...metrics,
    raw: {
      dateStart: period.start,
      dateEnd: period.end,
      entity: "CAMPAIGN",
      granularity: "ALL",
      recordCount: records.length,
    },
  };
}

async function metaMetrics(row, accessToken, period) {
  const fields = "impressions,clicks,spend,actions,action_values,date_start,date_stop";
  const timeRange = encodeURIComponent(JSON.stringify({ since: period.start, until: period.end }));
  const payload = await requestJson(
    `https://graph.facebook.com/v23.0/${encodeURIComponent(row.provider_campaign_id)}/insights?fields=${fields}&time_range=${timeRange}&limit=1`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "GoodAds/1.0",
      },
    },
    "Meta campaign insights"
  );
  const metrics = Array.isArray(payload.data) ? payload.data[0] || {} : {};
  const conversionActions = new Set(["lead", "purchase", "complete_registration", "subscribe"]);
  const revenueActions = new Set(["purchase", "omni_purchase"]);
  return {
    impressions: Math.max(Number(metrics.impressions) || 0, 0),
    clicks: Math.max(Number(metrics.clicks) || 0, 0),
    conversions: actionTotal(metrics.actions, conversionActions),
    spendMicros: Math.round(Math.max(Number(metrics.spend) || 0, 0) * 1000000),
    conversionValueMicros: Math.round(actionTotal(metrics.action_values, revenueActions) * 1000000),
    raw: {
      dateStart: metrics.date_start || period.start,
      dateEnd: metrics.date_stop || period.end,
      actions: Array.isArray(metrics.actions) ? metrics.actions.slice(0, 100) : [],
      actionValues: Array.isArray(metrics.action_values) ? metrics.action_values.slice(0, 100) : [],
    },
  };
}

async function googleMetrics(row, accessToken, period) {
  const customerId = String(row.provider_account_id).replace(/\D/g, "");
  const campaignId = String(row.provider_campaign_id).replace(/\D/g, "");
  const payload = await requestJson(
    `https://googleads.googleapis.com/v24/customers/${customerId}/googleAds:searchStream`,
    {
      method: "POST",
      headers: googleHeaders(accessToken),
      body: JSON.stringify({
        query: `SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE campaign.id = ${campaignId} AND segments.date BETWEEN '${period.start}' AND '${period.end}'`,
      }),
    },
    "Google Ads campaign metrics"
  );
  const records = Array.isArray(payload)
    ? payload.flatMap((batch) => batch.results || [])
    : payload.results || [];
  return records.reduce((total, record) => ({
    impressions: total.impressions + Math.max(Number(record.metrics?.impressions) || 0, 0),
    clicks: total.clicks + Math.max(Number(record.metrics?.clicks) || 0, 0),
    conversions: total.conversions + Math.max(Number(record.metrics?.conversions) || 0, 0),
    spendMicros: total.spendMicros + Math.max(Number(record.metrics?.costMicros) || 0, 0),
    conversionValueMicros: total.conversionValueMicros
      + Math.round(Math.max(Number(record.metrics?.conversionsValue) || 0, 0) * 1000000),
    raw: { rowCount: records.length },
  }), {
    impressions: 0,
    clicks: 0,
    conversions: 0,
    spendMicros: 0,
    conversionValueMicros: 0,
    raw: { rowCount: 0 },
  });
}

async function xMetrics(row, credentials, period) {
  const accountId = boundedText(row.provider_account_id, 120);
  const campaignId = boundedText(row.provider_campaign_id, 120);
  const endExclusive = new Date(`${period.end}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const url = new URL(`https://ads-api.x.com/12/stats/accounts/${encodeURIComponent(accountId)}`);
  url.searchParams.set("entity", "CAMPAIGN");
  url.searchParams.set("entity_ids", campaignId);
  url.searchParams.set("start_time", `${period.start}T00:00:00Z`);
  url.searchParams.set("end_time", endExclusive.toISOString().replace(".000Z", "Z"));
  url.searchParams.set("granularity", "TOTAL");
  url.searchParams.set("placement", "ALL_ON_TWITTER");
  url.searchParams.set("metric_groups", "ENGAGEMENT,BILLING,CONVERSION");
  const payload = await requestJson(
    url,
    {
      headers: {
        Authorization: social.oauth1AuthorizationHeader(
          social.providerConfig("x_ads"),
          url.toString(),
          "GET",
          credentials.accessToken,
          credentials.tokenSecret
        ),
        Accept: "application/json",
        "User-Agent": "GoodAds/1.0",
      },
    },
    "X Ads campaign metrics"
  );
  return xMetricsFromPayload(payload, period);
}

async function snapchatMetrics(row, accessToken, period) {
  const campaignId = boundedText(row.provider_campaign_id, 120);
  const endExclusive = new Date(`${period.end}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const url = new URL(`https://adsapi.snapchat.com/v1/campaigns/${encodeURIComponent(campaignId)}/stats`);
  url.searchParams.set("granularity", "TOTAL");
  url.searchParams.set("start_time", `${period.start}T00:00:00.000Z`);
  url.searchParams.set("end_time", endExclusive.toISOString());
  url.searchParams.set("fields", [
    "impressions",
    "swipes",
    "spend",
    "conversion_purchases",
    "conversion_sign_ups",
    "conversion_purchases_value",
  ].join(","));
  url.searchParams.set("swipe_up_attribution_window", "28_DAY");
  url.searchParams.set("view_attribution_window", "1_DAY");
  url.searchParams.set("action_report_time", "conversion");
  url.searchParams.set("omit_empty", "true");
  const payload = await requestJson(
    url,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "GoodAds/1.0",
      },
    },
    "Snapchat campaign metrics"
  );
  return snapchatMetricsFromPayload(payload, period);
}

async function pinterestMetrics(row, accessToken, period) {
  const accountId = boundedText(row.provider_account_id, 120);
  const campaignId = boundedText(row.provider_campaign_id, 120);
  const totals = {
    impressions: 0,
    clicks: 0,
    conversions: 0,
    spendMicros: 0,
    conversionValueMicros: 0,
  };
  let recordCount = 0;
  const chunks = splitPeriod(period, 90);
  for (const chunk of chunks) {
    const url = new URL(`https://api.pinterest.com/v5/ad_accounts/${encodeURIComponent(accountId)}/campaigns/analytics`);
    url.searchParams.set("start_date", chunk.start);
    url.searchParams.set("end_date", chunk.end);
    url.searchParams.set("campaign_ids", campaignId);
    url.searchParams.set("columns", [
      "IMPRESSION_1",
      "CLICKTHROUGH_1",
      "SPEND_IN_MICRO_DOLLAR",
      "TOTAL_CONVERSIONS",
      "TOTAL_CONVERSIONS_VALUE_IN_MICRO_DOLLAR",
    ].join(","));
    url.searchParams.set("granularity", "TOTAL");
    url.searchParams.set("click_window_days", "30");
    url.searchParams.set("engagement_window_days", "30");
    url.searchParams.set("view_window_days", "1");
    url.searchParams.set("conversion_report_time", "TIME_OF_AD_ACTION");
    url.searchParams.set("reporting_timezone", "UTC");
    const payload = await requestJson(
      url,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "User-Agent": "GoodAds/1.0",
        },
      },
      "Pinterest campaign metrics"
    );
    const metrics = pinterestMetricsFromPayload(payload, chunk);
    totals.impressions += metrics.impressions;
    totals.clicks += metrics.clicks;
    totals.conversions += metrics.conversions;
    totals.spendMicros += metrics.spendMicros;
    totals.conversionValueMicros += metrics.conversionValueMicros;
    recordCount += metrics.raw.recordCount;
  }
  return {
    ...totals,
    raw: {
      dateStart: period.start,
      dateEnd: period.end,
      entity: "CAMPAIGN",
      granularity: "TOTAL",
      recordCount,
      requestCount: chunks.length,
    },
  };
}

async function tiktokMetrics(row, accessToken, period) {
  const advertiserId = boundedText(row.provider_account_id, 120);
  const campaignId = boundedText(row.provider_campaign_id, 120);
  const url = new URL("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/");
  url.searchParams.set("advertiser_id", advertiserId);
  url.searchParams.set("service_type", "AUCTION");
  url.searchParams.set("report_type", "BASIC");
  url.searchParams.set("data_level", "AUCTION_CAMPAIGN");
  url.searchParams.set("dimensions", JSON.stringify(["campaign_id"]));
  url.searchParams.set("metrics", JSON.stringify(["spend", "impressions", "clicks", "conversion"]));
  url.searchParams.set("start_date", period.start);
  url.searchParams.set("end_date", period.end);
  url.searchParams.set("filtering", JSON.stringify([{
    field_name: "campaign_ids",
    filter_type: "IN",
    filter_value: JSON.stringify([campaignId]),
  }]));
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", "10");
  const payload = await requestJson(
    url,
    {
      headers: {
        "Access-Token": accessToken,
        Accept: "application/json",
        "User-Agent": "GoodAds/1.0",
      },
    },
    "TikTok campaign metrics"
  );
  return tiktokMetricsFromPayload(payload, period);
}

async function linkedInMetrics(row, accessToken, period) {
  const campaignId = boundedText(row.provider_campaign_id, 300).match(/(\d+)$/)?.[1] || "";
  if (!campaignId) {
    throw analyticsError(
      "LinkedIn campaign reporting requires a valid provider campaign ID.",
      409,
      "GOODADS_LINKEDIN_CAMPAIGN_ID_INVALID"
    );
  }
  const url = new URL("https://api.linkedin.com/rest/adAnalytics");
  url.searchParams.set("q", "analytics");
  url.searchParams.set("pivot", "CAMPAIGN");
  url.searchParams.set("timeGranularity", "ALL");
  url.searchParams.set(
    "dateRange",
    `(start:${linkedInDate(period.start)},end:${linkedInDate(period.end)})`
  );
  url.searchParams.set("campaigns", `List(urn:li:sponsoredCampaign:${campaignId})`);
  url.searchParams.set(
    "fields",
    "impressions,clicks,externalWebsiteConversions,costInLocalCurrency,conversionValueInLocalCurrency,pivotValues,dateRange"
  );
  const payload = await requestJson(
    url,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Linkedin-Version": linkedInVersion(),
        "X-Restli-Protocol-Version": "2.0.0",
        Accept: "application/json",
        "User-Agent": "GoodAds/1.0",
      },
    },
    "LinkedIn campaign metrics"
  );
  return linkedInMetricsFromPayload(payload, period);
}

async function campaignRows(organizationId = null) {
  const values = [];
  let tenantClause = "";
  if (organizationId) {
    values.push(organizationId);
    tenantClause = " AND provider_campaign.organization_id = $1";
  }
  const result = await query(
    `SELECT provider_campaign.id AS provider_campaign_record_id,
       provider_campaign.provider, provider_campaign.provider_campaign_id,
       provider_campaign.status, account.provider_account_id, account.currency,
       connection.*
     FROM goodads_provider_campaigns provider_campaign
     JOIN goodads_ad_accounts account ON account.id = provider_campaign.ad_account_id
     JOIN goodads_social_connections connection ON connection.id = account.connection_id
     WHERE provider_campaign.provider_campaign_id IS NOT NULL
       AND provider_campaign.status IN ('paused','active')
       AND account.status = 'verified'
       AND connection.status = 'connected'${tenantClause}
     ORDER BY provider_campaign.updated_at DESC
     LIMIT 100`,
    values
  );
  return result.rows;
}

function providerMetricsAdapter(provider) {
  return {
    meta: metaMetrics,
    google: googleMetrics,
    youtube: googleMetrics,
    linkedin: linkedInMetrics,
    pinterest: pinterestMetrics,
    tiktok: tiktokMetrics,
    x: xMetrics,
    snapchat: snapchatMetrics,
  }[provider];
}

async function syncRows(rows, period) {
  const results = [];
  for (const row of rows) {
    try {
      const adapter = providerMetricsAdapter(row.provider);
      if (!adapter) {
        throw analyticsError(
          `Analytics adapter is not installed for ${boundedText(row.provider, 40)}.`,
          503,
          "GOODADS_ANALYTICS_ADAPTER_NOT_INSTALLED"
        );
      }
      const authorization = row.provider === "x"
        ? await social.oauth1CredentialsForConnection(row)
        : await social.accessTokenForConnection(row);
      const metrics = await adapter(row, authorization, period);
      await query(
        `INSERT INTO goodads_analytics_snapshots (
           organization_id, provider_campaign_id, provider, provider_account_id,
           provider_campaign_reference, currency, period_start, period_end,
           impressions, clicks, conversions, spend_micros, conversion_value_micros,
           raw_metrics, captured_at
         ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11, $12, $13, $14::jsonb, NOW())
         ON CONFLICT (provider_campaign_id, period_start, period_end) DO UPDATE SET
           currency = EXCLUDED.currency,
           impressions = EXCLUDED.impressions,
           clicks = EXCLUDED.clicks,
           conversions = EXCLUDED.conversions,
           spend_micros = EXCLUDED.spend_micros,
           conversion_value_micros = EXCLUDED.conversion_value_micros,
           raw_metrics = EXCLUDED.raw_metrics,
           captured_at = NOW()`,
        [
          row.organization_id,
          row.provider_campaign_record_id,
          row.provider,
          row.provider_account_id,
          row.provider_campaign_id,
          boundedText(row.currency, 12).toUpperCase(),
          period.start,
          period.end,
          Math.round(metrics.impressions),
          Math.round(metrics.clicks),
          metrics.conversions,
          Math.round(metrics.spendMicros),
          Math.round(metrics.conversionValueMicros),
          JSON.stringify(metrics.raw),
        ]
      );
      results.push({ providerCampaignId: row.provider_campaign_record_id, provider: row.provider, status: "completed" });
    } catch (error) {
      results.push({
        providerCampaignId: row.provider_campaign_record_id,
        provider: row.provider,
        status: "failed",
        retryable: error.retryable === true,
        error: boundedText(error.message, 1000),
      });
    }
  }
  return results;
}

async function syncProviderMetrics({ context, from, to }) {
  requireManagement(context);
  const period = normalizePeriod(from, to);
  const rows = await campaignRows(context.organizationId);
  const results = await syncRows(rows, period);
  return {
    period,
    attempted: rows.length,
    completed: results.filter((result) => result.status === "completed").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
}

async function syncAllProviderMetrics() {
  const period = normalizePeriod();
  const rows = await campaignRows();
  const results = await syncRows(rows, period);
  return {
    period,
    attempted: rows.length,
    completed: results.filter((result) => result.status === "completed").length,
    failed: results.filter((result) => result.status === "failed").length,
  };
}

function number(value) {
  return Number(value) || 0;
}

function budgetRecommendations(rows, options = {}) {
  const now = Number(options.now) || Date.now();
  const staleAfterMinutes = Math.min(Math.max(Number(options.staleAfterMinutes) || 45, 15), 1440);
  const maximumShiftPercent = Math.min(Math.max(Number(options.maximumShiftPercent) || 20, 5), 25);
  const minimumSpendMicros = Math.max(Number(options.minimumSpendMicros) || 5000000, 1000000);
  const eligible = [];
  const excluded = { inactive: 0, stale: 0, insufficientData: 0, invalidBudget: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.status !== "active") {
      excluded.inactive += 1;
      continue;
    }
    const capturedAt = new Date(row.captured_at || row.capturedAt || 0).getTime();
    if (!Number.isFinite(capturedAt) || now - capturedAt > staleAfterMinutes * 60000) {
      excluded.stale += 1;
      continue;
    }
    const spendMicros = number(row.spend_micros ?? row.spendMicros);
    const conversions = number(row.conversions);
    const dailyBudget = number(row.daily_budget ?? row.dailyBudget);
    if (spendMicros < minimumSpendMicros || conversions <= 0) {
      excluded.insufficientData += 1;
      continue;
    }
    if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) {
      excluded.invalidBudget += 1;
      continue;
    }
    eligible.push({
      providerCampaignRecordId: row.provider_campaign_record_id || row.providerCampaignRecordId,
      campaignId: row.campaign_id || row.campaignId,
      campaignName: boundedText(row.campaign_name || row.campaignName || "Campaign", 200),
      provider: boundedText(row.provider, 40),
      currency: boundedText(row.currency || "", 12).toUpperCase(),
      dailyBudgetMicros: Math.round(dailyBudget * 1000000),
      spendMicros,
      conversions,
      conversionValueMicros: number(row.conversion_value_micros ?? row.conversionValueMicros),
      capturedAt: new Date(capturedAt).toISOString(),
      periodStart: String(row.period_start || row.periodStart || ""),
      periodEnd: String(row.period_end || row.periodEnd || ""),
    });
  }
  const currencyGroups = new Map();
  for (const item of eligible) {
    if (!item.currency || item.currency === "UNSPECIFIED") continue;
    currencyGroups.set(item.currency, [...(currencyGroups.get(item.currency) || []), item]);
  }
  const recommendations = [];
  for (const [currency, items] of currencyGroups) {
    if (items.length < 2) continue;
    const usesConversionValue = items.every((item) => item.conversionValueMicros > 0);
    const ranked = items.map((item) => ({
      ...item,
      efficiency: usesConversionValue
        ? item.conversionValueMicros / item.spendMicros
        : item.conversions / item.spendMicros,
    })).sort((left, right) => right.efficiency - left.efficiency);
    const destination = ranked[0];
    const source = ranked[ranked.length - 1];
    if (!destination.efficiency || source.efficiency > destination.efficiency * 0.8) continue;
    const shiftMicros = Math.floor(source.dailyBudgetMicros * (maximumShiftPercent / 100));
    if (shiftMicros < 1000000) continue;
    const combinedConversions = destination.conversions + source.conversions;
    const combinedSpendMicros = destination.spendMicros + source.spendMicros;
    const confidence = combinedConversions >= 20 && combinedSpendMicros >= 100000000
      ? "high"
      : combinedConversions >= 5 && combinedSpendMicros >= 25000000
        ? "medium"
        : "low";
    recommendations.push({
      id: `${currency}:${source.providerCampaignRecordId}:${destination.providerCampaignRecordId}`,
      currency,
      confidence,
      advisoryOnly: true,
      automaticExecution: false,
      maximumShiftPercent,
      shiftMicros,
      source: {
        providerCampaignRecordId: source.providerCampaignRecordId,
        campaignId: source.campaignId,
        campaignName: source.campaignName,
        provider: source.provider,
        currentDailyBudgetMicros: source.dailyBudgetMicros,
        recommendedDailyBudgetMicros: source.dailyBudgetMicros - shiftMicros,
        spendMicros: source.spendMicros,
        conversions: source.conversions,
        efficiency: source.efficiency,
      },
      destination: {
        providerCampaignRecordId: destination.providerCampaignRecordId,
        campaignId: destination.campaignId,
        campaignName: destination.campaignName,
        provider: destination.provider,
        currentDailyBudgetMicros: destination.dailyBudgetMicros,
        recommendedDailyBudgetMicros: destination.dailyBudgetMicros + shiftMicros,
        spendMicros: destination.spendMicros,
        conversions: destination.conversions,
        efficiency: destination.efficiency,
      },
      evidence: {
        metric: usesConversionValue ? "roas" : "conversions_per_spend",
        combinedSpendMicros,
        combinedConversions,
        periodStart: destination.periodStart,
        periodEnd: destination.periodEnd,
        capturedAt: [source.capturedAt, destination.capturedAt].sort()[0],
        staleAfterMinutes,
      },
      totalDailyBudgetBeforeMicros: source.dailyBudgetMicros + destination.dailyBudgetMicros,
      totalDailyBudgetAfterMicros: source.dailyBudgetMicros + destination.dailyBudgetMicros,
    });
  }
  return {
    advisoryOnly: true,
    automaticExecution: false,
    maximumShiftPercent,
    minimumSpendMicros,
    staleAfterMinutes,
    eligibleCampaigns: eligible.length,
    excluded,
    recommendations,
  };
}

async function overview({ context, from, to }) {
  const period = normalizePeriod(from, to);
  const [metricsResult, attributionResult, revenueResult, eventResult, recommendationResult] = await Promise.all([
    query(
      `WITH latest AS (
         SELECT DISTINCT ON (snapshot.provider_campaign_id)
           snapshot.*
         FROM goodads_analytics_snapshots snapshot
         WHERE snapshot.organization_id = $1
           AND snapshot.period_start = $2::date
           AND snapshot.period_end = $3::date
         ORDER BY snapshot.provider_campaign_id, snapshot.captured_at DESC
       )
       SELECT provider, COALESCE(NULLIF(currency, ''), 'UNSPECIFIED') AS currency,
         COUNT(*)::integer AS campaigns,
         COALESCE(SUM(impressions), 0)::bigint AS impressions,
         COALESCE(SUM(clicks), 0)::bigint AS clicks,
         COALESCE(SUM(conversions), 0)::numeric AS conversions,
         COALESCE(SUM(spend_micros), 0)::bigint AS spend_micros,
         COALESCE(SUM(conversion_value_micros), 0)::bigint AS conversion_value_micros,
         MAX(captured_at) AS captured_at
       FROM latest GROUP BY provider, COALESCE(NULLIF(currency, ''), 'UNSPECIFIED')
       ORDER BY provider, currency`,
      [context.organizationId, period.start, period.end]
    ),
    query(
      `SELECT
         COALESCE(NULLIF(data#>>'{utm,source}', ''), NULLIF(data->>'source', ''), 'direct') AS source,
         COALESCE(NULLIF(data#>>'{utm,medium}', ''), 'none') AS medium,
         COALESCE(NULLIF(data#>>'{utm,campaign}', ''), 'unassigned') AS campaign,
         COUNT(*)::integer AS leads,
         COUNT(*) FILTER (WHERE COALESCE(data->>'stage', '') = 'won')::integer AS won
       FROM goodads_resources
       WHERE organization_id = $1 AND resource_type = 'leads' AND archived_at IS NULL
         AND created_at::date BETWEEN $2::date AND $3::date
       GROUP BY 1, 2, 3 ORDER BY leads DESC, source LIMIT 100`,
      [context.organizationId, period.start, period.end]
    ),
    query(
      `SELECT currency,
         COUNT(*) FILTER (WHERE status = 'completed')::integer AS completed_orders,
         COALESCE(SUM(amount_minor) FILTER (WHERE status = 'completed'), 0)::bigint AS revenue_minor
       FROM goodads_payment_sessions
       WHERE organization_id = $1 AND created_at::date BETWEEN $2::date AND $3::date
       GROUP BY currency ORDER BY currency`,
      [context.organizationId, period.start, period.end]
    ),
    query(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'link_hubs.clicked')::integer AS link_clicks,
         COUNT(*) FILTER (WHERE event_type = 'leads.captured')::integer AS captured_events,
         COUNT(*) FILTER (WHERE event_type = 'attribution.page_view')::integer AS website_page_views,
         COUNT(*) FILTER (WHERE event_type IN (
           'attribution.lead', 'attribution.purchase',
           'attribution.complete_registration', 'attribution.subscribe'
         ))::integer AS website_conversions
       FROM goodads_resource_events
       WHERE organization_id = $1 AND created_at::date BETWEEN $2::date AND $3::date`,
      [context.organizationId, period.start, period.end]
    ),
    query(
      `WITH latest AS (
         SELECT DISTINCT ON (snapshot.provider_campaign_id)
           snapshot.*
         FROM goodads_analytics_snapshots snapshot
         WHERE snapshot.organization_id = $1
           AND snapshot.period_start = $2::date
           AND snapshot.period_end = $3::date
         ORDER BY snapshot.provider_campaign_id, snapshot.captured_at DESC
       )
       SELECT provider_campaign.id AS provider_campaign_record_id,
         provider_campaign.campaign_id, campaign.name AS campaign_name,
         provider_campaign.provider, provider_campaign.status,
         latest.currency, latest.spend_micros, latest.conversions,
         latest.conversion_value_micros, latest.period_start, latest.period_end,
         latest.captured_at, campaign.data->>'dailyBudget' AS daily_budget
       FROM latest
       JOIN goodads_provider_campaigns provider_campaign
         ON provider_campaign.id = latest.provider_campaign_id
       JOIN goodads_resources campaign ON campaign.id = provider_campaign.campaign_id
       WHERE provider_campaign.organization_id = $1
         AND campaign.organization_id = $1
         AND campaign.resource_type = 'campaigns'
         AND campaign.archived_at IS NULL
       ORDER BY latest.currency, provider_campaign.provider, campaign.name`,
      [context.organizationId, period.start, period.end]
    ),
  ]);

  const providerMetrics = metricsResult.rows.map((row) => {
    const impressions = number(row.impressions);
    const clicks = number(row.clicks);
    const conversions = number(row.conversions);
    const spendMicros = number(row.spend_micros);
    const conversionValueMicros = number(row.conversion_value_micros);
    return {
      provider: row.provider,
      currency: row.currency,
      campaigns: number(row.campaigns),
      impressions,
      clicks,
      conversions,
      spendMicros,
      conversionValueMicros,
      ctr: impressions ? clicks / impressions : 0,
      cpcMicros: clicks ? spendMicros / clicks : 0,
      costPerConversionMicros: conversions ? spendMicros / conversions : 0,
      roas: spendMicros ? conversionValueMicros / spendMicros : 0,
      capturedAt: row.captured_at,
    };
  });
  return {
    period,
    generatedAt: new Date().toISOString(),
    providerMetrics,
    attribution: attributionResult.rows.map((row) => ({
      source: row.source,
      medium: row.medium,
      campaign: row.campaign,
      leads: number(row.leads),
      won: number(row.won),
    })),
    revenueByCurrency: revenueResult.rows.map((row) => ({
      currency: row.currency,
      completedOrders: number(row.completed_orders),
      revenueMinor: number(row.revenue_minor),
    })),
    firstPartyEvents: {
      linkClicks: number(eventResult.rows[0]?.link_clicks),
      capturedLeads: number(eventResult.rows[0]?.captured_events),
      websitePageViews: number(eventResult.rows[0]?.website_page_views),
      websiteConversions: number(eventResult.rows[0]?.website_conversions),
      browserObserved: true,
      providerVerified: false,
    },
    budgetOptimization: budgetRecommendations(recommendationResult.rows),
    totals: providerMetrics.reduce((total, item) => ({
      campaigns: total.campaigns + item.campaigns,
      impressions: total.impressions + item.impressions,
      clicks: total.clicks + item.clicks,
      conversions: total.conversions + item.conversions,
    }), { campaigns: 0, impressions: 0, clicks: 0, conversions: 0 }),
  };
}

function capabilities() {
  return {
    providerAnalytics: {
      available: true,
      supportedProviders: ["google", "linkedin", "meta", "pinterest", "snapchat", "tiktok", "x", "youtube"],
      verifiedProviderReceipts: true,
      durableSnapshots: true,
      maximumRangeDays: 93,
      automaticSyncMinutes: 15,
      firstPartyAttribution: true,
      firstPartyWebsitePixel: true,
      attributionOriginBound: true,
      attributionReplayDeduplication: true,
      revenueSeparatedByCurrency: true,
      crossChannelBudgetRecommendations: true,
      budgetRecommendationsAdvisoryOnly: true,
      maximumRecommendedShiftPercent: 20,
    },
  };
}

module.exports = {
  overview,
  syncProviderMetrics,
  syncAllProviderMetrics,
  attributionInstallation,
  publicAttributionScript,
  recordAttributionEvent,
  capabilities,
  _test: {
    normalizePeriod,
    actionTotal,
    metricTotal,
    xMetricsFromPayload,
    snapchatMetricsFromPayload,
    pinterestMetricsFromPayload,
    splitPeriod,
    decimalToMicros,
    tiktokMetricsFromPayload,
    linkedInMetricsFromPayload,
    providerMetricsAdapter,
    budgetRecommendations,
    encodeAttributionToken,
    decodeAttributionToken,
    normalizedAttributionEvent,
    normalizedPageOrigin,
    attributionScript,
  },
};
