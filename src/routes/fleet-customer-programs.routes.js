"use strict";

const express = require("express");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { pool, query } = require("../config/database");
const {
  loyaltyTier,
  loyaltyTierDiscount,
  normalizedCode,
} = require("../services/fleet-customer-programs.service");

const router = express.Router();
const MANAGEMENT_ROLES = new Set(["owner", "admin", "manager"]);
const ACCOUNT_STATUSES = new Set(["active", "suspended", "closed"]);
const MEMBERSHIP_STATUSES = new Set(["active", "suspended", "ended"]);
const RATE_STATUSES = new Set(["active", "inactive"]);
const LOYALTY_STATUSES = new Set(["active", "paused", "closed"]);

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function org(request) {
  return request.tenantContext.organizationId;
}

function actor(request) {
  return request.user?.id || null;
}

function role(request) {
  const organizationRole = clean(request.tenantContext.organization?.membershipRole, 40).toLowerCase();
  if (MANAGEMENT_ROLES.has(organizationRole)) return organizationRole;
  const membership = (request.apps || []).find(app =>
    clean(app?.membershipStatus, 40).toLowerCase() === "active" &&
    (clean(app?.id, 80).toLowerCase() === "goodfleet" ||
      clean(app?.domain, 160).toLowerCase() === "fleet.goodos.app")
  );
  return clean(membership?.role, 40).toLowerCase();
}

function fail(response, status, code, message, details) {
  return response.status(status).json({ success: false, code, message, ...(details ? { details } : {}) });
}

function requireManagement(request, response, next) {
  if (!MANAGEMENT_ROLES.has(role(request))) {
    return fail(response, 403, "MANAGEMENT_ACCESS_REQUIRED", "GoodFleet management access is required.");
  }
  next();
}

function enumValue(value, allowed, field) {
  const normalized = clean(value, 40).toLowerCase();
  if (!allowed.has(normalized)) {
    const error = new Error(`${field} is invalid.`);
    error.statusCode = 400;
    error.code = "INVALID_FIELD";
    throw error;
  }
  return normalized;
}

function numeric(value, min, max, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    const error = new Error(`${field} must be between ${min} and ${max}.`);
    error.statusCode = 400;
    error.code = "INVALID_FIELD";
    throw error;
  }
  return parsed;
}

function integer(value, min, max, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    const error = new Error(`${field} must be a whole number between ${min} and ${max}.`);
    error.statusCode = 400;
    error.code = "INVALID_FIELD";
    throw error;
  }
  return parsed;
}

function dateOnly(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = clean(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const error = new Error(`${field} must use YYYY-MM-DD.`);
    error.statusCode = 400;
    error.code = "INVALID_FIELD";
    throw error;
  }
  return normalized;
}

function idempotencyKey(request) {
  const key = clean(request.get("Idempotency-Key"), 255);
  if (!key) {
    const error = new Error("An Idempotency-Key header is required.");
    error.statusCode = 400;
    error.code = "IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }
  return key;
}

function accountPayload(row) {
  return {
    id: row.id,
    name: row.name,
    accountCode: row.account_code,
    status: row.status,
    contactName: row.contact_name || null,
    billingEmail: row.billing_email || null,
    contactPhone: row.contact_phone || null,
    paymentTermsDays: Number(row.payment_terms_days || 0),
    creditLimit: Number(row.credit_limit || 0),
    notes: row.notes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function membershipPayload(row) {
  return {
    id: row.id,
    corporateAccountId: row.corporate_account_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    memberCode: row.member_code || null,
    status: row.status,
    joinedAt: row.joined_at,
    endedAt: row.ended_at || null,
  };
}

function ratePayload(row) {
  return {
    id: row.id,
    corporateAccountId: row.corporate_account_id,
    name: row.name,
    vehicleCategory: row.vehicle_category,
    branchId: row.branch_id || null,
    discountPercent: Number(row.discount_percent),
    status: row.status,
    startsOn: row.starts_on || null,
    endsOn: row.ends_on || null,
    createdAt: row.created_at,
  };
}

function loyaltyPayload(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    status: row.status,
    tier: row.tier,
    pointsBalance: Number(row.points_balance),
    lifetimePoints: Number(row.lifetime_points),
    discountPercent: Number(row.discount_percent),
    joinedAt: row.joined_at,
    updatedAt: row.updated_at,
    events: Array.isArray(row.events) ? row.events : [],
  };
}

async function audit(client, request, action, entityType, entityId, before, after) {
  await client.query(
    `INSERT INTO fleet_audit_events
      (organization_id,actor_id,action,entity_type,entity_id,before_json,after_json,request_id,ip_address)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [org(request), actor(request), action, entityType, entityId,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
      request.id || request.get("X-Request-ID") || null, request.ip || null]
  );
}

router.use(authRequired, tenantContext, requireManagement);

router.get("/readiness", (_request, response) => response.json({
  success: true,
  data: {
    corporateAccounts: "ready",
    negotiatedRates: "ready",
    loyaltyLedger: "ready",
    automaticEarning: "ready_for_paid_completed_rentals",
    paymentRedemption: "external_payment_activation_required",
  },
}));

router.get("/summary", async (request, response, next) => {
  try {
    const result = await query(
      `SELECT
        (SELECT COUNT(*) FROM fleet_corporate_accounts WHERE organization_id=$1 AND status='active') AS active_accounts,
        (SELECT COUNT(*) FROM fleet_corporate_memberships WHERE organization_id=$1 AND status='active') AS active_members,
        (SELECT COUNT(*) FROM fleet_negotiated_rates WHERE organization_id=$1 AND status='active') AS active_rates,
        (SELECT COUNT(*) FROM fleet_loyalty_accounts WHERE organization_id=$1 AND status='active') AS loyalty_members,
        (SELECT COALESCE(SUM(points_balance),0) FROM fleet_loyalty_accounts WHERE organization_id=$1 AND status='active') AS outstanding_points`,
      [org(request)]
    );
    const row = result.rows[0];
    response.json({ success: true, data: {
      activeAccounts: Number(row.active_accounts),
      activeMembers: Number(row.active_members),
      activeRates: Number(row.active_rates),
      loyaltyMembers: Number(row.loyalty_members),
      outstandingPoints: Number(row.outstanding_points),
    }});
  } catch (error) { next(error); }
});

router.get("/corporate-accounts", async (request, response, next) => {
  try {
    const organizationId = org(request);
    const [accounts, memberships, rates] = await Promise.all([
      query(`SELECT * FROM fleet_corporate_accounts WHERE organization_id=$1 ORDER BY name`, [organizationId]),
      query(
        `SELECT membership.*,customer.full_name AS customer_name,customer.email AS customer_email
           FROM fleet_corporate_memberships membership
           JOIN fleet_customers customer
             ON customer.organization_id=membership.organization_id AND customer.id=membership.customer_id
          WHERE membership.organization_id=$1
          ORDER BY customer.full_name`,
        [organizationId]
      ),
      query(`SELECT * FROM fleet_negotiated_rates WHERE organization_id=$1 ORDER BY created_at DESC`, [organizationId]),
    ]);
    response.json({ success: true, data: accounts.rows.map(row => ({
      ...accountPayload(row),
      members: memberships.rows.filter(member => member.corporate_account_id === row.id).map(membershipPayload),
      rates: rates.rows.filter(rate => rate.corporate_account_id === row.id).map(ratePayload),
    })) });
  } catch (error) { next(error); }
});

router.post("/corporate-accounts", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const key = idempotencyKey(request);
    const body = request.body || {};
    const code = normalizedCode(body.accountCode || body.name);
    if (!code) return fail(response, 400, "ACCOUNT_CODE_REQUIRED", "A corporate account code is required.");
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM fleet_corporate_accounts WHERE organization_id=$1 AND idempotency_key=$2`,
      [org(request), key]
    );
    if (existing.rowCount) {
      await client.query("COMMIT");
      return response.json({ success: true, data: { ...accountPayload(existing.rows[0]), members: [], rates: [] } });
    }
    const result = await client.query(
      `INSERT INTO fleet_corporate_accounts
        (organization_id,idempotency_key,name,account_code,status,contact_name,billing_email,
         contact_phone,payment_terms_days,credit_limit,notes,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,lower($7),$8,$9,$10,$11,$12,$12) RETURNING *`,
      [org(request), key, clean(body.name, 200), code,
        enumValue(body.status || "active", ACCOUNT_STATUSES, "status"),
        clean(body.contactName, 200) || null, clean(body.billingEmail, 320) || null,
        clean(body.contactPhone, 50) || null,
        integer(body.paymentTermsDays || 0, 0, 90, "paymentTermsDays"),
        numeric(body.creditLimit || 0, 0, 10_000_000, "creditLimit"),
        clean(body.notes, 4000) || null, actor(request)]
    );
    const account = accountPayload(result.rows[0]);
    await audit(client, request, "corporate_account.created", "corporate_account", account.id, null, account);
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: { ...account, members: [], rates: [] } });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return fail(response, 409, "CORPORATE_ACCOUNT_EXISTS", "That corporate account code already exists.");
    next(error);
  } finally { client.release(); }
});

router.patch("/corporate-accounts/:accountId", async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM fleet_corporate_accounts WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [org(request), request.params.accountId]
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "CORPORATE_ACCOUNT_NOT_FOUND", "Corporate account not found.");
    }
    const before = accountPayload(existing.rows[0]);
    const body = request.body || {};
    const result = await client.query(
      `UPDATE fleet_corporate_accounts SET
        name=$3,account_code=$4,status=$5,contact_name=$6,billing_email=lower($7),
        contact_phone=$8,payment_terms_days=$9,credit_limit=$10,notes=$11,
        updated_by=$12,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [org(request), request.params.accountId,
        clean(body.name ?? before.name, 200), normalizedCode(body.accountCode ?? before.accountCode),
        enumValue(body.status ?? before.status, ACCOUNT_STATUSES, "status"),
        clean(body.contactName ?? before.contactName, 200) || null,
        clean(body.billingEmail ?? before.billingEmail, 320) || null,
        clean(body.contactPhone ?? before.contactPhone, 50) || null,
        integer(body.paymentTermsDays ?? before.paymentTermsDays, 0, 90, "paymentTermsDays"),
        numeric(body.creditLimit ?? before.creditLimit, 0, 10_000_000, "creditLimit"),
        clean(body.notes ?? before.notes, 4000) || null, actor(request)]
    );
    const account = accountPayload(result.rows[0]);
    await audit(client, request, "corporate_account.updated", "corporate_account", account.id, before, account);
    await client.query("COMMIT");
    response.json({ success: true, data: account });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return fail(response, 409, "CORPORATE_ACCOUNT_EXISTS", "That corporate account code already exists.");
    next(error);
  } finally { client.release(); }
});

router.post("/corporate-accounts/:accountId/members", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const organizationId = org(request);
    const customerId = clean(request.body?.customerId, 80);
    await client.query("BEGIN");
    const valid = await client.query(
      `SELECT account.id,customer.full_name,customer.email
         FROM fleet_corporate_accounts account
         CROSS JOIN fleet_customers customer
        WHERE account.organization_id=$1 AND account.id=$2 AND account.status='active'
          AND customer.organization_id=$1 AND customer.id=$3 AND customer.archived_at IS NULL`,
      [organizationId, request.params.accountId, customerId]
    );
    if (!valid.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "ACCOUNT_OR_CUSTOMER_NOT_FOUND", "Active account or customer not found.");
    }
    await client.query(
      `UPDATE fleet_corporate_memberships
          SET status='ended',ended_at=NOW(),updated_by=$3,updated_at=NOW()
        WHERE organization_id=$1 AND customer_id=$2 AND status='active'`,
      [organizationId, customerId, actor(request)]
    );
    const result = await client.query(
      `INSERT INTO fleet_corporate_memberships
        (organization_id,corporate_account_id,customer_id,member_code,status,created_by,updated_by)
       VALUES ($1,$2,$3,$4,'active',$5,$5)
       ON CONFLICT (organization_id,corporate_account_id,customer_id) DO UPDATE SET
         member_code=EXCLUDED.member_code,status='active',joined_at=NOW(),ended_at=NULL,
         updated_by=EXCLUDED.updated_by,updated_at=NOW()
       RETURNING *`,
      [organizationId, request.params.accountId, customerId,
        clean(request.body?.memberCode, 80) || null, actor(request)]
    );
    const membership = membershipPayload({
      ...result.rows[0],
      customer_name: valid.rows[0].full_name,
      customer_email: valid.rows[0].email,
    });
    await audit(client, request, "corporate_membership.assigned", "corporate_membership", membership.id, null, membership);
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: membership });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally { client.release(); }
});

router.patch("/corporate-memberships/:membershipId", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const status = enumValue(request.body?.status, MEMBERSHIP_STATUSES, "status");
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE fleet_corporate_memberships SET status=$3,
        ended_at=CASE WHEN $3='ended' THEN NOW() ELSE NULL END,
        updated_by=$4,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [org(request), request.params.membershipId, status, actor(request)]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "MEMBERSHIP_NOT_FOUND", "Corporate membership not found.");
    }
    await audit(client, request, "corporate_membership.status_changed", "corporate_membership", result.rows[0].id, null, { status });
    await client.query("COMMIT");
    response.json({ success: true, data: { id: result.rows[0].id, status } });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  }
  finally { client.release(); }
});

router.post("/corporate-accounts/:accountId/rates", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const key = idempotencyKey(request);
    const body = request.body || {};
    const startsOn = dateOnly(body.startsOn, "startsOn");
    const endsOn = dateOnly(body.endsOn, "endsOn");
    if (startsOn && endsOn && endsOn < startsOn) return fail(response, 400, "INVALID_RATE_WINDOW", "Rate end date must not be before its start date.");
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO fleet_negotiated_rates
        (organization_id,corporate_account_id,idempotency_key,name,vehicle_category,branch_id,
         discount_percent,status,starts_on,ends_on,created_by,updated_by)
       SELECT $1,account.id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11
         FROM fleet_corporate_accounts account
        WHERE account.organization_id=$1 AND account.id=$2 AND account.status='active'
       ON CONFLICT (organization_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
       RETURNING *`,
      [org(request), request.params.accountId, key, clean(body.name, 200) || "Negotiated rate",
        clean(body.vehicleCategory, 80).toLowerCase().replace(/[^a-z0-9]+/g, "_") || "*",
        clean(body.branchId, 100) || null,
        numeric(body.discountPercent, 0.01, 80, "discountPercent"),
        enumValue(body.status || "active", RATE_STATUSES, "status"),
        startsOn, endsOn, actor(request)]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "CORPORATE_ACCOUNT_NOT_FOUND", "Active corporate account not found.");
    }
    const rate = ratePayload(result.rows[0]);
    await audit(client, request, "negotiated_rate.created", "negotiated_rate", rate.id, null, rate);
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: rate });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  }
  finally { client.release(); }
});

router.patch("/negotiated-rates/:rateId", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const body = request.body || {};
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM fleet_negotiated_rates WHERE organization_id=$1 AND id=$2`,
      [org(request), request.params.rateId]
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "NEGOTIATED_RATE_NOT_FOUND", "Negotiated rate not found.");
    }
    const before = ratePayload(existing.rows[0]);
    const startsOn = dateOnly(body.startsOn ?? before.startsOn, "startsOn");
    const endsOn = dateOnly(body.endsOn ?? before.endsOn, "endsOn");
    if (startsOn && endsOn && endsOn < startsOn) {
      await client.query("ROLLBACK");
      return fail(response, 400, "INVALID_RATE_WINDOW", "Rate end date must not be before its start date.");
    }
    const result = await client.query(
      `UPDATE fleet_negotiated_rates SET name=$3,vehicle_category=$4,branch_id=$5,
        discount_percent=$6,status=$7,starts_on=$8,ends_on=$9,updated_by=$10,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [org(request), request.params.rateId, clean(body.name ?? before.name, 200),
        clean(body.vehicleCategory ?? before.vehicleCategory, 80).toLowerCase().replace(/[^a-z0-9]+/g, "_") || "*",
        clean(body.branchId ?? before.branchId, 100) || null,
        numeric(body.discountPercent ?? before.discountPercent, 0.01, 80, "discountPercent"),
        enumValue(body.status ?? before.status, RATE_STATUSES, "status"), startsOn, endsOn, actor(request)]
    );
    const rate = ratePayload(result.rows[0]);
    await audit(client, request, "negotiated_rate.updated", "negotiated_rate", rate.id, before, rate);
    await client.query("COMMIT");
    response.json({ success: true, data: rate });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  }
  finally { client.release(); }
});

router.get("/loyalty-accounts", async (request, response, next) => {
  try {
    const result = await query(
      `SELECT loyalty.*,customer.full_name AS customer_name,customer.email AS customer_email,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id',event.id,'eventType',event.event_type,'pointsDelta',event.points_delta,
                  'balanceAfter',event.balance_after,'bookingId',event.booking_id,
                  'notes',event.notes,'createdAt',event.created_at
                ) ORDER BY event.created_at DESC)
                FROM (SELECT * FROM fleet_loyalty_events source
                       WHERE source.organization_id=loyalty.organization_id
                         AND source.loyalty_account_id=loyalty.id
                       ORDER BY source.created_at DESC LIMIT 25) event
              ),'[]'::jsonb) AS events
         FROM fleet_loyalty_accounts loyalty
         JOIN fleet_customers customer
           ON customer.organization_id=loyalty.organization_id AND customer.id=loyalty.customer_id
        WHERE loyalty.organization_id=$1
        ORDER BY loyalty.updated_at DESC`,
      [org(request)]
    );
    response.json({ success: true, data: result.rows.map(loyaltyPayload) });
  } catch (error) { next(error); }
});

router.post("/loyalty-accounts", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const customerId = clean(request.body?.customerId, 80);
    const discountPercent = numeric(request.body?.discountPercent || 0, 0, 25, "discountPercent");
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO fleet_loyalty_accounts
        (organization_id,customer_id,status,discount_percent,created_by,updated_by)
       SELECT $1,customer.id,'active',$3,$4,$4
         FROM fleet_customers customer
        WHERE customer.organization_id=$1 AND customer.id=$2 AND customer.archived_at IS NULL
       ON CONFLICT (organization_id,customer_id) DO UPDATE SET
         status='active',discount_percent=EXCLUDED.discount_percent,updated_by=EXCLUDED.updated_by,updated_at=NOW()
       RETURNING *`,
      [org(request), customerId, discountPercent, actor(request)]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }
    const customer = await client.query(
      `SELECT full_name,email FROM fleet_customers WHERE organization_id=$1 AND id=$2`,
      [org(request), customerId]
    );
    const loyalty = loyaltyPayload({ ...result.rows[0], customer_name: customer.rows[0].full_name, customer_email: customer.rows[0].email, events: [] });
    await audit(client, request, "loyalty.enrolled", "loyalty_account", loyalty.id, null, loyalty);
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: loyalty });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  }
  finally { client.release(); }
});

router.patch("/loyalty-accounts/:accountId", async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE fleet_loyalty_accounts SET status=$3,discount_percent=$4,
        updated_by=$5,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [org(request), request.params.accountId,
        enumValue(request.body?.status || "active", LOYALTY_STATUSES, "status"),
        numeric(request.body?.discountPercent || 0, 0, 25, "discountPercent"), actor(request)]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "LOYALTY_ACCOUNT_NOT_FOUND", "Loyalty account not found.");
    }
    await audit(client, request, "loyalty.updated", "loyalty_account", result.rows[0].id, null, {
      status: result.rows[0].status,
      discountPercent: Number(result.rows[0].discount_percent),
    });
    await client.query("COMMIT");
    response.json({ success: true, data: loyaltyPayload({ ...result.rows[0], events: [] }) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  }
  finally { client.release(); }
});

router.post("/loyalty-accounts/:accountId/adjustments", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const key = idempotencyKey(request);
    const delta = integer(request.body?.pointsDelta, -100_000, 100_000, "pointsDelta");
    if (delta === 0) return fail(response, 400, "POINTS_DELTA_REQUIRED", "Points adjustment cannot be zero.");
    const notes = clean(request.body?.notes, 1000);
    if (notes.length < 3) return fail(response, 400, "ADJUSTMENT_REASON_REQUIRED", "Enter a reason for the points adjustment.");
    await client.query("BEGIN");
    const duplicate = await client.query(
      `SELECT event.*,account.customer_id,account.status,account.tier,account.points_balance,
              account.lifetime_points,account.discount_percent,account.joined_at,account.updated_at
         FROM fleet_loyalty_events event
         JOIN fleet_loyalty_accounts account
           ON account.organization_id=event.organization_id AND account.id=event.loyalty_account_id
        WHERE event.organization_id=$1 AND event.idempotency_key=$2`,
      [org(request), key]
    );
    if (duplicate.rowCount) {
      await client.query("COMMIT");
      return response.json({ success: true, data: loyaltyPayload({ ...duplicate.rows[0], id: duplicate.rows[0].loyalty_account_id, events: [] }) });
    }
    const accountResult = await client.query(
      `SELECT * FROM fleet_loyalty_accounts
        WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [org(request), request.params.accountId]
    );
    if (!accountResult.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "LOYALTY_ACCOUNT_NOT_FOUND", "Loyalty account not found.");
    }
    const account = accountResult.rows[0];
    const balanceAfter = Number(account.points_balance) + delta;
    if (balanceAfter < 0) {
      await client.query("ROLLBACK");
      return fail(response, 409, "INSUFFICIENT_POINTS", "The adjustment would make the points balance negative.");
    }
    const lifetimePoints = Number(account.lifetime_points) + Math.max(0, delta);
    const tier = loyaltyTier(lifetimePoints);
    const tierDiscount = loyaltyTierDiscount(tier);
    const updated = await client.query(
      `UPDATE fleet_loyalty_accounts SET points_balance=$3,lifetime_points=$4,tier=$5,
        discount_percent=GREATEST(discount_percent,$6),updated_by=$7,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [org(request), account.id, balanceAfter, lifetimePoints, tier, tierDiscount, actor(request)]
    );
    await client.query(
      `INSERT INTO fleet_loyalty_events
        (organization_id,loyalty_account_id,idempotency_key,event_type,points_delta,balance_after,notes,actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [org(request), account.id, key, delta > 0 ? "manual_award" : "correction",
        delta, balanceAfter, notes, actor(request)]
    );
    await audit(client, request, "loyalty.points_adjusted", "loyalty_account", account.id,
      { pointsBalance: Number(account.points_balance), tier: account.tier },
      { pointsBalance: balanceAfter, pointsDelta: delta, tier, details: notes });
    await client.query("COMMIT");
    response.json({ success: true, data: loyaltyPayload({ ...updated.rows[0], events: [] }) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally { client.release(); }
});

module.exports = router;
