"use strict";

const crypto = require("crypto");
const express = require("express");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { pool, query } = require("../config/database");
const teamsService = require("../services/teams.service");

const router = express.Router();

const ACTIVE_BOOKING_STATUSES = [
  "pending_payment", "confirmed", "assigned", "checked_in",
  "checked_out", "extended", "overdue"
];

const WORKSPACE_ARRAY_KEYS = new Set([
  "contracts", "branches", "maintenance", "damageReports", "inspections",
  "supportTickets", "rates", "seasonalAdjustments", "dynamicPricingInsights",
  "discounts", "fees", "expenses", "addons", "onboardingSteps"
]);
const WORKSPACE_OBJECT_KEYS = new Set(["branding", "billingSettings"]);
const MAX_WORKSPACE_BYTES = 2 * 1024 * 1024;
const EMPLOYEE_ROLES = new Set(["owner", "admin", "manager", "staff", "mechanic"]);
const VEHICLE_STATUSES = new Set([
  "available", "reserved", "checked_out", "in_transit", "cleaning", "turnaround",
  "inspection", "maintenance", "out_of_service", "retired", "blocked", "recalled"
]);
const CUSTOMER_STATUSES = new Set(["active", "suspended", "blacklisted"]);
const LICENSE_STATUSES = new Set(["verified", "pending", "failed"]);
const BOOKING_STATUSES = new Set([
  "quote", "pending_payment", "confirmed", "assigned", "checked_in", "checked_out",
  "extended", "completed", "no_show", "cancelled", "refunded", "overdue"
]);
const PAYMENT_STATUSES = new Set(["unpaid", "partial", "paid", "refunded", "disputed", "failed"]);

function actor(request) {
  return request.user?.id || null;
}

function organization(request) {
  return request.tenantContext.organizationId;
}

function requireEmployee(request, response, next) {
  const role = text(request.tenantContext.organization?.membershipRole, 40).toLowerCase();
  if (!EMPLOYEE_ROLES.has(role)) {
    return fail(response, 403, "EMPLOYEE_ACCESS_REQUIRED", "GoodFleet employee access is required.");
  }
  return next();
}

function fail(response, status, code, message, details) {
  return response.status(status).json({ success: false, code, message, ...(details ? { details } : {}) });
}

function text(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function money(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    const error = new Error(`${field} must be a non-negative number.`);
    error.statusCode = 400;
    error.code = "INVALID_MONEY";
    throw error;
  }
  return parsed.toFixed(2);
}

function enumValue(value, allowed, field) {
  const normalized = text(value, 40).toLowerCase();
  if (!allowed.has(normalized)) {
    const error = new Error(`${field} is invalid.`);
    error.statusCode = 400;
    error.code = "INVALID_FIELD";
    throw error;
  }
  return normalized;
}

function required(value, field, max) {
  const normalized = text(value, max);
  if (!normalized) {
    const error = new Error(`${field} is required.`);
    error.statusCode = 400;
    error.code = "REQUIRED_FIELD";
    throw error;
  }
  return normalized;
}

function modelYear(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1900 || parsed > 2200) {
    const error = new Error("year is invalid.");
    error.statusCode = 400;
    error.code = "INVALID_FIELD";
    throw error;
  }
  return parsed;
}

function timestamp(date, time, field) {
  const datePart = String(date || "").slice(0, 10);
  const timePart = String(time || "10:00").slice(0, 5);
  const parsed = new Date(`${datePart}T${timePart}:00`);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${field} is invalid.`);
    error.statusCode = 400;
    error.code = "INVALID_DATE";
    throw error;
  }
  return parsed.toISOString();
}

function sanitizeWorkspace(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("Workspace state must be an object.");
    error.statusCode = 400;
    error.code = "INVALID_WORKSPACE_STATE";
    throw error;
  }
  const output = {};
  for (const key of WORKSPACE_ARRAY_KEYS) {
    if (key in input) {
      if (!Array.isArray(input[key])) {
        const error = new Error(`${key} must be an array.`);
        error.statusCode = 400;
        error.code = "INVALID_WORKSPACE_STATE";
        throw error;
      }
      output[key] = input[key];
    }
  }
  for (const key of WORKSPACE_OBJECT_KEYS) {
    if (key in input) {
      const value = input[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        const error = new Error(`${key} must be an object.`);
        error.statusCode = 400;
        error.code = "INVALID_WORKSPACE_STATE";
        throw error;
      }
      output[key] = value;
    }
  }
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_WORKSPACE_BYTES) {
    const error = new Error("Workspace state exceeds the 2 MB safety limit.");
    error.statusCode = 413;
    error.code = "WORKSPACE_STATE_TOO_LARGE";
    throw error;
  }
  return output;
}

function cleanPayload(payload) {
  const next = { ...payload };
  delete next.id;
  delete next.version;
  delete next.createdAt;
  delete next.updatedAt;
  return next;
}

function auditPayload(row) {
  return {
    id: row.id,
    userId: row.actor_id || "system",
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    timestamp: row.created_at,
    details: row.after_json?.details || row.action,
    ipAddress: row.ip_address || undefined
  };
}

function vehiclePayload(row) {
  return {
    ...(row.payload || {}), id: row.id, vin: row.vin, licensePlate: row.license_plate,
    make: row.make, model: row.model, year: row.model_year, status: row.status,
    assignedBranchId: row.assigned_branch_id, dailyRate: Number(row.daily_rate),
    registrationExpiry: row.registration_expiry, insuranceExpiry: row.insurance_expiry,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function customerPayload(row) {
  return {
    ...(row.payload || {}), id: row.id, name: row.full_name, email: row.email,
    phone: row.phone, status: row.status, licenseNumber: row.license_number,
    licenseExpiry: row.license_expiry,
    licenseVerificationStatus: row.license_verification_status,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function bookingPayload(row) {
  const pickup = new Date(row.pickup_at);
  const returned = new Date(row.return_at);
  return {
    ...(row.payload || {}), id: row.id, reservationNumber: row.reservation_number,
    customerId: row.customer_id, carId: row.vehicle_id || undefined,
    startDate: pickup.toISOString().slice(0, 10), endDate: returned.toISOString().slice(0, 10),
    pickupTime: pickup.toISOString().slice(11, 16), dropoffTime: returned.toISOString().slice(11, 16),
    pickupLocationId: row.pickup_branch_id, returnLocationId: row.return_branch_id,
    status: row.status, paymentStatus: row.payment_status,
    totalAmount: Number(row.total_amount), depositAmount: Number(row.deposit_amount),
    paidAmount: Number(row.paid_amount), version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function paymentPayload(row) {
  return {
    id: row.id,
    bookingId: row.booking_id || undefined,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status === "succeeded"
      ? "completed"
      : row.status === "failed"
        ? "failed"
        : "pending",
    method: row.request_json?.method || "Recorded payment",
    transactionId: row.provider_reference || undefined,
    createdAt: row.created_at,
    description: row.request_json?.description || row.operation_type.replaceAll("_", " "),
    type: row.operation_type === "refund" ? "refund" : "rental",
    refunded: row.operation_type === "refund" && row.status === "succeeded"
  };
}

async function audit(client, request, action, entityType, entityId, before, after) {
  await client.query(
    `INSERT INTO fleet_audit_events
      (organization_id, actor_id, action, entity_type, entity_id, before_json, after_json, request_id, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [organization(request), actor(request), action, entityType, entityId,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
      request.id || request.get("X-Request-ID") || null, request.ip || null]
  );
}

router.use(authRequired, tenantContext);
router.use(requireEmployee);

router.get("/health", async (request, response, next) => {
  try {
    const result = await query(
      `SELECT
        to_regclass('public.fleet_bookings') IS NOT NULL AS core_ready,
        to_regclass('public.fleet_workspace_state') IS NOT NULL AS workspace_ready,
        to_regclass('public.fleet_chat_messages') IS NOT NULL AS chat_ready,
        to_regclass('public.fleet_customer_notifications') IS NOT NULL AS notifications_ready,
        to_regclass('public.fleet_payment_operations') IS NOT NULL AS payment_schema_ready`
    );
    const readiness = result.rows[0];
    response.json({
      success: true,
      service: "goodfleet",
      databaseReady: Object.values(readiness).every(Boolean),
      readiness
    });
  } catch (error) { next(error); }
});

router.get("/bootstrap", async (request, response, next) => {
  try {
    const org = organization(request);
    const [vehicles, customers, bookings, payments, workspace, auditEvents, members] = await Promise.all([
      query(`SELECT * FROM fleet_vehicles WHERE organization_id=$1 AND archived_at IS NULL ORDER BY created_at DESC`, [org]),
      query(`SELECT * FROM fleet_customers WHERE organization_id=$1 AND archived_at IS NULL ORDER BY created_at DESC`, [org]),
      query(`SELECT * FROM fleet_bookings WHERE organization_id=$1 AND archived_at IS NULL ORDER BY pickup_at DESC`, [org]),
      query(`SELECT * FROM fleet_payment_operations WHERE organization_id=$1 ORDER BY created_at DESC`, [org]),
      query(`SELECT state_json,version,updated_at FROM fleet_workspace_state WHERE organization_id=$1`, [org]),
      query(
        `SELECT * FROM fleet_audit_events
         WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200`,
        [org]
      ),
      query(
        `SELECT account.id,account.email,account.display_name,account.first_name,
                account.last_name,account.platform_role,account.status,account.avatar_url,
                membership.role AS organization_role
         FROM backend_organization_memberships membership
         JOIN users account ON account.id=membership.user_id
         WHERE membership.organization_id=$1 AND membership.status='active'
         ORDER BY account.display_name,account.email`,
        [org]
      )
    ]);
    const workspaceRow = workspace.rows[0];
    response.json({ success: true, data: {
      vehicles: vehicles.rows.map(vehiclePayload),
      customers: customers.rows.map(customerPayload),
      bookings: bookings.rows.map(bookingPayload),
      payments: payments.rows.map(paymentPayload),
      workspace: {
        state: workspaceRow?.state_json || {},
        version: workspaceRow?.version || 0,
        updatedAt: workspaceRow?.updated_at || null
      },
      auditLogs: auditEvents.rows.map(auditPayload),
      staff: members.rows.map(member => ({
        id: member.id,
        name: member.display_name || [member.first_name, member.last_name].filter(Boolean).join(" ") || member.email,
        email: member.email,
        phone: "",
        branchId: "",
        role: member.platform_role === "owner" || member.organization_role === "owner"
          ? "owner"
          : member.platform_role === "manager" || member.organization_role === "admin"
            ? "manager"
            : "staff",
        status: member.status === "active" ? "active" : "inactive",
        avatarUrl: member.avatar_url || undefined
      }))
    }});
  } catch (error) { next(error); }
});

router.post("/staff/invitations", async (request, response, next) => {
  try {
    const email = required(request.body?.email, "email", 320).toLowerCase();
    const requestedRole = text(request.body?.role, 40).toLowerCase();
    const roleName = requestedRole === "owner"
      ? "owner"
      : requestedRole === "manager"
        ? "admin"
        : "user";
    const result = await teamsService.inviteTeamMemberForUser(
      actor(request),
      { email, roleName },
      { ipAddress: request.ip }
    );
    response.status(result.memberAdded ? 200 : 201).json({
      success: true,
      data: {
        memberAdded: Boolean(result.memberAdded),
        invitationSent: !result.memberAdded,
        email
      }
    });
  } catch (error) { next(error); }
});

router.patch("/staff/:userId", async (request, response, next) => {
  try {
    const requestedRole = text(request.body?.role, 40).toLowerCase();
    const roleName = requestedRole === "owner"
      ? "owner"
      : requestedRole === "manager"
        ? "admin"
        : "user";
    await teamsService.updateTeamMemberForUser(
      actor(request),
      request.params.userId,
      {
        roleName,
        status: request.body?.status === "inactive" ? "suspended" : "active"
      },
      { ipAddress: request.ip }
    );
    response.json({ success: true, data: { updated: true } });
  } catch (error) { next(error); }
});

router.delete("/staff/:userId", async (request, response, next) => {
  try {
    await teamsService.updateTeamMemberForUser(
      actor(request),
      request.params.userId,
      { roleName: "user", status: "removed" },
      { ipAddress: request.ip }
    );
    response.json({ success: true, data: { removed: true } });
  } catch (error) { next(error); }
});

router.put("/workspace", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const org = organization(request);
    const requestedVersion = Number(request.body?.version);
    const state = sanitizeWorkspace(request.body?.state);
    if (!Number.isInteger(requestedVersion) || requestedVersion < 0) {
      return fail(response, 400, "INVALID_WORKSPACE_VERSION", "A valid workspace version is required.");
    }
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT state_json,version FROM fleet_workspace_state WHERE organization_id=$1 FOR UPDATE`,
      [org]
    );
    const currentVersion = current.rows[0]?.version || 0;
    if (requestedVersion !== currentVersion) {
      await client.query("ROLLBACK");
      return fail(response, 409, "WORKSPACE_VERSION_CONFLICT", "Workspace changed in another session.", {
        currentVersion
      });
    }
    const saved = current.rowCount
      ? await client.query(
        `UPDATE fleet_workspace_state
         SET state_json=$2::jsonb,version=version+1,updated_by=$3,updated_at=NOW()
         WHERE organization_id=$1 RETURNING state_json,version,updated_at`,
        [org, JSON.stringify(state), actor(request)]
      )
      : await client.query(
        `INSERT INTO fleet_workspace_state
          (organization_id,state_json,version,created_by,updated_by)
         VALUES ($1,$2::jsonb,1,$3,$3) RETURNING state_json,version,updated_at`,
        [org, JSON.stringify(state), actor(request)]
      );
    const result = saved.rows[0];
    await audit(client, request, "workspace.updated", "workspace", org, null, {
      version: result.version,
      keys: Object.keys(state),
      details: "GoodFleet operational workspace saved"
    });
    await client.query("COMMIT");
    response.json({ success: true, data: {
      state: result.state_json,
      version: result.version,
      updatedAt: result.updated_at
    }});
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally { client.release(); }
});

router.post("/vehicles", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const body = request.body || {};
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO fleet_vehicles
       (organization_id,vin,license_plate,make,model,model_year,status,assigned_branch_id,daily_rate,registration_expiry,insurance_expiry,payload,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$13) RETURNING *`,
      [organization(request), required(body.vin, "vin", 80), required(body.licensePlate, "licensePlate", 40),
        required(body.make, "make", 100), required(body.model, "model", 100),
        modelYear(body.year), enumValue(body.status || "available", VEHICLE_STATUSES, "status"),
        text(body.assignedBranchId, 200) || null, money(body.dailyRate, "dailyRate"),
        body.registrationExpiry || null, body.insuranceExpiry || null, JSON.stringify(body), actor(request)]
    );
    const vehicle = vehiclePayload(result.rows[0]);
    await audit(client, request, "vehicle.created", "vehicle", vehicle.id, null, vehicle);
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: vehicle });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return fail(response, 409, "VEHICLE_ALREADY_EXISTS", "VIN or license plate already exists.");
    next(error);
  } finally { client.release(); }
});

router.post("/customers", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const body = request.body || {};
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO fleet_customers
       (organization_id,full_name,email,phone,status,license_number,license_expiry,license_verification_status,payload,created_by,updated_by)
       VALUES ($1,$2,lower($3),$4,$5,$6,$7,$8,$9::jsonb,$10,$10) RETURNING *`,
      [organization(request), required(body.name, "name", 200), required(body.email, "email", 320),
        text(body.phone, 50) || null, enumValue(body.status || "active", CUSTOMER_STATUSES, "status"),
        required(body.licenseNumber, "licenseNumber", 100), required(body.licenseExpiry, "licenseExpiry", 20),
        enumValue(body.licenseVerificationStatus || "pending", LICENSE_STATUSES, "licenseVerificationStatus"),
        JSON.stringify(body), actor(request)]
    );
    const customer = customerPayload(result.rows[0]);
    await audit(client, request, "customer.created", "customer", customer.id, null, customer);
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: customer });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return fail(response, 409, "CUSTOMER_ALREADY_EXISTS", "Email or driver license already exists.");
    next(error);
  } finally { client.release(); }
});

router.post("/bookings", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const body = request.body || {};
    const org = organization(request);
    const pickupAt = timestamp(body.startDate, body.pickupTime, "pickupAt");
    const returnAt = timestamp(body.endDate, body.dropoffTime, "returnAt");
    const requestedVehicleId = text(body.requestedCarId || body.carId, 80);
    if (new Date(returnAt) <= new Date(pickupAt)) return fail(response, 400, "INVALID_RENTAL_PERIOD", "Return must be after pickup.");
    await client.query("BEGIN");
    if (body.carId) await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${org}:${body.carId}`]);

    const customerResult = await client.query(
      `SELECT * FROM fleet_customers WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR SHARE`,
      [org, required(body.customerId, "customerId", 80)]
    );
    if (!customerResult.rowCount) { await client.query("ROLLBACK"); return fail(response, 404, "CUSTOMER_NOT_FOUND", "Customer not found."); }
    const customer = customerResult.rows[0];
    if (customer.status !== "active" || new Date(customer.license_expiry) < new Date(pickupAt)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "DRIVER_NOT_ELIGIBLE", "Customer must be active with a license valid through pickup.");
    }

    if (body.carId) {
      const vehicleResult = await client.query(
        `SELECT * FROM fleet_vehicles WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`,
        [org, body.carId]
      );
      if (!vehicleResult.rowCount) { await client.query("ROLLBACK"); return fail(response, 404, "VEHICLE_NOT_FOUND", "Vehicle not found."); }
      const vehicle = vehicleResult.rows[0];
      if (vehicle.status !== "available" || (vehicle.registration_expiry && new Date(vehicle.registration_expiry) < new Date(pickupAt)) || (vehicle.insurance_expiry && new Date(vehicle.insurance_expiry) < new Date(pickupAt))) {
        await client.query("ROLLBACK");
        return fail(response, 409, "VEHICLE_NOT_ELIGIBLE", "Vehicle is unavailable or has expired compliance documents.");
      }
    } else if (requestedVehicleId) {
      const requestedVehicle = await client.query(
        `SELECT id FROM fleet_vehicles
         WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL`,
        [org, requestedVehicleId]
      );
      if (!requestedVehicle.rowCount) {
        await client.query("ROLLBACK");
        return fail(response, 404, "VEHICLE_NOT_FOUND", "Requested vehicle not found.");
      }
    }

    const reservation = text(body.reservationNumber, 80) || `GF-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const result = await client.query(
      `INSERT INTO fleet_bookings
       (organization_id,reservation_number,customer_id,vehicle_id,pickup_at,return_at,pickup_branch_id,return_branch_id,status,payment_status,total_amount,deposit_amount,paid_amount,payload,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_payment','unpaid',$9,$10,$11,$12::jsonb,$13,$13) RETURNING *`,
      [org, reservation, body.customerId, body.carId || null, pickupAt, returnAt,
        required(body.pickupLocationId, "pickupLocationId", 200),
        required(body.returnLocationId, "returnLocationId", 200),
        money(body.totalAmount, "totalAmount"), money(body.depositAmount || 0, "depositAmount"),
        money(body.paidAmount || 0, "paidAmount"), JSON.stringify(body), actor(request)]
    );
    const booking = bookingPayload(result.rows[0]);
    await audit(client, request, "booking.created", "booking", booking.id, null, booking);
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: booking });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23P01") return fail(response, 409, "VEHICLE_NOT_AVAILABLE", "Vehicle is already committed during this rental period, including turnaround time.");
    if (error.code === "23505") return fail(response, 409, "RESERVATION_ALREADY_EXISTS", "Reservation number already exists.");
    next(error);
  } finally { client.release(); }
});

router.patch("/vehicles/:vehicleId", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const org = organization(request);
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM fleet_vehicles
       WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`,
      [org, request.params.vehicleId]
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "VEHICLE_NOT_FOUND", "Vehicle not found.");
    }
    const before = vehiclePayload(existing.rows[0]);
    const merged = cleanPayload({ ...before, ...(request.body || {}) });
    const result = await client.query(
      `UPDATE fleet_vehicles SET
        vin=$3,license_plate=$4,make=$5,model=$6,model_year=$7,status=$8,
        assigned_branch_id=$9,daily_rate=$10,registration_expiry=$11,
        insurance_expiry=$12,payload=$13::jsonb,version=version+1,
        updated_by=$14,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [org, request.params.vehicleId, required(merged.vin, "vin", 80),
        required(merged.licensePlate, "licensePlate", 40), required(merged.make, "make", 100),
        required(merged.model, "model", 100), modelYear(merged.year),
        enumValue(merged.status || "available", VEHICLE_STATUSES, "status"),
        text(merged.assignedBranchId, 200) || null,
        money(merged.dailyRate, "dailyRate"), merged.registrationExpiry || null,
        merged.insuranceExpiry || null, JSON.stringify(merged), actor(request)]
    );
    const vehicle = vehiclePayload(result.rows[0]);
    await audit(client, request, "vehicle.updated", "vehicle", vehicle.id, before, vehicle);
    await client.query("COMMIT");
    response.json({ success: true, data: vehicle });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return fail(response, 409, "VEHICLE_ALREADY_EXISTS", "VIN or license plate already exists.");
    next(error);
  } finally { client.release(); }
});

router.delete("/vehicles/:vehicleId", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const org = organization(request);
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM fleet_vehicles
       WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`,
      [org, request.params.vehicleId]
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "VEHICLE_NOT_FOUND", "Vehicle not found.");
    }
    const activeBooking = await client.query(
      `SELECT id FROM fleet_bookings
       WHERE organization_id=$1 AND vehicle_id=$2 AND archived_at IS NULL
         AND status=ANY($3::text[]) LIMIT 1`,
      [org, request.params.vehicleId, ACTIVE_BOOKING_STATUSES]
    );
    if (activeBooking.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 409, "VEHICLE_HAS_ACTIVE_BOOKING", "A vehicle with an active reservation cannot be archived.");
    }
    const before = vehiclePayload(existing.rows[0]);
    await client.query(
      `UPDATE fleet_vehicles
       SET status='retired',archived_at=NOW(),version=version+1,updated_by=$3,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2`,
      [org, request.params.vehicleId, actor(request)]
    );
    await audit(client, request, "vehicle.archived", "vehicle", request.params.vehicleId, before, {
      id: request.params.vehicleId,
      archived: true,
      details: "Vehicle archived"
    });
    await client.query("COMMIT");
    response.json({ success: true, data: { id: request.params.vehicleId, archived: true } });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally { client.release(); }
});

router.patch("/customers/:customerId", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const org = organization(request);
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM fleet_customers
       WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`,
      [org, request.params.customerId]
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }
    const before = customerPayload(existing.rows[0]);
    const merged = cleanPayload({ ...before, ...(request.body || {}) });
    const result = await client.query(
      `UPDATE fleet_customers SET
        full_name=$3,email=lower($4),phone=$5,status=$6,license_number=$7,
        license_expiry=$8,license_verification_status=$9,payload=$10::jsonb,
        version=version+1,updated_by=$11,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [org, request.params.customerId, required(merged.name, "name", 200),
        required(merged.email, "email", 320), text(merged.phone, 50) || null,
        enumValue(merged.status || "active", CUSTOMER_STATUSES, "status"),
        required(merged.licenseNumber, "licenseNumber", 100),
        required(merged.licenseExpiry, "licenseExpiry", 20),
        enumValue(merged.licenseVerificationStatus || "pending", LICENSE_STATUSES, "licenseVerificationStatus"),
        JSON.stringify(merged), actor(request)]
    );
    const customer = customerPayload(result.rows[0]);
    await audit(client, request, "customer.updated", "customer", customer.id, before, customer);
    await client.query("COMMIT");
    response.json({ success: true, data: customer });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return fail(response, 409, "CUSTOMER_ALREADY_EXISTS", "Email or driver license already exists.");
    next(error);
  } finally { client.release(); }
});

router.patch("/bookings/:bookingId", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const org = organization(request);
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM fleet_bookings
       WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`,
      [org, request.params.bookingId]
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "BOOKING_NOT_FOUND", "Reservation not found.");
    }
    const before = bookingPayload(existing.rows[0]);
    const merged = cleanPayload({ ...before, ...(request.body || {}) });
    const pickupAt = timestamp(merged.startDate, merged.pickupTime, "pickupAt");
    const returnAt = timestamp(merged.endDate, merged.dropoffTime, "returnAt");
    if (new Date(returnAt) <= new Date(pickupAt)) {
      await client.query("ROLLBACK");
      return fail(response, 400, "INVALID_RENTAL_PERIOD", "Return must be after pickup.");
    }
    if (merged.status === "checked_out") {
      if (!merged.carId) {
        await client.query("ROLLBACK");
        return fail(response, 409, "VEHICLE_ASSIGNMENT_REQUIRED", "Assign an eligible vehicle before checkout.");
      }
      const customer = await client.query(
        `SELECT status,license_verification_status,
                (license_expiry IS NOT NULL AND license_expiry >= CURRENT_DATE) AS license_current
           FROM fleet_customers
          WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL
          FOR SHARE`,
        [org, merged.customerId]
      );
      const renter = customer.rows[0];
      if (!renter || renter.status !== "active" ||
          renter.license_verification_status !== "verified" ||
          !renter.license_current) {
        await client.query("ROLLBACK");
        return fail(response, 409, "ID_VERIFICATION_REQUIRED", "Verify a valid government-issued driver license before vehicle checkout.");
      }
    }
    if (merged.carId && ACTIVE_BOOKING_STATUSES.includes(merged.status)) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${org}:${merged.carId}`]);
      const vehicle = await client.query(
        `SELECT id,status,registration_expiry,insurance_expiry FROM fleet_vehicles
         WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`,
        [org, merged.carId]
      );
      if (!vehicle.rowCount) {
        await client.query("ROLLBACK");
        return fail(response, 404, "VEHICLE_NOT_FOUND", "Vehicle not found.");
      }
      const record = vehicle.rows[0];
      if (record.status === "retired" || record.status === "blocked" ||
          (record.registration_expiry && new Date(record.registration_expiry) < new Date(pickupAt)) ||
          (record.insurance_expiry && new Date(record.insurance_expiry) < new Date(pickupAt))) {
        await client.query("ROLLBACK");
        return fail(response, 409, "VEHICLE_NOT_ELIGIBLE", "Vehicle is unavailable or has expired compliance documents.");
      }
    }
    const result = await client.query(
      `UPDATE fleet_bookings SET
        reservation_number=$3,customer_id=$4,vehicle_id=$5,pickup_at=$6,return_at=$7,
        pickup_branch_id=$8,return_branch_id=$9,status=$10,payment_status=$11,
        total_amount=$12,deposit_amount=$13,paid_amount=$14,payload=$15::jsonb,
        version=version+1,updated_by=$16,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [org, request.params.bookingId, required(merged.reservationNumber, "reservationNumber", 80),
        merged.customerId, merged.carId || null, pickupAt, returnAt,
        required(merged.pickupLocationId, "pickupLocationId", 200),
        required(merged.returnLocationId, "returnLocationId", 200),
        enumValue(merged.status, BOOKING_STATUSES, "status"),
        enumValue(merged.paymentStatus, PAYMENT_STATUSES, "paymentStatus"),
        money(merged.totalAmount, "totalAmount"),
        money(merged.depositAmount || 0, "depositAmount"),
        money(merged.paidAmount || 0, "paidAmount"), JSON.stringify(merged), actor(request)]
    );
    const booking = bookingPayload(result.rows[0]);
    await audit(client, request, "booking.updated", "booking", booking.id, before, booking);
    await client.query("COMMIT");
    response.json({ success: true, data: booking });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23P01") return fail(response, 409, "VEHICLE_NOT_AVAILABLE", "Vehicle is already committed during this rental period, including turnaround time.");
    if (error.code === "23505") return fail(response, 409, "RESERVATION_ALREADY_EXISTS", "Reservation number already exists.");
    next(error);
  } finally { client.release(); }
});

module.exports = router;
