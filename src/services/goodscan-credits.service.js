"use strict";

const Stripe = require("stripe");
const { pool, query } = require("../config/database");

const MODE_COSTS = Object.freeze({ text: 20, image: 30, multiview: 45, scan: 35 });
const QUALITY_MULTIPLIERS = Object.freeze({ rapid: 0.75, balanced: 1, "high-detail": 1.6 });
const OPERATION_COSTS = Object.freeze({
  remesh: 4,
  "uv-unwrap": 4,
  "pbr-texture": 10,
  "texture-edit": 12,
  rig: 18,
  animate: 14,
  "print-check": 4,
  "print-repair": 10,
});
const OUTPUT_FORMATS = new Set(["GLB", "OBJ", "FBX", "STL", "USDZ", "3MF"]);
const CHECKOUT_SUCCESS_URL = "https://scan.goodos.app/?billing=success&session_id={CHECKOUT_SESSION_ID}";
const CHECKOUT_CANCEL_URL = "https://scan.goodos.app/?billing=cancelled";

function serviceError(message, statusCode = 400, code = "GOODSCAN_CREDIT_REQUEST_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

function stripeCredentialsConfigured() {
  return /^sk_(test|live)_/.test(process.env.STRIPE_SECRET_KEY || "") &&
    /^whsec_/.test(process.env.GOODSCAN_STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || "");
}

function stripeClient() {
  if (!stripeCredentialsConfigured()) {
    throw serviceError("GoodScan credit purchases are not activated yet.", 503, "GOODSCAN_PAYMENTS_NOT_ACTIVATED");
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20_000 });
}

function webhookSecret() {
  return process.env.GOODSCAN_STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || "";
}

function requiredIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key || key.length > 255) {
    throw serviceError("A valid Idempotency-Key header is required.", 400, "IDEMPOTENCY_KEY_REQUIRED");
  }
  return key;
}

function boundedInteger(value, minimum, maximum, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw serviceError(`${field} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function quoteGeneration(rawManifest) {
  const manifest = rawManifest && typeof rawManifest === "object" && !Array.isArray(rawManifest) ? rawManifest : {};
  if (manifest.schema !== "goodscan.ai-generation.v1") {
    throw serviceError("Unsupported GoodScan generation manifest schema.");
  }
  const mode = String(manifest.mode || "").toLowerCase();
  if (!Object.hasOwn(MODE_COSTS, mode)) throw serviceError("Unsupported GoodScan generation mode.");
  const settings = manifest.settings && typeof manifest.settings === "object" ? manifest.settings : {};
  const quality = String(settings.quality || "balanced").toLowerCase();
  if (!Object.hasOwn(QUALITY_MULTIPLIERS, quality)) throw serviceError("Unsupported generation quality.");
  const generationCount = boundedInteger(settings.generationCount ?? 1, 1, 4, "generationCount");
  const operations = Array.isArray(manifest.operations) ? [...new Set(manifest.operations.map(String))] : [];
  const invalidOperation = operations.find(operation => !Object.hasOwn(OPERATION_COSTS, operation));
  if (invalidOperation) throw serviceError(`Unsupported generation operation: ${invalidOperation}.`);
  const outputFormats = Array.isArray(manifest.outputFormats) ? [...new Set(manifest.outputFormats.map(value => String(value).toUpperCase()))] : [];
  if (!outputFormats.length || outputFormats.some(format => !OUTPUT_FORMATS.has(format))) {
    throw serviceError("Select at least one supported output format.");
  }
  const textureResolution = String(settings.textureResolution || "2K").toUpperCase();
  if (!["2K", "4K", "8K"].includes(textureResolution)) throw serviceError("Unsupported texture resolution.");

  const base = MODE_COSTS[mode];
  const qualityCost = Math.ceil(base * QUALITY_MULTIPLIERS[quality]);
  const operationCost = operations.reduce((sum, operation) => sum + OPERATION_COSTS[operation], 0);
  const textureCost = textureResolution === "8K" ? 15 : textureResolution === "4K" ? 5 : 0;
  const extraFormatCost = Math.max(0, outputFormats.length - 2) * 2;
  const perVariation = qualityCost + operationCost + textureCost + extraFormatCost;
  const credits = perVariation * generationCount;
  return {
    credits,
    currency: "credits",
    breakdown: { mode, base, quality, qualityCost, operations: operationCost, texture: textureCost, extraFormats: extraFormatCost, variations: generationCount },
    pricingVersion: "goodscan-credits-2026-08-10",
  };
}

async function ensureAccount(client, userId) {
  const inserted = await client.query(
    `INSERT INTO goodscan_credit_accounts (owner_user_id)
     VALUES ($1) ON CONFLICT (owner_user_id) DO NOTHING RETURNING *`,
    [userId],
  );
  if (inserted.rowCount) {
    await client.query(
      `INSERT INTO goodscan_credit_ledger
        (owner_user_id, amount, balance_after, entry_type, reference_type, reference_id,
         idempotency_key, description, metadata)
       VALUES ($1,100,100,'welcome_grant','account',$1::text,$2,
         'Welcome credits for starting with GoodScan','{"source":"account_activation"}'::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [userId, `goodscan-welcome:${userId}`],
    );
    return inserted.rows[0];
  }
  const result = await client.query(
    `SELECT * FROM goodscan_credit_accounts WHERE owner_user_id=$1 FOR UPDATE`,
    [userId],
  );
  if (!result.rowCount) throw serviceError("GoodScan credit account is unavailable.", 503, "GOODSCAN_CREDIT_ACCOUNT_UNAVAILABLE");
  return result.rows[0];
}

function publicAccount(row) {
  return {
    balance: Number(row.balance),
    lifetimePurchased: Number(row.lifetime_purchased),
    lifetimeGranted: Number(row.lifetime_granted),
    lifetimeSpent: Number(row.lifetime_spent),
    lifetimeRefunded: Number(row.lifetime_refunded),
    currency: row.currency,
    updatedAt: row.updated_at,
  };
}

function publicLedger(row) {
  return {
    id: row.id,
    amount: Number(row.amount),
    balanceAfter: Number(row.balance_after),
    type: row.entry_type,
    description: row.description,
    referenceType: row.reference_type || null,
    referenceId: row.reference_id || null,
    createdAt: row.created_at,
  };
}

function publicProduct(row) {
  return {
    sku: row.sku,
    name: row.name,
    description: row.description,
    credits: Number(row.credits),
    priceCents: Number(row.price_cents),
    currency: row.currency,
  };
}

async function summary(userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const account = await ensureAccount(client, userId);
    const [products, ledger, purchases] = await Promise.all([
      client.query(`SELECT * FROM goodscan_credit_products WHERE active=TRUE ORDER BY sort_order, price_cents`),
      client.query(`SELECT * FROM goodscan_credit_ledger WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 50`, [userId]),
      client.query(`SELECT id, product_sku, credit_amount, price_cents, currency, status, fulfilled_at, created_at
                      FROM goodscan_credit_checkout_sessions WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 20`, [userId]),
    ]);
    await client.query("COMMIT");
    const configured = stripeCredentialsConfigured();
    return {
      account: publicAccount(account),
      products: products.rows.map(publicProduct),
      ledger: ledger.rows.map(publicLedger),
      purchases: purchases.rows.map(row => ({
        id: row.id,
        productSku: row.product_sku,
        credits: Number(row.credit_amount),
        priceCents: Number(row.price_cents),
        currency: row.currency,
        status: row.status,
        fulfilledAt: row.fulfilled_at,
        createdAt: row.created_at,
      })),
      payments: {
        provider: "stripe",
        configured,
        acceptingPayments: configured,
        supportedMethods: configured ? ["card", "apple_pay", "google_pay"] : [],
        message: configured ? "Secure checkout is available." : "Credit purchases are awaiting payment-provider activation.",
      },
      generationPricing: {
        version: "goodscan-credits-2026-08-10",
        minimumCredits: 15,
        quoteEndpoint: "/api/goodscan/v1/ai/quote",
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function accountUsage(userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const account = await ensureAccount(client, userId);
    await client.query("COMMIT");
    return publicAccount(account);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function createCheckoutSession({ userId, productSku, idempotencyKey }) {
  const key = requiredIdempotencyKey(idempotencyKey);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureAccount(client, userId);
    const duplicate = await client.query(
      `SELECT * FROM goodscan_credit_checkout_sessions WHERE owner_user_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [userId, key],
    );
    if (duplicate.rowCount) {
      await client.query("COMMIT");
      const row = duplicate.rows[0];
      return { id: row.id, status: row.status, checkoutUrl: row.checkout_url, expiresAt: row.expires_at };
    }
    const product = await client.query(
      `SELECT * FROM goodscan_credit_products WHERE sku=$1 AND active=TRUE FOR SHARE`,
      [String(productSku || "")],
    );
    if (!product.rowCount) throw serviceError("The selected GoodScan credit pack is unavailable.", 404, "GOODSCAN_CREDIT_PRODUCT_NOT_FOUND");
    const user = await client.query(`SELECT email FROM users WHERE id=$1`, [userId]);
    const row = product.rows[0];
    const checkout = await client.query(
      `INSERT INTO goodscan_credit_checkout_sessions
        (owner_user_id, product_sku, credit_amount, price_cents, currency, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [userId, row.sku, row.credits, row.price_cents, row.currency, key],
    );
    const checkoutRow = checkout.rows[0];
    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: user.rows[0]?.email || undefined,
      client_reference_id: String(userId),
      success_url: CHECKOUT_SUCCESS_URL,
      cancel_url: CHECKOUT_CANCEL_URL,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: row.currency,
          unit_amount: Number(row.price_cents),
          product_data: {
            name: `${row.credits.toLocaleString()} GoodScan credits`,
            description: row.description,
          },
        },
      }],
      payment_intent_data: { metadata: { app: "goodscan", goodscanCheckoutId: checkoutRow.id, goodscanUserId: String(userId), productSku: row.sku } },
      metadata: { app: "goodscan", goodscanCheckoutId: checkoutRow.id, goodscanUserId: String(userId), productSku: row.sku },
    }, { idempotencyKey: `goodscan:${userId}:${key}`.slice(0, 255) });
    const updated = await client.query(
      `UPDATE goodscan_credit_checkout_sessions
          SET stripe_checkout_session_id=$2, checkout_url=$3, expires_at=$4, updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [checkoutRow.id, session.id, session.url, new Date(session.expires_at * 1000)],
    );
    await client.query("COMMIT");
    return { id: updated.rows[0].id, status: updated.rows[0].status, checkoutUrl: session.url, expiresAt: updated.rows[0].expires_at };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function fulfillCheckout(client, session) {
  if (session.metadata?.app !== "goodscan" || !session.metadata?.goodscanCheckoutId) return null;
  const checkout = await client.query(
    `SELECT * FROM goodscan_credit_checkout_sessions WHERE id=$1 FOR UPDATE`,
    [session.metadata.goodscanCheckoutId],
  );
  if (!checkout.rowCount) throw serviceError("GoodScan checkout record was not found.", 404, "GOODSCAN_CHECKOUT_NOT_FOUND");
  const row = checkout.rows[0];
  if (row.stripe_checkout_session_id && row.stripe_checkout_session_id !== session.id) {
    throw serviceError("Stripe session does not match the GoodScan checkout.", 409, "GOODSCAN_CHECKOUT_MISMATCH");
  }
  if (session.payment_status !== "paid") return row.id;
  if (Number(session.amount_total) !== Number(row.price_cents) || String(session.currency).toLowerCase() !== row.currency) {
    throw serviceError("Stripe payment amount does not match the GoodScan credit pack.", 409, "GOODSCAN_CHECKOUT_AMOUNT_MISMATCH");
  }
  if (row.status === "paid") return row.id;
  const account = await ensureAccount(client, row.owner_user_id);
  const balanceAfter = Number(account.balance) + Number(row.credit_amount);
  const ledger = await client.query(
    `INSERT INTO goodscan_credit_ledger
      (owner_user_id, amount, balance_after, entry_type, reference_type, reference_id,
       idempotency_key, description, metadata)
     VALUES ($1,$2,$3,'purchase','stripe_checkout',$4,$5,$6,$7::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [row.owner_user_id, row.credit_amount, balanceAfter, session.id, `stripe-checkout:${session.id}`,
      `Purchased ${Number(row.credit_amount).toLocaleString()} GoodScan credits`, JSON.stringify({ productSku: row.product_sku, paymentIntentId: session.payment_intent || null })],
  );
  if (ledger.rowCount) {
    await client.query(
      `UPDATE goodscan_credit_accounts
          SET balance=$2, lifetime_purchased=lifetime_purchased+$3, version=version+1, updated_at=NOW()
        WHERE owner_user_id=$1`,
      [row.owner_user_id, balanceAfter, row.credit_amount],
    );
  }
  await client.query(
    `UPDATE goodscan_credit_checkout_sessions
        SET status='paid', stripe_payment_intent_id=$2, fulfilled_at=COALESCE(fulfilled_at,NOW()), updated_at=NOW()
      WHERE id=$1`,
    [row.id, session.payment_intent || null],
  );
  return row.id;
}

async function reverseRefund(client, charge, eventId) {
  const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntentId || !charge.amount_refunded) return null;
  const checkout = await client.query(
    `SELECT * FROM goodscan_credit_checkout_sessions WHERE stripe_payment_intent_id=$1 FOR UPDATE`,
    [paymentIntentId],
  );
  if (!checkout.rowCount) return null;
  const row = checkout.rows[0];
  const totalRefunded = Math.min(Number(charge.amount_refunded), Number(row.price_cents));
  const previousRefunded = Number(row.amount_refunded_cents || 0);
  if (totalRefunded <= previousRefunded) return row.id;
  const previousCredits = Math.floor(Number(row.credit_amount) * previousRefunded / Number(row.price_cents));
  const totalCredits = Math.floor(Number(row.credit_amount) * totalRefunded / Number(row.price_cents));
  const creditsToReverse = Math.max(0, totalCredits - previousCredits);
  const account = await ensureAccount(client, row.owner_user_id);
  if (creditsToReverse) {
    const balanceAfter = Number(account.balance) - creditsToReverse;
    const ledger = await client.query(
      `INSERT INTO goodscan_credit_ledger
        (owner_user_id, amount, balance_after, entry_type, reference_type, reference_id,
         idempotency_key, description, metadata)
       VALUES ($1,$2,$3,'purchase_reversal','stripe_refund',$4,$5,$6,$7::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [row.owner_user_id, -creditsToReverse, balanceAfter, charge.id, `stripe-refund:${eventId}`,
        `Reversed ${creditsToReverse.toLocaleString()} credits after payment refund`, JSON.stringify({ paymentIntentId, amountRefundedCents: totalRefunded })],
    );
    if (ledger.rowCount) {
      await client.query(
        `UPDATE goodscan_credit_accounts
            SET balance=$2, lifetime_refunded=lifetime_refunded+$3, version=version+1, updated_at=NOW()
          WHERE owner_user_id=$1`,
        [row.owner_user_id, balanceAfter, creditsToReverse],
      );
    }
  }
  await client.query(
    `UPDATE goodscan_credit_checkout_sessions
        SET amount_refunded_cents=$2, status=$3, updated_at=NOW()
      WHERE id=$1`,
    [row.id, totalRefunded, totalRefunded >= Number(row.price_cents) ? "refunded" : "partially_refunded"],
  );
  return row.id;
}

async function processStripeEvent(event) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stored = await client.query(
      `INSERT INTO goodscan_credit_webhook_events
        (provider_event_id, event_type, signature_verified, payload)
       VALUES ($1,$2,TRUE,$3::jsonb)
       ON CONFLICT (provider_event_id) DO UPDATE
         SET processing_status='received', processing_error=NULL, processed_at=NULL
       WHERE goodscan_credit_webhook_events.processing_status='failed'
       RETURNING id`,
      [event.id, event.type, JSON.stringify(event)],
    );
    if (!stored.rowCount) {
      await client.query("COMMIT");
      return { duplicate: true };
    }
    let checkoutId = null;
    let status = "ignored";
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      checkoutId = await fulfillCheckout(client, event.data.object);
      status = checkoutId ? "processed" : "ignored";
    } else if (event.type === "checkout.session.expired" && event.data.object.metadata?.app === "goodscan") {
      const expired = await client.query(
        `UPDATE goodscan_credit_checkout_sessions SET status='expired', updated_at=NOW()
          WHERE id=$1 AND status='pending' RETURNING id`,
        [event.data.object.metadata.goodscanCheckoutId],
      );
      checkoutId = expired.rows[0]?.id || null;
      status = checkoutId ? "processed" : "ignored";
    } else if (event.type === "charge.refunded") {
      checkoutId = await reverseRefund(client, event.data.object, event.id);
      status = checkoutId ? "processed" : "ignored";
    }
    await client.query(
      `UPDATE goodscan_credit_webhook_events
          SET processing_status=$2, related_checkout_id=$3, processed_at=NOW()
        WHERE id=$1`,
      [stored.rows[0].id, status, checkoutId],
    );
    await client.query("COMMIT");
    return { duplicate: false, status };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await query(
      `INSERT INTO goodscan_credit_webhook_events
        (provider_event_id,event_type,signature_verified,processing_status,payload,processing_error,processed_at)
       VALUES ($1,$2,TRUE,'failed',$3::jsonb,$4,NOW())
       ON CONFLICT (provider_event_id) DO UPDATE SET processing_status='failed', processing_error=EXCLUDED.processing_error, processed_at=NOW()`,
      [event.id, event.type, JSON.stringify(event), String(error.message || error).slice(0, 1000)],
    ).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function reserveGenerationCredits({ userId, manifest, idempotencyKey }) {
  const key = requiredIdempotencyKey(idempotencyKey);
  const quote = quoteGeneration(manifest);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const duplicate = await client.query(
      `SELECT * FROM goodscan_generation_jobs WHERE owner_user_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [userId, key],
    );
    if (duplicate.rowCount) {
      await client.query("COMMIT");
      return duplicate.rows[0];
    }
    const account = await ensureAccount(client, userId);
    if (Number(account.balance) < quote.credits) {
      throw serviceError(`This job costs ${quote.credits} credits, but the account has ${account.balance}.`, 402, "GOODSCAN_INSUFFICIENT_CREDITS");
    }
    const balanceAfter = Number(account.balance) - quote.credits;
    const ledger = await client.query(
      `INSERT INTO goodscan_credit_ledger
        (owner_user_id, amount, balance_after, entry_type, reference_type, reference_id,
         idempotency_key, description, metadata)
       VALUES ($1,$2,$3,'generation_debit','generation_job',$4,$5,$6,$7::jsonb) RETURNING id`,
      [userId, -quote.credits, balanceAfter, key, `generation-debit:${userId}:${key}`,
        `Reserved credits for ${manifest.mode} generation`, JSON.stringify({ quote })],
    );
    const job = await client.query(
      `INSERT INTO goodscan_generation_jobs
        (owner_user_id,status,quoted_credits,manifest,debit_ledger_id,idempotency_key)
       VALUES ($1,'queued',$2,$3::jsonb,$4,$5) RETURNING *`,
      [userId, quote.credits, JSON.stringify(manifest), ledger.rows[0].id, key],
    );
    await client.query(
      `UPDATE goodscan_credit_accounts
          SET balance=$2, lifetime_spent=lifetime_spent+$3, version=version+1, updated_at=NOW()
        WHERE owner_user_id=$1`,
      [userId, balanceAfter, quote.credits],
    );
    await client.query("COMMIT");
    return job.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  accountUsage,
  createCheckoutSession,
  processStripeEvent,
  quoteGeneration,
  requiredIdempotencyKey,
  reserveGenerationCredits,
  serviceError,
  stripeClient,
  stripeCredentialsConfigured,
  summary,
  webhookSecret,
};
