"use strict";

const crypto = require("crypto");
const express = require("express");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { pool, query } = require("../config/database");
const notificationService = require("../services/notification.service");
const teamsService = require("../services/teams.service");
const { encryptValue } = require("../services/secret.service");

const router = express.Router();
const PUBLIC_APP_URL = String(process.env.GOODFLEET_PUBLIC_URL || "https://fleet.goodos.app").replace(/\/$/, "");
const GOODFLEET_TESTING_MODE = String(process.env.GOODFLEET_TESTING_MODE || "true").toLowerCase() === "true";

const ACTIVE_BOOKING_STATUSES = [
  "pending_payment", "confirmed", "assigned", "checked_in",
  "checked_out", "extended", "overdue"
];

const WORKSPACE_ARRAY_KEYS = new Set([
  "contracts", "branches", "maintenance", "damageReports", "inspections",
  "supportTickets", "rates", "seasonalAdjustments", "dynamicPricingInsights",
  "discounts", "fees", "expenses", "addons", "onboardingSteps"
]);
const WORKSPACE_OBJECT_KEYS = new Set(["branding", "billingSettings", "ownerSettings"]);
const WORKSPACE_AUDIT_DESCRIPTORS = {
  contracts: ["contract", "Contract"],
  branches: ["branch", "Branch"],
  maintenance: ["maintenance", "Maintenance record"],
  damageReports: ["damage_report", "Damage report"],
  inspections: ["inspection", "Inspection"],
  supportTickets: ["support_ticket", "Support ticket"],
  rates: ["rate", "Rate"],
  seasonalAdjustments: ["seasonal_adjustment", "Seasonal adjustment"],
  dynamicPricingInsights: ["dynamic_pricing_insight", "Dynamic pricing insight"],
  discounts: ["discount", "Discount"],
  fees: ["fee", "Fee"],
  expenses: ["expense", "Expense"],
  addons: ["addon", "Add-on"],
  onboardingSteps: ["onboarding_step", "Onboarding step"],
  branding: ["branding", "Branding settings"],
  billingSettings: ["billing_settings", "Billing settings"],
  ownerSettings: ["owner_settings", "Owner settings"]
};
const MAX_WORKSPACE_BYTES = 2 * 1024 * 1024;
const EMPLOYEE_ROLES = new Set(["owner", "admin", "manager", "staff", "mechanic"]);
const LICENSE_VERIFIER_ROLES = new Set(["owner", "admin", "manager", "staff"]);
const OWNER_ROLES = new Set(["owner", "admin"]);
const FLEET_EDITOR_ROLES = new Set(["owner", "admin", "manager"]);
const BOOKING_EDITOR_ROLES = new Set(["owner", "admin", "manager", "staff"]);
const BOOKING_DELETE_ROLES = new Set(["owner", "admin", "manager"]);
const MANAGEMENT_RETURN_OVERRIDE_ROLES = new Set(["owner", "admin", "manager"]);
const VEHICLE_STATUSES = new Set([
  "available", "reserved", "checked_out", "in_transit", "cleaning", "turnaround",
  "inspection", "maintenance", "out_of_service", "retired", "blocked", "recalled"
]);
const CUSTOMER_STATUSES = new Set(["active", "suspended", "blacklisted"]);
const BOOKING_STATUSES = new Set([
  "quote", "pending_payment", "confirmed", "assigned", "checked_in", "checked_out",
  "extended", "needs_attention", "completed", "no_show", "cancelled", "refunded", "overdue"
]);
const PAYMENT_STATUSES = new Set(["unpaid", "partial", "paid", "refunded", "disputed", "failed"]);
const ONBOARDING_MODULES = new Set([
  "overview", "reservations", "calendar", "vehicles", "turnaround", "tracking",
  "communications", "customers", "revenue", "staff-access", "integrations",
  "audit-history", "help", "documentation", "settings"
]);

function actor(request) {
  return request.user?.id || null;
}

function organization(request) {
  return request.tenantContext.organizationId;
}

function goodFleetAppRole(request) {
  const membership = (request.apps || []).find(app =>
    text(app?.membershipStatus, 40).toLowerCase() === "active" &&
    (text(app?.id, 80).toLowerCase() === "goodfleet" ||
      text(app?.domain, 160).toLowerCase() === "fleet.goodos.app")
  );
  return text(membership?.role, 40).toLowerCase();
}

function goodFleetAccessRole(request) {
  const organizationRole = text(request.tenantContext.organization?.membershipRole, 40).toLowerCase();
  if (["owner", "admin", "manager"].includes(organizationRole)) return organizationRole;
  const appRole = goodFleetAppRole(request);
  if (EMPLOYEE_ROLES.has(appRole)) return appRole;
  return organizationRole;
}

function normalizedFleetRole(request) {
  const role = goodFleetAccessRole(request);
  if (role === "owner") return "owner";
  if (role === "admin" || role === "manager") return "manager";
  if (role === "mechanic") return "mechanic";
  return "staff";
}

function requireEmployee(request, response, next) {
  const role = goodFleetAccessRole(request);
  if (!EMPLOYEE_ROLES.has(role)) {
    return fail(response, 403, "EMPLOYEE_ACCESS_REQUIRED", "GoodFleet employee access is required.");
  }
  return next();
}

function requireLicenseVerifier(request, response, next) {
  const role = goodFleetAccessRole(request);
  if (!LICENSE_VERIFIER_ROLES.has(role)) {
    return fail(response, 403, "LICENSE_VERIFIER_ACCESS_REQUIRED", "Front-desk or management access is required to verify renter identification.");
  }
  return next();
}

function requireOwner(request, response, next) {
  if (!OWNER_ROLES.has(goodFleetAccessRole(request))) {
    return fail(response, 403, "OWNER_ACCESS_REQUIRED", "GoodFleet owner access is required.");
  }
  return next();
}

function requireFleetEditor(request, response, next) {
  if (!FLEET_EDITOR_ROLES.has(goodFleetAccessRole(request))) {
    return fail(response, 403, "FLEET_EDIT_ACCESS_REQUIRED", "Fleet management access is required.");
  }
  return next();
}

function requireBookingEditor(request, response, next) {
  if (!BOOKING_EDITOR_ROLES.has(goodFleetAccessRole(request))) {
    return fail(response, 403, "BOOKING_EDIT_ACCESS_REQUIRED", "Reservation desk access is required.");
  }
  return next();
}

function requireBookingManager(request, response, next) {
  if (!BOOKING_DELETE_ROLES.has(goodFleetAccessRole(request))) {
    return fail(response, 403, "BOOKING_DELETE_ACCESS_REQUIRED", "Management access is required to delete a reservation.");
  }
  return next();
}

function allowedWorkspaceKeys(request) {
  const role = goodFleetAccessRole(request);
  if (role === "owner" || role === "admin") {
    return new Set([...WORKSPACE_ARRAY_KEYS, ...WORKSPACE_OBJECT_KEYS]);
  }
  if (role === "manager") {
    return new Set([...WORKSPACE_ARRAY_KEYS, "branding", "billingSettings"]);
  }
  if (role === "staff") {
    return new Set([
      "maintenance", "damageReports", "inspections", "supportTickets",
      "onboardingSteps"
    ]);
  }
  if (role === "mechanic") {
    return new Set(["maintenance", "damageReports", "inspections", "onboardingSteps"]);
  }
  return new Set();
}

function fail(response, status, code, message, details) {
  return response.status(status).json({ success: false, code, message, ...(details ? { details } : {}) });
}

function text(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizePhone(value) {
  const raw = text(value, 30);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
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

function rentalDays(pickupAt, returnAt) {
  return Math.max(1, Math.ceil(
    (new Date(returnAt).getTime() - new Date(pickupAt).getTime()) / 86_400_000
  ));
}

async function calculateBookingPrice(client, org, input, pickupAt, returnAt) {
  const pricingVehicleId = text(input.carId || input.requestedCarId, 80);
  if (!pricingVehicleId) {
    const error = new Error("A requested vehicle is required to calculate the reservation price.");
    error.statusCode = 400;
    error.code = "VEHICLE_REQUIRED";
    throw error;
  }
  const [vehicleResult, workspaceResult] = await Promise.all([
    client.query(
      `SELECT id,daily_rate FROM fleet_vehicles
        WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL`,
      [org, pricingVehicleId]
    ),
    client.query(
      `SELECT state_json FROM fleet_workspace_state WHERE organization_id=$1`,
      [org]
    )
  ]);
  if (!vehicleResult.rowCount) {
    const error = new Error("Requested vehicle not found.");
    error.statusCode = 404;
    error.code = "VEHICLE_NOT_FOUND";
    throw error;
  }
  const state = workspaceResult.rows[0]?.state_json || {};
  const days = rentalDays(pickupAt, returnAt);
  const dailyRate = Number(vehicleResult.rows[0].daily_rate);
  const base = dailyRate * days;
  const suppliedCode = text(input.discountCode || input.promoCode, 80).toLowerCase();
  const discountRecord = Array.isArray(state.discounts)
    ? state.discounts.find(item =>
      String(item?.status || "").toLowerCase() === "active" &&
      String(item?.code || "").trim().toLowerCase() === suppliedCode
    )
    : null;
  let discount = 0;
  if (discountRecord) {
    const value = Math.max(0, Number(discountRecord.value) || 0);
    discount = discountRecord.type === "percentage"
      ? base * Math.min(value, 100) / 100
      : Math.min(value, base);
  }
  const discountedBase = Math.max(0, base - discount);
  const mandatoryFees = (Array.isArray(state.fees) ? state.fees : [])
    .filter(item =>
      String(item?.status || "").toLowerCase() === "active" &&
      String(item?.type || "").toLowerCase() === "mandatory"
    )
    .reduce((sum, fee) => {
      const value = Math.max(0, Number(fee.value) || 0);
      if (fee.calculationType === "per_day") return sum + value * days;
      if (fee.calculationType === "percentage") return sum + discountedBase * value / 100;
      return sum + value;
    }, 0);
  const branch = (Array.isArray(state.branches) ? state.branches : [])
    .find(item => String(item?.id || "") === String(input.pickupLocationId || ""));
  const configuredTax = Number(branch?.financialConfig?.taxRate ?? state.billingSettings?.taxRate ?? 0);
  const taxRate = Number.isFinite(configuredTax) ? Math.min(Math.max(configuredTax, 0), 100) : 0;
  const additionalCharges = (Array.isArray(input.additionalCharges) ? input.additionalCharges : [])
    .reduce((sum, charge) => sum + Math.max(0, Number(charge?.amount) || 0), 0);
  const tax = (discountedBase + mandatoryFees + additionalCharges) * taxRate / 100;
  return {
    days,
    dailyRate: Number(dailyRate.toFixed(2)),
    base: Number(base.toFixed(2)),
    discount: Number(discount.toFixed(2)),
    mandatoryFees: Number(mandatoryFees.toFixed(2)),
    additionalCharges: Number(additionalCharges.toFixed(2)),
    taxRate: Number(taxRate.toFixed(4)),
    tax: Number(tax.toFixed(2)),
    total: Number((discountedBase + mandatoryFees + additionalCharges + tax).toFixed(2))
  };
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
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

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalJson(value[key]);
      return result;
    }, {});
  }
  return value;
}

function jsonEqual(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function workspaceEntityId(key, item, index) {
  const explicitId = text(item?.id, 200);
  if (explicitId) return explicitId;
  return `${key}:${sha256(JSON.stringify(canonicalJson(item || {}))).slice(0, 20)}:${index}`;
}

function workspaceItemLabel(item, fallback) {
  return text(
    item?.name || item?.title || item?.label || item?.code ||
      item?.description || item?.id || fallback,
    160
  );
}

function changedWorkspaceFields(before, after) {
  return [...new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {})
  ])].filter(key => !jsonEqual(before?.[key], after?.[key]));
}

function workspaceAuditSnapshot(item, changedFields = []) {
  if (!item || typeof item !== "object") return item;
  const allowed = [
    "id", "name", "title", "label", "code", "status", "type", "category",
    "bookingId", "vehicleId", "customerId", "branchId", "date", "startDate",
    "endDate", "amount", "price", "dailyRate", "enabled"
  ];
  const snapshot = {};
  for (const key of allowed) {
    if (key in item) snapshot[key] = item[key];
  }
  if (changedFields.length) snapshot.changedFields = changedFields;
  return snapshot;
}

async function auditWorkspaceChanges(client, request, beforeState, afterState) {
  const changedSections = [];
  for (const [key, [entityType, label]] of Object.entries(WORKSPACE_AUDIT_DESCRIPTORS)) {
    const beforeValue = beforeState?.[key];
    const afterValue = afterState?.[key];
    if (jsonEqual(beforeValue, afterValue)) continue;
    changedSections.push(key);

    if (WORKSPACE_ARRAY_KEYS.has(key)) {
      const beforeItems = Array.isArray(beforeValue) ? beforeValue : [];
      const afterItems = Array.isArray(afterValue) ? afterValue : [];
      const beforeMap = new Map(beforeItems.map((item, index) => [
        workspaceEntityId(key, item, index), item
      ]));
      const afterMap = new Map(afterItems.map((item, index) => [
        workspaceEntityId(key, item, index), item
      ]));

      for (const [entityId, item] of afterMap) {
        const previous = beforeMap.get(entityId);
        const operation = previous ? "updated" : "created";
        if (previous && jsonEqual(previous, item)) continue;
        const changedFields = previous ? changedWorkspaceFields(previous, item) : [];
        await audit(
          client,
          request,
          `${entityType}.${operation}`,
          entityType,
          entityId,
          previous ? workspaceAuditSnapshot(previous) : null,
          {
            ...workspaceAuditSnapshot(item, changedFields),
            details: `${label} ${workspaceItemLabel(item, entityId)} ${operation}`
          }
        );
      }

      for (const [entityId, item] of beforeMap) {
        if (afterMap.has(entityId)) continue;
        await audit(
          client,
          request,
          `${entityType}.deleted`,
          entityType,
          entityId,
          workspaceAuditSnapshot(item),
          {
            id: entityId,
            deleted: true,
            details: `${label} ${workspaceItemLabel(item, entityId)} deleted`
          }
        );
      }
      continue;
    }

    const changedFields = changedWorkspaceFields(beforeValue, afterValue);
    await audit(
      client,
      request,
      `${entityType}.updated`,
      entityType,
      organization(request),
      workspaceAuditSnapshot(beforeValue),
      {
        ...workspaceAuditSnapshot(afterValue, changedFields),
        details: `${label} updated`
      }
    );
  }
  return changedSections;
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
    licenseExpiry: dateOnly(row.license_expiry),
    licenseVerificationStatus: row.license_verification_status,
    licenseVerifiedAt: row.license_verified_at,
    licenseVerifiedBy: row.license_verified_by,
    licenseVerificationMethod: row.license_verification_method,
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
  const completed = ["succeeded", "captured"].includes(row.status);
  const refunded = ["refunded", "partially_refunded", "voided"].includes(row.status) ||
    (row.operation_type === "refund" && completed);
  const storedType = row.request_json?.type;
  return {
    id: row.id,
    bookingId: row.booking_id || undefined,
    amount: Number(row.amount),
    currency: row.currency,
    status: refunded
      ? "refunded"
      : completed || row.status === "authorized"
        ? "completed"
        : row.status === "failed"
          ? "failed"
          : "pending",
    method: row.request_json?.method || "Recorded payment",
    transactionId: row.provider_reference || undefined,
    createdAt: row.created_at,
    description: row.request_json?.description || row.operation_type.replaceAll("_", " "),
    type: row.operation_type === "refund"
      ? "refund"
      : storedType === "deposit" ? "deposit"
        : storedType === "fine" ? "fine" : "rental",
    refunded
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

async function fleetOperatorRecipients(organizationId, actingUserId) {
  const result = await query(
    `SELECT DISTINCT account.id,account.email
     FROM backend_organization_memberships membership
     JOIN users account ON account.id=membership.user_id
     WHERE membership.organization_id=$1
       AND membership.status='active'
       AND account.status='active'
       AND (
         membership.role IN ('owner','admin')
         OR account.platform_role IN ('owner','manager')
         OR account.id=$2::uuid
       )`,
    [organizationId, actingUserId || null]
  );
  return result.rows;
}

async function notifyFleetOperators({
  organizationId,
  actingUserId,
  sourceId,
  notificationKey,
  title,
  message,
  severity,
  category,
  actionUrl,
  payload
}) {
  const recipients = await fleetOperatorRecipients(organizationId, actingUserId);
  await Promise.all(recipients.map(async recipient => {
    const existing = await query(
      `SELECT id
       FROM backend_notifications
       WHERE organization_id=$1
         AND source='goodfleet-operations'
         AND source_id=$2
         AND recipient_user_id=$3::uuid
       LIMIT 1`,
      [organizationId, sourceId, recipient.id]
    );
    if (existing.rowCount) return;

    try {
      await notificationService.createNotification({
        appId: "goodfleet",
        organizationId,
        recipientUserId: recipient.id,
        recipientEmail: recipient.email,
        notificationKey,
        title,
        message,
        severity,
        category,
        actionUrl,
        source: "goodfleet-operations",
        sourceId,
        payload
      });
    } catch (error) {
      if (error.code !== "23505") throw error;
    }
  }));
}

function nextOilServiceMileage(vehicle) {
  const configured = Number(vehicle.nextServiceMileage);
  if (Number.isFinite(configured) && configured > 0) return configured;
  const lastOilChange = Number(vehicle.lastOilChangeMileage);
  const interval = Number(vehicle.oilChangeInterval);
  return Number.isFinite(lastOilChange) && Number.isFinite(interval) && interval > 0
    ? lastOilChange + interval
    : null;
}

async function maybeNotifyOilService(organizationId, actingUserId, vehicle) {
  const currentMileage = Number(vehicle.mileage);
  const nextMileage = nextOilServiceMileage(vehicle);
  if (!Number.isFinite(currentMileage) || !Number.isFinite(nextMileage)) return;

  const workspace = await query(
    `SELECT state_json
     FROM fleet_workspace_state
     WHERE organization_id=$1`,
    [organizationId]
  );
  const configuredThreshold = Number(
    workspace.rows[0]?.state_json?.ownerSettings?.operations?.maintenanceReminderMiles
  );
  const reminderMiles = Number.isFinite(configuredThreshold) && configuredThreshold >= 0
    ? configuredThreshold
    : 500;
  const milesRemaining = Math.round(nextMileage - currentMileage);
  if (milesRemaining > reminderMiles) return;

  const dueNow = milesRemaining <= 0;
  await notifyFleetOperators({
    organizationId,
    actingUserId,
    sourceId: `oil-change:${vehicle.id}:${Math.round(nextMileage)}`,
    notificationKey: dueNow ? "fleet.oil_change_due" : "fleet.oil_change_approaching",
    title: dueNow
      ? `${vehicle.make} ${vehicle.model} oil change is due`
      : `${vehicle.make} ${vehicle.model} is nearing its oil change`,
    message: dueNow
      ? `Current mileage is ${Math.round(currentMileage).toLocaleString()} mi. The oil-change interval at ${Math.round(nextMileage).toLocaleString()} mi has been reached.`
      : `${milesRemaining.toLocaleString()} mi remain before the oil change due at ${Math.round(nextMileage).toLocaleString()} mi.`,
    severity: dueNow ? "error" : "warning",
    category: "maintenance",
    actionUrl: `/operations?tab=maintenance&action=new&carId=${encodeURIComponent(vehicle.id)}&service=oil_change`,
    payload: {
      vehicleId: vehicle.id,
      currentMileage,
      nextServiceMileage: nextMileage,
      milesRemaining
    }
  });
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
        to_regclass('public.fleet_staff_onboarding_progress') IS NOT NULL AS onboarding_ready,
        to_regclass('public.fleet_payment_operations') IS NOT NULL AS payment_schema_ready,
        to_regclass('public.fleet_contract_envelopes') IS NOT NULL AS contract_schema_ready`
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
                membership.role AS organization_role,
                app_membership.role AS app_role
         FROM backend_organization_memberships membership
         JOIN users account ON account.id=membership.user_id
         LEFT JOIN app_memberships app_membership
           ON app_membership.user_id=account.id
          AND app_membership.app_id='goodfleet'
          AND app_membership.status='active'
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
        role: member.platform_role === "owner" || member.organization_role === "owner" || member.app_role === "owner"
          ? "owner"
          : member.platform_role === "manager" || member.organization_role === "admin" || member.app_role === "manager" || member.app_role === "admin"
            ? "manager"
            : "staff",
        status: member.status === "active" ? "active" : "inactive",
        avatarUrl: member.avatar_url || undefined
      }))
    }});
  } catch (error) { next(error); }
});

router.post("/staff/invitations", requireOwner, async (request, response, next) => {
  try {
    const email = required(request.body?.email, "email", 320).toLowerCase();
    const requestedRole = text(request.body?.role, 40).toLowerCase();
    const fleetRole = requestedRole === "owner"
      ? "owner"
      : requestedRole === "manager"
        ? "manager"
        : "staff";
    const roleName = fleetRole === "owner" ? "owner" : fleetRole === "manager" ? "admin" : "user";
    const result = await teamsService.inviteTeamMemberForUser(
      actor(request),
      { email, roleName },
      { ipAddress: request.ip }
    );
    if (result.memberAdded && result.member?.id) {
      await query(
        `INSERT INTO app_memberships (
           user_id,app_id,role,status,organization_id,project_id,environment_id
         ) VALUES ($1,'goodfleet',$2,'active',$3,'proj_goodos_platform','env_goodos_production')
         ON CONFLICT (user_id,app_id) DO UPDATE SET
           role=EXCLUDED.role,status='active',organization_id=EXCLUDED.organization_id,
           project_id=EXCLUDED.project_id,environment_id=EXCLUDED.environment_id,updated_at=NOW()`,
        [result.member.id, fleetRole, organization(request)]
      );
    } else if (result.invitation?.id) {
      await query(
        `UPDATE backend_user_invites
         SET app_id='goodfleet',app_role=$2,organization_id=$3,
             project_id='proj_goodos_platform',environment_id='env_goodos_production',updated_at=NOW()
         WHERE id=$1`,
        [result.invitation.id, fleetRole, organization(request)]
      );
    }
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

router.patch("/staff/:userId", requireOwner, async (request, response, next) => {
  try {
    const requestedRole = text(request.body?.role, 40).toLowerCase();
    const fleetRole = requestedRole === "owner"
      ? "owner"
      : requestedRole === "manager"
        ? "manager"
        : "staff";
    const roleName = fleetRole === "owner" ? "owner" : fleetRole === "manager" ? "admin" : "user";
    const membershipStatus = request.body?.status === "inactive" ? "disabled" : "active";
    await teamsService.updateTeamMemberForUser(
      actor(request),
      request.params.userId,
      {
        roleName,
        status: request.body?.status === "inactive" ? "suspended" : "active"
      },
      { ipAddress: request.ip }
    );
    await query(
      `INSERT INTO app_memberships (
         user_id,app_id,role,status,organization_id,project_id,environment_id
       ) VALUES ($1,'goodfleet',$2,$3,$4,'proj_goodos_platform','env_goodos_production')
       ON CONFLICT (user_id,app_id) DO UPDATE SET
         role=EXCLUDED.role,status=EXCLUDED.status,organization_id=EXCLUDED.organization_id,
         project_id=EXCLUDED.project_id,environment_id=EXCLUDED.environment_id,updated_at=NOW()`,
      [request.params.userId, fleetRole, membershipStatus, organization(request)]
    );
    response.json({ success: true, data: { updated: true } });
  } catch (error) { next(error); }
});

router.delete("/staff/:userId", requireOwner, async (request, response, next) => {
  try {
    await teamsService.updateTeamMemberForUser(
      actor(request),
      request.params.userId,
      { roleName: "user", status: "removed" },
      { ipAddress: request.ip }
    );
    await query(
      `UPDATE app_memberships
       SET status='revoked',updated_at=NOW()
       WHERE user_id=$1 AND app_id='goodfleet' AND organization_id=$2`,
      [request.params.userId, organization(request)]
    );
    response.json({ success: true, data: { removed: true } });
  } catch (error) { next(error); }
});

router.get("/staff-onboarding", async (request, response, next) => {
  try {
    const progress = await query(
      `SELECT tour_version,completed_modules,last_module,started_at,dismissed_at,
              completed_at,updated_at
         FROM fleet_staff_onboarding_progress
        WHERE organization_id=$1 AND user_id=$2`,
      [organization(request), actor(request)]
    );
    const row = progress.rows[0];
    response.json({
      success: true,
      data: {
        role: normalizedFleetRole(request),
        tourVersion: row?.tour_version || 1,
        completedModules: row?.completed_modules || [],
        lastModule: row?.last_module || null,
        startedAt: row?.started_at || null,
        dismissedAt: row?.dismissed_at || null,
        completedAt: row?.completed_at || null,
        updatedAt: row?.updated_at || null
      }
    });
  } catch (error) { next(error); }
});

router.put("/staff-onboarding", async (request, response, next) => {
  try {
    const rawModules = request.body?.completedModules;
    if (!Array.isArray(rawModules)) {
      return fail(response, 400, "INVALID_ONBOARDING_PROGRESS", "Completed training modules must be an array.");
    }
    const completedModules = [...new Set(rawModules.map(value => text(value, 80)))];
    if (completedModules.some(moduleId => !ONBOARDING_MODULES.has(moduleId))) {
      return fail(response, 400, "INVALID_ONBOARDING_MODULE", "Training progress includes an unknown module.");
    }
    const lastModule = text(request.body?.lastModule, 80) || null;
    if (lastModule && !ONBOARDING_MODULES.has(lastModule)) {
      return fail(response, 400, "INVALID_ONBOARDING_MODULE", "The last training module is unknown.");
    }
    const tourVersion = Number(request.body?.tourVersion || 1);
    if (!Number.isInteger(tourVersion) || tourVersion < 1 || tourVersion > 100) {
      return fail(response, 400, "INVALID_ONBOARDING_VERSION", "A valid training version is required.");
    }
    const saved = await query(
      `INSERT INTO fleet_staff_onboarding_progress (
         organization_id,user_id,tour_version,completed_modules,last_module,
         role_at_start,dismissed_at,completed_at
       ) VALUES (
         $1,$2,$3,$4::text[],$5,$6,
         CASE WHEN $7 THEN NOW() ELSE NULL END,
         CASE WHEN $8 THEN NOW() ELSE NULL END
       )
       ON CONFLICT (organization_id,user_id) DO UPDATE SET
         tour_version=EXCLUDED.tour_version,
         completed_modules=EXCLUDED.completed_modules,
         last_module=EXCLUDED.last_module,
         role_at_start=EXCLUDED.role_at_start,
         dismissed_at=EXCLUDED.dismissed_at,
         completed_at=EXCLUDED.completed_at,
         updated_at=NOW()
       RETURNING tour_version,completed_modules,last_module,started_at,dismissed_at,
                 completed_at,updated_at`,
      [
        organization(request), actor(request), tourVersion, completedModules, lastModule,
        normalizedFleetRole(request), request.body?.dismissed === true,
        request.body?.completed === true
      ]
    );
    const row = saved.rows[0];
    response.json({
      success: true,
      data: {
        role: normalizedFleetRole(request),
        tourVersion: row.tour_version,
        completedModules: row.completed_modules,
        lastModule: row.last_module,
        startedAt: row.started_at,
        dismissedAt: row.dismissed_at,
        completedAt: row.completed_at,
        updatedAt: row.updated_at
      }
    });
  } catch (error) { next(error); }
});

router.get("/staff-onboarding/team", async (request, response, next) => {
  try {
    if (!["owner", "admin", "manager"].includes(goodFleetAccessRole(request))) {
      return fail(response, 403, "ONBOARDING_OVERVIEW_FORBIDDEN", "Management access is required to view team training progress.");
    }
    const result = await query(
      `SELECT account.id,account.email,account.display_name,account.first_name,
              account.last_name,app_membership.role,
              progress.tour_version,progress.completed_modules,progress.last_module,
              progress.started_at,progress.dismissed_at,progress.completed_at,
              progress.updated_at
         FROM app_memberships app_membership
         JOIN users account ON account.id=app_membership.user_id
         LEFT JOIN fleet_staff_onboarding_progress progress
           ON progress.organization_id=app_membership.organization_id
          AND progress.user_id=app_membership.user_id
        WHERE app_membership.organization_id=$1
          AND app_membership.app_id='goodfleet'
          AND app_membership.status='active'
        ORDER BY account.display_name,account.email`,
      [organization(request)]
    );
    response.json({
      success: true,
      data: result.rows.map(member => ({
        userId: member.id,
        name: member.display_name ||
          [member.first_name, member.last_name].filter(Boolean).join(" ") ||
          member.email,
        email: member.email,
        role: member.role === "owner"
          ? "owner"
          : member.role === "manager" || member.role === "admin"
            ? "manager"
            : member.role === "mechanic" ? "mechanic" : "staff",
        tourVersion: member.tour_version || 1,
        completedModules: member.completed_modules || [],
        lastModule: member.last_module || null,
        startedAt: member.started_at || null,
        dismissedAt: member.dismissed_at || null,
        completedAt: member.completed_at || null,
        updatedAt: member.updated_at || null
      }))
    });
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
    const previousState = current.rows[0]?.state_json || {};
    const currentVersion = current.rows[0]?.version || 0;
    if (requestedVersion !== currentVersion) {
      await client.query("ROLLBACK");
      return fail(response, 409, "WORKSPACE_VERSION_CONFLICT", "Workspace changed in another session.", {
        currentVersion
      });
    }
    const permittedWorkspaceKeys = allowedWorkspaceKeys(request);
    for (const key of [...WORKSPACE_ARRAY_KEYS, ...WORKSPACE_OBJECT_KEYS]) {
      if (!permittedWorkspaceKeys.has(key)) {
        if (Object.prototype.hasOwnProperty.call(previousState, key)) {
          state[key] = previousState[key];
        } else {
          delete state[key];
        }
      }
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
    const changedSections = await auditWorkspaceChanges(
      client,
      request,
      previousState,
      result.state_json
    );
    await audit(client, request, "workspace.updated", "workspace", org, null, {
      version: result.version,
      changedSections,
      details: "GoodFleet operational workspace saved"
    });
    await client.query("COMMIT");
    const auditEvents = await client.query(
      `SELECT * FROM fleet_audit_events
       WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200`,
      [org]
    );
    response.json({ success: true, data: {
      state: result.state_json,
      version: result.version,
      updatedAt: result.updated_at,
      auditLogs: auditEvents.rows.map(auditPayload)
    }});
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally { client.release(); }
});

router.delete("/branches/:branchId", requireFleetEditor, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const org = organization(request);
    const branchId = required(request.params.branchId, "branchId", 200);
    const requestedVersion = Number(request.body?.version);
    if (!Number.isInteger(requestedVersion) || requestedVersion < 0) {
      return fail(response, 400, "INVALID_WORKSPACE_VERSION", "A valid workspace version is required.");
    }

    await client.query("BEGIN");
    const current = await client.query(
      `SELECT state_json,version FROM fleet_workspace_state WHERE organization_id=$1 FOR UPDATE`,
      [org]
    );
    const previousState = current.rows[0]?.state_json || {};
    const currentVersion = current.rows[0]?.version || 0;
    if (requestedVersion !== currentVersion) {
      await client.query("ROLLBACK");
      return fail(response, 409, "WORKSPACE_VERSION_CONFLICT", "Workspace changed in another session.", {
        currentVersion
      });
    }

    const branches = Array.isArray(previousState.branches) ? previousState.branches : [];
    const branch = branches.find(item => text(item?.id, 200) === branchId);
    if (!branch) {
      await client.query("ROLLBACK");
      return fail(response, 404, "BRANCH_NOT_FOUND", "The selected branch no longer exists.");
    }
    if (branches.length <= 1) {
      await client.query("ROLLBACK");
      return fail(response, 409, "LAST_BRANCH_REQUIRED", "GoodFleet must retain at least one operating branch.");
    }

    const [vehicleReferences, bookingReferences] = await Promise.all([
      client.query(
        `SELECT COUNT(*)::int AS count
         FROM fleet_vehicles
         WHERE organization_id=$1 AND archived_at IS NULL AND assigned_branch_id=$2`,
        [org, branchId]
      ),
      client.query(
        `SELECT COUNT(*)::int AS count
         FROM fleet_bookings
         WHERE organization_id=$1 AND archived_at IS NULL
           AND (pickup_branch_id=$2 OR return_branch_id=$2)`,
        [org, branchId]
      )
    ]);
    const pricingReferences = ["rates", "seasonalAdjustments", "discounts", "fees"]
      .reduce((count, key) => count + (
        Array.isArray(previousState[key])
          ? previousState[key].filter(item => text(item?.branchId, 200) === branchId).length
          : 0
      ), 0);
    const blockers = {
      vehicles: vehicleReferences.rows[0]?.count || 0,
      bookings: bookingReferences.rows[0]?.count || 0,
      pricingRules: pricingReferences
    };
    if (blockers.vehicles || blockers.bookings || blockers.pricingRules) {
      await client.query("ROLLBACK");
      return fail(
        response,
        409,
        "BRANCH_IN_USE",
        "Reassign vehicles, reservations, and pricing rules before removing this branch.",
        blockers
      );
    }

    const nextState = {
      ...previousState,
      branches: branches.filter(item => text(item?.id, 200) !== branchId)
    };
    const saved = await client.query(
      `UPDATE fleet_workspace_state
       SET state_json=$2::jsonb,version=version+1,updated_by=$3,updated_at=NOW()
       WHERE organization_id=$1 RETURNING state_json,version,updated_at`,
      [org, JSON.stringify(nextState), actor(request)]
    );
    const result = saved.rows[0];
    const changedSections = await auditWorkspaceChanges(
      client,
      request,
      previousState,
      result.state_json
    );
    await audit(client, request, "workspace.updated", "workspace", org, null, {
      version: result.version,
      changedSections,
      details: `GoodFleet branch ${workspaceItemLabel(branch, branchId)} removed`
    });
    await client.query("COMMIT");

    const auditEvents = await client.query(
      `SELECT * FROM fleet_audit_events
       WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200`,
      [org]
    );
    return response.json({ success: true, data: {
      state: result.state_json,
      version: result.version,
      updatedAt: result.updated_at,
      auditLogs: auditEvents.rows.map(auditPayload)
    }});
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/vehicles", requireFleetEditor, async (request, response, next) => {
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

router.post("/customers", requireBookingEditor, async (request, response, next) => {
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
        text(body.licenseNumber, 100) || null, text(body.licenseExpiry, 20) || null,
        "pending", JSON.stringify({
          ...body,
          licenseVerificationStatus: "pending",
          licenseVerifiedAt: null,
          licenseVerifiedBy: null,
          licenseVerificationMethod: null
        }), actor(request)]
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

router.post("/bookings", requireBookingEditor, async (request, response, next) => {
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
    if (customer.status !== "active") {
      await client.query("ROLLBACK");
      return fail(response, 409, "CUSTOMER_NOT_ELIGIBLE", "Customer account must be active to create a reservation.");
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

    const price = await calculateBookingPrice(client, org, body, pickupAt, returnAt);
    const storedPayload = cleanPayload({
      ...body,
      totalAmount: price.total,
      pricing: price
    });
    const reservation = text(body.reservationNumber, 80) || `GF-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const result = await client.query(
      `INSERT INTO fleet_bookings
       (organization_id,reservation_number,customer_id,vehicle_id,pickup_at,return_at,pickup_branch_id,return_branch_id,status,payment_status,total_amount,deposit_amount,paid_amount,payload,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_payment','unpaid',$9,$10,$11,$12::jsonb,$13,$13) RETURNING *`,
      [org, reservation, body.customerId, body.carId || null, pickupAt, returnAt,
        required(body.pickupLocationId, "pickupLocationId", 200),
        required(body.returnLocationId, "returnLocationId", 200),
        money(price.total, "totalAmount"), money(body.depositAmount || 0, "depositAmount"),
        "0.00", JSON.stringify(storedPayload), actor(request)]
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

router.patch("/vehicles/:vehicleId", requireFleetEditor, async (request, response, next) => {
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
    await maybeNotifyOilService(org, actor(request), vehicle).catch(error => {
      console.error("GoodFleet oil-change notification failed", {
        organizationId: org,
        vehicleId: vehicle.id,
        message: error.message
      });
    });
    response.json({ success: true, data: vehicle });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return fail(response, 409, "VEHICLE_ALREADY_EXISTS", "VIN or license plate already exists.");
    next(error);
  } finally { client.release(); }
});

router.delete("/vehicles/:vehicleId", requireFleetEditor, async (request, response, next) => {
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

router.patch("/customers/:customerId", requireBookingEditor, async (request, response, next) => {
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
    const licenseNumber = text(merged.licenseNumber, 100) || null;
    const licenseExpiry = text(merged.licenseExpiry, 20) || null;
    const licenseChanged = licenseNumber !== (existing.rows[0].license_number || null) ||
      licenseExpiry !== dateOnly(existing.rows[0].license_expiry);
    const verificationStatus = licenseChanged
      ? "pending"
      : existing.rows[0].license_verification_status;
    const verifiedAt = licenseChanged ? null : existing.rows[0].license_verified_at;
    const verifiedBy = licenseChanged ? null : existing.rows[0].license_verified_by;
    const verificationMethod = licenseChanged ? null : existing.rows[0].license_verification_method;
    const storedPayload = {
      ...merged,
      licenseNumber,
      licenseExpiry,
      licenseVerificationStatus: verificationStatus,
      licenseVerifiedAt: verifiedAt,
      licenseVerifiedBy: verifiedBy,
      licenseVerificationMethod: verificationMethod
    };
    const result = await client.query(
      `UPDATE fleet_customers SET
        full_name=$3,email=lower($4),phone=$5,status=$6,license_number=$7,
        license_expiry=$8,license_verification_status=$9,license_verified_at=$10,
        license_verified_by=$11,license_verification_method=$12,payload=$13::jsonb,
        version=version+1,updated_by=$14,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [org, request.params.customerId, required(merged.name, "name", 200),
        required(merged.email, "email", 320), text(merged.phone, 50) || null,
        enumValue(merged.status || "active", CUSTOMER_STATUSES, "status"),
        licenseNumber, licenseExpiry, verificationStatus, verifiedAt, verifiedBy,
        verificationMethod, JSON.stringify(storedPayload), actor(request)]
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

router.post("/customers/:customerId/license-verification", requireLicenseVerifier, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const org = organization(request);
    const body = request.body || {};
    const licenseNumber = required(body.licenseNumber, "licenseNumber", 100);
    const licenseExpiry = required(body.licenseExpiry, "licenseExpiry", 20);
    const expiry = new Date(`${licenseExpiry.slice(0, 10)}T23:59:59.999Z`);
    if (Number.isNaN(expiry.getTime()) || expiry < new Date()) {
      return fail(response, 400, "LICENSE_EXPIRED", "A current driver license is required for vehicle checkout.");
    }
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
    if (existing.rows[0].status !== "active") {
      await client.query("ROLLBACK");
      return fail(response, 409, "CUSTOMER_NOT_ELIGIBLE", "Only an active customer can be cleared for checkout.");
    }
    const before = customerPayload(existing.rows[0]);
    const verifiedAt = new Date().toISOString();
    const storedPayload = cleanPayload({
      ...before,
      licenseNumber,
      licenseExpiry: licenseExpiry.slice(0, 10),
      licenseVerificationStatus: "verified",
      licenseVerifiedAt: verifiedAt,
      licenseVerifiedBy: actor(request),
      licenseVerificationMethod: "in_person"
    });
    const result = await client.query(
      `UPDATE fleet_customers SET
        license_number=$3,license_expiry=$4,license_verification_status='verified',
        license_verified_at=$5,license_verified_by=$6,license_verification_method='in_person',
        payload=$7::jsonb,version=version+1,updated_by=$6,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [org, request.params.customerId, licenseNumber, licenseExpiry.slice(0, 10),
        verifiedAt, actor(request), JSON.stringify(storedPayload)]
    );
    const customer = customerPayload(result.rows[0]);
    await audit(client, request, "customer.license_verified", "customer", customer.id, before, {
      ...customer,
      details: "Government-issued driver license verified in person for vehicle checkout"
    });
    await client.query("COMMIT");
    response.json({ success: true, data: customer });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return fail(response, 409, "CUSTOMER_ALREADY_EXISTS", "Driver license already belongs to another customer.");
    next(error);
  } finally { client.release(); }
});

router.post("/bookings/quote", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const body = request.body || {};
    const org = organization(request);
    const pickupAt = timestamp(body.startDate, body.pickupTime, "pickupAt");
    const returnAt = timestamp(body.endDate, body.dropoffTime, "returnAt");
    if (new Date(returnAt) <= new Date(pickupAt)) {
      return fail(response, 400, "INVALID_RENTAL_PERIOD", "Return must be after pickup.");
    }
    const price = await calculateBookingPrice(client, org, body, pickupAt, returnAt);
    const assignedVehicleId = text(body.carId, 80);
    let available = true;
    if (assignedVehicleId) {
      const conflict = await client.query(
        `SELECT id,reservation_number FROM fleet_bookings
          WHERE organization_id=$1 AND vehicle_id=$2 AND archived_at IS NULL
            AND id::text<>COALESCE(NULLIF($5,''),'00000000-0000-0000-0000-000000000000')
            AND status=ANY($6::text[])
            AND tsrange(
              (pickup_at AT TIME ZONE 'UTC') - interval '2 hours',
              (return_at AT TIME ZONE 'UTC') + interval '2 hours',
              '[)'
            ) && tsrange(
              ($3::timestamptz AT TIME ZONE 'UTC') - interval '2 hours',
              ($4::timestamptz AT TIME ZONE 'UTC') + interval '2 hours',
              '[)'
            )
          LIMIT 1`,
        [org, assignedVehicleId, pickupAt, returnAt, text(body.bookingId, 80), ACTIVE_BOOKING_STATUSES]
      );
      available = !conflict.rowCount;
    }
    response.json({
      success: true,
      data: {
        ...price,
        available,
        currency: "USD"
      }
    });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.post("/bookings/:bookingId/extensions", requireBookingEditor, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const org = organization(request);
    const days = Number(request.body?.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      return fail(response, 400, "INVALID_EXTENSION", "Extension days must be between 1 and 90.");
    }
    const key = text(request.get("Idempotency-Key"), 255);
    if (!key) {
      return fail(response, 400, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key header is required.");
    }
    await client.query("BEGIN");
    const duplicate = await client.query(
      `SELECT booking.* FROM fleet_payment_operations operation
        JOIN fleet_bookings booking
          ON booking.organization_id=operation.organization_id
         AND booking.id=operation.booking_id
       WHERE operation.organization_id=$1 AND operation.idempotency_key=$2`,
      [org, key]
    );
    if (duplicate.rowCount) {
      await client.query("COMMIT");
      return response.json({ success: true, data: bookingPayload(duplicate.rows[0]) });
    }
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
    if (!["confirmed", "assigned", "checked_in", "checked_out", "extended", "overdue"].includes(before.status)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "BOOKING_CANNOT_BE_EXTENDED", "Only active confirmed rentals can be extended.");
    }
    const nextReturn = new Date(existing.rows[0].return_at);
    nextReturn.setUTCDate(nextReturn.getUTCDate() + days);
    const merged = cleanPayload({
      ...before,
      endDate: nextReturn.toISOString().slice(0, 10),
      dropoffTime: nextReturn.toISOString().slice(11, 16)
    });
    if (merged.carId) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${org}:${merged.carId}`]);
    }
    const price = await calculateBookingPrice(
      client,
      org,
      merged,
      existing.rows[0].pickup_at,
      nextReturn.toISOString()
    );
    const additionalAmount = Math.max(0, price.total - Number(existing.rows[0].total_amount));
    const paymentStatus = Number(existing.rows[0].paid_amount) <= 0 ? "unpaid" : "partial";
    const storedPayload = cleanPayload({
      ...merged,
      totalAmount: price.total,
      paymentStatus,
      pricing: price,
      lastExtension: {
        days,
        additionalAmount: Number(additionalAmount.toFixed(2)),
        requestedAt: new Date().toISOString(),
        requestedBy: actor(request)
      }
    });
    const updated = await client.query(
      `UPDATE fleet_bookings
          SET return_at=$3,status='extended',payment_status=$4,total_amount=$5,
              payload=$6::jsonb,version=version+1,updated_by=$7,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [org, request.params.bookingId, nextReturn.toISOString(), paymentStatus,
        price.total.toFixed(2), JSON.stringify(storedPayload), actor(request)]
    );
    if (additionalAmount > 0) {
      await client.query(
        `INSERT INTO fleet_payment_operations
          (organization_id,booking_id,customer_id,operation_type,provider,idempotency_key,
           amount,currency,status,request_json,created_by)
         VALUES ($1,$2,$3,'invoice','internal',$4,$5,'USD','pending',$6::jsonb,$7)`,
        [org, request.params.bookingId, existing.rows[0].customer_id, key,
          additionalAmount.toFixed(2), JSON.stringify({
            method: "Credit Card",
            description: `${days}-day rental extension`,
            type: "rental"
          }), actor(request)]
      );
    }
    const booking = bookingPayload(updated.rows[0]);
    await audit(client, request, "booking.extended", "booking", booking.id, before, booking);
    await client.query("COMMIT");
    response.json({ success: true, data: booking });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23P01") return fail(response, 409, "VEHICLE_NOT_AVAILABLE", "This vehicle is already committed during the requested extension.");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/bookings/:bookingId/reopen", requireBookingEditor, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const org = organization(request);
    if (request.body?.confirmed !== true) {
      return fail(response, 400, "BOOKING_REOPEN_CONFIRMATION_REQUIRED", "Confirm that this completed reservation should be reopened.");
    }
    const accessRole = goodFleetAccessRole(request);
    if (!EMPLOYEE_ROLES.has(accessRole)) {
      return fail(response, 403, "EMPLOYEE_ACCESS_REQUIRED", "Only a GoodFleet team member can reopen a completed reservation.");
    }
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM fleet_bookings
        WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL
        FOR UPDATE`,
      [org, request.params.bookingId]
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "BOOKING_NOT_FOUND", "Reservation not found.");
    }
    const before = bookingPayload(existing.rows[0]);
    if (before.status === "needs_attention") {
      await client.query("COMMIT");
      return response.json({ success: true, data: before });
    }
    if (before.status !== "completed") {
      await client.query("ROLLBACK");
      return fail(response, 409, "BOOKING_REOPEN_NOT_AVAILABLE", "Only a completed reservation can be reopened for follow-up.");
    }
    const reopenedAt = new Date().toISOString();
    const storedPayload = cleanPayload({
      ...before,
      status: "needs_attention",
      returnInspectionStatus: "required",
      returnInspectionCompletedAt: null,
      reopenedAt,
      reopenedBy: actor(request),
      reopenCount: Math.max(0, Number(before.reopenCount) || 0) + 1,
    });
    delete storedPayload.returnPhotoOverride;
    const updated = await client.query(
      `UPDATE fleet_bookings
          SET status='needs_attention',payload=$3::jsonb,version=version+1,
              updated_by=$4,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
        RETURNING *`,
      [org, request.params.bookingId, JSON.stringify(storedPayload), actor(request)]
    );
    if (before.carId) {
      const vehicleBefore = await client.query(
        `SELECT * FROM fleet_vehicles
          WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL
          FOR UPDATE`,
        [org, before.carId]
      );
      if (vehicleBefore.rowCount) {
        const vehiclePayloadBefore = vehiclePayload(vehicleBefore.rows[0]);
        const nextVehiclePayload = cleanPayload({
          ...vehiclePayloadBefore,
          isInspected: false,
          returnInspectionBookingId: before.id,
          returnInspectionRequiredAt: reopenedAt,
        });
        await client.query(
          `UPDATE fleet_vehicles
              SET status='inspection',payload=$3::jsonb,version=version+1,
                  updated_by=$4,updated_at=NOW()
            WHERE organization_id=$1 AND id=$2`,
          [org, before.carId, JSON.stringify(nextVehiclePayload), actor(request)]
        );
        await audit(
          client,
          request,
          "vehicle.follow_up_required",
          "vehicle",
          before.carId,
          vehiclePayloadBefore,
          {
            ...nextVehiclePayload,
            status: "inspection",
            bookingId: before.id,
            details: `Vehicle held for follow-up after reopening ${before.reservationNumber}`
          }
        );
      }
    }
    const booking = bookingPayload(updated.rows[0]);
    await audit(
      client,
      request,
      "booking.reopened",
      "booking",
      booking.id,
      before,
      {
        ...booking,
        details: `Completed reservation ${booking.reservationNumber} reopened for team follow-up`,
        reopenedByRole: accessRole,
      }
    );
    await client.query("COMMIT");
    return response.json({ success: true, data: booking });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/bookings/:bookingId/return-link", requireBookingEditor, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const org = organization(request);
    const clientRequestId = text(
      request.body?.clientRequestId || request.get("Idempotency-Key"),
      200
    );
    if (!clientRequestId) {
      return fail(response, 400, "IDEMPOTENCY_KEY_REQUIRED", "A client request ID is required.");
    }
    await client.query("BEGIN");
    const existingNotification = await client.query(
      `SELECT notification.id,delivery.status,delivery.error_code
         FROM fleet_customer_notifications notification
         LEFT JOIN fleet_customer_notification_deliveries delivery
           ON delivery.notification_id=notification.id AND delivery.channel='sms'
        WHERE notification.organization_id=$1
          AND notification.created_by=$2
          AND notification.client_request_id=$3
        LIMIT 1`,
      [org, actor(request), clientRequestId]
    );
    if (existingNotification.rowCount) {
      await client.query("COMMIT");
      const existing = existingNotification.rows[0];
      return response.json({
        success: true,
        data: {
          notificationId: existing.id,
          sms: existing.status === "pending"
            ? "queued"
            : existing.status === "delivered"
              ? "delivered"
              : "provider_unavailable",
        }
      });
    }
    const result = await client.query(
      `SELECT booking.id,booking.reservation_number,booking.status,
              customer.id AS customer_id,customer.full_name,customer.email,customer.phone,
              users.id AS recipient_user_id
         FROM fleet_bookings booking
         JOIN fleet_customers customer
           ON customer.organization_id=booking.organization_id
          AND customer.id=booking.customer_id
         LEFT JOIN users
           ON lower(users.email)=lower(customer.email) AND users.status='active'
        WHERE booking.organization_id=$1
          AND booking.id=$2
          AND booking.archived_at IS NULL
        LIMIT 1`,
      [org, request.params.bookingId]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "BOOKING_NOT_FOUND", "Reservation not found.");
    }
    const booking = result.rows[0];
    if (!["checked_out", "extended", "overdue", "needs_attention"].includes(booking.status)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "RETURN_LINK_NOT_AVAILABLE", "The secure return link is available after the vehicle is checked out.");
    }
    const phone = normalizePhone(booking.phone);
    if (!phone) {
      await client.query("ROLLBACK");
      return fail(response, 409, "CUSTOMER_PHONE_REQUIRED", "Add a valid customer mobile number before sending the secure return link.");
    }
    const providerResult = await client.query(
      `SELECT id,organization_id,project_id,environment_id
         FROM goodbase_consumer_auth_providers
        WHERE organization_id=$1
          AND provider_type IN ('phone_otp','sms_mfa')
          AND status='enabled'
          AND controller_url IS NOT NULL
          AND secret_ref IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
      [org]
    );
    const provider = providerResult.rows[0] || null;
    const actionUrl = `/account/return?booking=${encodeURIComponent(booking.id)}`;
    const secureUrl = `${PUBLIC_APP_URL}${actionUrl}`;
    const title = `Return photos needed: ${booking.reservation_number}`;
    const body = "Complete the guided seven-photo vehicle return from your secure GoodFleet account.";
    const smsBody = `GoodFleet ${booking.reservation_number}: complete your guided vehicle return here: ${secureUrl} Sign in to your account. Do not forward this link.`;
    const inserted = await client.query(
      `INSERT INTO fleet_customer_notifications (
         organization_id,customer_id,recipient_user_id,recipient_email,recipient_phone,title,body,
         category,channels,status,action_url,client_request_id,created_by
       )
       VALUES ($1,$2,$3,lower($4),$5,$6,$7,'trip',ARRAY['in_app','sms']::text[],
               'partially_delivered',$8,$9,$10)
       RETURNING id`,
      [
        org,
        booking.customer_id,
        booking.recipient_user_id || null,
        booking.email,
        phone,
        title,
        body,
        actionUrl,
        clientRequestId,
        actor(request),
      ]
    );
    const notificationId = inserted.rows[0].id;
    await client.query(
      `INSERT INTO fleet_customer_notification_deliveries
        (notification_id,channel,status,attempted_at,delivered_at,error_code)
       VALUES
         ($1,'in_app','delivered',NOW(),NOW(),NULL),
         ($1,'sms',$2,NULL,NULL,$3)`,
      [
        notificationId,
        provider ? "pending" : "failed",
        provider ? null : "SMS_PROVIDER_UNAVAILABLE",
      ]
    );
    if (provider) {
      await client.query(
        `INSERT INTO goodbase_sms_deliveries (
           organization_id,project_id,environment_id,user_id,destination_hash,
           encrypted_payload,provider_id,purpose,expires_at,fleet_notification_id
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,'fleet_return',NOW()+INTERVAL '7 days',$8)`,
        [
          provider.organization_id,
          provider.project_id,
          provider.environment_id,
          booking.recipient_user_id || null,
          sha256(phone),
          encryptValue(JSON.stringify({
            phone,
            message: smsBody,
            actionUrl: secureUrl,
            notificationId,
          })),
          provider.id,
          notificationId,
        ]
      );
    }
    await audit(
      client,
      request,
      "booking.return_link_sent",
      "booking",
      booking.id,
      null,
      {
        details: `Secure return link ${provider ? "queued by SMS" : "saved with SMS provider unavailable"} for ${booking.reservation_number}.`,
        notificationId,
        phoneLast4: phone.slice(-4),
        smsStatus: provider ? "queued" : "provider_unavailable",
      }
    );
    await client.query("COMMIT");
    response.status(202).json({
      success: true,
      data: {
        notificationId,
        sms: provider ? "queued" : "provider_unavailable",
        phoneLast4: phone.slice(-4),
      }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.patch("/bookings/:bookingId", requireBookingEditor, async (request, response, next) => {
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
    const tripFields = new Set([
      "customerId", "carId", "requestedCarId", "startDate", "endDate",
      "pickupTime", "dropoffTime", "pickupLocationId", "returnLocationId",
      "insuranceSelection", "discountCode", "promoCode"
    ]);
    const changesTrip = Object.keys(request.body || {}).some(key => tripFields.has(key));
    if (changesTrip && ["completed", "cancelled", "refunded"].includes(before.status)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "BOOKING_NOT_EDITABLE", "Completed, cancelled, and refunded reservations cannot have trip details changed.");
    }
    const merged = cleanPayload({ ...before, ...(request.body || {}) });
    if (before.status === "completed" && merged.status !== "completed") {
      await client.query("ROLLBACK");
      return fail(
        response,
        409,
        "BOOKING_REOPEN_ENDPOINT_REQUIRED",
        "Use the controlled reopen action to move a completed reservation back into follow-up."
      );
    }
    const returnCompleted = before.status !== "completed" && merged.status === "completed";
    let returnPhotoOverride = null;
    if (Object.prototype.hasOwnProperty.call(request.body || {}, "returnPhotoOverride")) {
      if (!returnCompleted) {
        await client.query("ROLLBACK");
        return fail(response, 409, "RETURN_OVERRIDE_NOT_APPLICABLE", "The management return override can only be used while completing an active return.");
      }
      const accessRole = goodFleetAccessRole(request);
      if (!MANAGEMENT_RETURN_OVERRIDE_ROLES.has(accessRole)) {
        await client.query("ROLLBACK");
        return fail(response, 403, "MANAGEMENT_RETURN_OVERRIDE_REQUIRED", "Only an owner, administrator, or manager can bypass customer return photos.");
      }
      const overrideInput = request.body?.returnPhotoOverride;
      const reason = text(overrideInput?.reason, 1000);
      if (
        overrideInput?.confirmed !== true ||
        overrideInput?.physicalInspectionConfirmed !== true ||
        (!GOODFLEET_TESTING_MODE && reason.length < 10)
      ) {
        await client.query("ROLLBACK");
        return fail(
          response,
          400,
          "RETURN_OVERRIDE_CONFIRMATION_REQUIRED",
          GOODFLEET_TESTING_MODE
            ? "Confirm the physical inspection."
            : "Confirm the physical inspection and enter a reason of at least 10 characters."
        );
      }
      returnPhotoOverride = {
        confirmed: true,
        physicalInspectionConfirmed: true,
        reason: reason || "Testing mode override — explanation requirement disabled.",
        usedAt: new Date().toISOString(),
        usedBy: actor(request),
        usedByRole: accessRole,
      };
      merged.returnPhotoOverride = returnPhotoOverride;
    }
    if (returnCompleted) {
      merged.returnInspectionStatus = "required";
      merged.returnInspectionRequiredAt = new Date().toISOString();
    }
    const pickupAt = timestamp(merged.startDate, merged.pickupTime, "pickupAt");
    const returnAt = timestamp(merged.endDate, merged.dropoffTime, "returnAt");
    if (new Date(returnAt) <= new Date(pickupAt)) {
      await client.query("ROLLBACK");
      return fail(response, 400, "INVALID_RENTAL_PERIOD", "Return must be after pickup.");
    }
    const customerRecord = await client.query(
      `SELECT status FROM fleet_customers
        WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR SHARE`,
      [org, merged.customerId]
    );
    if (!customerRecord.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }
    if (customerRecord.rows[0].status !== "active") {
      await client.query("ROLLBACK");
      return fail(response, 409, "CUSTOMER_NOT_ELIGIBLE", "Customer account must be active.");
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
      if (before.status !== "checked_out") {
        const departureCondition = await client.query(
          `SELECT report.id
             FROM fleet_condition_reports report
            WHERE report.organization_id=$1
              AND report.booking_id=$2
              AND report.phase='departure'
              AND report.status='submitted'
              AND report.captured_by_type='employee'
              AND COALESCE((report.acknowledgement_json->>'confirmed')::boolean,false)=true
              AND (
                SELECT COUNT(DISTINCT photo.slot) FILTER (
                  WHERE photo.slot=ANY(ARRAY[
                    'front','rear','driver_side','passenger_side','dashboard',
                    'front_interior','rear_interior'
                  ]::text[])
                )
                  FROM fleet_condition_photos photo
                 WHERE photo.organization_id=report.organization_id
                   AND photo.report_id=report.id
              )=7
            LIMIT 1`,
          [org, request.params.bookingId]
        );
        if (!departureCondition.rowCount) {
          await client.query("ROLLBACK");
          return fail(
            response,
            409,
            "DEPARTURE_WALKAROUND_REQUIRED",
            "Complete the joint vehicle walkaround, required departure photos, and customer acknowledgement before vehicle release."
          );
        }
      }
    }
    if (merged.status === "completed" && before.status !== "completed") {
      const returnCondition = await client.query(
        `SELECT report.id
           FROM fleet_condition_reports report
          WHERE report.organization_id=$1
            AND report.booking_id=$2
            AND report.phase='return'
            AND report.status='submitted'
            AND report.captured_by_type='customer'
            AND COALESCE((report.acknowledgement_json->>'confirmed')::boolean,false)=true
            AND (
              SELECT COUNT(DISTINCT photo.slot) FILTER (
                WHERE photo.slot=ANY(ARRAY[
                  'front','rear','driver_side','passenger_side','dashboard',
                  'front_interior','rear_interior'
                ]::text[])
              )
                FROM fleet_condition_photos photo
               WHERE photo.organization_id=report.organization_id
                 AND photo.report_id=report.id
            )=7
          LIMIT 1`,
        [org, request.params.bookingId]
      );
      if (!returnCondition.rowCount && !returnPhotoOverride) {
        await client.query("ROLLBACK");
        return fail(
          response,
          409,
          "RETURN_WALKAROUND_REQUIRED",
          "Complete the guided return photos and condition acknowledgement before finishing vehicle check-in."
        );
      }
      if (returnCondition.rowCount && returnPhotoOverride) {
        delete merged.returnPhotoOverride;
        returnPhotoOverride = null;
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
    const price = await calculateBookingPrice(client, org, merged, pickupAt, returnAt);
    const paidAmount = Number(before.paidAmount);
    const paymentStatus = before.paymentStatus === "disputed"
      ? "disputed"
      : before.paymentStatus === "refunded"
        ? "refunded"
        : paidAmount <= 0
          ? "unpaid"
          : paidAmount + 0.005 >= price.total ? "paid" : "partial";
    const storedPayload = cleanPayload({
      ...merged,
      totalAmount: price.total,
      paidAmount,
      paymentStatus,
      pricing: price
    });
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
        enumValue(paymentStatus, PAYMENT_STATUSES, "paymentStatus"),
        money(price.total, "totalAmount"),
        money(merged.depositAmount || 0, "depositAmount"),
        money(paidAmount, "paidAmount"), JSON.stringify(storedPayload), actor(request)]
    );
    const booking = bookingPayload(result.rows[0]);
    if (returnPhotoOverride) {
      await audit(
        client,
        request,
        "booking.return_photo_override",
        "booking",
        booking.id,
        null,
        {
          details: `Management completed ${booking.reservationNumber} after a physical inspection without customer return photos.`,
          reason: returnPhotoOverride.reason,
          physicalInspectionConfirmed: true,
          usedByRole: returnPhotoOverride.usedByRole,
        }
      );
    }
    if (booking.status === "checked_out" && booking.carId && before.status !== "checked_out") {
      const vehicleBefore = await client.query(
        `SELECT * FROM fleet_vehicles
         WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`,
        [org, booking.carId]
      );
      if (vehicleBefore.rowCount) {
        await client.query(
          `UPDATE fleet_vehicles
           SET status='checked_out',version=version+1,updated_by=$3,updated_at=NOW()
           WHERE organization_id=$1 AND id=$2`,
          [org, booking.carId, actor(request)]
        );
        await audit(client, request, "vehicle.checked_out", "vehicle", booking.carId,
          vehiclePayload(vehicleBefore.rows[0]), {
            id: booking.carId,
            status: "checked_out",
            bookingId: booking.id,
            details: `Vehicle released for reservation ${booking.reservationNumber}`
          });
      }
    }
    if (
      ["completed", "cancelled"].includes(booking.status) &&
      booking.carId &&
      !["completed", "cancelled"].includes(before.status)
    ) {
      const nextVehicleStatus = booking.status === "completed" &&
        storedPayload.checkinCleanliness &&
        storedPayload.checkinCleanliness !== "clean"
        ? "cleaning"
        : "available";
      const vehicleBefore = await client.query(
        `SELECT * FROM fleet_vehicles
          WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`,
        [org, booking.carId]
      );
      if (vehicleBefore.rowCount) {
        await client.query(
          `UPDATE fleet_vehicles
              SET status=$3,
                  payload=payload || $4::jsonb,
                  version=version+1,updated_by=$5,updated_at=NOW()
            WHERE organization_id=$1 AND id=$2`,
          [org, booking.carId, nextVehicleStatus, JSON.stringify({
            mileage: storedPayload.checkinMileage,
            fuelLevel: storedPayload.checkinFuelLevel
          }), actor(request)]
        );
        await audit(client, request, "vehicle.returned", "vehicle", booking.carId,
          vehiclePayload(vehicleBefore.rows[0]), {
            id: booking.carId,
            status: nextVehicleStatus,
            bookingId: booking.id,
            details: `Vehicle returned for reservation ${booking.reservationNumber}`
          });
      }
    }
    await audit(client, request, "booking.updated", "booking", booking.id, before, booking);
    let returnedVehicle = null;
    if (returnCompleted && booking.carId) {
      const currentVehicle = await client.query(
        `SELECT *
         FROM fleet_vehicles
         WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL
         FOR UPDATE`,
        [org, booking.carId]
      );
      if (currentVehicle.rowCount) {
        const beforeVehicle = vehiclePayload(currentVehicle.rows[0]);
        const storedMileage = Number(beforeVehicle.mileage);
        const reportedMileage = Number(booking.checkinMileage);
        const returnMileage = Number.isFinite(reportedMileage)
          ? reportedMileage
          : Number.isFinite(storedMileage) ? storedMileage : 0;
        if (Number.isFinite(storedMileage) && returnMileage < storedMileage) {
          await client.query("ROLLBACK");
          return fail(
            response,
            400,
            "INVALID_RETURN_MILEAGE",
            "Return mileage cannot be lower than the vehicle's current mileage."
          );
        }
        const vehicleState = {
          ...cleanPayload(beforeVehicle),
          mileage: returnMileage,
          fuelLevel: Number.isFinite(Number(booking.checkinFuelLevel))
            ? Number(booking.checkinFuelLevel)
            : beforeVehicle.fuelLevel,
          isInspected: false,
          returnInspectionBookingId: booking.id,
          returnInspectionRequiredAt: merged.returnInspectionRequiredAt
        };
        const updatedVehicle = await client.query(
          `UPDATE fleet_vehicles
           SET status='inspection',payload=$3::jsonb,version=version+1,
               updated_by=$4,updated_at=NOW()
           WHERE organization_id=$1 AND id=$2
           RETURNING *`,
          [org, booking.carId, JSON.stringify(vehicleState), actor(request)]
        );
        returnedVehicle = vehiclePayload(updatedVehicle.rows[0]);
        await audit(
          client,
          request,
          "vehicle.return_inspection_required",
          "vehicle",
          returnedVehicle.id,
          beforeVehicle,
          {
            ...returnedVehicle,
            bookingId: booking.id,
            details: `Return inspection required for ${booking.reservationNumber}`
          }
        );
      }
    }
    await client.query("COMMIT");
    if (returnedVehicle) {
      await Promise.all([
        notifyFleetOperators({
          organizationId: org,
          actingUserId: actor(request),
          sourceId: `return-inspection:${booking.id}`,
          notificationKey: "fleet.return_inspection_required",
          title: `${returnedVehicle.make} ${returnedVehicle.model} needs a return inspection`,
          message: `${booking.reservationNumber} was returned at ${Math.round(Number(returnedVehicle.mileage) || 0).toLocaleString()} mi. Complete the condition, fuel, damage, and cleanliness inspection before making this vehicle available.`,
          severity: "warning",
          category: "inspection",
          actionUrl: `/operations?tab=checklists&action=new&bookingId=${encodeURIComponent(booking.id)}&carId=${encodeURIComponent(returnedVehicle.id)}&type=return`,
          payload: {
            bookingId: booking.id,
            reservationNumber: booking.reservationNumber,
            vehicleId: returnedVehicle.id,
            returnMileage: returnedVehicle.mileage
          }
        }),
        maybeNotifyOilService(org, actor(request), returnedVehicle)
      ]).catch(error => {
        console.error("GoodFleet return notification failed", {
          organizationId: org,
          bookingId: booking.id,
          message: error.message
        });
      });
    }
    response.json({ success: true, data: booking });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23P01") return fail(response, 409, "VEHICLE_NOT_AVAILABLE", "Vehicle is already committed during this rental period, including turnaround time.");
    if (error.code === "23505") return fail(response, 409, "RESERVATION_ALREADY_EXISTS", "Reservation number already exists.");
    next(error);
  } finally { client.release(); }
});

router.delete("/bookings/:bookingId", requireBookingManager, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const org = organization(request);
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM fleet_bookings
       WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL
       FOR UPDATE`,
      [org, request.params.bookingId]
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "BOOKING_NOT_FOUND", "Reservation not found.");
    }

    const before = bookingPayload(existing.rows[0]);
    if (["checked_out", "extended", "overdue"].includes(before.status)) {
      await client.query("ROLLBACK");
      return fail(
        response,
        409,
        "ACTIVE_RENTAL_CANNOT_BE_DELETED",
        "Complete the vehicle return before deleting this active rental."
      );
    }

    const deletedAt = new Date().toISOString();
    const deletionReason = text(request.body?.reason, 500) || "Deleted by management";
    const deletionRecord = {
      deleted: true,
      archived: true,
      deletedAt,
      deletedBy: actor(request),
      deletedByRole: goodFleetAccessRole(request),
      deletionReason,
      previousStatus: before.status
    };
    const storedPayload = cleanPayload({
      ...(existing.rows[0].payload || {}),
      ...deletionRecord
    });

    await client.query(
      `UPDATE fleet_bookings
       SET status='cancelled',archived_at=NOW(),payload=$3::jsonb,
           version=version+1,updated_by=$4,updated_at=NOW()
       WHERE organization_id=$1 AND id=$2`,
      [org, request.params.bookingId, JSON.stringify(storedPayload), actor(request)]
    );

    let releasedVehicleId = null;
    if (before.carId) {
      const vehicle = await client.query(
        `SELECT * FROM fleet_vehicles
         WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL
         FOR UPDATE`,
        [org, before.carId]
      );
      if (vehicle.rowCount && vehicle.rows[0].status === "reserved") {
        const otherReservation = await client.query(
          `SELECT id FROM fleet_bookings
           WHERE organization_id=$1 AND vehicle_id=$2 AND id<>$3
             AND archived_at IS NULL AND status=ANY($4::text[])
           LIMIT 1`,
          [org, before.carId, request.params.bookingId, ACTIVE_BOOKING_STATUSES]
        );
        if (!otherReservation.rowCount) {
          const vehicleBefore = vehiclePayload(vehicle.rows[0]);
          await client.query(
            `UPDATE fleet_vehicles
             SET status='available',version=version+1,updated_by=$3,updated_at=NOW()
             WHERE organization_id=$1 AND id=$2`,
            [org, before.carId, actor(request)]
          );
          releasedVehicleId = before.carId;
          await audit(
            client,
            request,
            "vehicle.reservation_released",
            "vehicle",
            before.carId,
            vehicleBefore,
            {
              id: before.carId,
              status: "available",
              bookingId: before.id,
              details: `Vehicle released after deleting reservation ${before.reservationNumber}`
            }
          );
        }
      }
    }

    await audit(
      client,
      request,
      "booking.deleted",
      "booking",
      before.id,
      before,
      {
        id: before.id,
        reservationNumber: before.reservationNumber,
        ...deletionRecord,
        details: `Reservation ${before.reservationNumber} removed from active booking records`
      }
    );
    await client.query("COMMIT");
    return response.json({
      success: true,
      data: {
        id: before.id,
        reservationNumber: before.reservationNumber,
        deleted: true,
        archived: true,
        releasedVehicleId
      }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
