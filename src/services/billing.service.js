const crypto = require("crypto");

const {
  query,
} = require("../config/database");

const {
  logAudit,
} = require("./audit.service");

// GOODOS_BILLING_LIVE_SERVICE_V1

function serviceError(
  message,
  statusCode = 500
) {
  const error = new Error(message);
  error.statusCode = statusCode;

  return error;
}

function billingId(prefix) {
  return (
    `${prefix}_` +
    crypto.randomUUID().replace(/-/g, "")
  );
}

function camelizeKey(value) {
  return value.replace(
    /_([a-z])/g,
    (_, letter) => letter.toUpperCase()
  );
}

function camelizeRow(row) {
  if (!row) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(row).map(
      ([key, value]) => [
        camelizeKey(key),
        value,
      ]
    )
  );
}

function jsonValue(
  value,
  fallback
) {
  if (
    value === null ||
    value === undefined
  ) {
    return fallback;
  }

  if (
    typeof value === "object"
  ) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizePlan(row) {
  const plan = camelizeRow(row);

  return {
    ...plan,
    included:
      jsonValue(
        plan.includedJson,
        {}
      ),
    limits:
      jsonValue(
        plan.limitsJson,
        {}
      ),
    features:
      jsonValue(
        plan.featuresJson,
        []
      ),
    metadata:
      jsonValue(
        plan.metadataJson,
        {}
      ),
  };
}

function normalizeCustomer(row) {
  const customer =
    camelizeRow(row);

  if (!customer) {
    return null;
  }

  return {
    ...customer,
    metadata:
      jsonValue(
        customer.metadataJson,
        {}
      ),
  };
}

function normalizeSubscription(row) {
  const subscription =
    camelizeRow(row);

  if (!subscription) {
    return null;
  }

  return {
    ...subscription,
    metadata:
      jsonValue(
        subscription.metadataJson,
        {}
      ),
  };
}

function normalizeInvoice(row) {
  const invoice =
    camelizeRow(row);

  if (!invoice) {
    return null;
  }

  const metadata =
    jsonValue(
      invoice.metadataJson,
      {}
    );

  return {
    ...invoice,
    metadata,
    invoicePdfUrl:
      metadata.invoicePdf ||
      metadata.invoicePdfUrl ||
      metadata.invoice_pdf ||
      null,
    hostedInvoiceUrl:
      metadata.hostedInvoiceUrl ||
      metadata.hosted_invoice_url ||
      null,
  };
}

function validEmail(value) {
  return (
    value.length >= 3 &&
    value.length <= 320 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(
      value
    )
  );
}

async function requireOrganization(
  userId
) {
  const result = await query(
    `
      SELECT
        organization.id,
        organization.name,
        organization.slug,
        organization.plan,
        organization.status,

        membership.role
          AS membership_role,

        membership.status
          AS membership_status

      FROM backend_organizations
           organization

      JOIN backend_organization_memberships
           membership
        ON membership.organization_id =
           organization.id

      WHERE membership.user_id =
            $1::uuid

        AND membership.status =
            'active'

        AND organization.status =
            'active'

      ORDER BY
        CASE membership.role
          WHEN 'owner' THEN 1
          WHEN 'admin' THEN 2
          WHEN 'manager' THEN 3
          ELSE 4
        END

      LIMIT 1
    `,
    [
      userId,
    ]
  );

  if (result.rowCount === 0) {
    throw serviceError(
      "Active organization membership is required.",
      403
    );
  }

  return camelizeRow(
    result.rows[0]
  );
}

function canManageBilling(
  organization
) {
  return [
    "owner",
    "admin",
  ].includes(
    organization.membershipRole
  );
}

const PURCHASE_TIER_COUNTS = {
  single: 1,
  five: 5,
  ten: 10,
  suite: "all",
};

const PURCHASE_TIER_ALIASES = {
  single: ["single", "single-app", "single_app"],
  five: ["five", "five-app", "five_app"],
  ten: ["ten", "ten-app", "ten_app"],
  suite: ["suite", "goodos-suite", "goodos_suite", "enterprise"],
};

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

function stripePriceId(plan, billingCycle) {
  const metadata = plan?.metadata || {};
  return billingCycle === "annual"
    ? metadata.stripeAnnualPriceId || metadata.stripePriceId || null
    : metadata.stripeMonthlyPriceId || metadata.stripePriceId || null;
}

function paypalPlanId(plan, billingCycle) {
  const metadata = plan?.metadata || {};
  return billingCycle === "annual"
    ? metadata.paypalAnnualPlanId || metadata.paypalPlanId || null
    : metadata.paypalMonthlyPlanId || metadata.paypalPlanId || null;
}

function planMatchesTier(plan, tier) {
  const metadata = plan?.metadata || {};
  const candidates = [
    plan?.name,
    plan?.displayName,
    metadata.purchaseTier,
    metadata.tier,
  ].map(normalizeKey);

  return (PURCHASE_TIER_ALIASES[tier] || [])
    .map(normalizeKey)
    .some(alias => candidates.includes(alias));
}

function checkoutMethods(plans) {
  const stripeMappedPlans = plans.filter(plan =>
    stripePriceId(plan, "monthly") || stripePriceId(plan, "annual")
  ).length;
  const paypalMappedPlans = plans.filter(plan =>
    paypalPlanId(plan, "monthly") || paypalPlanId(plan, "annual")
  ).length;

  const cardMissing = [];
  if (!process.env.STRIPE_SECRET_KEY) cardMissing.push("Stripe secret key");
  if (!process.env.STRIPE_WEBHOOK_SECRET) cardMissing.push("Stripe webhook secret");
  if (!stripeMappedPlans) cardMissing.push("Stripe plan price mappings");

  const paypalMissing = [];
  if (!process.env.PAYPAL_CLIENT_ID) paypalMissing.push("PayPal client ID");
  if (!process.env.PAYPAL_CLIENT_SECRET) paypalMissing.push("PayPal client secret");
  if (!process.env.PAYPAL_WEBHOOK_ID) paypalMissing.push("PayPal webhook ID");
  if (!paypalMappedPlans) paypalMissing.push("PayPal plan mappings");

  return [
    {
      id: "card",
      displayName: "Credit or debit card",
      provider: "stripe",
      available: cardMissing.length === 0,
      mappedPlans: stripeMappedPlans,
      missing: cardMissing,
    },
    {
      id: "paypal",
      displayName: "PayPal",
      provider: "paypal",
      available: paypalMissing.length === 0,
      mappedPlans: paypalMappedPlans,
      missing: paypalMissing,
    },
  ];
}

function normalizeBillingCycle(value) {
  return value === "annual" ? "annual" : "monthly";
}

function normalizePaymentMethod(value) {
  if (!["card", "paypal"].includes(value)) {
    throw serviceError("Choose card or PayPal to continue.", 400);
  }

  return value;
}

function normalizePurchaseTier(value) {
  const tier = normalizeKey(value);

  if (!Object.prototype.hasOwnProperty.call(PURCHASE_TIER_COUNTS, tier)) {
    throw serviceError("Choose a valid GoodOS purchase tier.", 400);
  }

  return tier;
}

function publicBillingUrl(pathname) {
  const base = String(
    process.env.PUBLIC_API_URL ||
    process.env.API_PUBLIC_URL ||
    "https://base.goodos.app"
  ).replace(/\/$/, "");

  return `${base}${pathname}`;
}

function goodosPurchaseUrl(result) {
  const base = String(
    process.env.GOODOS_PUBLIC_URL ||
    "https://goodos.app"
  ).replace(/\/$/, "");

  return `${base}/?pricing=1&checkout=${encodeURIComponent(result)}`;
}

async function providerRequest(url, options, label) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      body?.error?.message ||
      body?.message ||
      `${label} failed.`;
    throw serviceError(message, 502);
  }

  return body;
}

async function paypalAccessToken() {
  const base = process.env.PAYPAL_API_BASE || "https://api-m.paypal.com";
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");
  const body = await providerRequest(
    `${base}/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    },
    "PayPal authorization"
  );

  return body.access_token;
}

async function activePlansForOrganization(organizationId) {
  const result = await query(
    `
      SELECT *
      FROM backend_billing_plans
      WHERE status = 'active'
        AND (organization_id = $1 OR organization_id IS NULL)
      ORDER BY sort_order, monthly_price_cents
    `,
    [organizationId]
  );

  return result.rows.map(normalizePlan);
}

async function resolvePurchaseApps(tier, appIdsInput) {
  const requested = Array.from(new Set(
    (Array.isArray(appIdsInput) ? appIdsInput : [])
      .map(value => String(value || "").trim())
      .filter(Boolean)
  ));
  const expected = PURCHASE_TIER_COUNTS[tier];
  const result = await query(
    `
      SELECT id
      FROM apps
      WHERE status = 'active'
        AND id <> 'goodos'
        AND ($1::boolean OR id = ANY($2::text[]))
      ORDER BY name, id
    `,
    [expected === "all", requested]
  );
  const appIds = result.rows.map(row => row.id);

  if (expected !== "all" && requested.length !== expected) {
    throw serviceError(`The ${tier} tier requires exactly ${expected} applications.`, 400);
  }

  if (expected !== "all" && appIds.length !== requested.length) {
    throw serviceError("One or more selected applications are unavailable.", 400);
  }

  if (appIds.length === 0) {
    throw serviceError("No active applications are available for this purchase.", 400);
  }

  return appIds;
}

async function createStripeCheckout({ subscriptionId, plan, billingCycle, organization, userId, appIds, tier }) {
  const priceId = stripePriceId(plan, billingCycle);
  if (!process.env.STRIPE_SECRET_KEY || !priceId) {
    throw serviceError("Card checkout is not configured for this tier yet.", 503);
  }

  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("line_items[0][price]", priceId);
  params.set("line_items[0][quantity]", "1");
  params.set("success_url", publicBillingUrl(`/api/billing/checkout/return?provider=stripe&local=${encodeURIComponent(subscriptionId)}&session_id={CHECKOUT_SESSION_ID}`));
  params.set("cancel_url", goodosPurchaseUrl("cancelled"));
  params.set("client_reference_id", subscriptionId);
  params.set("metadata[organizationId]", organization.id);
  params.set("metadata[userId]", userId);
  params.set("metadata[tier]", tier);
  params.set("metadata[appIds]", appIds.join(","));

  const session = await providerRequest(
    "https://api.stripe.com/v1/checkout/sessions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
    "Card checkout"
  );

  return { checkoutUrl: session.url, externalId: session.id };
}

async function createPaypalCheckout({ subscriptionId, plan, billingCycle, organization, userId, appIds, tier }) {
  const planId = paypalPlanId(plan, billingCycle);
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET || !planId) {
    throw serviceError("PayPal checkout is not configured for this tier yet.", 503);
  }

  const base = process.env.PAYPAL_API_BASE || "https://api-m.paypal.com";
  const accessToken = await paypalAccessToken();
  const subscription = await providerRequest(
    `${base}/v1/billing/subscriptions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        plan_id: planId,
        custom_id: subscriptionId,
        application_context: {
          brand_name: "GoodOS",
          user_action: "SUBSCRIBE_NOW",
          return_url: publicBillingUrl(`/api/billing/checkout/return?provider=paypal&local=${encodeURIComponent(subscriptionId)}`),
          cancel_url: goodosPurchaseUrl("cancelled"),
        },
      }),
    },
    "PayPal checkout"
  );
  const approval = (subscription.links || []).find(link => link.rel === "approve");

  if (!approval?.href) {
    throw serviceError("PayPal did not return an approval link.", 502);
  }

  return { checkoutUrl: approval.href, externalId: subscription.id };
}

async function createCheckoutForUser(userId, input = {}, requestMeta = {}) {
  const organization = await requireOrganization(userId);
  if (!canManageBilling(organization)) {
    throw serviceError("Owner or admin access is required to purchase applications.", 403);
  }

  const tier = normalizePurchaseTier(input.tier);
  const billingCycle = normalizeBillingCycle(input.billingCycle);
  const paymentMethod = normalizePaymentMethod(input.paymentMethod);
  const appIds = await resolvePurchaseApps(tier, input.appIds);
  const plans = await activePlansForOrganization(organization.id);
  const plan = plans.find(candidate => planMatchesTier(candidate, tier));

  if (!plan) {
    throw serviceError("This GoodOS purchase tier is not configured yet.", 503);
  }

  const id = billingId("sub");
  const provider = paymentMethod === "paypal" ? "paypal" : "stripe";
  await query(
    `
      INSERT INTO backend_subscriptions (
        id, organization_id, plan_id, plan_name, status, billing_cycle,
        provider, metadata_json, project_id, environment_id, created_by
      ) VALUES (
        $1, $2, $3, $4, 'pending', $5, $6, $7::jsonb,
        'proj_goodos_platform', 'env_goodos_production', $8::uuid
      )
    `,
    [id, organization.id, plan.id, plan.name, billingCycle, provider,
      JSON.stringify({ tier, appIds, userId, source: "goodos_shared_checkout_v1" }), userId]
  );

  try {
    const checkout = provider === "paypal"
      ? await createPaypalCheckout({ subscriptionId: id, plan, billingCycle, organization, userId, appIds, tier })
      : await createStripeCheckout({ subscriptionId: id, plan, billingCycle, organization, userId, appIds, tier });

    await query(
      `UPDATE backend_subscriptions SET external_subscription_id = $2, updated_at = NOW() WHERE id = $1`,
      [id, checkout.externalId]
    );
    await logAudit({
      userId,
      appId: "goodos",
      action: "billing.checkout.created",
      entityType: "subscription",
      entityId: id,
      ipAddress: requestMeta.ipAddress || null,
      metadata: { organizationId: organization.id, tier, appIds, provider, billingCycle },
    });

    return { success: true, checkoutUrl: checkout.checkoutUrl, sessionId: checkout.externalId, provider };
  } catch (error) {
    await query(`UPDATE backend_subscriptions SET status = 'failed', updated_at = NOW() WHERE id = $1`, [id]);
    throw error;
  }
}

async function verifyProviderCheckout(provider, externalId) {
  if (provider === "stripe") {
    const session = await providerRequest(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(externalId)}`,
      { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } },
      "Card checkout verification"
    );
    if (session.status !== "complete" || !["paid", "no_payment_required"].includes(session.payment_status)) {
      throw serviceError("Card checkout has not completed.", 409);
    }
    return session.subscription || externalId;
  }

  const accessToken = await paypalAccessToken();
  const base = process.env.PAYPAL_API_BASE || "https://api-m.paypal.com";
  const subscription = await providerRequest(
    `${base}/v1/billing/subscriptions/${encodeURIComponent(externalId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "PayPal checkout verification"
  );
  if (subscription.status !== "ACTIVE") {
    throw serviceError("PayPal subscription has not become active.", 409);
  }
  return subscription.id;
}

async function confirmCheckoutForUser(userId, input = {}) {
  const id = String(input.local || "").trim();
  const provider = input.provider === "paypal" ? "paypal" : "stripe";
  const result = await query(
    `SELECT * FROM backend_subscriptions WHERE id = $1 AND created_by = $2::uuid LIMIT 1`,
    [id, userId]
  );
  const subscription = normalizeSubscription(result.rows[0]);
  if (!subscription) throw serviceError("Checkout session was not found.", 404);
  if (subscription.provider !== provider) throw serviceError("Checkout provider does not match.", 400);

  const checkoutExternalId = provider === "stripe"
    ? String(input.sessionId || "")
    : subscription.externalSubscriptionId;
  if (!checkoutExternalId) throw serviceError("Checkout confirmation is incomplete.", 400);
  const externalSubscriptionId = await verifyProviderCheckout(provider, checkoutExternalId);
  const metadata = subscription.metadata || {};
  const appIds = Array.isArray(metadata.appIds) ? metadata.appIds : [];

  for (const appId of appIds) {
    const membership = await query(
      `
        UPDATE app_memberships
        SET status = 'active', organization_id = $3,
            project_id = 'proj_goodos_platform',
            environment_id = 'env_goodos_production', updated_at = NOW()
        WHERE user_id = $1::uuid AND app_id = $2
      `,
      [userId, appId, subscription.organizationId]
    );
    if (membership.rowCount === 0) {
      await query(
        `
          INSERT INTO app_memberships (
            user_id, app_id, role, status, organization_id, project_id, environment_id
          ) VALUES (
            $1::uuid, $2, 'member', 'active', $3,
            'proj_goodos_platform', 'env_goodos_production'
          )
        `,
        [userId, appId, subscription.organizationId]
      );
    }
  }

  await query(
    `
      UPDATE backend_subscriptions
      SET status = 'active', external_subscription_id = $2,
          current_period_start = NOW(),
          current_period_end = CASE WHEN billing_cycle = 'annual'
            THEN NOW() + INTERVAL '1 year' ELSE NOW() + INTERVAL '1 month' END,
          updated_at = NOW()
      WHERE id = $1
    `,
    [id, externalSubscriptionId]
  );
  await query(
    `UPDATE backend_organizations SET plan = $2, updated_at = NOW() WHERE id = $1`,
    [subscription.organizationId, subscription.planName]
  );

  return { success: true, redirectUrl: goodosPurchaseUrl("success") };
}

function providerStatus(plans) {
  const secretConfigured =
    Boolean(
      process.env.STRIPE_SECRET_KEY
    );

  const webhookConfigured =
    Boolean(
      process.env.STRIPE_WEBHOOK_SECRET
    );

  const mappedPlans =
    plans.filter(plan => {
      const metadata =
        plan.metadata || {};

      return Boolean(
        metadata.stripeMonthlyPriceId ||
        metadata.stripeAnnualPriceId ||
        metadata.stripePriceId
      );
    }).length;

  const packageInstalled = true;

  const ready =
    packageInstalled &&
    secretConfigured &&
    webhookConfigured &&
    mappedPlans > 0;

  const missing = [];

  if (!packageInstalled) {
    missing.push(
      "Stripe server package"
    );
  }

  if (!secretConfigured) {
    missing.push(
      "Stripe secret key"
    );
  }

  if (!webhookConfigured) {
    missing.push(
      "Stripe webhook secret"
    );
  }

  if (mappedPlans === 0) {
    missing.push(
      "Stripe plan price mappings"
    );
  }

  return {
    provider:
      process.env.PAYMENT_PROVIDER ||
      "stripe",
    packageInstalled,
    secretConfigured,
    webhookConfigured,
    mappedPlans,
    ready,
    missing,
    transport: "https",
  };
}

async function getBillingOverviewForUser(
  userId
) {
  const organization =
    await requireOrganization(userId);

  const [
    plansResult,
    customerResult,
    subscriptionResult,
    invoicesResult,
  ] = await Promise.all([
    query(
      `
        SELECT *
        FROM backend_billing_plans

        WHERE status = 'active'

          AND (
            organization_id =
              $1

            OR organization_id
               IS NULL
          )

        ORDER BY
          sort_order,
          annual_price_cents,
          monthly_price_cents,
          display_name
      `,
      [
        organization.id,
      ]
    ),

    query(
      `
        SELECT *
        FROM backend_billing_customers

        WHERE organization_id = $1
          AND status = 'active'

        ORDER BY
          updated_at DESC,
          created_at DESC

        LIMIT 1
      `,
      [
        organization.id,
      ]
    ),

    query(
      `
        SELECT *
        FROM backend_subscriptions

        WHERE organization_id = $1

        ORDER BY
          CASE status
            WHEN 'active' THEN 1
            WHEN 'trialing' THEN 2
            WHEN 'past_due' THEN 3
            ELSE 4
          END,

          updated_at DESC,
          created_at DESC

        LIMIT 1
      `,
      [
        organization.id,
      ]
    ),

    query(
      `
        SELECT *
        FROM backend_invoices

        WHERE organization_id = $1

        ORDER BY
          created_at DESC

        LIMIT 100
      `,
      [
        organization.id,
      ]
    ),
  ]);

  const plans =
    plansResult.rows.map(
      normalizePlan
    );

  const customer =
    normalizeCustomer(
      customerResult.rows[0]
    );

  const subscription =
    normalizeSubscription(
      subscriptionResult.rows[0]
    );

  const invoices =
    invoicesResult.rows.map(
      normalizeInvoice
    );

  const organizationPlan =
    String(
      organization.plan || ""
    ).toLowerCase();

  const currentPlan =
    plans.find(plan =>
      [
        String(
          plan.id || ""
        ).toLowerCase(),
        String(
          plan.name || ""
        ).toLowerCase(),
      ].includes(
        String(
          subscription?.planId ||
          organizationPlan
        ).toLowerCase()
      )
    ) ||
    plans.find(
      plan =>
        String(
          plan.name || ""
        ).toLowerCase() ===
        organizationPlan
    ) ||
    null;

  return {
    organization,
    canManage:
      canManageBilling(
        organization
      ),
    currentPlan,
    plans,
    customer,
    subscription,
    invoices,
    paymentMethods: [],
    checkoutMethods:
      checkoutMethods(plans),
    provider:
      providerStatus(plans),
  };
}

async function updateBillingEmailForUser(
  userId,
  emailInput,
  requestMeta = {}
) {
  const organization =
    await requireOrganization(userId);

  if (
    !canManageBilling(
      organization
    )
  ) {
    throw serviceError(
      "Owner or admin access is required to update billing information.",
      403
    );
  }

  const email =
    String(emailInput || "")
      .trim()
      .toLowerCase();

  if (!validEmail(email)) {
    throw serviceError(
      "A valid billing email is required.",
      400
    );
  }

  const existing = await query(
    `
      SELECT id
      FROM backend_billing_customers

      WHERE organization_id = $1

      ORDER BY
        updated_at DESC,
        created_at DESC

      LIMIT 1
    `,
    [
      organization.id,
    ]
  );

  let result;

  if (existing.rowCount > 0) {
    result = await query(
      `
        UPDATE backend_billing_customers

        SET
          billing_email = $2,
          email =
            COALESCE(
              email,
              $2
            ),
          updated_at = NOW()

        WHERE id = $1

        RETURNING *
      `,
      [
        existing.rows[0].id,
        email,
      ]
    );
  } else {
    result = await query(
      `
        INSERT INTO backend_billing_customers (
          id,
          organization_id,
          user_id,
          name,
          email,
          provider,
          billing_email,
          tax_status,
          status,
          metadata_json,
          project_id,
          environment_id,
          created_by
        )
        VALUES (
          $1,
          $2,
          $3::uuid,
          $4,
          $5,
          'internal',
          $5,
          'not_configured',
          'active',
          $6::jsonb,
          'proj_goodos_platform',
          'env_goodos_production',
          $3::uuid
        )

        RETURNING *
      `,
      [
        billingId("billcust"),
        organization.id,
        userId,
        organization.name,
        email,
        JSON.stringify({
          source:
            "goodos_billing_live_v1",
        }),
      ]
    );
  }

  const customer =
    normalizeCustomer(
      result.rows[0]
    );

  await logAudit({
    userId,
    appId: "goodos",
    action:
      "billing.customer.updated",
    entityType:
      "billing_customer",
    entityId:
      customer.id,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        organization.id,
      billingEmail: email,
    },
  });

  return customer;
}

module.exports = {
  confirmCheckoutForUser,
  createCheckoutForUser,
  getBillingOverviewForUser,
  updateBillingEmailForUser,
  _test: {
    checkoutMethods,
    normalizeBillingCycle,
    normalizePaymentMethod,
    normalizePurchaseTier,
    planMatchesTier,
  },
};
