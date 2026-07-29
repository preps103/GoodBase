"use strict";

const { query } = require("../config/database");
const social = require("./goodads-social.service");

const MANAGEMENT_ROLES = new Set(["owner", "admin", "manager"]);

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

async function syncRows(rows, period) {
  const results = [];
  for (const row of rows) {
    try {
      const accessToken = await social.accessTokenForConnection(row);
      const metrics = row.provider === "meta"
        ? await metaMetrics(row, accessToken, period)
        : await googleMetrics(row, accessToken, period);
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

async function overview({ context, from, to }) {
  const period = normalizePeriod(from, to);
  const [metricsResult, attributionResult, revenueResult, eventResult] = await Promise.all([
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
         COUNT(*) FILTER (WHERE event_type = 'leads.captured')::integer AS captured_events
       FROM goodads_resource_events
       WHERE organization_id = $1 AND created_at::date BETWEEN $2::date AND $3::date`,
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
    },
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
      supportedProviders: ["google", "meta"],
      verifiedProviderReceipts: true,
      durableSnapshots: true,
      maximumRangeDays: 93,
      automaticSyncMinutes: 15,
      firstPartyAttribution: true,
      revenueSeparatedByCurrency: true,
    },
  };
}

module.exports = {
  overview,
  syncProviderMetrics,
  syncAllProviderMetrics,
  capabilities,
  _test: {
    normalizePeriod,
    actionTotal,
  },
};
