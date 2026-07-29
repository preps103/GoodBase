"use strict";

const express = require("express");
const Stripe = require("stripe");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { pool, query } = require("../config/database");

const router = express.Router();
const PUBLIC_ORGANIZATION_ID =
  process.env.GOODFLEET_PUBLIC_ORGANIZATION_ID || "org_goodos";
const MONEY_TYPES = new Set(["rental", "deposit", "fine"]);
const MANUAL_METHODS = new Map([
  ["cash", "Cash"],
  ["bank transfer", "Bank Transfer"],
  ["bank_transfer", "Bank Transfer"],
  ["zelle", "Zelle"]
]);

function credentialsConfigured() {
  return Boolean(
    /^sk_(test|live)_/.test(process.env.STRIPE_SECRET_KEY || "") &&
    /^pk_(test|live)_/.test(process.env.STRIPE_PUBLISHABLE_KEY || "") &&
    /^whsec_/.test(process.env.STRIPE_WEBHOOK_SECRET || "")
  );
}

function stripeClient() {
  if (!credentialsConfigured()) {
    const error = new Error("Add the Stripe secret, publishable, and webhook keys to activate card payments.");
    error.statusCode = 503;
    error.code = "PAYMENTS_NOT_ACTIVATED";
    throw error;
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
}

function fail(response, status, code, message) {
  return response.status(status).json({ success: false, code, message });
}

function actor(request) {
  return request.user?.id || null;
}

function organization(request) {
  return request.tenantContext.organizationId;
}

function requirePaymentEmployee(request, response, next) {
  const organizationRole = String(request.tenantContext.organization?.membershipRole || "").toLowerCase();
  const appRole = (request.apps || []).find(app =>
    String(app?.membershipStatus || "").toLowerCase() === "active" &&
    (String(app?.id || "").toLowerCase() === "goodfleet" ||
      String(app?.domain || "").toLowerCase() === "fleet.goodos.app")
  )?.role;
  if (!new Set(["owner", "admin", "manager", "staff"]).has(
    ["owner", "admin", "manager"].includes(organizationRole)
      ? organizationRole
      : String(appRole || organizationRole).toLowerCase()
  )) {
    return fail(response, 403, "PAYMENT_ACCESS_REQUIRED", "GoodFleet payment access is required.");
  }
  return next();
}

function requirePaymentCustomer(request, response, next) {
  const role = String(
    (request.apps || []).find(app =>
      String(app?.membershipStatus || "").toLowerCase() === "active" &&
      (String(app?.id || "").toLowerCase() === "goodfleet" ||
        String(app?.domain || "").toLowerCase() === "fleet.goodos.app")
    )?.role || ""
  ).toLowerCase();
  if (!["customer", "host"].includes(role)) {
    return fail(
      response,
      403,
      "CUSTOMER_PAYMENT_ACCESS_REQUIRED",
      "A GoodFleet guest or host account is required.",
    );
  }
  return next();
}

function idempotencyKey(request) {
  return String(request.get("Idempotency-Key") || "").trim().slice(0, 255);
}

function requiredIdempotencyKey(request, response) {
  const key = idempotencyKey(request);
  if (!key) {
    fail(response, 400, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key header is required for payment changes.");
    return null;
  }
  return key;
}

function amount(value, field = "amount") {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1_000_000) {
    const error = new Error(`${field} must be greater than zero and no more than 1,000,000.`);
    error.statusCode = 400;
    error.code = "INVALID_AMOUNT";
    throw error;
  }
  return Number(parsed.toFixed(2));
}

function currency(value) {
  const normalized = String(value || process.env.STRIPE_DEFAULT_CURRENCY || "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    const error = new Error("currency must be a three-letter ISO code.");
    error.statusCode = 400;
    error.code = "INVALID_CURRENCY";
    throw error;
  }
  return normalized;
}

function cents(value) {
  return Math.round(Number(value) * 100);
}

function operationPayload(row) {
  const providerStatus = row.status;
  const status = providerStatus === "succeeded"
    ? row.operation_type === "authorization"
      ? "authorized"
      : row.operation_type === "refund" ? "refunded" : "captured"
    : providerStatus === "cancelled" ? "voided" : providerStatus;
  return {
    paymentId: row.id,
    status,
    amount: Number(row.amount),
    currency: row.currency,
    providerReference: row.provider_reference || undefined,
    receiptUrl: row.receipt_url || row.response_json?.receiptUrl || undefined,
    checkoutUrl: row.response_json?.checkoutUrl || undefined,
    expiresAt: row.response_json?.expiresAt || undefined,
    operationType: row.operation_type,
    method: row.request_json?.method || undefined,
    description: row.request_json?.description || undefined,
  };
}

async function existingOperation(client, org, key) {
  const result = await client.query(
    `SELECT * FROM fleet_payment_operations
      WHERE organization_id=$1 AND idempotency_key=$2`,
    [org, key]
  );
  return result.rows[0] || null;
}

async function loadBooking(client, org, bookingId, lock = false) {
  const result = await client.query(
    `SELECT booking.*,customer.full_name AS customer_name,customer.email AS customer_email
       FROM fleet_bookings booking
       JOIN fleet_customers customer
         ON customer.organization_id=booking.organization_id
        AND customer.id=booking.customer_id
      WHERE booking.organization_id=$1 AND booking.id=$2
        AND booking.archived_at IS NULL
      ${lock ? "FOR UPDATE OF booking" : ""}`,
    [org, bookingId]
  );
  if (!result.rowCount) {
    const error = new Error("Reservation not found.");
    error.statusCode = 404;
    error.code = "BOOKING_NOT_FOUND";
    throw error;
  }
  return result.rows[0];
}

async function recalculateBookingBalance(client, org, bookingId) {
  const booking = await loadBooking(client, org, bookingId, true);
  const totals = await client.query(
    `SELECT COALESCE(SUM(
       CASE
         WHEN status IN ('succeeded','captured') AND operation_type IN ('checkout','capture','manual_payment') THEN amount
         WHEN status IN ('succeeded','refunded') AND operation_type='refund' THEN -amount
         ELSE 0
       END
     ),0)::numeric(12,2) AS paid_amount
       FROM fleet_payment_operations
      WHERE organization_id=$1 AND booking_id=$2`,
    [org, bookingId]
  );
  const paidAmount = Math.max(0, Number(totals.rows[0].paid_amount));
  const totalAmount = Number(booking.total_amount);
  const paymentStatus = paidAmount <= 0
    ? "unpaid"
    : paidAmount + 0.005 >= totalAmount ? "paid" : "partial";
  await client.query(
    `UPDATE fleet_bookings
        SET paid_amount=$3,payment_status=$4,version=version+1,updated_at=NOW()
      WHERE organization_id=$1 AND id=$2`,
    [org, bookingId, paidAmount.toFixed(2), paymentStatus]
  );
  return { paidAmount, paymentStatus, balanceDue: Math.max(0, totalAmount - paidAmount) };
}

function safeReturnUrl(value) {
  const fallback = "https://fleet.goodos.app/app/reservations";
  try {
    const url = new URL(String(value || fallback));
    const allowed = url.protocol === "https:" &&
      (url.hostname === "goodos.app" || url.hostname.endsWith(".goodos.app"));
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    if (!allowed && !local) return fallback;
    url.hash = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

async function insertOperation(client, input) {
  const result = await client.query(
    `INSERT INTO fleet_payment_operations
      (organization_id,booking_id,customer_id,operation_type,provider,provider_reference,
       idempotency_key,amount,currency,status,request_json,response_json,parent_operation_id,
       created_by,processed_by,processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16)
     RETURNING *`,
    [
      input.organizationId, input.bookingId || null, input.customerId || null,
      input.operationType, input.provider || "stripe", input.providerReference || null,
      input.idempotencyKey, input.amount, input.currency, input.status || "pending",
      JSON.stringify(input.request || {}), JSON.stringify(input.response || {}),
      input.parentOperationId || null, input.actor || null, input.processedBy || null,
      input.processedAt || null
    ]
  );
  return result.rows[0];
}

async function findOperation(client, org, paymentId, lock = false) {
  const result = await client.query(
    `SELECT * FROM fleet_payment_operations
      WHERE organization_id=$1
        AND (id::text=$2 OR provider_reference=$2)
      ORDER BY created_at DESC LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
    [org, paymentId]
  );
  if (!result.rowCount) {
    const error = new Error("Payment record not found.");
    error.statusCode = 404;
    error.code = "PAYMENT_NOT_FOUND";
    throw error;
  }
  return result.rows[0];
}

function paymentIntentReference(operation) {
  return operation.response_json?.paymentIntentId ||
    (String(operation.provider_reference || "").startsWith("pi_") ? operation.provider_reference : null);
}

async function updateStripeOperation(event, stripe) {
  const object = event.data.object;
  let providerReference = object.id;
  let status = null;
  let receiptUrl = null;
  let organizationId = object.metadata?.organizationId || null;
  let bookingId = object.metadata?.bookingId || null;
  let operationId = object.metadata?.operationId || null;

  if (object.object === "checkout.session") {
    providerReference = object.id;
    operationId = object.metadata?.operationId || null;
    if (object.payment_intent) {
      const intent = await stripe.paymentIntents.retrieve(String(object.payment_intent));
      providerReference = intent.id;
      status = intent.status === "requires_capture" ? "authorized"
        : intent.status === "succeeded" ? "succeeded"
          : intent.status === "requires_action" ? "requires_action" : "pending";
    }
  } else if (object.object === "payment_intent") {
    status = object.status === "requires_capture" ? "authorized"
      : object.status === "succeeded" ? "succeeded"
        : object.status === "canceled" ? "voided"
          : object.status === "requires_action" ? "requires_action"
            : object.status === "requires_payment_method" ? "requires_payment_method" : "pending";
  } else if (object.object === "charge" && object.refunded) {
    providerReference = object.payment_intent || object.id;
    status = "refunded";
    receiptUrl = object.receipt_url || null;
  }

  if (!operationId && !providerReference) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let operationResult;
    if (operationId) {
      operationResult = await client.query(
        `SELECT * FROM fleet_payment_operations WHERE id=$1 FOR UPDATE`,
        [operationId]
      );
    } else {
      operationResult = await client.query(
        `SELECT * FROM fleet_payment_operations
          WHERE provider_reference=$1
             OR response_json->>'paymentIntentId'=$1
             OR response_json->>'checkoutSessionId'=$1
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [providerReference]
      );
    }
    const operation = operationResult.rows[0];
    if (!operation) {
      await client.query("ROLLBACK");
      return null;
    }
    organizationId ||= operation.organization_id;
    bookingId ||= operation.booking_id;
    await client.query(
      `UPDATE fleet_payment_operations
          SET provider_reference=COALESCE($2,provider_reference),
              status=COALESCE($3,status),
              receipt_url=COALESCE($4,receipt_url),
              response_json=response_json || $5::jsonb,
              processed_at=CASE WHEN $3 IN ('succeeded','authorized','refunded','voided','failed') THEN NOW() ELSE processed_at END,
              updated_at=NOW()
        WHERE id=$1`,
      [operation.id, providerReference, status, receiptUrl, JSON.stringify({
        lastEventId: event.id,
        lastEventType: event.type,
        paymentIntentId: providerReference?.startsWith("pi_") ? providerReference : operation.response_json?.paymentIntentId
      })]
    );
    if (bookingId && status === "succeeded") {
      await recalculateBookingBalance(client, organizationId, bookingId);
    }
    if (bookingId && status === "authorized" && operation.operation_type === "authorization") {
      await client.query(
        `UPDATE fleet_bookings
            SET payload=jsonb_set(
                  jsonb_set(payload,'{depositStatus}','"held"'::jsonb,true),
                  '{depositCollected}','true'::jsonb,true
                ),
                version=version+1,updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [organizationId, bookingId]
      );
    }
    await client.query("COMMIT");
    return { operationId: operation.id, organizationId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

router.post("/webhooks/stripe", async (request, response) => {
  if (!/^whsec_/.test(process.env.STRIPE_WEBHOOK_SECRET || "")) {
    return fail(response, 503, "WEBHOOK_NOT_CONFIGURED", "Stripe webhook verification is not configured.");
  }
  const stripe = stripeClient();
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      request.rawBody || Buffer.from(JSON.stringify(request.body || {})),
      request.get("Stripe-Signature"),
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    return fail(response, 400, "INVALID_WEBHOOK_SIGNATURE", "Webhook signature verification failed.");
  }

  const eventOrg = event.data?.object?.metadata?.organizationId || null;
  try {
    const saved = await query(
      `INSERT INTO fleet_payment_webhook_events
        (provider,provider_event_id,event_type,payload_json,signature_verified,organization_id)
       VALUES ('stripe',$1,$2,$3::jsonb,true,$4)
       ON CONFLICT (provider,provider_event_id) DO NOTHING
       RETURNING id`,
      [event.id, event.type, JSON.stringify(event), eventOrg]
    );
    if (!saved.rowCount) return response.json({ success: true, data: { received: true, duplicate: true } });

    const related = await updateStripeOperation(event, stripe);
    await query(
      `UPDATE fleet_payment_webhook_events
          SET processing_status='processed',processed_at=NOW(),
              organization_id=COALESCE($2,organization_id),related_operation_id=$3
        WHERE id=$1`,
      [saved.rows[0].id, related?.organizationId || null, related?.operationId || null]
    );
    return response.json({ success: true, data: { received: true } });
  } catch (error) {
    await query(
      `UPDATE fleet_payment_webhook_events
          SET processing_status='failed',processing_error=$2,processed_at=NOW()
        WHERE provider='stripe' AND provider_event_id=$1`,
      [event.id, String(error.message || error).slice(0, 1000)]
    ).catch(() => {});
    return fail(response, 500, "WEBHOOK_PROCESSING_FAILED", "The verified event could not be processed.");
  }
});

router.get(
  "/customer-capability",
  authRequired,
  tenantContext,
  requirePaymentCustomer,
  async (_request, response, next) => {
    try {
      const schema = await query(
        `SELECT
          to_regclass('public.fleet_payment_operations') IS NOT NULL AS ledger_ready,
          to_regclass('public.fleet_payment_webhook_events') IS NOT NULL AS webhook_store_ready`
      );
      const readiness = schema.rows[0];
      const credentialsReady = credentialsConfigured();
      response.json({
        success: true,
        data: {
          provider: "stripe",
          configured:
            credentialsReady &&
            readiness.ledger_ready &&
            readiness.webhook_store_ready,
          acceptingPayments:
            credentialsReady &&
            readiness.ledger_ready &&
            readiness.webhook_store_ready,
          payoutsEnabled: credentialsReady,
          webhooksHealthy: credentialsReady,
          currency: currency(process.env.STRIPE_DEFAULT_CURRENCY || "USD"),
          supportedMethods: credentialsReady
            ? ["card", "apple_pay", "google_pay"]
            : [],
          missingRequirements: credentialsReady
            ? []
            : ["Payment provider activation is pending"],
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/customer-checkout-sessions",
  authRequired,
  tenantContext,
  requirePaymentCustomer,
  async (request, response, next) => {
    const client = await pool.connect();
    try {
      const key = requiredIdempotencyKey(request, response);
      if (!key) return;
      const stripe = stripeClient();
      await client.query("BEGIN");
      const duplicate = await existingOperation(
        client,
        PUBLIC_ORGANIZATION_ID,
        key,
      );
      if (duplicate) {
        await client.query("COMMIT");
        return response.json({
          success: true,
          data: operationPayload(duplicate),
        });
      }
      const booking = await loadBooking(
        client,
        PUBLIC_ORGANIZATION_ID,
        request.body?.bookingId,
        true,
      );
      const ownsBooking =
        booking.guest_user_id === request.user.id ||
        (
          await client.query(
            `SELECT 1
               FROM fleet_customers
              WHERE organization_id=$1
                AND id=$2
                AND user_id=$3
                AND archived_at IS NULL
              LIMIT 1`,
            [PUBLIC_ORGANIZATION_ID, booking.customer_id, request.user.id],
          )
        ).rowCount > 0;
      if (!ownsBooking) {
        await client.query("ROLLBACK");
        return fail(
          response,
          403,
          "BOOKING_PAYMENT_FORBIDDEN",
          "This reservation does not belong to your GoodFleet account.",
        );
      }
      const balanceDue = Math.max(
        0,
        Number(booking.total_amount) - Number(booking.paid_amount),
      );
      if (balanceDue <= 0) {
        await client.query("ROLLBACK");
        return fail(
          response,
          409,
          "BOOKING_ALREADY_PAID",
          "This reservation has no remaining balance.",
        );
      }
      const operation = await insertOperation(client, {
        organizationId: PUBLIC_ORGANIZATION_ID,
        bookingId: booking.id,
        customerId: booking.customer_id,
        operationType: "checkout",
        idempotencyKey: key,
        amount: balanceDue,
        currency: currency(request.body?.currency),
        request: {
          method: "Credit Card",
          description: `Reservation ${booking.reservation_number} balance`,
          customerInitiated: true,
        },
        actor: actor(request),
      });
      const returnUrl = safeReturnUrl(
        request.body?.returnUrl || "https://fleet.goodos.app/account/payments",
      );
      const separator = returnUrl.includes("?") ? "&" : "?";
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          customer_email: booking.customer_email,
          client_reference_id: booking.id,
          success_url: `${returnUrl}${separator}payment=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${returnUrl}${separator}payment=cancelled`,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: currency(request.body?.currency).toLowerCase(),
                unit_amount: cents(balanceDue),
                product_data: {
                  name: `GoodFleet reservation ${booking.reservation_number}`,
                },
              },
            },
          ],
          payment_intent_data: {
            metadata: {
              organizationId: PUBLIC_ORGANIZATION_ID,
              bookingId: booking.id,
              operationId: operation.id,
            },
          },
          metadata: {
            organizationId: PUBLIC_ORGANIZATION_ID,
            bookingId: booking.id,
            operationId: operation.id,
          },
        },
        { idempotencyKey: key },
      );
      const updated = await client.query(
        `UPDATE fleet_payment_operations
            SET provider_reference=$2,status='requires_action',
                response_json=$3::jsonb,updated_at=NOW()
          WHERE id=$1
          RETURNING *`,
        [
          operation.id,
          session.id,
          JSON.stringify({
            checkoutSessionId: session.id,
            checkoutUrl: session.url,
            expiresAt: new Date(session.expires_at * 1000).toISOString(),
          }),
        ],
      );
      await client.query("COMMIT");
      return response.status(201).json({
        success: true,
        data: operationPayload(updated.rows[0]),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      next(error);
    } finally {
      client.release();
    }
  },
);

router.use(authRequired, tenantContext, requirePaymentEmployee);

router.get("/capability", async (request, response, next) => {
  try {
    const schema = await query(
      `SELECT
        to_regclass('public.fleet_payment_operations') IS NOT NULL AS ledger_ready,
        to_regclass('public.fleet_payment_webhook_events') IS NOT NULL AS webhook_store_ready`
    );
    const readiness = schema.rows[0];
    const webhookHealth = readiness.webhook_store_ready
      ? await query(
        `SELECT EXISTS (
          SELECT 1 FROM fleet_payment_webhook_events
           WHERE provider='stripe' AND signature_verified=true
             AND processing_status='processed'
             AND received_at > NOW() - interval '7 days'
        ) AS healthy`
      )
      : { rows: [{ healthy: false }] };
    const credentialsReady = credentialsConfigured();
    const missingRequirements = [];
    if (!readiness.ledger_ready) missingRequirements.push("payment ledger migration");
    if (!readiness.webhook_store_ready) missingRequirements.push("webhook event migration");
    if (!/^sk_(test|live)_/.test(process.env.STRIPE_SECRET_KEY || "")) missingRequirements.push("Stripe secret key");
    if (!/^pk_(test|live)_/.test(process.env.STRIPE_PUBLISHABLE_KEY || "")) missingRequirements.push("Stripe publishable key");
    if (!/^whsec_/.test(process.env.STRIPE_WEBHOOK_SECRET || "")) missingRequirements.push("Stripe webhook signing secret");

    response.json({
      success: true,
      data: {
        provider: "stripe",
        configured: credentialsReady && readiness.ledger_ready && readiness.webhook_store_ready,
        acceptingPayments: credentialsReady && readiness.ledger_ready && readiness.webhook_store_ready,
        payoutsEnabled: credentialsReady,
        webhooksHealthy: credentialsReady && webhookHealth.rows[0].healthy,
        currency: currency(process.env.STRIPE_DEFAULT_CURRENCY || "USD"),
        supportedMethods: credentialsReady ? ["card", "apple_pay", "google_pay"] : [],
        missingRequirements,
        readiness: {
          credentialsConfigured: credentialsReady,
          ledgerReady: readiness.ledger_ready,
          webhookStoreReady: readiness.webhook_store_ready,
          processingActivated: credentialsReady
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post("/checkout-sessions", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const key = requiredIdempotencyKey(request, response);
    if (!key) return;
    const org = organization(request);
    const stripe = stripeClient();
    await client.query("BEGIN");
    const duplicate = await existingOperation(client, org, key);
    if (duplicate) {
      await client.query("COMMIT");
      return response.json({ success: true, data: operationPayload(duplicate) });
    }
    const booking = await loadBooking(client, org, request.body?.bookingId, true);
    const balanceDue = Math.max(0, Number(booking.total_amount) - Number(booking.paid_amount));
    if (balanceDue <= 0) {
      await client.query("ROLLBACK");
      return fail(response, 409, "BOOKING_ALREADY_PAID", "This reservation has no remaining balance.");
    }
    const operation = await insertOperation(client, {
      organizationId: org,
      bookingId: booking.id,
      customerId: booking.customer_id,
      operationType: "checkout",
      idempotencyKey: key,
      amount: balanceDue,
      currency: currency(request.body?.currency),
      request: { method: "Credit Card", description: `Reservation ${booking.reservation_number} balance` },
      actor: actor(request)
    });
    const returnUrl = safeReturnUrl(request.body?.returnUrl);
    const separator = returnUrl.includes("?") ? "&" : "?";
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: booking.customer_email,
      client_reference_id: booking.id,
      success_url: `${returnUrl}${separator}payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnUrl}${separator}payment=cancelled`,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: currency(request.body?.currency).toLowerCase(),
          unit_amount: cents(balanceDue),
          product_data: { name: `GoodFleet reservation ${booking.reservation_number}` }
        }
      }],
      payment_intent_data: {
        metadata: { organizationId: org, bookingId: booking.id, operationId: operation.id }
      },
      metadata: { organizationId: org, bookingId: booking.id, operationId: operation.id }
    }, { idempotencyKey: key });
    const updated = await client.query(
      `UPDATE fleet_payment_operations
          SET provider_reference=$2,
              status='requires_action',
              response_json=$3::jsonb,
              updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [operation.id, session.id, JSON.stringify({
        checkoutSessionId: session.id,
        checkoutUrl: session.url,
        expiresAt: new Date(session.expires_at * 1000).toISOString()
      })]
    );
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: operationPayload(updated.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/invoices", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const key = requiredIdempotencyKey(request, response);
    if (!key) return;
    const org = organization(request);
    await client.query("BEGIN");
    const duplicate = await existingOperation(client, org, key);
    if (duplicate) {
      await client.query("COMMIT");
      return response.json({ success: true, data: operationPayload(duplicate) });
    }
    const booking = await loadBooking(client, org, request.body?.bookingId, true);
    const invoiceType = String(request.body?.type || "rental").toLowerCase();
    if (!MONEY_TYPES.has(invoiceType)) {
      await client.query("ROLLBACK");
      return fail(response, 400, "INVALID_INVOICE_TYPE", "Invoice type must be rental, deposit, or fine.");
    }
    const invoice = await insertOperation(client, {
      organizationId: org,
      bookingId: booking.id,
      customerId: booking.customer_id,
      operationType: "invoice",
      provider: "internal",
      idempotencyKey: key,
      amount: amount(request.body?.amount),
      currency: currency(request.body?.currency),
      status: "pending",
      request: {
        method: String(request.body?.method || "Bank Transfer").slice(0, 50),
        description: String(request.body?.description || "GoodFleet invoice").slice(0, 500),
        type: invoiceType
      },
      actor: actor(request)
    });
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: operationPayload(invoice) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/manual-payments", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const key = requiredIdempotencyKey(request, response);
    if (!key) return;
    const org = organization(request);
    const normalizedMethod = MANUAL_METHODS.get(String(request.body?.method || "").trim().toLowerCase());
    if (!normalizedMethod) {
      return fail(response, 400, "MANUAL_METHOD_REQUIRED", "Use Cash, Bank Transfer, or Zelle for a manually verified payment.");
    }
    await client.query("BEGIN");
    const duplicate = await existingOperation(client, org, key);
    if (duplicate) {
      await client.query("COMMIT");
      return response.json({ success: true, data: operationPayload(duplicate) });
    }
    const booking = await loadBooking(client, org, request.body?.bookingId, true);
    const received = amount(request.body?.amount);
    const balanceDue = Math.max(0, Number(booking.total_amount) - Number(booking.paid_amount));
    if (received > balanceDue + 0.005) {
      await client.query("ROLLBACK");
      return fail(response, 409, "PAYMENT_EXCEEDS_BALANCE", "The recorded payment cannot exceed the reservation balance.");
    }
    const payment = await insertOperation(client, {
      organizationId: org,
      bookingId: booking.id,
      customerId: booking.customer_id,
      operationType: "manual_payment",
      provider: "internal",
      providerReference: String(request.body?.reference || "").trim().slice(0, 200) || null,
      idempotencyKey: key,
      amount: received,
      currency: currency(request.body?.currency),
      status: "succeeded",
      request: {
        method: normalizedMethod,
        description: String(request.body?.description || `${normalizedMethod} payment`).slice(0, 500),
        type: String(request.body?.type || "rental").slice(0, 40),
        verificationNote: String(request.body?.verificationNote || "").slice(0, 1000)
      },
      actor: actor(request),
      processedBy: actor(request),
      processedAt: new Date()
    });
    const balance = await recalculateBookingBalance(client, org, booking.id);
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: { ...operationPayload(payment), balance } });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/authorizations", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const key = requiredIdempotencyKey(request, response);
    if (!key) return;
    const org = organization(request);
    const stripe = stripeClient();
    await client.query("BEGIN");
    const duplicate = await existingOperation(client, org, key);
    if (duplicate) {
      await client.query("COMMIT");
      return response.json({ success: true, data: operationPayload(duplicate) });
    }
    const booking = await loadBooking(client, org, request.body?.bookingId, true);
    const holdAmount = amount(request.body?.amount || booking.deposit_amount, "deposit amount");
    const operation = await insertOperation(client, {
      organizationId: org,
      bookingId: booking.id,
      customerId: booking.customer_id,
      operationType: "authorization",
      idempotencyKey: key,
      amount: holdAmount,
      currency: currency(request.body?.currency),
      request: { method: "Credit Card", description: "Security deposit authorization", type: "deposit" },
      actor: actor(request)
    });
    const returnUrl = safeReturnUrl(request.body?.returnUrl);
    const separator = returnUrl.includes("?") ? "&" : "?";
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: booking.customer_email,
      client_reference_id: booking.id,
      success_url: `${returnUrl}${separator}deposit=authorized&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnUrl}${separator}deposit=cancelled`,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: currency(request.body?.currency).toLowerCase(),
          unit_amount: cents(holdAmount),
          product_data: { name: `Security deposit — ${booking.reservation_number}` }
        }
      }],
      payment_intent_data: {
        capture_method: "manual",
        metadata: { organizationId: org, bookingId: booking.id, operationId: operation.id, purpose: "security_deposit" }
      },
      metadata: { organizationId: org, bookingId: booking.id, operationId: operation.id, purpose: "security_deposit" }
    }, { idempotencyKey: key });
    const updated = await client.query(
      `UPDATE fleet_payment_operations
          SET provider_reference=$2,status='requires_action',response_json=$3::jsonb,updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [operation.id, session.id, JSON.stringify({
        checkoutSessionId: session.id,
        checkoutUrl: session.url,
        expiresAt: new Date(session.expires_at * 1000).toISOString()
      })]
    );
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: operationPayload(updated.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/:paymentId/capture", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const key = requiredIdempotencyKey(request, response);
    if (!key) return;
    const org = organization(request);
    const stripe = stripeClient();
    await client.query("BEGIN");
    const duplicate = await existingOperation(client, org, key);
    if (duplicate) {
      await client.query("COMMIT");
      return response.json({ success: true, data: operationPayload(duplicate) });
    }
    const original = await findOperation(client, org, request.params.paymentId, true);
    const intentId = paymentIntentReference(original);
    if (!intentId) {
      await client.query("ROLLBACK");
      return fail(response, 409, "AUTHORIZATION_NOT_READY", "The verified Stripe authorization is not ready to capture.");
    }
    const captureAmount = request.body?.amount ? amount(request.body.amount) : Number(original.amount);
    const intent = await stripe.paymentIntents.capture(intentId, {
      amount_to_capture: cents(captureAmount)
    }, { idempotencyKey: key });
    const capture = await insertOperation(client, {
      organizationId: org,
      bookingId: original.booking_id,
      customerId: original.customer_id,
      operationType: "capture",
      providerReference: null,
      idempotencyKey: key,
      amount: captureAmount,
      currency: original.currency,
      status: intent.status === "succeeded" ? "succeeded" : "pending",
      request: { method: "Credit Card", description: "Captured authorized amount", type: original.request_json?.type || "rental" },
      response: { paymentIntentId: intent.id },
      parentOperationId: original.id,
      actor: actor(request),
      processedBy: actor(request),
      processedAt: intent.status === "succeeded" ? new Date() : null
    });
    await client.query(
      `UPDATE fleet_payment_operations SET status='captured',updated_at=NOW() WHERE id=$1`,
      [original.id]
    );
    if (original.booking_id && intent.status === "succeeded") await recalculateBookingBalance(client, org, original.booking_id);
    await client.query("COMMIT");
    response.json({ success: true, data: operationPayload(capture) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/:paymentId/refunds", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const key = requiredIdempotencyKey(request, response);
    if (!key) return;
    const org = organization(request);
    await client.query("BEGIN");
    const duplicate = await existingOperation(client, org, key);
    if (duplicate) {
      await client.query("COMMIT");
      return response.json({ success: true, data: operationPayload(duplicate) });
    }
    const original = await findOperation(client, org, request.params.paymentId, true);
    const refundAmount = amount(request.body?.amount);
    if (refundAmount > Number(original.amount) + 0.005) {
      await client.query("ROLLBACK");
      return fail(response, 409, "REFUND_EXCEEDS_PAYMENT", "The refund cannot exceed the original payment.");
    }
    let providerReference = null;
    let receiptUrl = null;
    if (original.provider === "stripe") {
      const stripe = stripeClient();
      const intentId = paymentIntentReference(original);
      if (!intentId) {
        await client.query("ROLLBACK");
        return fail(response, 409, "PAYMENT_NOT_SETTLED", "A verified Stripe payment is required before refunding.");
      }
      const refund = await stripe.refunds.create({
        payment_intent: intentId,
        amount: cents(refundAmount),
        reason: "requested_by_customer",
        metadata: { organizationId: org, bookingId: original.booking_id || "", operationId: original.id }
      }, { idempotencyKey: key });
      providerReference = refund.id;
      receiptUrl = refund.receipt_number || null;
    }
    const refundOperation = await insertOperation(client, {
      organizationId: org,
      bookingId: original.booking_id,
      customerId: original.customer_id,
      operationType: "refund",
      provider: original.provider,
      providerReference,
      idempotencyKey: key,
      amount: refundAmount,
      currency: original.currency,
      status: "succeeded",
      request: {
        method: original.request_json?.method || "Recorded payment",
        description: `Refund: ${String(request.body?.reason || "operator requested").slice(0, 300)}`,
        type: "refund"
      },
      response: { receiptUrl },
      parentOperationId: original.id,
      actor: actor(request),
      processedBy: actor(request),
      processedAt: new Date()
    });
    await client.query(
      `UPDATE fleet_payment_operations
          SET status=CASE WHEN $2 >= amount THEN 'refunded' ELSE 'partially_refunded' END,updated_at=NOW()
        WHERE id=$1`,
      [original.id, refundAmount]
    );
    if (original.booking_id) await recalculateBookingBalance(client, org, original.booking_id);
    await client.query("COMMIT");
    response.json({ success: true, data: operationPayload(refundOperation) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/:paymentId/void", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const key = requiredIdempotencyKey(request, response);
    if (!key) return;
    const org = organization(request);
    const stripe = stripeClient();
    await client.query("BEGIN");
    const duplicate = await existingOperation(client, org, key);
    if (duplicate) {
      await client.query("COMMIT");
      return response.json({ success: true, data: operationPayload(duplicate) });
    }
    const original = await findOperation(client, org, request.params.paymentId, true);
    const intentId = paymentIntentReference(original);
    if (!intentId) {
      await client.query("ROLLBACK");
      return fail(response, 409, "AUTHORIZATION_NOT_READY", "The verified Stripe authorization is not ready to release.");
    }
    const intent = await stripe.paymentIntents.cancel(intentId, {}, { idempotencyKey: key });
    const voidOperation = await insertOperation(client, {
      organizationId: org,
      bookingId: original.booking_id,
      customerId: original.customer_id,
      operationType: "void",
      providerReference: null,
      idempotencyKey: key,
      amount: Number(original.amount),
      currency: original.currency,
      status: "voided",
      request: { method: "Credit Card", description: "Security deposit hold released", type: "deposit" },
      response: { paymentIntentId: intent.id },
      parentOperationId: original.id,
      actor: actor(request),
      processedBy: actor(request),
      processedAt: new Date()
    });
    await client.query(
      `UPDATE fleet_payment_operations SET status='voided',updated_at=NOW() WHERE id=$1`,
      [original.id]
    );
    if (original.booking_id) {
      await client.query(
        `UPDATE fleet_bookings
            SET payload=jsonb_set(payload,'{depositStatus}','"released"'::jsonb,true),
                version=version+1,updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [org, original.booking_id]
      );
    }
    await client.query("COMMIT");
    response.json({ success: true, data: operationPayload(voidOperation) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/:paymentId/increment", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const key = requiredIdempotencyKey(request, response);
    if (!key) return;
    const org = organization(request);
    const stripe = stripeClient();
    await client.query("BEGIN");
    const duplicate = await existingOperation(client, org, key);
    if (duplicate) {
      await client.query("COMMIT");
      return response.json({ success: true, data: operationPayload(duplicate) });
    }
    const original = await findOperation(client, org, request.params.paymentId, true);
    const newTotal = amount(request.body?.amount, "authorization amount");
    if (newTotal <= Number(original.amount)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "INCREMENT_MUST_INCREASE_TOTAL", "The new authorization total must be higher than the current authorization.");
    }
    const intentId = paymentIntentReference(original);
    if (!intentId) {
      await client.query("ROLLBACK");
      return fail(response, 409, "AUTHORIZATION_NOT_READY", "The verified Stripe authorization is not ready to increase.");
    }
    const intent = await stripe.paymentIntents.incrementAuthorization(intentId, {
      amount: cents(newTotal)
    }, { idempotencyKey: key });
    const increment = await insertOperation(client, {
      organizationId: org,
      bookingId: original.booking_id,
      customerId: original.customer_id,
      operationType: "increment",
      providerReference: null,
      idempotencyKey: key,
      amount: newTotal - Number(original.amount),
      currency: original.currency,
      status: "authorized",
      request: { method: "Credit Card", description: "Authorization increased", type: original.request_json?.type || "deposit" },
      response: { paymentIntentId: intent.id, authorizedTotal: newTotal },
      parentOperationId: original.id,
      actor: actor(request),
      processedBy: actor(request),
      processedAt: new Date()
    });
    await client.query(
      `UPDATE fleet_payment_operations SET amount=$2,updated_at=NOW() WHERE id=$1`,
      [original.id, newTotal]
    );
    await client.query("COMMIT");
    response.json({ success: true, data: operationPayload(increment) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/invoices/:invoiceId/dispute", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const key = requiredIdempotencyKey(request, response);
    if (!key) return;
    const org = organization(request);
    await client.query("BEGIN");
    const invoice = await findOperation(client, org, request.params.invoiceId, true);
    const dispute = await insertOperation(client, {
      organizationId: org,
      bookingId: invoice.booking_id,
      customerId: invoice.customer_id,
      operationType: "dispute",
      provider: "internal",
      idempotencyKey: key,
      amount: Number(invoice.amount),
      currency: invoice.currency,
      status: "disputed",
      request: {
        method: invoice.request_json?.method,
        description: String(request.body?.reason || "Invoice disputed").slice(0, 500),
        type: invoice.request_json?.type
      },
      parentOperationId: invoice.id,
      actor: actor(request),
      processedBy: actor(request),
      processedAt: new Date()
    });
    await client.query(
      `UPDATE fleet_payment_operations SET status='disputed',updated_at=NOW() WHERE id=$1`,
      [invoice.id]
    );
    if (invoice.booking_id) {
      await client.query(
        `UPDATE fleet_bookings SET payment_status='disputed',version=version+1,updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [org, invoice.booking_id]
      );
    }
    await client.query("COMMIT");
    response.json({ success: true, data: operationPayload(dispute) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/provider/connect", (_request, response) => {
  response.json({
    success: true,
    data: {
      provider: "stripe",
      dashboardUrl: "https://dashboard.stripe.com/apikeys",
      webhookUrl: "https://base.goodos.app/api/fleet/v1/payments/webhooks/stripe",
      requiredEnvironmentVariables: [
        "STRIPE_SECRET_KEY",
        "STRIPE_PUBLISHABLE_KEY",
        "STRIPE_WEBHOOK_SECRET"
      ]
    }
  });
});

module.exports = router;
