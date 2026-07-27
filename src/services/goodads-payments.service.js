"use strict";

const crypto = require("node:crypto");
const { query } = require("../config/database");

const PAYMENT_PROVIDERS = Object.freeze({
  stripe: {
    id: "stripe",
    name: "Stripe",
    description: "Hosted Stripe Checkout for cards, wallets, and supported local payment methods.",
  },
  paypal: {
    id: "paypal",
    name: "PayPal",
    description: "PayPal Orders checkout with server-side capture and verified webhooks.",
  },
  square: {
    id: "square",
    name: "Square",
    description: "Square-hosted payment links for cards, wallets, Afterpay, and Cash App where available.",
  },
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAYMENT_ADMIN_ROLES = new Set(["owner", "admin"]);
const MUTATING_ROLES = new Set(["owner", "admin", "manager", "editor", "member"]);
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

function paymentError(message, statusCode = 400, code = "GOODADS_PAYMENT_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function boundedText(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function roleFromContext(context) {
  return String(context?.organization?.membershipRole || "").toLowerCase();
}

function requirePaymentAdmin(context) {
  if (!PAYMENT_ADMIN_ROLES.has(roleFromContext(context))) {
    throw paymentError(
      "Owner or administrator access is required to manage payment credentials.",
      403,
      "GOODADS_PAYMENT_ADMIN_REQUIRED"
    );
  }
}

function requireMutationRole(context) {
  if (!MUTATING_ROLES.has(roleFromContext(context))) {
    throw paymentError(
      "Your organization role cannot modify payment offers.",
      403,
      "GOODADS_PAYMENT_WRITE_FORBIDDEN"
    );
  }
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (!PAYMENT_PROVIDERS[provider]) {
    throw paymentError("Unsupported payment provider.", 404, "GOODADS_PAYMENT_PROVIDER_NOT_FOUND");
  }
  return provider;
}

function normalizeEnvironment(value) {
  const environment = String(value || "sandbox").trim().toLowerCase();
  if (!["sandbox", "live"].includes(environment)) {
    throw paymentError("Payment environment must be sandbox or live.");
  }
  return environment;
}

function encryptionKey() {
  const raw = String(
    process.env.GOODADS_PAYMENT_ENCRYPTION_KEY
      || process.env.GOODADS_OAUTH_ENCRYPTION_KEY
      || ""
  );
  if (!raw) {
    throw paymentError(
      "GoodAds payment encryption is not configured.",
      503,
      "GOODADS_PAYMENT_ENCRYPTION_MISSING"
    );
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function encryptCredentials(credentials) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptCredentials(row) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(row.credential_iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(row.credential_tag, "base64"));
  const decoded = Buffer.concat([
    decipher.update(Buffer.from(row.credential_ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(decoded);
}

function normalizeCredentials(provider, value) {
  const credentials = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (provider === "stripe") {
    const secretKey = boundedText(credentials.secretKey, 500);
    const webhookSecret = boundedText(credentials.webhookSecret, 500);
    if (!/^sk_(?:test|live)_/.test(secretKey) || (webhookSecret && !webhookSecret.startsWith("whsec_"))) {
      throw paymentError("Stripe requires a valid secret key. Its webhook signing secret must start with whsec_.");
    }
    return { secretKey, webhookSecret };
  }
  if (provider === "paypal") {
    const clientId = boundedText(credentials.clientId, 500);
    const clientSecret = boundedText(credentials.clientSecret, 500);
    const webhookId = boundedText(credentials.webhookId, 200);
    if (!clientId || !clientSecret) {
      throw paymentError("PayPal requires a client ID and client secret.");
    }
    return { clientId, clientSecret, webhookId };
  }
  const accessToken = boundedText(credentials.accessToken, 1000);
  const locationId = boundedText(credentials.locationId, 200);
  const signatureKey = boundedText(credentials.signatureKey, 500);
  if (!accessToken || !locationId) {
    throw paymentError("Square requires an access token and location ID.");
  }
  return { accessToken, locationId, signatureKey };
}

function providerBase(provider, environment) {
  if (provider === "paypal") {
    return environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  }
  if (provider === "square") {
    return environment === "live" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  }
  return "https://api.stripe.com";
}

async function responseBody(response) {
  return response.json().catch(() => ({}));
}

function providerFailure(provider, payload, fallback) {
  const message = boundedText(
    payload?.error?.message
      || payload?.message
      || payload?.details?.[0]?.detail
      || payload?.errors?.[0]?.detail
      || fallback,
    500
  );
  return paymentError(
    message || `${PAYMENT_PROVIDERS[provider].name} rejected the request.`,
    502,
    `GOODADS_${provider.toUpperCase()}_REJECTED`
  );
}

async function paypalAccessToken(credentials, environment, fetchImpl = fetch) {
  const response = await fetchImpl(`${providerBase("paypal", environment)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15000),
  });
  const payload = await responseBody(response);
  if (!response.ok || !payload.access_token) {
    throw providerFailure("paypal", payload, "PayPal credentials could not be verified.");
  }
  return payload.access_token;
}

async function validateCredentials(providerValue, environmentValue, credentialValue, fetchImpl = fetch) {
  const provider = normalizeProvider(providerValue);
  const environment = normalizeEnvironment(environmentValue);
  const credentials = normalizeCredentials(provider, credentialValue);
  if (provider === "stripe") {
    if (
      (environment === "live" && credentials.secretKey.startsWith("sk_test_"))
      || (environment === "sandbox" && credentials.secretKey.startsWith("sk_live_"))
    ) {
      throw paymentError("Stripe key mode does not match the selected payment environment.");
    }
    const response = await fetchImpl(`${providerBase(provider, environment)}/v1/account`, {
      headers: { Authorization: `Bearer ${credentials.secretKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const payload = await responseBody(response);
    if (!response.ok || !payload.id) {
      throw providerFailure(provider, payload, "Stripe credentials could not be verified.");
    }
    return {
      credentials,
      accountReference: boundedText(payload.id, 200),
      accountLabel: boundedText(payload.business_profile?.name || payload.settings?.dashboard?.display_name || payload.id, 240),
      capabilities: {
        checkout: true,
        webhooks: Boolean(credentials.webhookSecret),
        chargesEnabled: payload.charges_enabled === true,
        payoutsEnabled: payload.payouts_enabled === true,
      },
    };
  }
  if (provider === "paypal") {
    await paypalAccessToken(credentials, environment, fetchImpl);
    return {
      credentials,
      accountReference: `paypal:${crypto.createHash("sha256").update(credentials.clientId).digest("hex").slice(0, 16)}`,
      accountLabel: "PayPal business account",
      capabilities: { checkout: true, capture: true, webhooks: Boolean(credentials.webhookId) },
    };
  }
  const response = await fetchImpl(`${providerBase(provider, environment)}/v2/locations`, {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Square-Version": "2026-07-15",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  const payload = await responseBody(response);
  const location = (payload.locations || []).find((item) => item.id === credentials.locationId);
  if (!response.ok || !location) {
    throw providerFailure(provider, payload, "Square credentials or location could not be verified.");
  }
  return {
    credentials,
    accountReference: boundedText(location.id, 200),
    accountLabel: boundedText(location.name || location.business_name || location.id, 240),
    capabilities: {
      checkout: true,
      webhooks: Boolean(credentials.signatureKey),
      currency: location.currency || null,
      status: location.status || null,
    },
  };
}

function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || "https://base.goodos.app").replace(/\/+$/, "");
}

function appBaseUrl() {
  return "https://ads.goodos.app";
}

function webhookUrl(provider, connectionId) {
  return `${publicBaseUrl()}/api/apps/goodads/v1/public/payment-webhooks/${provider}/${connectionId}`;
}

function publicConnection(row) {
  return {
    id: row.id,
    provider: row.provider,
    environment: row.environment,
    accountReference: row.account_reference,
    accountLabel: row.account_label,
    status: row.status,
    capabilities: row.capabilities || {},
    connectedAt: row.connected_at,
    lastVerifiedAt: row.last_verified_at,
    updatedAt: row.updated_at,
    webhookUrl: webhookUrl(row.provider, row.id),
  };
}

async function listProviders({ context }) {
  const result = await query(
    `SELECT * FROM goodads_payment_connections
     WHERE organization_id = $1 AND status <> 'disconnected'
     ORDER BY provider`,
    [context.organizationId]
  );
  const connections = new Map(result.rows.map((row) => [row.provider, publicConnection(row)]));
  return Object.values(PAYMENT_PROVIDERS).map((definition) => ({
    ...definition,
    configured: connections.get(definition.id)?.status === "connected",
    connection: connections.get(definition.id) || null,
  }));
}

async function configureProvider({ provider: providerValue, environment: environmentValue, credentials, context, userId }) {
  requirePaymentAdmin(context);
  const provider = normalizeProvider(providerValue);
  const environment = normalizeEnvironment(environmentValue);
  encryptionKey();
  const validated = await validateCredentials(provider, environment, credentials);
  const encrypted = encryptCredentials(validated.credentials);
  const connectionStatus = validated.capabilities.webhooks ? "connected" : "pending_webhook";
  const result = await query(
    `INSERT INTO goodads_payment_connections (
       organization_id, provider, environment, credential_ciphertext, credential_iv,
       credential_tag, account_reference, account_label, status, capabilities,
       connected_by, last_verified_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $11, $9::jsonb, $10::uuid, NOW())
     ON CONFLICT (organization_id, provider)
     DO UPDATE SET environment = EXCLUDED.environment,
       credential_ciphertext = EXCLUDED.credential_ciphertext,
       credential_iv = EXCLUDED.credential_iv,
       credential_tag = EXCLUDED.credential_tag,
       account_reference = EXCLUDED.account_reference,
       account_label = EXCLUDED.account_label,
       status = EXCLUDED.status,
       capabilities = EXCLUDED.capabilities,
       connected_by = EXCLUDED.connected_by,
       last_verified_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [
      context.organizationId,
      provider,
      environment,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      validated.accountReference,
      validated.accountLabel,
      JSON.stringify(validated.capabilities),
      userId,
      connectionStatus,
    ]
  );
  return publicConnection(result.rows[0]);
}

async function disconnectProvider({ provider: providerValue, context }) {
  requirePaymentAdmin(context);
  const provider = normalizeProvider(providerValue);
  const result = await query(
    `UPDATE goodads_payment_connections
     SET status = 'disconnected', credential_ciphertext = '', credential_iv = '',
       credential_tag = '', updated_at = NOW()
     WHERE organization_id = $1 AND provider = $2 AND status <> 'disconnected'
     RETURNING id`,
    [context.organizationId, provider]
  );
  await query(
    `UPDATE goodads_payment_preferences
     SET enabled_providers = array_remove(enabled_providers, $2),
       default_provider = CASE WHEN default_provider = $2 THEN NULL ELSE default_provider END,
       updated_at = NOW()
     WHERE organization_id = $1`,
    [context.organizationId, provider]
  );
  return { disconnected: result.rowCount === 1 };
}

async function getPreferences({ context }) {
  const result = await query(
    `SELECT default_provider, enabled_providers, currency, updated_at
     FROM goodads_payment_preferences WHERE organization_id = $1`,
    [context.organizationId]
  );
  const row = result.rows[0];
  return {
    defaultProvider: row?.default_provider || null,
    enabledProviders: row?.enabled_providers || [],
    currency: row?.currency || "USD",
    updatedAt: row?.updated_at || null,
  };
}

function normalizedProviderList(value) {
  const providers = [...new Set((Array.isArray(value) ? value : []).map(normalizeProvider))];
  if (providers.length > Object.keys(PAYMENT_PROVIDERS).length) {
    throw paymentError("Too many payment providers were selected.");
  }
  return providers;
}

function formatMinorAmount(amountMinor, currency) {
  const exponent = ZERO_DECIMAL_CURRENCIES.has(currency)
    ? 0
    : THREE_DECIMAL_CURRENCIES.has(currency)
      ? 3
      : 2;
  return (amountMinor / (10 ** exponent)).toFixed(exponent);
}

async function updatePreferences({ payload, context, userId }) {
  requirePaymentAdmin(context);
  const enabledProviders = normalizedProviderList(payload?.enabledProviders);
  const defaultProvider = payload?.defaultProvider ? normalizeProvider(payload.defaultProvider) : null;
  const currency = boundedText(payload?.currency || "USD", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw paymentError("A three-letter currency code is required.");
  if (defaultProvider && !enabledProviders.includes(defaultProvider)) {
    throw paymentError("The default provider must also be enabled.");
  }
  if (enabledProviders.length) {
    const configured = await query(
      `SELECT provider FROM goodads_payment_connections
       WHERE organization_id = $1 AND provider = ANY($2::text[]) AND status = 'connected'`,
      [context.organizationId, enabledProviders]
    );
    const configuredIds = new Set(configured.rows.map((row) => row.provider));
    const missing = enabledProviders.filter((provider) => !configuredIds.has(provider));
    if (missing.length) {
      throw paymentError(
        `Connect ${missing.map((id) => PAYMENT_PROVIDERS[id].name).join(", ")} before enabling checkout.`,
        409,
        "GOODADS_PAYMENT_PROVIDER_NOT_CONNECTED"
      );
    }
  }
  const result = await query(
    `INSERT INTO goodads_payment_preferences (
       organization_id, default_provider, enabled_providers, currency, updated_by
     ) VALUES ($1, $2, $3::text[], $4, $5::uuid)
     ON CONFLICT (organization_id)
     DO UPDATE SET default_provider = EXCLUDED.default_provider,
       enabled_providers = EXCLUDED.enabled_providers,
       currency = EXCLUDED.currency,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING default_provider, enabled_providers, currency, updated_at`,
    [context.organizationId, defaultProvider, enabledProviders, currency, userId]
  );
  const row = result.rows[0];
  return {
    defaultProvider: row.default_provider,
    enabledProviders: row.enabled_providers,
    currency: row.currency,
    updatedAt: row.updated_at,
  };
}

function normalizeOffer(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw paymentError("A payment offer is required.");
  }
  const name = boundedText(payload.name, 240);
  const publicSlug = boundedText(payload.publicSlug, 64).toLowerCase();
  const amountMinor = Number(payload.amountMinor);
  const currency = boundedText(payload.currency || "USD", 3).toUpperCase();
  const enabledProviders = normalizedProviderList(payload.enabledProviders);
  const status = boundedText(payload.status || "draft", 20).toLowerCase();
  if (name.length < 2) throw paymentError("Offer name is required.");
  if (!SLUG_PATTERN.test(publicSlug)) throw paymentError("A valid public payment address is required.");
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 999999999) {
    throw paymentError("Offer amount must be a positive amount in the currency's smallest unit.");
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw paymentError("A three-letter currency code is required.");
  if (!enabledProviders.length) throw paymentError("Select at least one payment provider.");
  if (!["draft", "active"].includes(status)) throw paymentError("Offer status must be draft or active.");
  return {
    name,
    publicSlug,
    description: boundedText(payload.description, 4000),
    amountMinor,
    currency,
    enabledProviders,
    status,
    successMessage: boundedText(payload.successMessage || "Payment received. Thank you.", 1000),
    metadata: payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? JSON.parse(JSON.stringify(payload.metadata))
      : {},
  };
}

function offerRow(row) {
  return {
    id: row.id,
    name: row.name,
    publicSlug: row.public_slug,
    description: row.description,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    enabledProviders: row.enabled_providers,
    status: row.status,
    successMessage: row.success_message,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listOffers({ context }) {
  const result = await query(
    `SELECT * FROM goodads_payment_offers
     WHERE organization_id = $1 AND archived_at IS NULL
     ORDER BY updated_at DESC LIMIT 100`,
    [context.organizationId]
  );
  return result.rows.map(offerRow);
}

async function saveOffer({ id, payload, context, userId }) {
  requireMutationRole(context);
  const offer = normalizeOffer(payload);
  if (offer.status === "active") {
    const configured = await query(
      `SELECT provider FROM goodads_payment_connections
       WHERE organization_id = $1 AND provider = ANY($2::text[]) AND status = 'connected'`,
      [context.organizationId, offer.enabledProviders]
    );
    if (configured.rowCount !== offer.enabledProviders.length) {
      throw paymentError(
        "Every provider on an active offer must be connected.",
        409,
        "GOODADS_PAYMENT_OFFER_PROVIDER_MISSING"
      );
    }
  }
  const offerId = id ? String(id) : null;
  if (offerId && !UUID_PATTERN.test(offerId)) throw paymentError("A valid offer ID is required.");
  const result = await query(
    `INSERT INTO goodads_payment_offers (
       id, organization_id, name, public_slug, description, amount_minor, currency,
       enabled_providers, status, success_message, metadata, created_by, updated_by
     ) VALUES (
       COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7,
       $8::text[], $9, $10, $11::jsonb, $12::uuid, $12::uuid
     )
     ON CONFLICT (id)
     DO UPDATE SET name = EXCLUDED.name, public_slug = EXCLUDED.public_slug,
       description = EXCLUDED.description, amount_minor = EXCLUDED.amount_minor,
       currency = EXCLUDED.currency, enabled_providers = EXCLUDED.enabled_providers,
       status = EXCLUDED.status, success_message = EXCLUDED.success_message,
       metadata = EXCLUDED.metadata, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     WHERE goodads_payment_offers.organization_id = EXCLUDED.organization_id
       AND goodads_payment_offers.archived_at IS NULL
     RETURNING *`,
    [
      offerId,
      context.organizationId,
      offer.name,
      offer.publicSlug,
      offer.description,
      offer.amountMinor,
      offer.currency,
      offer.enabledProviders,
      offer.status,
      offer.successMessage,
      JSON.stringify(offer.metadata),
      userId,
    ]
  );
  if (!result.rows[0]) throw paymentError("Payment offer not found.", 404, "GOODADS_PAYMENT_OFFER_NOT_FOUND");
  return offerRow(result.rows[0]);
}

async function archiveOffer({ id, context, userId }) {
  requireMutationRole(context);
  if (!UUID_PATTERN.test(String(id || ""))) throw paymentError("A valid offer ID is required.");
  const result = await query(
    `UPDATE goodads_payment_offers
     SET status = 'archived', archived_at = NOW(), updated_by = $3::uuid, updated_at = NOW()
     WHERE id = $1::uuid AND organization_id = $2 AND archived_at IS NULL
     RETURNING id`,
    [id, context.organizationId, userId]
  );
  if (!result.rows[0]) throw paymentError("Payment offer not found.", 404, "GOODADS_PAYMENT_OFFER_NOT_FOUND");
  return { archived: true, id: result.rows[0].id };
}

async function getPublicOffer(slugValue) {
  const slug = boundedText(slugValue, 64).toLowerCase();
  if (!SLUG_PATTERN.test(slug)) throw paymentError("Payment offer not found.", 404, "GOODADS_PAYMENT_OFFER_NOT_FOUND");
  const result = await query(
    `SELECT o.*, COALESCE(array_agg(c.provider ORDER BY c.provider)
       FILTER (WHERE c.provider IS NOT NULL), ARRAY[]::text[]) AS connected_providers
     FROM goodads_payment_offers o
     LEFT JOIN goodads_payment_connections c
       ON c.organization_id = o.organization_id
      AND c.provider = ANY(o.enabled_providers)
      AND c.status = 'connected'
     WHERE o.public_slug = $1 AND o.status = 'active' AND o.archived_at IS NULL
     GROUP BY o.id`,
    [slug]
  );
  const row = result.rows[0];
  if (!row) throw paymentError("Payment offer not found.", 404, "GOODADS_PAYMENT_OFFER_NOT_FOUND");
  return {
    id: row.id,
    name: row.name,
    publicSlug: row.public_slug,
    description: row.description,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    providers: row.connected_providers.map((provider) => ({
      id: provider,
      name: PAYMENT_PROVIDERS[provider].name,
    })),
  };
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function publicSessionToken(sessionId) {
  return crypto
    .createHmac("sha256", encryptionKey())
    .update(`goodads-payment-session:${sessionId}`)
    .digest("base64url");
}

function resultUrl(sessionId, accessToken, provider, extra = "") {
  const base = `${appBaseUrl()}/payment/result?session=${encodeURIComponent(sessionId)}`
    + `&access=${encodeURIComponent(accessToken)}&provider=${encodeURIComponent(provider)}`;
  return `${base}${extra}`;
}

async function createStripeCheckout({ credentials, session, offer, accessToken, idempotencyKey, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    mode: "payment",
    success_url: resultUrl(session.id, accessToken, "stripe", "&stripe_session_id={CHECKOUT_SESSION_ID}"),
    cancel_url: resultUrl(session.id, accessToken, "stripe", "&cancelled=1"),
    client_reference_id: session.id,
    "metadata[goodads_session_id]": session.id,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": offer.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(offer.amount_minor),
    "line_items[0][price_data][product_data][name]": offer.name,
  });
  if (offer.description) body.set("line_items[0][price_data][product_data][description]", offer.description);
  if (session.customer_email) body.set("customer_email", session.customer_email);
  const response = await fetchImpl(`${providerBase("stripe", "live")}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const payload = await responseBody(response);
  if (!response.ok || !payload.id || !payload.url) {
    throw providerFailure("stripe", payload, "Stripe checkout could not be created.");
  }
  return { reference: payload.id, checkoutUrl: payload.url, metadata: {} };
}

async function createPayPalCheckout({ credentials, environment, session, offer, accessToken, idempotencyKey, fetchImpl = fetch }) {
  const bearer = await paypalAccessToken(credentials, environment, fetchImpl);
  const response = await fetchImpl(`${providerBase("paypal", environment)}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "PayPal-Request-Id": idempotencyKey.slice(0, 108),
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: session.id,
        custom_id: session.id,
        description: offer.description || offer.name,
        amount: {
          currency_code: offer.currency,
          value: formatMinorAmount(Number(offer.amount_minor), offer.currency),
        },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            user_action: "PAY_NOW",
            return_url: resultUrl(session.id, accessToken, "paypal"),
            cancel_url: resultUrl(session.id, accessToken, "paypal", "&cancelled=1"),
          },
        },
      },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await responseBody(response);
  const approval = (payload.links || []).find((link) => link.rel === "payer-action" || link.rel === "approve");
  if (!response.ok || !payload.id || !approval?.href) {
    throw providerFailure("paypal", payload, "PayPal checkout could not be created.");
  }
  return { reference: payload.id, checkoutUrl: approval.href, metadata: {} };
}

async function createSquareCheckout({ credentials, environment, session, offer, accessToken, idempotencyKey, fetchImpl = fetch }) {
  const response = await fetchImpl(`${providerBase("square", environment)}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Square-Version": "2026-07-15",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      description: `GoodAds offer ${session.id}`,
      quick_pay: {
        name: offer.name,
        price_money: { amount: offer.amount_minor, currency: offer.currency },
        location_id: credentials.locationId,
      },
      checkout_options: {
        redirect_url: resultUrl(session.id, accessToken, "square"),
      },
      pre_populated_data: session.customer_email ? { buyer_email: session.customer_email } : undefined,
      payment_note: boundedText(offer.description || offer.name, 500),
    }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await responseBody(response);
  const link = payload.payment_link;
  if (!response.ok || !link?.id || !link?.url || !link?.order_id) {
    throw providerFailure("square", payload, "Square checkout could not be created.");
  }
  return {
    reference: link.order_id,
    checkoutUrl: link.url,
    metadata: { paymentLinkId: link.id },
  };
}

function safeCustomerEmail(value) {
  const email = boundedText(value, 320).toLowerCase();
  if (email && !EMAIL_PATTERN.test(email)) throw paymentError("Enter a valid email address.");
  return email || null;
}

async function createCheckout({ slug, payload, idempotencyKey }) {
  const requestKey = boundedText(idempotencyKey, 200);
  if (!requestKey) {
    throw paymentError("Idempotency-Key header is required.", 400, "GOODADS_PAYMENT_IDEMPOTENCY_REQUIRED");
  }
  const offerResult = await query(
    `SELECT * FROM goodads_payment_offers
     WHERE public_slug = $1 AND status = 'active' AND archived_at IS NULL`,
    [boundedText(slug, 64).toLowerCase()]
  );
  const offer = offerResult.rows[0];
  if (!offer) throw paymentError("Payment offer not found.", 404, "GOODADS_PAYMENT_OFFER_NOT_FOUND");
  const existing = await query(
    `SELECT * FROM goodads_payment_sessions
     WHERE organization_id = $1 AND idempotency_key = $2`,
    [offer.organization_id, requestKey]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return {
      id: row.id,
      provider: row.provider,
      checkoutUrl: row.checkout_url,
      accessToken: publicSessionToken(row.id),
      status: row.status,
      duplicate: true,
    };
  }
  const preferences = await query(
    `SELECT default_provider, enabled_providers
     FROM goodads_payment_preferences WHERE organization_id = $1`,
    [offer.organization_id]
  );
  const preferred = preferences.rows[0] || {};
  const provider = normalizeProvider(payload?.provider || preferred.default_provider || offer.enabled_providers[0]);
  const enabled = preferences.rows[0] ? preferred.enabled_providers : offer.enabled_providers;
  if (!offer.enabled_providers.includes(provider) || !enabled.includes(provider)) {
    throw paymentError("The selected payment provider is not enabled for this offer.", 409, "GOODADS_PAYMENT_PROVIDER_DISABLED");
  }
  const connectionResult = await query(
    `SELECT * FROM goodads_payment_connections
     WHERE organization_id = $1 AND provider = $2 AND status = 'connected'`,
    [offer.organization_id, provider]
  );
  const connection = connectionResult.rows[0];
  if (!connection) {
    throw paymentError(
      `${PAYMENT_PROVIDERS[provider].name} is not connected for this workspace.`,
      503,
      "GOODADS_PAYMENT_PROVIDER_NOT_CONNECTED"
    );
  }
  const sessionId = crypto.randomUUID();
  const accessToken = publicSessionToken(sessionId);
  const customerEmail = safeCustomerEmail(payload?.customerEmail);
  const inserted = await query(
    `INSERT INTO goodads_payment_sessions (
       id, organization_id, offer_id, provider, idempotency_key, public_token_hash,
       amount_minor, currency, customer_email, status
     ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, 'creating')
     RETURNING *`,
    [
      sessionId,
      offer.organization_id,
      offer.id,
      provider,
      requestKey,
      tokenHash(accessToken),
      offer.amount_minor,
      offer.currency,
      customerEmail,
    ]
  );
  const session = inserted.rows[0];
  const credentials = decryptCredentials(connection);
  try {
    const checkoutArgs = {
      credentials,
      environment: connection.environment,
      session,
      offer,
      accessToken,
      idempotencyKey: requestKey,
    };
    const checkout = provider === "stripe"
      ? await createStripeCheckout(checkoutArgs)
      : provider === "paypal"
        ? await createPayPalCheckout(checkoutArgs)
        : await createSquareCheckout(checkoutArgs);
    await query(
      `UPDATE goodads_payment_sessions
       SET provider_reference = $2, checkout_url = $3, metadata = $4::jsonb,
         status = 'pending', updated_at = NOW()
       WHERE id = $1::uuid`,
      [sessionId, checkout.reference, checkout.checkoutUrl, JSON.stringify(checkout.metadata)]
    );
    return {
      id: sessionId,
      provider,
      checkoutUrl: checkout.checkoutUrl,
      accessToken,
      status: "pending",
      duplicate: false,
    };
  } catch (error) {
    await query(
      `UPDATE goodads_payment_sessions
       SET status = 'failed', failure_code = $2, failure_message = $3, updated_at = NOW()
       WHERE id = $1::uuid`,
      [sessionId, error.code || "PROVIDER_FAILED", boundedText(error.message, 500)]
    );
    throw error;
  }
}

function publicSession(row) {
  return {
    id: row.id,
    provider: row.provider,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

async function loadPublicSession(id, accessToken) {
  if (!UUID_PATTERN.test(String(id || "")) || !accessToken) {
    throw paymentError("Payment session not found.", 404, "GOODADS_PAYMENT_SESSION_NOT_FOUND");
  }
  const result = await query(
    `SELECT * FROM goodads_payment_sessions WHERE id = $1::uuid AND public_token_hash = $2`,
    [id, tokenHash(accessToken)]
  );
  if (!result.rows[0]) throw paymentError("Payment session not found.", 404, "GOODADS_PAYMENT_SESSION_NOT_FOUND");
  return result.rows[0];
}

async function getPublicSession({ id, accessToken }) {
  return publicSession(await loadPublicSession(id, accessToken));
}

async function capturePayPal({ id, accessToken, orderId, idempotencyKey }) {
  const session = await loadPublicSession(id, accessToken);
  if (session.provider !== "paypal" || session.provider_reference !== String(orderId || "")) {
    throw paymentError("PayPal order does not match this payment session.", 409, "GOODADS_PAYPAL_ORDER_MISMATCH");
  }
  if (session.status === "completed") return publicSession(session);
  if (!["pending", "approved"].includes(session.status)) {
    throw paymentError("This PayPal payment cannot be captured.", 409, "GOODADS_PAYPAL_CAPTURE_INVALID");
  }
  const connectionResult = await query(
    `SELECT * FROM goodads_payment_connections
     WHERE organization_id = $1 AND provider = 'paypal' AND status = 'connected'`,
    [session.organization_id]
  );
  const connection = connectionResult.rows[0];
  if (!connection) throw paymentError("PayPal is no longer connected.", 503, "GOODADS_PAYMENT_PROVIDER_NOT_CONNECTED");
  const credentials = decryptCredentials(connection);
  const bearer = await paypalAccessToken(credentials, connection.environment);
  const response = await fetch(
    `${providerBase("paypal", connection.environment)}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "PayPal-Request-Id": boundedText(idempotencyKey || `capture-${id}`, 108),
        Prefer: "return=representation",
      },
      body: "{}",
      signal: AbortSignal.timeout(20000),
    }
  );
  const payload = await responseBody(response);
  if (!response.ok || payload.status !== "COMPLETED") {
    throw providerFailure("paypal", payload, "PayPal payment could not be captured.");
  }
  const result = await query(
    `UPDATE goodads_payment_sessions
     SET status = 'completed', completed_at = COALESCE(completed_at, NOW()),
       updated_at = NOW(), metadata = metadata || $2::jsonb
     WHERE id = $1::uuid RETURNING *`,
    [id, JSON.stringify({ paypalCaptureId: payload.purchase_units?.[0]?.payments?.captures?.[0]?.id || null })]
  );
  return publicSession(result.rows[0]);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyStripeSignature(rawBody, signatureHeader, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = String(signatureHeader || "").split(",").map((entry) => entry.split("="));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > 300 || !signatures.length) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${Buffer.from(rawBody).toString("utf8")}`)
    .digest("hex");
  return signatures.some((signature) => safeEqual(signature, expected));
}

function verifySquareSignature(rawBody, signatureHeader, signatureKey, notificationUrl) {
  const expected = crypto
    .createHmac("sha256", signatureKey)
    .update(`${notificationUrl}${Buffer.from(rawBody).toString("utf8")}`)
    .digest("base64");
  return safeEqual(signatureHeader, expected);
}

async function verifyPayPalWebhook({ connection, credentials, headers, payload }) {
  const bearer = await paypalAccessToken(credentials, connection.environment);
  const response = await fetch(
    `${providerBase("paypal", connection.environment)}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        transmission_id: headers["paypal-transmission-id"],
        transmission_time: headers["paypal-transmission-time"],
        cert_url: headers["paypal-cert-url"],
        auth_algo: headers["paypal-auth-algo"],
        transmission_sig: headers["paypal-transmission-sig"],
        webhook_id: credentials.webhookId,
        webhook_event: payload,
      }),
      signal: AbortSignal.timeout(15000),
    }
  );
  const result = await responseBody(response);
  return response.ok && result.verification_status === "SUCCESS";
}

function webhookSessionIdentity(provider, payload) {
  if (provider === "stripe") {
    const object = payload?.data?.object || {};
    return {
      sessionId: object.metadata?.goodads_session_id || object.client_reference_id || null,
      providerReference: object.id || null,
      status: payload.type === "checkout.session.completed" && object.payment_status === "paid"
        ? "completed"
        : payload.type === "checkout.session.expired"
          ? "expired"
          : payload.type === "charge.refunded"
            ? "refunded"
            : null,
    };
  }
  if (provider === "paypal") {
    const resource = payload?.resource || {};
    const orderReference = resource.supplementary_data?.related_ids?.order_id || resource.id || null;
    const type = String(payload?.event_type || "");
    return {
      sessionId: resource.custom_id || resource.purchase_units?.[0]?.custom_id || null,
      providerReference: orderReference,
      status: type === "PAYMENT.CAPTURE.COMPLETED"
        ? "completed"
        : type === "CHECKOUT.ORDER.APPROVED"
          ? "approved"
          : ["PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"].includes(type)
            ? "failed"
            : type === "PAYMENT.CAPTURE.REFUNDED"
              ? "refunded"
              : null,
    };
  }
  const payment = payload?.data?.object?.payment || {};
  return {
    sessionId: payment.reference_id || null,
    providerReference: payment.order_id || null,
    status: payment.status === "COMPLETED"
      ? "completed"
      : ["FAILED", "CANCELED"].includes(payment.status)
        ? "failed"
        : payment.status === "APPROVED"
          ? "approved"
          : null,
  };
}

async function handleWebhook({ provider: providerValue, connectionId, rawBody, headers, payload }) {
  const provider = normalizeProvider(providerValue);
  if (!UUID_PATTERN.test(String(connectionId || ""))) {
    throw paymentError("Webhook connection not found.", 404, "GOODADS_PAYMENT_CONNECTION_NOT_FOUND");
  }
  if (!Buffer.isBuffer(rawBody) || !rawBody.length) {
    throw paymentError("Raw webhook payload is required.", 400, "GOODADS_PAYMENT_WEBHOOK_BODY_REQUIRED");
  }
  const connectionResult = await query(
    `SELECT * FROM goodads_payment_connections
     WHERE id = $1::uuid AND provider = $2 AND status = 'connected'`,
    [connectionId, provider]
  );
  const connection = connectionResult.rows[0];
  if (!connection) throw paymentError("Webhook connection not found.", 404, "GOODADS_PAYMENT_CONNECTION_NOT_FOUND");
  const credentials = decryptCredentials(connection);
  let verified = false;
  if (provider === "stripe") {
    verified = verifyStripeSignature(rawBody, headers["stripe-signature"], credentials.webhookSecret);
  } else if (provider === "paypal") {
    verified = await verifyPayPalWebhook({ connection, credentials, headers, payload });
  } else {
    verified = verifySquareSignature(
      rawBody,
      headers["x-square-hmacsha256-signature"],
      credentials.signatureKey,
      webhookUrl(provider, connectionId)
    );
  }
  if (!verified) {
    throw paymentError("Webhook signature verification failed.", 401, "GOODADS_PAYMENT_WEBHOOK_INVALID");
  }
  const providerEventId = boundedText(payload?.id || headers["paypal-transmission-id"], 240);
  const eventType = boundedText(payload?.type || payload?.event_type || "unknown", 240);
  if (!providerEventId) throw paymentError("Webhook event ID is required.");
  const inserted = await query(
    `INSERT INTO goodads_payment_webhook_events (
       organization_id, connection_id, provider, provider_event_id, event_type, payload_hash
     ) VALUES ($1, $2::uuid, $3, $4, $5, $6)
     ON CONFLICT (connection_id, provider_event_id) DO NOTHING
     RETURNING id`,
    [
      connection.organization_id,
      connection.id,
      provider,
      providerEventId,
      eventType,
      crypto.createHash("sha256").update(rawBody).digest("hex"),
    ]
  );
  if (!inserted.rows[0]) return { accepted: true, duplicate: true };
  const identity = webhookSessionIdentity(provider, payload);
  let updated = null;
  if (identity.status && (identity.sessionId || identity.providerReference)) {
    const result = await query(
      `UPDATE goodads_payment_sessions
       SET status = $4,
         completed_at = CASE WHEN $4 = 'completed' THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
         updated_at = NOW()
       WHERE organization_id = $1 AND provider = $2
         AND (
           ($3::uuid IS NOT NULL AND id = $3::uuid)
           OR ($5::text IS NOT NULL AND provider_reference = $5)
         )
       RETURNING id`,
      [
        connection.organization_id,
        provider,
        identity.sessionId && UUID_PATTERN.test(identity.sessionId) ? identity.sessionId : null,
        identity.status,
        identity.providerReference,
      ]
    );
    updated = result.rows[0]?.id || null;
  }
  await query(
    `UPDATE goodads_payment_webhook_events
     SET processing_status = $2, processed_at = NOW()
     WHERE id = $1::uuid`,
    [inserted.rows[0].id, updated ? "processed" : "ignored"]
  );
  return { accepted: true, duplicate: false, sessionUpdated: Boolean(updated) };
}

async function listSessions({ context, limit = 50 }) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const result = await query(
    `SELECT s.id, s.provider, s.amount_minor, s.currency, s.customer_email, s.status,
       s.created_at, s.updated_at, s.completed_at, o.name AS offer_name
     FROM goodads_payment_sessions s
     JOIN goodads_payment_offers o ON o.id = s.offer_id
     WHERE s.organization_id = $1
     ORDER BY s.created_at DESC LIMIT $2`,
    [context.organizationId, boundedLimit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    customerEmail: row.customer_email,
    status: row.status,
    offerName: row.offer_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }));
}

module.exports = {
  PAYMENT_PROVIDERS,
  normalizeProvider,
  normalizeEnvironment,
  normalizeCredentials,
  normalizeOffer,
  formatMinorAmount,
  tokenHash,
  verifyStripeSignature,
  verifySquareSignature,
  webhookSessionIdentity,
  validateCredentials,
  listProviders,
  configureProvider,
  disconnectProvider,
  getPreferences,
  updatePreferences,
  listOffers,
  saveOffer,
  archiveOffer,
  getPublicOffer,
  createCheckout,
  getPublicSession,
  capturePayPal,
  handleWebhook,
  listSessions,
};
