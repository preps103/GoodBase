"use strict";

const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const authRequired = require("../middleware/authRequired");
const { pool, query } = require("../config/database");
const notificationService = require("../services/notification.service");

const router = express.Router();
const PUBLIC_ORGANIZATION_ID =
  process.env.GOODFLEET_PUBLIC_ORGANIZATION_ID || "org_goodos";
const ACTIVE_BOOKING_STATUSES = [
  "pending_payment",
  "confirmed",
  "assigned",
  "checked_in",
  "checked_out",
  "extended",
  "overdue",
];
const EMPLOYEE_ROLES = new Set([
  "owner",
  "admin",
  "manager",
  "staff",
  "mechanic",
]);
const CHANGE_TYPES = new Set([
  "dates",
  "location",
  "delivery",
  "vehicle",
  "extension",
  "other",
]);
const CANCELLABLE_STATUSES = new Set([
  "pending_payment",
  "confirmed",
  "assigned",
]);
const MESSAGE_REPORT_REASONS = new Set([
  "harassment",
  "payment_request",
  "unsafe_behavior",
  "spam",
  "privacy",
  "other",
]);
const CLAIM_STATUSES = new Set([
  "reported",
  "evidence_review",
  "estimate_pending",
  "insurer_review",
  "customer_response",
  "approved",
  "repair_authorized",
  "disputed",
  "settled",
  "closed",
  "denied",
]);
const CLAIM_LIABILITY = new Set([
  "guest",
  "host",
  "operator",
  "third_party",
  "shared",
  "undetermined",
]);
const CLAIM_EVIDENCE_TYPES = new Set([
  "photo",
  "condition_report",
  "estimate",
  "invoice",
  "police_report",
  "insurance_document",
  "other",
]);
const CLAIM_EVIDENCE_ROOT = path.resolve(
  process.env.GOODFLEET_CLAIM_EVIDENCE_DIR ||
    "/var/lib/goodbase/goodfleet-claim-evidence",
);
const MAX_CLAIM_EVIDENCE_BYTES = 10 * 1024 * 1024;
const claimEvidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MAX_CLAIM_EVIDENCE_BYTES, fields: 10 },
});

router.use(authRequired);

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function receiveClaimEvidence(request, response, next) {
  claimEvidenceUpload.single("file")(request, response, error => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      return fail(
        response,
        413,
        "CLAIM_EVIDENCE_TOO_LARGE",
        "Claim evidence must be 10 MB or smaller.",
      );
    }
    return fail(
      response,
      400,
      "CLAIM_EVIDENCE_UPLOAD_FAILED",
      error.message || "Claim evidence upload failed.",
    );
  });
}

function claimEvidenceFileType(file) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mimeType: "image/jpeg", extension: "jpg", evidenceType: "photo" };
  }
  if (
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return { mimeType: "image/png", extension: "png", evidenceType: "photo" };
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: "webp", evidenceType: "photo" };
  }
  if (buffer.subarray(0, 4).toString("ascii") === "%PDF") {
    return {
      mimeType: "application/pdf",
      extension: "pdf",
      evidenceType: "other",
    };
  }
  return null;
}

function safeClaimEvidencePath(fileName) {
  const normalized = path.basename(String(fileName || ""));
  if (!normalized || normalized !== fileName) return null;
  const resolved = path.resolve(CLAIM_EVIDENCE_ROOT, normalized);
  return resolved.startsWith(`${CLAIM_EVIDENCE_ROOT}${path.sep}`)
    ? resolved
    : null;
}

function listingPhotos(input, fallback = []) {
  const values = Array.isArray(input) ? input : fallback;
  return [...new Set(
    values
      .map(value => clean(value, 2000))
      .filter(value => /^https:\/\//i.test(value)),
  )].slice(0, 20);
}

function listingAvailability(input, fallback = {}) {
  const source =
    input && typeof input === "object" && !Array.isArray(input)
      ? input
      : fallback;
  const pickupDays = [
    ...new Set(
      (Array.isArray(source?.pickupDays)
        ? source.pickupDays
        : [0, 1, 2, 3, 4, 5, 6]
      )
        .map(Number)
        .filter(day => Number.isInteger(day) && day >= 0 && day <= 6),
    ),
  ].sort();
  const unavailableRanges = (Array.isArray(source?.unavailableRanges)
    ? source.unavailableRanges
    : []
  )
    .map(range => {
      const start = new Date(range?.start);
      const end = new Date(range?.end);
      return !Number.isNaN(start.getTime()) &&
        !Number.isNaN(end.getTime()) &&
        end > start
        ? {
            start: start.toISOString(),
            end: end.toISOString(),
            reason: clean(range?.reason, 200) || "Host calendar block",
          }
        : null;
    })
    .filter(Boolean)
    .slice(0, 200);
  return {
    pickupDays: pickupDays.length ? pickupDays : [0, 1, 2, 3, 4, 5, 6],
    unavailableRanges,
  };
}

function fail(response, status, code, message, details) {
  return response.status(status).json({
    success: false,
    code,
    message,
    ...(details ? { details } : {}),
  });
}

function fleetMembership(request) {
  return (request.apps || []).find(
    app =>
      clean(app?.membershipStatus, 40).toLowerCase() === "active" &&
      (clean(app?.id, 80).toLowerCase() === "goodfleet" ||
        clean(app?.domain, 160).toLowerCase() === "fleet.goodos.app"),
  );
}

function fleetRole(request) {
  return clean(fleetMembership(request)?.role, 40).toLowerCase();
}

function requireMarketplaceMember(request, response, next) {
  const role = fleetRole(request);
  if (!role) {
    return fail(
      response,
      403,
      "GOODFLEET_MEMBERSHIP_REQUIRED",
      "An active GoodFleet account is required.",
    );
  }
  return next();
}

function requireGuestMember(request, response, next) {
  const role = fleetRole(request);
  if (role !== "customer" && role !== "host") {
    return fail(
      response,
      403,
      "GUEST_ACCESS_REQUIRED",
      "A GoodFleet guest or host account is required.",
    );
  }
  return next();
}

async function requireHost(request, response, next) {
  if (fleetRole(request) === "host") return next();
  try {
    const delegated = await query(
      `UPDATE fleet_host_team_members
          SET user_id=COALESCE(user_id,$2),
              status=CASE WHEN status='invited' THEN 'active' ELSE status END,
              accepted_at=CASE
                WHEN status='invited' THEN COALESCE(accepted_at,NOW())
                ELSE accepted_at
              END,
              updated_at=CASE WHEN status='invited' THEN NOW() ELSE updated_at END
        WHERE organization_id=$1
          AND status IN ('invited','active')
          AND (
            user_id=$2 OR
            (user_id IS NULL AND lower(invited_email)=lower($3))
          )
        RETURNING id`,
      [
        PUBLIC_ORGANIZATION_ID,
        request.user.id,
        clean(request.user.email, 320),
      ],
    );
    if (delegated.rowCount) return next();
    return fail(
      response,
      403,
      "HOST_ACCESS_REQUIRED",
      "An active GoodFleet host or delegated host-team account is required.",
    );
  } catch (error) {
    return next(error);
  }
}

function requireEmployee(request, response, next) {
  if (!EMPLOYEE_ROLES.has(fleetRole(request))) {
    return fail(
      response,
      403,
      "EMPLOYEE_ACCESS_REQUIRED",
      "GoodFleet employee access is required.",
    );
  }
  return next();
}

function rentalTimestamp(date, time, field) {
  const datePart = clean(date, 10);
  const timePart = clean(time || "10:00", 5);
  const parsed = new Date(`${datePart}T${timePart}:00`);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${field} is invalid.`);
    error.statusCode = 400;
    error.code = "INVALID_DATE";
    throw error;
  }
  return parsed.toISOString();
}

function normalizedTimestamp(value, field) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${field} is invalid.`);
    error.statusCode = 400;
    error.code = "INVALID_DATE";
    throw error;
  }
  return parsed.toISOString();
}

function rentalDays(pickupAt, returnAt) {
  return Math.max(
    1,
    Math.ceil(
      (new Date(returnAt).getTime() - new Date(pickupAt).getTime()) /
        86_400_000,
    ),
  );
}

function customerPayload(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.full_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    licenseVerificationStatus: row.license_verification_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function bookingPayload(row) {
  return {
    id: row.id,
    reservationNumber: row.reservation_number,
    customerId: row.customer_id,
    vehicleId: row.vehicle_id,
    listingId: row.listing_id,
    pickupAt: row.pickup_at,
    returnAt: row.return_at,
    pickupLocationId: row.pickup_branch_id,
    returnLocationId: row.return_branch_id,
    status: row.status,
    paymentStatus: row.payment_status,
    totalAmount: Number(row.total_amount),
    depositAmount: Number(row.deposit_amount),
    paidAmount: Number(row.paid_amount),
    cancellationReason: row.cancellation_reason || null,
    cancelledAt: row.cancelled_at || null,
    vehicle: row.vehicle_id
      ? {
          id: row.vehicle_id,
          name: [row.model_year, row.make, row.model].filter(Boolean).join(" "),
          imageUrl: row.vehicle_image_url || null,
        }
      : null,
    host: row.host_user_id
      ? {
          id: row.host_user_id,
          name: row.host_display_name,
        }
      : {
          id: null,
        name: "GoodFleet",
      },
    guest: row.guest_name
      ? {
          name: row.guest_name,
          email: row.guest_email || null,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listingPayload(row) {
  const photos = Array.isArray(row.photos_json) ? row.photos_json : [];
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    hostProfileId: row.host_profile_id,
    operatorManaged: Boolean(row.operator_managed),
    title: row.title,
    description: row.description,
    status: row.status,
    instantBook: Boolean(row.instant_book),
    deliveryEnabled: Boolean(row.delivery_enabled),
    deliveryRadiusMiles:
      row.delivery_radius_miles === null
        ? null
        : Number(row.delivery_radius_miles),
    deliveryFee: Number(row.delivery_fee),
    minimumTripDays: row.minimum_trip_days,
    maximumTripDays: row.maximum_trip_days,
    advanceNoticeHours: row.advance_notice_hours,
    tripBufferHours: row.trip_buffer_hours,
    mileageLimitPerDay: row.mileage_limit_per_day,
    additionalMileRate:
      row.additional_mile_rate === null
        ? null
        : Number(row.additional_mile_rate),
    rules: row.rules_json || {},
    features: row.features_json || [],
    photos,
    availability: row.availability_json || {
      unavailableRanges: [],
      pickupDays: [0, 1, 2, 3, 4, 5, 6],
    },
    reviewNote: row.review_note || null,
    reviewedAt: row.reviewed_at || null,
    vehicle: {
      id: row.vehicle_id,
      vin: row.vin,
      licensePlate: row.license_plate,
      make: row.make,
      model: row.model,
      year: row.model_year,
      status: row.vehicle_status,
      dailyRate: Number(row.daily_rate),
      imageUrl: photos[0] || row.vehicle_payload?.imageUrl || null,
      registrationExpiry: row.registration_expiry,
      insuranceExpiry: row.insurance_expiry,
    },
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function changeRequestPayload(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    requestType: row.request_type,
    status: row.status,
    requestedChanges: row.requested_changes || {},
    decisionNote: row.decision_note || null,
    quotedTotal:
      row.quoted_total === null || row.quoted_total === undefined
        ? null
        : Number(row.quoted_total),
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at || null,
    appliedAt: row.applied_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function additionalDriverPayload(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    userId: row.user_id || null,
    fullName: row.full_name,
    email: row.email,
    status: row.status,
    licenseVerificationStatus: row.license_verification_status,
    reviewNote: row.review_note || null,
    invitedAt: row.invited_at,
    acceptedAt: row.accepted_at || null,
    verifiedAt: row.verified_at || null,
    approvedAt: row.approved_at || null,
    updatedAt: row.updated_at,
  };
}

function reviewPayload(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    reviewer: {
      id: row.reviewer_user_id,
      name: row.reviewer_name || null,
      role: row.reviewer_role,
    },
    revieweeUserId: row.reviewee_user_id || null,
    rating: Number(row.rating),
    body: row.body || "",
    privateFeedback: row.private_feedback || "",
    response: row.response || null,
    respondedAt: row.responded_at || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function claimPayload(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    reservationNumber: row.reservation_number || null,
    vehicleId: row.vehicle_id,
    vehicleName: [row.model_year, row.make, row.model]
      .filter(Boolean)
      .join(" "),
    reportedBy: row.reported_by,
    assignedTo: row.assigned_to || null,
    status: row.status,
    incidentAt: row.incident_at,
    description: row.description,
    liability: row.liability,
    estimatedAmount:
      row.estimated_amount === null ? null : Number(row.estimated_amount),
    finalAmount: row.final_amount === null ? null : Number(row.final_amount),
    insurerName: row.insurer_name || null,
    insurerClaimReference: row.insurer_claim_reference || null,
    decisionNote: row.decision_note || null,
    resolvedAt: row.resolved_at || null,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    events: Array.isArray(row.events) ? row.events : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messagePayload(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sender: {
      id: row.sender_user_id,
      name: row.sender_name,
      role: row.sender_role,
      avatarUrl: row.sender_avatar_url || null,
    },
    body: row.body,
    attachments: row.attachments_json || [],
    moderationStatus: row.moderation_status,
    scheduledAt: row.scheduled_at,
    deliveredAt: row.delivered_at,
    editedAt: row.edited_at,
    createdAt: row.created_at,
  };
}

async function audit(
  client,
  request,
  organizationId,
  action,
  entityType,
  entityId,
  after,
) {
  await client.query(
    `INSERT INTO fleet_audit_events
      (organization_id,actor_id,action,entity_type,entity_id,after_json,request_id,ip_address)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [
      organizationId,
      request.user.id,
      action,
      entityType,
      entityId,
      JSON.stringify(after || {}),
      request.id || request.get("X-Request-ID") || null,
      request.ip || null,
    ],
  );
}

async function ensureCustomer(client, request, input = {}) {
  const email = clean(request.user.email, 320).toLowerCase();
  if (!email) {
    const error = new Error("A verified email address is required.");
    error.statusCode = 409;
    error.code = "VERIFIED_EMAIL_REQUIRED";
    throw error;
  }

  const existing = await client.query(
    `SELECT *
       FROM fleet_customers
      WHERE organization_id=$1
        AND archived_at IS NULL
        AND (user_id=$2 OR lower(email)=lower($3))
      ORDER BY (user_id=$2) DESC,updated_at DESC
      LIMIT 1
      FOR UPDATE`,
    [PUBLIC_ORGANIZATION_ID, request.user.id, email],
  );
  const name =
    clean(input.name, 200) ||
    clean(request.user.displayName, 200) ||
    [request.user.firstName, request.user.lastName].filter(Boolean).join(" ") ||
    "GoodFleet guest";
  const phone = clean(input.phone, 50) || null;

  if (existing.rowCount) {
    const result = await client.query(
      `UPDATE fleet_customers
          SET user_id=COALESCE(user_id,$3),
              full_name=COALESCE(NULLIF($4,''),full_name),
              phone=COALESCE(NULLIF($5,''),phone),
              updated_by=$3,
              updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
        RETURNING *`,
      [
        PUBLIC_ORGANIZATION_ID,
        existing.rows[0].id,
        request.user.id,
        name,
        phone,
      ],
    );
    return result.rows[0];
  }

  const created = await client.query(
    `INSERT INTO fleet_customers
      (organization_id,user_id,full_name,email,phone,status,license_number,
       license_expiry,license_verification_status,payload,created_by,updated_by)
     VALUES ($1,$2,$3,$4,$5,'active',NULL,NULL,'pending',$6::jsonb,$2,$2)
     RETURNING *`,
    [
      PUBLIC_ORGANIZATION_ID,
      request.user.id,
      name,
      email,
      phone,
      JSON.stringify({ accountSource: "goodfleet_marketplace" }),
    ],
  );
  return created.rows[0];
}

async function ensureHostProfile(client, request, input = {}) {
  const existing = await client.query(
    `SELECT *
       FROM fleet_host_profiles
      WHERE organization_id=$1 AND user_id=$2
      LIMIT 1
      FOR UPDATE`,
    [PUBLIC_ORGANIZATION_ID, request.user.id],
  );
  const displayName =
    clean(input.displayName, 200) ||
    clean(request.user.displayName, 200) ||
    "GoodFleet host";
  if (existing.rowCount) return existing.rows[0];

  const created = await client.query(
    `INSERT INTO fleet_host_profiles
      (organization_id,user_id,display_name,support_phone,bio)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [
      PUBLIC_ORGANIZATION_ID,
      request.user.id,
      displayName,
      clean(input.supportPhone, 50) || null,
      clean(input.bio, 2000) || null,
    ],
  );
  return created.rows[0];
}

async function hostProfileForRequest(client, request) {
  const owned = await client.query(
    `SELECT host.*,true AS is_owner,NULL::uuid AS team_member_id,
            '[]'::jsonb AS team_permissions
       FROM fleet_host_profiles host
      WHERE host.organization_id=$1 AND host.user_id=$2
      LIMIT 1`,
    [PUBLIC_ORGANIZATION_ID, request.user.id],
  );
  if (owned.rowCount) return owned.rows[0];
  const delegated = await client.query(
    `SELECT host.*,false AS is_owner,member.id AS team_member_id,
            member.permissions_json AS team_permissions,
            member.role AS team_role
       FROM fleet_host_team_members member
       JOIN fleet_host_profiles host
         ON host.organization_id=member.organization_id
        AND host.id=member.host_profile_id
      WHERE member.organization_id=$1
        AND member.status='active'
        AND (
          member.user_id=$2 OR
          lower(member.invited_email)=lower($3)
        )
      ORDER BY member.accepted_at DESC NULLS LAST
      LIMIT 1`,
    [
      PUBLIC_ORGANIZATION_ID,
      request.user.id,
      clean(request.user.email, 320),
    ],
  );
  return delegated.rows[0] || null;
}

async function delegatedHostAccess(
  request,
  hostProfileId,
  vehicleId,
  requiredPermissions,
) {
  if (!hostProfileId) return false;
  const result = await query(
    `SELECT 1
       FROM fleet_host_team_members member
      WHERE member.organization_id=$1
        AND member.host_profile_id=$2
        AND member.status='active'
        AND (member.user_id=$3 OR lower(member.invited_email)=lower($5))
        AND member.permissions_json ?| $6::text[]
        AND (
          NOT EXISTS (
            SELECT 1
              FROM fleet_host_team_vehicle_access scoped
             WHERE scoped.organization_id=member.organization_id
               AND scoped.team_member_id=member.id
          ) OR EXISTS (
            SELECT 1
              FROM fleet_host_team_vehicle_access scoped
             WHERE scoped.organization_id=member.organization_id
               AND scoped.team_member_id=member.id
               AND scoped.vehicle_id=$4
          )
        )
      LIMIT 1`,
    [
      PUBLIC_ORGANIZATION_ID,
      hostProfileId,
      request.user.id,
      vehicleId || null,
      clean(request.user.email, 320),
      requiredPermissions,
    ],
  );
  return Boolean(result.rowCount);
}

async function priceQuote(client, listing, input, pickupAt, returnAt) {
  const days = rentalDays(pickupAt, returnAt);
  if (
    days < listing.minimum_trip_days ||
    days > listing.maximum_trip_days
  ) {
    const error = new Error(
      `This vehicle accepts trips from ${listing.minimum_trip_days} to ${listing.maximum_trip_days} days.`,
    );
    error.statusCode = 409;
    error.code = "TRIP_LENGTH_NOT_ALLOWED";
    throw error;
  }

  const pickupLeadHours =
    (new Date(pickupAt).getTime() - Date.now()) / 3_600_000;
  if (pickupLeadHours < listing.advance_notice_hours) {
    const error = new Error(
      `This vehicle requires at least ${listing.advance_notice_hours} hours of advance notice.`,
    );
    error.statusCode = 409;
    error.code = "ADVANCE_NOTICE_REQUIRED";
    throw error;
  }
  const availability =
    listing.availability_json &&
    typeof listing.availability_json === "object" &&
    !Array.isArray(listing.availability_json)
      ? listing.availability_json
      : {};
  const pickupDays = Array.isArray(availability.pickupDays)
    ? availability.pickupDays
        .map(Number)
        .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
    : [0, 1, 2, 3, 4, 5, 6];
  if (!pickupDays.includes(new Date(pickupAt).getDay())) {
    const error = new Error("This host does not offer pickup on the selected day.");
    error.statusCode = 409;
    error.code = "PICKUP_DAY_UNAVAILABLE";
    throw error;
  }
  const blocked = (Array.isArray(availability.unavailableRanges)
    ? availability.unavailableRanges
    : []
  ).some(range => {
    const start = new Date(range?.start).getTime();
    const end = new Date(range?.end).getTime();
    return (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start < new Date(returnAt).getTime() &&
      end > new Date(pickupAt).getTime()
    );
  });
  if (blocked) {
    const error = new Error("This vehicle is blocked on the selected dates.");
    error.statusCode = 409;
    error.code = "HOST_CALENDAR_BLOCK";
    throw error;
  }

  const workspace = await client.query(
    `SELECT state_json
       FROM fleet_workspace_state
      WHERE organization_id=$1`,
    [PUBLIC_ORGANIZATION_ID],
  );
  const state = workspace.rows[0]?.state_json || {};
  const dailyRate = Number(listing.daily_rate);
  const base = dailyRate * days;
  const deliveryFee =
    input.delivery === true && listing.delivery_enabled
      ? Number(listing.delivery_fee)
      : 0;
  if (input.delivery === true && !listing.delivery_enabled) {
    const error = new Error("Delivery is not available for this vehicle.");
    error.statusCode = 409;
    error.code = "DELIVERY_NOT_AVAILABLE";
    throw error;
  }
  const branch = (Array.isArray(state.branches) ? state.branches : []).find(
    item => String(item?.id || "") === String(input.pickupLocationId || ""),
  );
  const configuredTax = Number(
    branch?.financialConfig?.taxRate ??
      state.billingSettings?.taxRate ??
      0,
  );
  const taxRate = Number.isFinite(configuredTax)
    ? Math.min(Math.max(configuredTax, 0), 100)
    : 0;
  const taxable = base + deliveryFee;
  const tax = (taxable * taxRate) / 100;
  return {
    days,
    dailyRate: Number(dailyRate.toFixed(2)),
    base: Number(base.toFixed(2)),
    deliveryFee: Number(deliveryFee.toFixed(2)),
    taxRate: Number(taxRate.toFixed(4)),
    tax: Number(tax.toFixed(2)),
    total: Number((taxable + tax).toFixed(2)),
    currency: "USD",
  };
}

async function marketplaceListing(
  client,
  listingId,
  { forUpdate = false } = {},
) {
  const result = await client.query(
    `SELECT listing.*,vehicle.vin,vehicle.license_plate,vehicle.make,
            vehicle.model,vehicle.model_year,vehicle.status AS vehicle_status,
            vehicle.daily_rate,vehicle.assigned_branch_id,
            vehicle.registration_expiry,
            vehicle.insurance_expiry,vehicle.payload AS vehicle_payload,
            host.user_id AS host_user_id,host.display_name AS host_display_name,
            host.identity_verification_status AS host_identity_verification_status
       FROM fleet_vehicle_listings listing
       JOIN fleet_vehicles vehicle
         ON vehicle.organization_id=listing.organization_id
        AND vehicle.id=listing.vehicle_id
       LEFT JOIN fleet_host_profiles host
         ON host.organization_id=listing.organization_id
        AND host.id=listing.host_profile_id
      WHERE listing.organization_id=$1
        AND listing.id=$2
        AND listing.archived_at IS NULL
        AND vehicle.archived_at IS NULL
      LIMIT 1
      ${forUpdate ? "FOR UPDATE OF listing,vehicle" : ""}`,
    [PUBLIC_ORGANIZATION_ID, listingId],
  );
  return result.rows[0] || null;
}

async function notify(input) {
  try {
    await notificationService.createNotification({
      ...input,
      appId: "goodfleet",
      organizationId: input.organizationId || PUBLIC_ORGANIZATION_ID,
      projectId: "proj_goodos_platform",
      environmentId: "env_goodos_production",
      source: input.source || "goodfleet-marketplace",
    });
  } catch (error) {
    console.error("GoodFleet marketplace notification failed", {
      sourceId: input.sourceId,
      recipientUserId: input.recipientUserId,
      message: error.message,
    });
  }
}

async function operatorRecipients(organizationId, excludeUserId) {
  const result = await query(
    `SELECT DISTINCT account.id,account.email
       FROM app_memberships membership
       JOIN users account ON account.id=membership.user_id
      WHERE membership.app_id='goodfleet'
        AND membership.organization_id=$1
        AND membership.status='active'
        AND membership.role IN ('owner','admin','manager')
        AND account.status='active'
        AND ($2::uuid IS NULL OR account.id<>$2::uuid)`,
    [organizationId, excludeUserId || null],
  );
  return result.rows;
}

async function notifyBookingParty({
  organizationId,
  recipientUserId,
  title,
  message,
  bookingId,
  actionUrl,
}) {
  if (recipientUserId) {
    await notify({
      recipientUserId,
      title,
      message,
      category: "reservation",
      channel: "in_app",
      actionUrl,
      notificationKey: "fleet.marketplace.activity",
      sourceId: bookingId,
      organizationId,
      payload: { bookingId },
    });
    return;
  }
  const recipients = await operatorRecipients(organizationId, null);
  await Promise.all(
    recipients.map(recipient =>
      notify({
        recipientUserId: recipient.id,
        recipientEmail: recipient.email,
        title,
        message,
        category: "reservation",
        channel: "in_app",
        actionUrl,
        notificationKey: "fleet.marketplace.activity",
        sourceId: bookingId,
        organizationId,
        payload: { bookingId },
      }),
    ),
  );
}

async function conversationAccess(request, conversationId) {
  const role = fleetRole(request);
  const result = await query(
    `SELECT conversation.*,booking.reservation_number,booking.vehicle_id,
            listing.host_profile_id,
            customer.full_name AS guest_name,
            host.display_name AS host_name
       FROM fleet_trip_conversations conversation
       JOIN fleet_bookings booking
         ON booking.organization_id=conversation.organization_id
        AND booking.id=conversation.booking_id
       JOIN fleet_customers customer
         ON customer.organization_id=booking.organization_id
        AND customer.id=booking.customer_id
       LEFT JOIN fleet_vehicle_listings listing
         ON listing.organization_id=booking.organization_id
        AND listing.id=booking.listing_id
       LEFT JOIN fleet_host_profiles host
         ON host.organization_id=conversation.organization_id
        AND host.user_id=conversation.host_user_id
      WHERE conversation.id=$1
      LIMIT 1`,
    [conversationId],
  );
  const conversation = result.rows[0];
  if (!conversation) return null;
  const allowed =
    conversation.guest_user_id === request.user.id ||
    conversation.host_user_id === request.user.id ||
    EMPLOYEE_ROLES.has(role) ||
    (await delegatedHostAccess(
      request,
      conversation.host_profile_id,
      conversation.vehicle_id,
      ["messaging"],
    ));
  return allowed ? conversation : null;
}

async function bookingAccess(request, bookingId, { forUpdate = false } = {}) {
  const result = await query(
    `SELECT booking.*,listing.host_profile_id,
            host.user_id AS host_user_id,
            customer.full_name AS guest_name,
            customer.email AS guest_email,
            vehicle.make,vehicle.model,vehicle.model_year,
            vehicle.payload->>'imageUrl' AS vehicle_image_url,
            COALESCE(host.display_name,'GoodFleet') AS host_display_name
       FROM fleet_bookings booking
       JOIN fleet_customers customer
         ON customer.organization_id=booking.organization_id
        AND customer.id=booking.customer_id
       JOIN fleet_vehicles vehicle
         ON vehicle.organization_id=booking.organization_id
        AND vehicle.id=booking.vehicle_id
       LEFT JOIN fleet_vehicle_listings listing
         ON listing.organization_id=booking.organization_id
        AND listing.id=booking.listing_id
       LEFT JOIN fleet_host_profiles host
         ON host.organization_id=listing.organization_id
        AND host.id=listing.host_profile_id
      WHERE booking.organization_id=$1
        AND booking.id=$2
        AND booking.archived_at IS NULL
      LIMIT 1
      ${forUpdate ? "FOR UPDATE OF booking" : ""}`,
    [PUBLIC_ORGANIZATION_ID, bookingId],
  );
  const booking = result.rows[0];
  if (!booking) return null;
  const role = fleetRole(request);
  const allowed =
    booking.guest_user_id === request.user.id ||
    booking.host_user_id === request.user.id ||
    EMPLOYEE_ROLES.has(role) ||
    (await delegatedHostAccess(
      request,
      booking.host_profile_id,
      booking.vehicle_id,
      ["trips_view", "trips_manage"],
    ));
  return allowed ? booking : null;
}

router.use(requireMarketplaceMember);
router.use(["/profile", "/quote", "/reservations"], requireGuestMember);

router.get("/profile", async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const customer = await ensureCustomer(client, request);
    const host =
      fleetRole(request) === "host"
        ? await ensureHostProfile(client, request)
        : null;
    await client.query("COMMIT");
    response.json({
      success: true,
      data: {
        role: fleetRole(request),
        customer: customerPayload(customer),
        host,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.patch("/profile", async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const customer = await ensureCustomer(client, request, request.body || {});
    const updated = await client.query(
      `UPDATE fleet_customers
          SET full_name=$3,phone=$4,payload=payload||$5::jsonb,
              version=version+1,updated_by=$2,updated_at=NOW()
        WHERE organization_id=$1 AND id=$6
        RETURNING *`,
      [
        PUBLIC_ORGANIZATION_ID,
        request.user.id,
        clean(request.body?.name, 200) || customer.full_name,
        clean(request.body?.phone, 50) || customer.phone,
        JSON.stringify({
          preferredContactMethod:
            clean(request.body?.preferredContactMethod, 30) || "email",
        }),
        customer.id,
      ],
    );
    await audit(
      client,
      request,
      PUBLIC_ORGANIZATION_ID,
      "marketplace.profile.updated",
      "customer",
      customer.id,
      { phoneUpdated: Boolean(request.body?.phone) },
    );
    await client.query("COMMIT");
    response.json({
      success: true,
      data: customerPayload(updated.rows[0]),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/quote", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const listing = await marketplaceListing(
      client,
      clean(request.body?.listingId, 80),
    );
    if (!listing || listing.status !== "active") {
      return fail(
        response,
        404,
        "LISTING_NOT_AVAILABLE",
        "This vehicle listing is not available.",
      );
    }
    const pickupAt = rentalTimestamp(
      request.body?.startDate,
      request.body?.pickupTime,
      "pickupAt",
    );
    const returnAt = rentalTimestamp(
      request.body?.endDate,
      request.body?.dropoffTime,
      "returnAt",
    );
    if (new Date(returnAt) <= new Date(pickupAt)) {
      return fail(
        response,
        400,
        "INVALID_RENTAL_PERIOD",
        "Return must be after pickup.",
      );
    }
    const quote = await priceQuote(
      client,
      listing,
      request.body || {},
      pickupAt,
      returnAt,
    );
    const conflict = await client.query(
      `SELECT 1
         FROM fleet_bookings booking
        WHERE booking.organization_id=$1
          AND booking.vehicle_id=$2
          AND booking.archived_at IS NULL
          AND booking.status=ANY($5::text[])
          AND tsrange(
            (booking.pickup_at AT TIME ZONE 'UTC') -
              make_interval(hours => $6::integer),
            (booking.return_at AT TIME ZONE 'UTC') +
              make_interval(hours => $6::integer),
            '[)'
          ) && tsrange(
            ($3::timestamptz AT TIME ZONE 'UTC'),
            ($4::timestamptz AT TIME ZONE 'UTC'),
            '[)'
          )
        LIMIT 1`,
      [
        PUBLIC_ORGANIZATION_ID,
        listing.vehicle_id,
        pickupAt,
        returnAt,
        ACTIVE_BOOKING_STATUSES,
        listing.trip_buffer_hours,
      ],
    );
    response.json({
      success: true,
      data: {
        ...quote,
        available: !conflict.rowCount,
        listing: listingPayload(listing),
      },
    });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.post("/reservations", async (request, response, next) => {
  const client = await pool.connect();
  let createdBooking = null;
  let hostUserId = null;
  try {
    const listingId = clean(request.body?.listingId, 80);
    const pickupAt = rentalTimestamp(
      request.body?.startDate,
      request.body?.pickupTime,
      "pickupAt",
    );
    const returnAt = rentalTimestamp(
      request.body?.endDate,
      request.body?.dropoffTime,
      "returnAt",
    );
    if (new Date(returnAt) <= new Date(pickupAt)) {
      return fail(
        response,
        400,
        "INVALID_RENTAL_PERIOD",
        "Return must be after pickup.",
      );
    }

    await client.query("BEGIN");
    const listing = await marketplaceListing(client, listingId, {
      forUpdate: true,
    });
    if (!listing || listing.status !== "active") {
      await client.query("ROLLBACK");
      return fail(
        response,
        404,
        "LISTING_NOT_AVAILABLE",
        "This vehicle listing is not available.",
      );
    }
    if (!["available", "reserved"].includes(listing.vehicle_status)) {
      await client.query("ROLLBACK");
      return fail(
        response,
        409,
        "VEHICLE_NOT_AVAILABLE",
        "This vehicle is not currently accepting reservations.",
      );
    }
    if (
      !listing.registration_expiry ||
      !listing.insurance_expiry ||
      new Date(listing.registration_expiry) < new Date(returnAt) ||
      new Date(listing.insurance_expiry) < new Date(returnAt)
    ) {
      await client.query("ROLLBACK");
      return fail(
        response,
        409,
        "VEHICLE_COMPLIANCE_REQUIRED",
        "This vehicle cannot be booked until its registration and insurance are verified for the trip.",
      );
    }

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`${PUBLIC_ORGANIZATION_ID}:${listing.vehicle_id}`],
    );
    const customer = await ensureCustomer(
      client,
      request,
      request.body?.customer || {},
    );
    if (customer.status !== "active") {
      await client.query("ROLLBACK");
      return fail(
        response,
        409,
        "CUSTOMER_NOT_ELIGIBLE",
        "This account cannot create reservations.",
      );
    }
    const quote = await priceQuote(
      client,
      listing,
      request.body || {},
      pickupAt,
      returnAt,
    );
    const conflict = await client.query(
      `SELECT reservation_number
         FROM fleet_bookings
        WHERE organization_id=$1
          AND vehicle_id=$2
          AND archived_at IS NULL
          AND status=ANY($5::text[])
          AND tsrange(
            (pickup_at AT TIME ZONE 'UTC') -
              make_interval(hours => $6::integer),
            (return_at AT TIME ZONE 'UTC') +
              make_interval(hours => $6::integer),
            '[)'
          ) && tsrange(
            ($3::timestamptz AT TIME ZONE 'UTC'),
            ($4::timestamptz AT TIME ZONE 'UTC'),
            '[)'
          )
        LIMIT 1`,
      [
        PUBLIC_ORGANIZATION_ID,
        listing.vehicle_id,
        pickupAt,
        returnAt,
        ACTIVE_BOOKING_STATUSES,
        listing.trip_buffer_hours,
      ],
    );
    if (conflict.rowCount) {
      await client.query("ROLLBACK");
      return fail(
        response,
        409,
        "VEHICLE_NOT_AVAILABLE",
        "This vehicle was just reserved for the selected period. Choose different dates or another vehicle.",
      );
    }

    const reservationNumber =
      `GF-${Date.now().toString(36).toUpperCase()}-` +
      crypto.randomBytes(3).toString("hex").toUpperCase();
    const branchId =
      clean(request.body?.pickupLocationId, 200) ||
      listing.assigned_branch_id ||
      "default";
    const depositAmount = Math.max(
      0,
      Number(request.body?.depositAmount) || 200,
    );
    const inserted = await client.query(
      `INSERT INTO fleet_bookings
        (organization_id,reservation_number,customer_id,vehicle_id,guest_user_id,
         listing_id,pickup_at,return_at,pickup_branch_id,return_branch_id,status,
         payment_status,total_amount,deposit_amount,paid_amount,payload,
         created_by,updated_by)
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending_payment','unpaid',
         $11,$12,0,$13::jsonb,$5,$5
       )
       RETURNING *`,
      [
        PUBLIC_ORGANIZATION_ID,
        reservationNumber,
        customer.id,
        listing.vehicle_id,
        request.user.id,
        listing.id,
        pickupAt,
        returnAt,
        branchId,
        clean(request.body?.returnLocationId, 200) || branchId,
        quote.total.toFixed(2),
        depositAmount.toFixed(2),
        JSON.stringify({
          bookingSource: "marketplace",
          delivery: Boolean(request.body?.delivery),
          deliveryAddress: clean(request.body?.deliveryAddress, 500) || null,
          pricing: quote,
        }),
      ],
    );
    hostUserId = listing.host_user_id || null;
    await client.query(
      `INSERT INTO fleet_trip_conversations
        (organization_id,booking_id,listing_id,guest_user_id,host_user_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organization_id,booking_id) DO NOTHING`,
      [
        PUBLIC_ORGANIZATION_ID,
        inserted.rows[0].id,
        listing.id,
        request.user.id,
        hostUserId,
      ],
    );
    await audit(
      client,
      request,
      PUBLIC_ORGANIZATION_ID,
      "marketplace.booking.created",
      "booking",
      inserted.rows[0].id,
      {
        reservationNumber,
        listingId: listing.id,
        totalAmount: quote.total,
      },
    );
    await client.query("COMMIT");
    createdBooking = inserted.rows[0];

    await notifyBookingParty({
      organizationId: PUBLIC_ORGANIZATION_ID,
      recipientUserId: hostUserId,
      title: "New GoodFleet reservation",
      message: `${customer.full_name} requested ${listing.title} for ${quote.days} day${quote.days === 1 ? "" : "s"}.`,
      bookingId: createdBooking.id,
      actionUrl: hostUserId
        ? `/host/trips?booking=${encodeURIComponent(createdBooking.id)}`
        : `/bookings?booking=${createdBooking.id}`,
    });
    response.status(201).json({
      success: true,
      data: bookingPayload({
        ...createdBooking,
        make: listing.make,
        model: listing.model,
        model_year: listing.model_year,
        vehicle_image_url: listing.vehicle_payload?.imageUrl,
        host_user_id: hostUserId,
        host_display_name: listing.host_display_name,
      }),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23P01") {
      return fail(
        response,
        409,
        "VEHICLE_NOT_AVAILABLE",
        "This vehicle is already committed during the selected rental period.",
      );
    }
    next(error);
  } finally {
    client.release();
  }
});

router.get("/reservations", async (request, response, next) => {
  try {
    const result = await query(
      `SELECT booking.*,vehicle.make,vehicle.model,vehicle.model_year,
              vehicle.payload->>'imageUrl' AS vehicle_image_url,
              host.user_id AS host_user_id,host.display_name AS host_display_name
         FROM fleet_bookings booking
         JOIN fleet_vehicles vehicle
           ON vehicle.organization_id=booking.organization_id
          AND vehicle.id=booking.vehicle_id
         LEFT JOIN fleet_vehicle_listings listing
           ON listing.organization_id=booking.organization_id
          AND listing.id=booking.listing_id
         LEFT JOIN fleet_host_profiles host
           ON host.organization_id=listing.organization_id
          AND host.id=listing.host_profile_id
        WHERE booking.organization_id=$1
          AND booking.guest_user_id=$2
          AND booking.archived_at IS NULL
        ORDER BY booking.pickup_at DESC`,
      [PUBLIC_ORGANIZATION_ID, request.user.id],
    );
    response.json({
      success: true,
      data: result.rows.map(bookingPayload),
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/reservations/:bookingId/cancel",
  async (request, response, next) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const booking = await client.query(
        `SELECT *
           FROM fleet_bookings
          WHERE organization_id=$1
            AND id=$2
            AND guest_user_id=$3
            AND archived_at IS NULL
          FOR UPDATE`,
        [PUBLIC_ORGANIZATION_ID, request.params.bookingId, request.user.id],
      );
      if (!booking.rowCount) {
        await client.query("ROLLBACK");
        return fail(
          response,
          404,
          "BOOKING_NOT_FOUND",
          "Reservation not found.",
        );
      }
      const record = booking.rows[0];
      if (!CANCELLABLE_STATUSES.has(record.status)) {
        await client.query("ROLLBACK");
        return fail(
          response,
          409,
          "BOOKING_NOT_CANCELLABLE",
          "This reservation can no longer be cancelled online.",
        );
      }
      if (Number(record.paid_amount) > 0 || record.payment_status !== "unpaid") {
        await client.query("ROLLBACK");
        return fail(
          response,
          409,
          "CANCELLATION_REVIEW_REQUIRED",
          "This paid reservation requires a cancellation and refund review.",
        );
      }
      const reason =
        clean(request.body?.reason, 1000) || "Cancelled by guest";
      const updated = await client.query(
        `UPDATE fleet_bookings
            SET status='cancelled',cancellation_reason=$4,cancelled_at=NOW(),
                cancelled_by=$3,version=version+1,updated_by=$3,updated_at=NOW()
          WHERE organization_id=$1 AND id=$2
          RETURNING *`,
        [
          PUBLIC_ORGANIZATION_ID,
          record.id,
          request.user.id,
          reason,
        ],
      );
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        "marketplace.booking.cancelled",
        "booking",
        record.id,
        { reason },
      );
      await client.query("COMMIT");
      response.json({
        success: true,
        data: bookingPayload(updated.rows[0]),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

router.post(
  "/reservations/:bookingId/change-requests",
  async (request, response, next) => {
    const client = await pool.connect();
    try {
      const requestType = clean(request.body?.requestType, 40).toLowerCase();
      const requestedChanges =
        request.body?.requestedChanges &&
        typeof request.body.requestedChanges === "object" &&
        !Array.isArray(request.body.requestedChanges)
          ? request.body.requestedChanges
          : null;
      if (!CHANGE_TYPES.has(requestType) || !requestedChanges) {
        return fail(
          response,
          400,
          "INVALID_CHANGE_REQUEST",
          "Choose a valid change type and requested changes.",
        );
      }
      await client.query("BEGIN");
      const booking = await client.query(
        `SELECT id,status
           FROM fleet_bookings
          WHERE organization_id=$1 AND id=$2 AND guest_user_id=$3
            AND archived_at IS NULL
          FOR SHARE`,
        [PUBLIC_ORGANIZATION_ID, request.params.bookingId, request.user.id],
      );
      if (!booking.rowCount) {
        await client.query("ROLLBACK");
        return fail(
          response,
          404,
          "BOOKING_NOT_FOUND",
          "Reservation not found.",
        );
      }
      if (
        ["completed", "cancelled", "refunded", "no_show"].includes(
          booking.rows[0].status,
        )
      ) {
        await client.query("ROLLBACK");
        return fail(
          response,
          409,
          "BOOKING_CHANGE_NOT_ALLOWED",
          "This reservation can no longer be changed.",
        );
      }
      const created = await client.query(
        `INSERT INTO fleet_booking_change_requests
          (organization_id,booking_id,requested_by,request_type,requested_changes)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         RETURNING *`,
        [
          PUBLIC_ORGANIZATION_ID,
          booking.rows[0].id,
          request.user.id,
          requestType,
          JSON.stringify(requestedChanges),
        ],
      );
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        "marketplace.booking.change_requested",
        "booking_change_request",
        created.rows[0].id,
        { bookingId: booking.rows[0].id, requestType },
      );
      await client.query("COMMIT");
      const recipients = await operatorRecipients(
        PUBLIC_ORGANIZATION_ID,
        request.user.id,
      );
      await Promise.all(
        recipients.map(recipient =>
          notify({
            recipientUserId: recipient.id,
            recipientEmail: recipient.email,
            title: "Reservation change requested",
            message: `A guest requested a ${requestType} change for a GoodFleet reservation.`,
            category: "reservation",
            channel: "in_app",
            actionUrl: `/bookings?booking=${booking.rows[0].id}`,
            sourceId: created.rows[0].id,
            payload: {
              bookingId: booking.rows[0].id,
              changeRequestId: created.rows[0].id,
            },
          }),
        ),
      );
      response.status(201).json({ success: true, data: created.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

router.get(
  "/reservations/:bookingId/change-requests",
  async (request, response, next) => {
    try {
      const booking = await bookingAccess(request, request.params.bookingId);
      if (!booking) {
        return fail(
          response,
          404,
          "BOOKING_NOT_FOUND",
          "Reservation not found.",
        );
      }
      const result = await query(
        `SELECT *
           FROM fleet_booking_change_requests
          WHERE organization_id=$1 AND booking_id=$2
          ORDER BY created_at DESC`,
        [PUBLIC_ORGANIZATION_ID, booking.id],
      );
      response.json({
        success: true,
        data: result.rows.map(changeRequestPayload),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get("/host/change-requests", requireHost, async (request, response, next) => {
  try {
    const result = await query(
      `SELECT change.*,booking.reservation_number,booking.pickup_at,
              booking.return_at,vehicle.make,vehicle.model,vehicle.model_year,
              customer.full_name AS guest_name
         FROM fleet_booking_change_requests change
         JOIN fleet_bookings booking
           ON booking.organization_id=change.organization_id
          AND booking.id=change.booking_id
         JOIN fleet_vehicle_listings listing
           ON listing.organization_id=booking.organization_id
          AND listing.id=booking.listing_id
         JOIN fleet_host_profiles host
           ON host.organization_id=listing.organization_id
          AND host.id=listing.host_profile_id
         JOIN fleet_vehicles vehicle
           ON vehicle.organization_id=booking.organization_id
          AND vehicle.id=booking.vehicle_id
         JOIN fleet_customers customer
           ON customer.organization_id=booking.organization_id
          AND customer.id=booking.customer_id
        WHERE change.organization_id=$1
          AND (
            host.user_id=$2 OR EXISTS (
              SELECT 1
                FROM fleet_host_team_members member
               WHERE member.organization_id=host.organization_id
                 AND member.host_profile_id=host.id
                 AND member.status='active'
                 AND (member.user_id=$2 OR lower(member.invited_email)=lower($3))
                 AND member.permissions_json ?| ARRAY['trips_view','trips_manage']
                 AND (
                   NOT EXISTS (
                     SELECT 1 FROM fleet_host_team_vehicle_access scoped
                      WHERE scoped.organization_id=member.organization_id
                        AND scoped.team_member_id=member.id
                   ) OR EXISTS (
                     SELECT 1 FROM fleet_host_team_vehicle_access scoped
                      WHERE scoped.organization_id=member.organization_id
                        AND scoped.team_member_id=member.id
                        AND scoped.vehicle_id=booking.vehicle_id
                   )
                 )
            )
          )
        ORDER BY (change.status='pending') DESC,change.created_at DESC`,
      [
        PUBLIC_ORGANIZATION_ID,
        request.user.id,
        clean(request.user.email, 320),
      ],
    );
    response.json({
      success: true,
      data: result.rows.map(row => ({
        ...changeRequestPayload(row),
        reservationNumber: row.reservation_number,
        currentPickupAt: row.pickup_at,
        currentReturnAt: row.return_at,
        vehicleName: [row.model_year, row.make, row.model]
          .filter(Boolean)
          .join(" "),
        guestName: row.guest_name,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/host/change-requests/:changeRequestId/decision",
  requireHost,
  async (request, response, next) => {
    const client = await pool.connect();
    let guestUserId = null;
    let bookingId = null;
    try {
      const decision = clean(request.body?.decision, 20).toLowerCase();
      const decisionNote = clean(request.body?.note, 2000);
      if (!["approve", "decline"].includes(decision)) {
        return fail(
          response,
          400,
          "INVALID_CHANGE_DECISION",
          "Choose approve or decline.",
        );
      }
      await client.query("BEGIN");
      const recordResult = await client.query(
        `SELECT change.*,booking.*,host.user_id AS host_user_id,
                listing.trip_buffer_hours
           FROM fleet_booking_change_requests change
           JOIN fleet_bookings booking
             ON booking.organization_id=change.organization_id
            AND booking.id=change.booking_id
           JOIN fleet_vehicle_listings listing
             ON listing.organization_id=booking.organization_id
            AND listing.id=booking.listing_id
           JOIN fleet_host_profiles host
             ON host.organization_id=listing.organization_id
            AND host.id=listing.host_profile_id
          WHERE change.organization_id=$1
            AND change.id=$2
            AND (
              host.user_id=$3 OR EXISTS (
                SELECT 1
                  FROM fleet_host_team_members member
                 WHERE member.organization_id=host.organization_id
                   AND member.host_profile_id=host.id
                   AND member.status='active'
                   AND (member.user_id=$3 OR lower(member.invited_email)=lower($4))
                   AND member.permissions_json ? 'trips_manage'
                   AND (
                     NOT EXISTS (
                       SELECT 1 FROM fleet_host_team_vehicle_access scoped
                        WHERE scoped.organization_id=member.organization_id
                          AND scoped.team_member_id=member.id
                     ) OR EXISTS (
                       SELECT 1 FROM fleet_host_team_vehicle_access scoped
                        WHERE scoped.organization_id=member.organization_id
                          AND scoped.team_member_id=member.id
                          AND scoped.vehicle_id=booking.vehicle_id
                     )
                   )
              )
            )
          FOR UPDATE OF change,booking`,
        [
          PUBLIC_ORGANIZATION_ID,
          request.params.changeRequestId,
          request.user.id,
          clean(request.user.email, 320),
        ],
      );
      if (!recordResult.rowCount) {
        await client.query("ROLLBACK");
        return fail(
          response,
          404,
          "CHANGE_REQUEST_NOT_FOUND",
          "Reservation change request not found.",
        );
      }
      const record = recordResult.rows[0];
      if (record.status !== "pending") {
        await client.query("ROLLBACK");
        return fail(
          response,
          409,
          "CHANGE_REQUEST_ALREADY_DECIDED",
          "This change request was already decided.",
        );
      }
      bookingId = record.booking_id;
      guestUserId = record.guest_user_id;
      let quotedTotal = null;
      let appliedAt = null;
      if (decision === "approve") {
        const changes = record.requested_changes || {};
        const pickupAt = changes.pickupAt
          ? normalizedTimestamp(changes.pickupAt, "pickupAt")
          : changes.startDate
            ? rentalTimestamp(
                changes.startDate,
                changes.pickupTime || new Date(record.pickup_at)
                  .toISOString()
                  .slice(11, 16),
                "pickupAt",
              )
            : new Date(record.pickup_at).toISOString();
        const returnAt = changes.returnAt
          ? normalizedTimestamp(changes.returnAt, "returnAt")
          : changes.endDate
            ? rentalTimestamp(
                changes.endDate,
                changes.dropoffTime || new Date(record.return_at)
                  .toISOString()
                  .slice(11, 16),
                "returnAt",
              )
            : new Date(record.return_at).toISOString();
        if (
          Number.isNaN(new Date(pickupAt).getTime()) ||
          Number.isNaN(new Date(returnAt).getTime()) ||
          new Date(returnAt) <= new Date(pickupAt)
        ) {
          await client.query("ROLLBACK");
          return fail(
            response,
            400,
            "INVALID_RENTAL_PERIOD",
            "The requested trip dates are invalid.",
          );
        }
        const listing = await marketplaceListing(client, record.listing_id);
        if (!listing) {
          await client.query("ROLLBACK");
          return fail(
            response,
            409,
            "LISTING_NOT_AVAILABLE",
            "The vehicle listing is no longer available.",
          );
        }
        const quote = await priceQuote(
          client,
          listing,
          {
            pickupLocationId:
              changes.pickupLocationId || record.pickup_branch_id,
            delivery: Boolean(changes.delivery),
          },
          pickupAt,
          returnAt,
        );
        const conflict = await client.query(
          `SELECT 1
             FROM fleet_bookings booking
            WHERE booking.organization_id=$1
              AND booking.vehicle_id=$2
              AND booking.id<>$3
              AND booking.archived_at IS NULL
              AND booking.status=ANY($6::text[])
              AND tsrange(
                (booking.pickup_at AT TIME ZONE 'UTC') -
                  make_interval(hours => $7::integer),
                (booking.return_at AT TIME ZONE 'UTC') +
                  make_interval(hours => $7::integer),
                '[)'
              ) && tsrange(
                ($4::timestamptz AT TIME ZONE 'UTC'),
                ($5::timestamptz AT TIME ZONE 'UTC'),
                '[)'
              )
            LIMIT 1`,
          [
            PUBLIC_ORGANIZATION_ID,
            record.vehicle_id,
            record.booking_id,
            pickupAt,
            returnAt,
            ACTIVE_BOOKING_STATUSES,
            listing.trip_buffer_hours,
          ],
        );
        if (conflict.rowCount) {
          await client.query("ROLLBACK");
          return fail(
            response,
            409,
            "VEHICLE_NOT_AVAILABLE",
            "The vehicle is unavailable for the requested dates.",
          );
        }
        quotedTotal = quote.total;
        appliedAt = new Date().toISOString();
        await client.query(
          `UPDATE fleet_bookings
              SET pickup_at=$3,return_at=$4,
                  pickup_branch_id=COALESCE($5,pickup_branch_id),
                  return_branch_id=COALESCE($6,return_branch_id),
                  total_amount=$7,
                  payment_status=CASE
                    WHEN paid_amount=0 THEN 'unpaid'
                    WHEN paid_amount<$7 THEN 'partial'
                    ELSE 'paid'
                  END,
                  status=CASE
                    WHEN $8='extension' AND status IN ('checked_out','overdue')
                      THEN 'extended'
                    ELSE status
                  END,
                  version=version+1,updated_by=$9,updated_at=NOW()
            WHERE organization_id=$1 AND id=$2`,
          [
            PUBLIC_ORGANIZATION_ID,
            record.booking_id,
            pickupAt,
            returnAt,
            clean(changes.pickupLocationId, 200) || null,
            clean(changes.returnLocationId, 200) || null,
            quote.total.toFixed(2),
            record.request_type,
            request.user.id,
          ],
        );
      }
      const updated = await client.query(
        `UPDATE fleet_booking_change_requests
            SET status=$3,decision_note=$4,decided_by=$5,decided_at=NOW(),
                quoted_total=$6,applied_at=$7,updated_at=NOW()
          WHERE organization_id=$1 AND id=$2
          RETURNING *`,
        [
          PUBLIC_ORGANIZATION_ID,
          record.id,
          decision === "approve" ? "approved" : "declined",
          decisionNote || null,
          request.user.id,
          quotedTotal,
          appliedAt,
        ],
      );
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        `marketplace.booking.change_${decision === "approve" ? "approved" : "declined"}`,
        "booking_change_request",
        record.id,
        {
          bookingId: record.booking_id,
          quotedTotal,
          applied: decision === "approve",
        },
      );
      await client.query("COMMIT");
      await notifyBookingParty({
        organizationId: PUBLIC_ORGANIZATION_ID,
        recipientUserId: guestUserId,
        title: `Reservation change ${decision === "approve" ? "approved" : "declined"}`,
        message:
          decision === "approve"
            ? "Your host approved the requested trip change. Review the updated dates and balance."
            : `Your host declined the requested trip change${decisionNote ? `: ${decisionNote}` : "."}`,
        bookingId,
        actionUrl: "/account/trips",
      });
      response.json({
        success: true,
        data: changeRequestPayload(updated.rows[0]),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

router.post(
  "/reservations/:bookingId/additional-drivers",
  async (request, response, next) => {
    const client = await pool.connect();
    let invitedUser = null;
    try {
      const fullName = clean(request.body?.fullName, 200);
      const email = clean(request.body?.email, 320).toLowerCase();
      if (!fullName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return fail(
          response,
          400,
          "DRIVER_DETAILS_REQUIRED",
          "Enter the additional driver's name and valid email.",
        );
      }
      const booking = await client.query(
        `SELECT id,reservation_number
           FROM fleet_bookings
          WHERE organization_id=$1 AND id=$2 AND guest_user_id=$3
            AND archived_at IS NULL
            AND status NOT IN ('completed','cancelled','refunded','no_show')`,
        [PUBLIC_ORGANIZATION_ID, request.params.bookingId, request.user.id],
      );
      if (!booking.rowCount) {
        return fail(
          response,
          404,
          "BOOKING_NOT_FOUND",
          "Active reservation not found.",
        );
      }
      const account = await client.query(
        `SELECT account.id,account.email,
                customer.license_verification_status
           FROM users account
           LEFT JOIN fleet_customers customer
             ON customer.organization_id=$1
            AND customer.user_id=account.id
            AND customer.archived_at IS NULL
          WHERE lower(account.email)=lower($2)
            AND account.status='active'
          LIMIT 1`,
        [PUBLIC_ORGANIZATION_ID, email],
      );
      invitedUser = account.rows[0] || null;
      await client.query("BEGIN");
      const created = await client.query(
        `INSERT INTO fleet_booking_additional_drivers
          (organization_id,booking_id,invited_by,user_id,full_name,email,
           license_verification_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (organization_id,booking_id,email)
         DO UPDATE SET full_name=EXCLUDED.full_name,user_id=EXCLUDED.user_id,
                       status='invited',
                       license_verification_status=EXCLUDED.license_verification_status,
                       invited_at=NOW(),updated_at=NOW()
         RETURNING *`,
        [
          PUBLIC_ORGANIZATION_ID,
          booking.rows[0].id,
          request.user.id,
          invitedUser?.id || null,
          fullName,
          email,
          invitedUser?.license_verification_status === "verified"
            ? "verified"
            : "pending",
        ],
      );
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        "marketplace.additional_driver.invited",
        "additional_driver",
        created.rows[0].id,
        {
          bookingId: booking.rows[0].id,
          linkedAccount: Boolean(invitedUser?.id),
        },
      );
      await client.query("COMMIT");
      if (invitedUser?.id) {
        await notify({
          recipientUserId: invitedUser.id,
          recipientEmail: invitedUser.email,
          title: "You were added as a GoodFleet driver",
          message: `Review and accept the additional-driver invitation for ${booking.rows[0].reservation_number}.`,
          category: "reservation",
          channel: "in_app",
          actionUrl: "/account/trips",
          notificationKey: "fleet.marketplace.driver_invitation",
          sourceId: created.rows[0].id,
          payload: {
            bookingId: booking.rows[0].id,
            additionalDriverId: created.rows[0].id,
          },
        });
      }
      response.status(201).json({
        success: true,
        data: additionalDriverPayload(created.rows[0]),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      next(error);
    } finally {
      client.release();
    }
  },
);

router.get(
  "/reservations/:bookingId/additional-drivers",
  async (request, response, next) => {
    try {
      const booking = await bookingAccess(request, request.params.bookingId);
      if (!booking) {
        return fail(
          response,
          404,
          "BOOKING_NOT_FOUND",
          "Reservation not found.",
        );
      }
      const result = await query(
        `SELECT *
           FROM fleet_booking_additional_drivers
          WHERE organization_id=$1 AND booking_id=$2 AND status<>'removed'
          ORDER BY invited_at`,
        [PUBLIC_ORGANIZATION_ID, booking.id],
      );
      response.json({
        success: true,
        data: result.rows.map(additionalDriverPayload),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get("/additional-driver-invitations", async (request, response, next) => {
  try {
    const email = clean(request.user.email, 320).toLowerCase();
    const result = await query(
      `SELECT driver.*,booking.reservation_number,booking.pickup_at,
              booking.return_at,vehicle.make,vehicle.model,vehicle.model_year
         FROM fleet_booking_additional_drivers driver
         JOIN fleet_bookings booking
           ON booking.organization_id=driver.organization_id
          AND booking.id=driver.booking_id
         JOIN fleet_vehicles vehicle
           ON vehicle.organization_id=booking.organization_id
          AND vehicle.id=booking.vehicle_id
        WHERE driver.organization_id=$1
          AND lower(driver.email)=lower($2)
          AND driver.status<>'removed'
        ORDER BY driver.invited_at DESC`,
      [PUBLIC_ORGANIZATION_ID, email],
    );
    response.json({
      success: true,
      data: result.rows.map(row => ({
        ...additionalDriverPayload(row),
        reservationNumber: row.reservation_number,
        pickupAt: row.pickup_at,
        returnAt: row.return_at,
        vehicleName: [row.model_year, row.make, row.model]
          .filter(Boolean)
          .join(" "),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/additional-driver-invitations/:driverId/accept",
  async (request, response, next) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const email = clean(request.user.email, 320).toLowerCase();
      const invitation = await client.query(
        `SELECT driver.*,customer.license_verification_status AS customer_license_status
           FROM fleet_booking_additional_drivers driver
           LEFT JOIN fleet_customers customer
             ON customer.organization_id=driver.organization_id
            AND customer.user_id=$3
            AND customer.archived_at IS NULL
          WHERE driver.organization_id=$1
            AND driver.id=$2
            AND lower(driver.email)=lower($4)
            AND driver.status IN ('invited','verification_required')
          FOR UPDATE OF driver`,
        [
          PUBLIC_ORGANIZATION_ID,
          request.params.driverId,
          request.user.id,
          email,
        ],
      );
      if (!invitation.rowCount) {
        await client.query("ROLLBACK");
        return fail(
          response,
          404,
          "DRIVER_INVITATION_NOT_FOUND",
          "Additional-driver invitation not found.",
        );
      }
      const licenseVerified =
        invitation.rows[0].customer_license_status === "verified";
      const updated = await client.query(
        `UPDATE fleet_booking_additional_drivers
            SET user_id=$3,status=$4,license_verification_status=$5,
                accepted_at=COALESCE(accepted_at,NOW()),
                verified_at=CASE WHEN $5='verified' THEN NOW() ELSE NULL END,
                approved_at=CASE WHEN $4='approved' THEN NOW() ELSE NULL END,
                updated_at=NOW()
          WHERE organization_id=$1 AND id=$2
          RETURNING *`,
        [
          PUBLIC_ORGANIZATION_ID,
          invitation.rows[0].id,
          request.user.id,
          licenseVerified ? "approved" : "verification_required",
          licenseVerified ? "verified" : "pending",
        ],
      );
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        "marketplace.additional_driver.accepted",
        "additional_driver",
        invitation.rows[0].id,
        {
          bookingId: invitation.rows[0].booking_id,
          licenseVerified,
        },
      );
      await client.query("COMMIT");
      response.json({
        success: true,
        data: additionalDriverPayload(updated.rows[0]),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

router.post(
  "/admin/additional-drivers/:driverId/review",
  requireEmployee,
  async (request, response, next) => {
    const client = await pool.connect();
    try {
      const decision = clean(request.body?.decision, 20).toLowerCase();
      if (!["approve", "reject"].includes(decision)) {
        return fail(
          response,
          400,
          "INVALID_DRIVER_DECISION",
          "Choose approve or reject.",
        );
      }
      await client.query("BEGIN");
      const driver = await client.query(
        `SELECT driver.*,customer.license_verification_status AS customer_license_status
           FROM fleet_booking_additional_drivers driver
           LEFT JOIN fleet_customers customer
             ON customer.organization_id=driver.organization_id
            AND customer.user_id=driver.user_id
            AND customer.archived_at IS NULL
          WHERE driver.organization_id=$1 AND driver.id=$2
          FOR UPDATE OF driver`,
        [PUBLIC_ORGANIZATION_ID, request.params.driverId],
      );
      if (!driver.rowCount) {
        await client.query("ROLLBACK");
        return fail(
          response,
          404,
          "ADDITIONAL_DRIVER_NOT_FOUND",
          "Additional driver not found.",
        );
      }
      if (
        decision === "approve" &&
        driver.rows[0].customer_license_status !== "verified"
      ) {
        await client.query("ROLLBACK");
        return fail(
          response,
          409,
          "DRIVER_LICENSE_VERIFICATION_REQUIRED",
          "Verify this driver's linked GoodFleet identity before approval.",
        );
      }
      const updated = await client.query(
        `UPDATE fleet_booking_additional_drivers
            SET status=$3,license_verification_status=$4,reviewed_by=$5,
                review_note=$6,
                verified_at=CASE WHEN $4='verified' THEN NOW() ELSE verified_at END,
                approved_at=CASE WHEN $3='approved' THEN NOW() ELSE NULL END,
                updated_at=NOW()
          WHERE organization_id=$1 AND id=$2
          RETURNING *`,
        [
          PUBLIC_ORGANIZATION_ID,
          driver.rows[0].id,
          decision === "approve" ? "approved" : "rejected",
          decision === "approve" ? "verified" : "failed",
          request.user.id,
          clean(request.body?.note, 2000) || null,
        ],
      );
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        `marketplace.additional_driver.${decision === "approve" ? "approved" : "rejected"}`,
        "additional_driver",
        driver.rows[0].id,
        { bookingId: driver.rows[0].booking_id },
      );
      await client.query("COMMIT");
      if (driver.rows[0].user_id) {
        await notifyBookingParty({
          organizationId: PUBLIC_ORGANIZATION_ID,
          recipientUserId: driver.rows[0].user_id,
          title: `Additional-driver access ${decision === "approve" ? "approved" : "not approved"}`,
          message:
            decision === "approve"
              ? "Your GoodFleet driver verification is complete."
              : "GoodFleet could not approve this additional-driver request. Review your identity details.",
          bookingId: driver.rows[0].booking_id,
          actionUrl: "/account/trips",
        });
      }
      response.json({
        success: true,
        data: additionalDriverPayload(updated.rows[0]),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

router.delete(
  "/reservations/:bookingId/additional-drivers/:driverId",
  async (request, response, next) => {
    try {
      const result = await query(
        `UPDATE fleet_booking_additional_drivers driver
            SET status='removed',updated_at=NOW()
          FROM fleet_bookings booking
         WHERE driver.organization_id=$1
           AND driver.id=$2
           AND driver.booking_id=$3
           AND booking.organization_id=driver.organization_id
           AND booking.id=driver.booking_id
           AND booking.guest_user_id=$4
         RETURNING driver.*`,
        [
          PUBLIC_ORGANIZATION_ID,
          request.params.driverId,
          request.params.bookingId,
          request.user.id,
        ],
      );
      if (!result.rowCount) {
        return fail(
          response,
          404,
          "ADDITIONAL_DRIVER_NOT_FOUND",
          "Additional driver not found.",
        );
      }
      response.json({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

router.get("/conversations", async (request, response, next) => {
  try {
    const role = fleetRole(request);
    const result = await query(
      `SELECT conversation.*,booking.reservation_number,booking.status AS booking_status,
              vehicle.make,vehicle.model,vehicle.model_year,
              customer.full_name AS guest_name,
              host.display_name AS host_name,
              (
                SELECT message.body
                  FROM fleet_trip_messages message
                 WHERE message.organization_id=conversation.organization_id
                   AND message.conversation_id=conversation.id
                   AND message.deleted_at IS NULL
                   AND COALESCE(message.scheduled_at,NOW())<=NOW()
                 ORDER BY message.created_at DESC
                 LIMIT 1
              ) AS last_message,
              (
                SELECT COUNT(*)::integer
                  FROM fleet_trip_messages message
                 WHERE message.organization_id=conversation.organization_id
                   AND message.conversation_id=conversation.id
                   AND message.deleted_at IS NULL
                   AND COALESCE(message.scheduled_at,NOW())<=NOW()
                   AND message.created_at>COALESCE(
                     (SELECT read_state.last_read_at
                        FROM fleet_trip_message_reads read_state
                       WHERE read_state.conversation_id=conversation.id
                         AND read_state.user_id=$2),
                     '-infinity'::timestamptz
                   )
                   AND message.sender_user_id<>$2
              ) AS unread_count
         FROM fleet_trip_conversations conversation
         JOIN fleet_bookings booking
           ON booking.organization_id=conversation.organization_id
          AND booking.id=conversation.booking_id
         JOIN fleet_vehicles vehicle
           ON vehicle.organization_id=booking.organization_id
          AND vehicle.id=booking.vehicle_id
         JOIN fleet_customers customer
           ON customer.organization_id=booking.organization_id
          AND customer.id=booking.customer_id
         LEFT JOIN fleet_vehicle_listings listing
           ON listing.organization_id=booking.organization_id
          AND listing.id=booking.listing_id
         LEFT JOIN fleet_host_profiles host
           ON host.organization_id=conversation.organization_id
          AND host.user_id=conversation.host_user_id
        WHERE conversation.organization_id=$1
          AND (
            conversation.guest_user_id=$2
            OR conversation.host_user_id=$2
            OR $3::boolean
            OR EXISTS (
              SELECT 1
                FROM fleet_host_team_members member
               WHERE member.organization_id=conversation.organization_id
                 AND member.host_profile_id=listing.host_profile_id
                 AND member.status='active'
                 AND (member.user_id=$2 OR lower(member.invited_email)=lower($4))
                 AND member.permissions_json ? 'messaging'
                 AND (
                   NOT EXISTS (
                     SELECT 1 FROM fleet_host_team_vehicle_access scoped
                      WHERE scoped.organization_id=member.organization_id
                        AND scoped.team_member_id=member.id
                   ) OR EXISTS (
                     SELECT 1 FROM fleet_host_team_vehicle_access scoped
                      WHERE scoped.organization_id=member.organization_id
                        AND scoped.team_member_id=member.id
                        AND scoped.vehicle_id=booking.vehicle_id
                   )
                 )
            )
          )
        ORDER BY COALESCE(conversation.last_message_at,conversation.created_at) DESC`,
      [
        PUBLIC_ORGANIZATION_ID,
        request.user.id,
        EMPLOYEE_ROLES.has(role),
        clean(request.user.email, 320),
      ],
    );
    response.json({
      success: true,
      data: result.rows.map(row => ({
        id: row.id,
        bookingId: row.booking_id,
        reservationNumber: row.reservation_number,
        bookingStatus: row.booking_status,
        vehicleName: [row.model_year, row.make, row.model]
          .filter(Boolean)
          .join(" "),
        guest: { id: row.guest_user_id, name: row.guest_name },
        host: {
          id: row.host_user_id || null,
          name: row.host_name || "GoodFleet",
        },
        status: row.status,
        lastMessage: row.last_message || null,
        lastMessageAt: row.last_message_at,
        unreadCount: Number(row.unread_count || 0),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get(
  "/conversations/:conversationId/messages",
  async (request, response, next) => {
    try {
      const conversation = await conversationAccess(
        request,
        request.params.conversationId,
      );
      if (!conversation) {
        return fail(
          response,
          404,
          "CONVERSATION_NOT_FOUND",
          "Trip conversation not found.",
        );
      }
      const result = await query(
        `SELECT message.*,account.display_name AS sender_name,
                COALESCE(
                  account.auth_metadata_json->>'avatarUrl',
                  account.auth_metadata_json->>'picture'
                ) AS sender_avatar_url
           FROM fleet_trip_messages message
           JOIN users account ON account.id=message.sender_user_id
          WHERE message.organization_id=$1
            AND message.conversation_id=$2
            AND message.deleted_at IS NULL
            AND (
              message.scheduled_at IS NULL
              OR message.scheduled_at<=NOW()
              OR message.sender_user_id=$3
            )
          ORDER BY message.created_at
          LIMIT 500`,
        [
          conversation.organization_id,
          conversation.id,
          request.user.id,
        ],
      );
      response.json({
        success: true,
        data: {
          conversation: {
            id: conversation.id,
            bookingId: conversation.booking_id,
            reservationNumber: conversation.reservation_number,
            guestName: conversation.guest_name,
            hostName: conversation.host_name || "GoodFleet",
            status: conversation.status,
          },
          messages: result.rows.map(messagePayload),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/conversations/:conversationId/messages",
  async (request, response, next) => {
    const client = await pool.connect();
    let createdMessage = null;
    let conversation = null;
    try {
      conversation = await conversationAccess(
        request,
        request.params.conversationId,
      );
      if (!conversation) {
        return fail(
          response,
          404,
          "CONVERSATION_NOT_FOUND",
          "Trip conversation not found.",
        );
      }
      if (conversation.status !== "active") {
        return fail(
          response,
          409,
          "CONVERSATION_CLOSED",
          "This trip conversation is not active.",
        );
      }
      const body = clean(request.body?.body, 4000);
      if (!body) {
        return fail(
          response,
          400,
          "MESSAGE_REQUIRED",
          "Enter a message.",
        );
      }
      const role = fleetRole(request);
      const senderRole =
        conversation.guest_user_id === request.user.id
          ? "guest"
          : EMPLOYEE_ROLES.has(role)
            ? "staff"
            : "host";
      const scheduledAt = request.body?.scheduledAt
        ? new Date(request.body.scheduledAt)
        : null;
      if (
        scheduledAt &&
        (Number.isNaN(scheduledAt.getTime()) ||
          scheduledAt <= new Date() ||
          senderRole === "guest")
      ) {
        return fail(
          response,
          400,
          "INVALID_MESSAGE_SCHEDULE",
          "Only hosts and staff can schedule a future message.",
        );
      }
      if (!role) {
        return fail(
          response,
          403,
          "GOODFLEET_MEMBERSHIP_REQUIRED",
          "An active GoodFleet account is required.",
        );
      }
      const attachments = Array.isArray(request.body?.attachments)
        ? request.body.attachments.slice(0, 5).map(item => ({
            name: clean(item?.name, 200),
            url: clean(item?.url, 1000),
            type: clean(item?.type, 100),
          }))
        : [];
      if (attachments.some(item => !item.name || !item.url)) {
        return fail(
          response,
          400,
          "INVALID_MESSAGE_ATTACHMENT",
          "Every attachment needs a name and secure URL.",
        );
      }
      const clientMessageId =
        clean(
          request.body?.clientMessageId ||
            request.get("Idempotency-Key"),
          200,
        ) || crypto.randomUUID();

      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO fleet_trip_messages
          (organization_id,conversation_id,sender_user_id,sender_role,body,
           client_message_id,attachments_json,scheduled_at,delivered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,
                 CASE WHEN $8::timestamptz IS NULL THEN NOW() ELSE NULL END)
         ON CONFLICT (organization_id,sender_user_id,client_message_id)
         DO UPDATE SET client_message_id=EXCLUDED.client_message_id
         RETURNING *`,
        [
          conversation.organization_id,
          conversation.id,
          request.user.id,
          senderRole,
          body,
          clientMessageId,
          JSON.stringify(attachments),
          scheduledAt ? scheduledAt.toISOString() : null,
        ],
      );
      createdMessage = result.rows[0];
      await client.query(
        `UPDATE fleet_trip_conversations
            SET last_message_at=CASE WHEN $3::timestamptz IS NULL THEN NOW()
                                     ELSE last_message_at END,
                updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [
          conversation.organization_id,
          conversation.id,
          scheduledAt ? scheduledAt.toISOString() : null,
        ],
      );
      await client.query(
        `INSERT INTO fleet_trip_message_reads (conversation_id,user_id,last_read_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (conversation_id,user_id)
         DO UPDATE SET last_read_at=NOW()`,
        [conversation.id, request.user.id],
      );
      await audit(
        client,
        request,
        conversation.organization_id,
        scheduledAt
          ? "marketplace.message.scheduled"
          : "marketplace.message.sent",
        "trip_message",
        createdMessage.id,
        {
          conversationId: conversation.id,
          bookingId: conversation.booking_id,
          senderRole,
          scheduledAt: scheduledAt?.toISOString() || null,
        },
      );
      await client.query("COMMIT");

      if (!scheduledAt) {
        const recipientUserId =
          senderRole === "guest"
            ? conversation.host_user_id
            : conversation.guest_user_id;
        await notifyBookingParty({
          organizationId: conversation.organization_id,
          recipientUserId,
          title: `New message for ${conversation.reservation_number}`,
          message: `${request.user.displayName || "A GoodFleet user"} sent a trip message.`,
          bookingId: conversation.booking_id,
          actionUrl:
            senderRole === "guest"
              ? conversation.host_user_id
                ? `/host/messages?booking=${encodeURIComponent(conversation.booking_id)}`
                : `/communications?trip=${conversation.id}`
              : `/account/messages?booking=${encodeURIComponent(conversation.booking_id)}`,
        });
      }
      response.status(201).json({
        success: true,
        data: messagePayload({
          ...createdMessage,
          sender_name: request.user.displayName,
          sender_avatar_url: request.user.avatarUrl,
        }),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      next(error);
    } finally {
      client.release();
    }
  },
);

router.post(
  "/conversations/:conversationId/read",
  async (request, response, next) => {
    try {
      const conversation = await conversationAccess(
        request,
        request.params.conversationId,
      );
      if (!conversation) {
        return fail(
          response,
          404,
          "CONVERSATION_NOT_FOUND",
          "Trip conversation not found.",
        );
      }
      await query(
        `INSERT INTO fleet_trip_message_reads (conversation_id,user_id,last_read_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (conversation_id,user_id)
         DO UPDATE SET last_read_at=NOW()`,
        [conversation.id, request.user.id],
      );
      response.json({ success: true, data: { read: true } });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/conversations/:conversationId/reports",
  async (request, response, next) => {
    const client = await pool.connect();
    try {
      const conversation = await conversationAccess(
        request,
        request.params.conversationId,
      );
      if (!conversation) {
        return fail(
          response,
          404,
          "CONVERSATION_NOT_FOUND",
          "Trip conversation not found.",
        );
      }
      const messageId = clean(request.body?.messageId, 80);
      const reason = clean(request.body?.reason, 40).toLowerCase();
      const details = clean(request.body?.details, 2000);
      if (!messageId || !MESSAGE_REPORT_REASONS.has(reason)) {
        return fail(
          response,
          400,
          "INVALID_MESSAGE_REPORT",
          "Select a message and a valid safety reason.",
        );
      }

      await client.query("BEGIN");
      const messageResult = await client.query(
        `SELECT id,sender_user_id
           FROM fleet_trip_messages
          WHERE organization_id=$1
            AND conversation_id=$2
            AND id=$3
            AND deleted_at IS NULL
          FOR UPDATE`,
        [conversation.organization_id, conversation.id, messageId],
      );
      const reportedMessage = messageResult.rows[0];
      if (!reportedMessage) {
        await client.query("ROLLBACK");
        return fail(
          response,
          404,
          "MESSAGE_NOT_FOUND",
          "The reported message was not found in this trip.",
        );
      }
      if (reportedMessage.sender_user_id === request.user.id) {
        await client.query("ROLLBACK");
        return fail(
          response,
          400,
          "CANNOT_REPORT_OWN_MESSAGE",
          "You cannot report your own message.",
        );
      }

      const reportResult = await client.query(
        `INSERT INTO fleet_trip_message_reports
          (organization_id,conversation_id,message_id,reporter_user_id,reason,details)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (organization_id,message_id,reporter_user_id)
         DO UPDATE SET reason=EXCLUDED.reason,
                       details=EXCLUDED.details,
                       status='open',
                       reviewed_by=NULL,
                       reviewed_at=NULL,
                       resolution_notes='',
                       updated_at=NOW()
         RETURNING id,status,created_at,updated_at`,
        [
          conversation.organization_id,
          conversation.id,
          reportedMessage.id,
          request.user.id,
          reason,
          details,
        ],
      );
      await client.query(
        `UPDATE fleet_trip_messages
            SET moderation_status='flagged'
          WHERE organization_id=$1 AND id=$2`,
        [conversation.organization_id, reportedMessage.id],
      );
      await audit(
        client,
        request,
        conversation.organization_id,
        "marketplace.message.reported",
        "trip_message_report",
        reportResult.rows[0].id,
        {
          conversationId: conversation.id,
          messageId: reportedMessage.id,
          bookingId: conversation.booking_id,
          reason,
        },
      );
      await client.query("COMMIT");

      const operators = await query(
        `SELECT DISTINCT membership.user_id
           FROM app_memberships membership
          WHERE membership.app_id='goodfleet'
            AND membership.status='active'
            AND membership.role IN ('owner','admin','manager')`,
      );
      await Promise.allSettled(
        operators.rows.map(operator =>
          notifyBookingParty({
            organizationId: conversation.organization_id,
            recipientUserId: operator.user_id,
            title: "Trip message safety report",
            message: `A message for ${conversation.reservation_number} needs review.`,
            bookingId: conversation.booking_id,
            actionUrl: `/communications?trip=${encodeURIComponent(conversation.id)}&reported=1`,
            notificationKey: "fleet.marketplace.message_report",
          }),
        ),
      );
      response.status(201).json({
        success: true,
        data: {
          id: reportResult.rows[0].id,
          status: reportResult.rows[0].status,
          createdAt: reportResult.rows[0].created_at,
          updatedAt: reportResult.rows[0].updated_at,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      next(error);
    } finally {
      client.release();
    }
  },
);

router.get(
  "/reservations/:bookingId/reviews",
  async (request, response, next) => {
    try {
      const booking = await bookingAccess(request, request.params.bookingId);
      if (!booking) {
        return fail(
          response,
          404,
          "BOOKING_NOT_FOUND",
          "Reservation not found.",
        );
      }
      const result = await query(
        `SELECT review.*,COALESCE(account.display_name,account.email) AS reviewer_name
           FROM fleet_trip_reviews review
           JOIN users account ON account.id=review.reviewer_user_id
          WHERE review.organization_id=$1 AND review.booking_id=$2
            AND (
              review.status='published' OR
              review.reviewer_user_id=$3 OR
              $4::boolean
            )
          ORDER BY review.created_at`,
        [
          PUBLIC_ORGANIZATION_ID,
          booking.id,
          request.user.id,
          EMPLOYEE_ROLES.has(fleetRole(request)),
        ],
      );
      response.json({
        success: true,
        data: result.rows.map(reviewPayload),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/reservations/:bookingId/reviews",
  async (request, response, next) => {
    const client = await pool.connect();
    let revieweeUserId = null;
    try {
      const rating = Number(request.body?.rating);
      const body = clean(request.body?.body, 2000);
      const privateFeedback = clean(request.body?.privateFeedback, 2000);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return fail(
          response,
          400,
          "INVALID_REVIEW_RATING",
          "Choose a rating from one to five.",
        );
      }
      await client.query("BEGIN");
      const access = await client.query(
        `SELECT booking.*,customer.user_id AS guest_user_id,
                host.user_id AS host_user_id
           FROM fleet_bookings booking
           JOIN fleet_customers customer
             ON customer.organization_id=booking.organization_id
            AND customer.id=booking.customer_id
           LEFT JOIN fleet_vehicle_listings listing
             ON listing.organization_id=booking.organization_id
            AND listing.id=booking.listing_id
           LEFT JOIN fleet_host_profiles host
             ON host.organization_id=listing.organization_id
            AND host.id=listing.host_profile_id
          WHERE booking.organization_id=$1 AND booking.id=$2
            AND booking.archived_at IS NULL
          FOR SHARE OF booking`,
        [PUBLIC_ORGANIZATION_ID, request.params.bookingId],
      );
      if (!access.rowCount) {
        await client.query("ROLLBACK");
        return fail(
          response,
          404,
          "BOOKING_NOT_FOUND",
          "Reservation not found.",
        );
      }
      const booking = access.rows[0];
      if (booking.status !== "completed") {
        await client.query("ROLLBACK");
        return fail(
          response,
          409,
          "TRIP_NOT_COMPLETED",
          "Reviews open after the trip is completed.",
        );
      }
      const reviewerRole =
        booking.guest_user_id === request.user.id
          ? "guest"
          : booking.host_user_id === request.user.id
            ? "host"
            : null;
      if (!reviewerRole) {
        await client.query("ROLLBACK");
        return fail(
          response,
          403,
          "REVIEW_NOT_ALLOWED",
          "Only the guest or host for this trip can leave a review.",
        );
      }
      revieweeUserId =
        reviewerRole === "guest"
          ? booking.host_user_id
          : booking.guest_user_id;
      const saved = await client.query(
        `INSERT INTO fleet_trip_reviews
          (organization_id,booking_id,reviewer_user_id,reviewee_user_id,
           reviewer_role,rating,body,private_feedback)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (organization_id,booking_id,reviewer_user_id)
         DO UPDATE SET rating=EXCLUDED.rating,body=EXCLUDED.body,
                       private_feedback=EXCLUDED.private_feedback,
                       status='published',updated_at=NOW()
         RETURNING *`,
        [
          PUBLIC_ORGANIZATION_ID,
          booking.id,
          request.user.id,
          revieweeUserId,
          reviewerRole,
          rating,
          body,
          privateFeedback || null,
        ],
      );
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        "marketplace.trip.reviewed",
        "trip_review",
        saved.rows[0].id,
        { bookingId: booking.id, reviewerRole, rating },
      );
      await client.query("COMMIT");
      if (revieweeUserId) {
        await notifyBookingParty({
          organizationId: PUBLIC_ORGANIZATION_ID,
          recipientUserId: revieweeUserId,
          title: "New GoodFleet trip review",
          message: `A ${reviewerRole} left a ${rating}-star review.`,
          bookingId: booking.id,
          actionUrl:
            reviewerRole === "guest" ? "/host/trips" : "/account/trips",
        });
      }
      response.status(201).json({
        success: true,
        data: reviewPayload(saved.rows[0]),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

router.post(
  "/reviews/:reviewId/respond",
  requireHost,
  async (request, response, next) => {
    const client = await pool.connect();
    try {
      const responseBody = clean(request.body?.response, 2000);
      if (!responseBody) {
        return fail(
          response,
          400,
          "REVIEW_RESPONSE_REQUIRED",
          "Enter a public response.",
        );
      }
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE fleet_trip_reviews review
            SET response=$4,responded_at=NOW(),updated_at=NOW()
           FROM fleet_bookings booking
           JOIN fleet_vehicle_listings listing
             ON listing.organization_id=booking.organization_id
            AND listing.id=booking.listing_id
           JOIN fleet_host_profiles host
             ON host.organization_id=listing.organization_id
            AND host.id=listing.host_profile_id
          WHERE review.organization_id=$1
            AND review.id=$2
            AND review.booking_id=booking.id
            AND host.user_id=$3
            AND review.reviewer_role='guest'
          RETURNING review.*`,
        [
          PUBLIC_ORGANIZATION_ID,
          request.params.reviewId,
          request.user.id,
          responseBody,
        ],
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return fail(
          response,
          404,
          "REVIEW_NOT_FOUND",
          "Guest review not found.",
        );
      }
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        "marketplace.review.responded",
        "trip_review",
        updated.rows[0].id,
        { bookingId: updated.rows[0].booking_id },
      );
      await client.query("COMMIT");
      response.json({
        success: true,
        data: reviewPayload(updated.rows[0]),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

router.get("/host/performance", requireHost, async (request, response, next) => {
  try {
    const result = await query(
      `SELECT
         COUNT(DISTINCT booking.id) FILTER (
           WHERE booking.status='completed'
         )::integer AS completed_trips,
         COUNT(DISTINCT booking.id) FILTER (
           WHERE booking.status IN ('cancelled','no_show')
         )::integer AS cancelled_trips,
         COUNT(DISTINCT listing.id) FILTER (
           WHERE listing.status='active'
         )::integer AS active_listings,
         COALESCE(ROUND(AVG(review.rating)::numeric,2),0) AS average_rating,
         COUNT(DISTINCT review.id)::integer AS review_count,
         COALESCE(SUM(booking.total_amount) FILTER (
           WHERE booking.status NOT IN ('cancelled','refunded','no_show')
         ),0) AS gross_booking_value
       FROM fleet_host_profiles host
       LEFT JOIN fleet_vehicle_listings listing
         ON listing.organization_id=host.organization_id
        AND listing.host_profile_id=host.id
        AND listing.archived_at IS NULL
       LEFT JOIN fleet_bookings booking
         ON booking.organization_id=listing.organization_id
        AND booking.listing_id=listing.id
        AND booking.archived_at IS NULL
       LEFT JOIN fleet_trip_reviews review
         ON review.organization_id=booking.organization_id
        AND review.booking_id=booking.id
        AND review.reviewer_role='guest'
        AND review.status='published'
      WHERE host.organization_id=$1 AND host.user_id=$2
      GROUP BY host.id`,
      [PUBLIC_ORGANIZATION_ID, request.user.id],
    );
    response.json({
      success: true,
      data: result.rows[0] || {
        completed_trips: 0,
        cancelled_trips: 0,
        active_listings: 0,
        average_rating: 0,
        review_count: 0,
        gross_booking_value: 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

async function claimRecord(claimId) {
  const result = await query(
    `SELECT claim.*,booking.reservation_number,booking.guest_user_id,
            host.user_id AS host_user_id,
            vehicle.make,vehicle.model,vehicle.model_year,
            COALESCE(evidence.items,'[]'::jsonb) AS evidence,
            COALESCE(events.items,'[]'::jsonb) AS events
       FROM fleet_claim_cases claim
       JOIN fleet_bookings booking
         ON booking.organization_id=claim.organization_id
        AND booking.id=claim.booking_id
       JOIN fleet_vehicles vehicle
         ON vehicle.organization_id=claim.organization_id
        AND vehicle.id=claim.vehicle_id
       LEFT JOIN fleet_vehicle_listings listing
         ON listing.organization_id=booking.organization_id
        AND listing.id=booking.listing_id
       LEFT JOIN fleet_host_profiles host
         ON host.organization_id=listing.organization_id
        AND host.id=listing.host_profile_id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'id',item.id,'type',item.evidence_type,'fileName',item.file_name,
             'fileUrl',item.file_url,'mimeType',item.mime_type,'note',item.note,
             'createdAt',item.created_at
           ) ORDER BY item.created_at
         ) AS items
           FROM fleet_claim_evidence item
          WHERE item.organization_id=claim.organization_id
            AND item.claim_id=claim.id
       ) evidence ON TRUE
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'id',event.id,'action',event.action,'details',event.details_json,
             'actorId',event.actor_id,'createdAt',event.created_at
           ) ORDER BY event.created_at
         ) AS items
           FROM fleet_claim_events event
          WHERE event.organization_id=claim.organization_id
            AND event.claim_id=claim.id
       ) events ON TRUE
      WHERE claim.organization_id=$1 AND claim.id=$2
      LIMIT 1`,
    [PUBLIC_ORGANIZATION_ID, claimId],
  );
  return result.rows[0] || null;
}

function canAccessClaim(request, record) {
  const role = fleetRole(request);
  return Boolean(
    record &&
      (record.guest_user_id === request.user.id ||
        record.host_user_id === request.user.id ||
        EMPLOYEE_ROLES.has(role)),
  );
}

router.get("/claims", async (request, response, next) => {
  try {
    const role = fleetRole(request);
    const result = await query(
      `SELECT claim.id
         FROM fleet_claim_cases claim
         JOIN fleet_bookings booking
           ON booking.organization_id=claim.organization_id
          AND booking.id=claim.booking_id
         LEFT JOIN fleet_vehicle_listings listing
           ON listing.organization_id=booking.organization_id
          AND listing.id=booking.listing_id
         LEFT JOIN fleet_host_profiles host
           ON host.organization_id=listing.organization_id
          AND host.id=listing.host_profile_id
        WHERE claim.organization_id=$1
          AND (
            $3::boolean OR booking.guest_user_id=$2 OR host.user_id=$2
          )
        ORDER BY claim.updated_at DESC
        LIMIT 200`,
      [
        PUBLIC_ORGANIZATION_ID,
        request.user.id,
        EMPLOYEE_ROLES.has(role),
      ],
    );
    const records = await Promise.all(
      result.rows.map(row => claimRecord(row.id)),
    );
    response.json({
      success: true,
      data: records.filter(Boolean).map(claimPayload),
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/reservations/:bookingId/claims",
  async (request, response, next) => {
    const client = await pool.connect();
    try {
      const description = clean(request.body?.description, 4000);
      const incidentAt = request.body?.incidentAt
        ? new Date(request.body.incidentAt)
        : new Date();
      if (description.length < 10 || Number.isNaN(incidentAt.getTime())) {
        return fail(
          response,
          400,
          "CLAIM_DETAILS_REQUIRED",
          "Describe the incident and provide a valid incident date.",
        );
      }
      const booking = await bookingAccess(request, request.params.bookingId);
      if (!booking) {
        return fail(
          response,
          404,
          "BOOKING_NOT_FOUND",
          "Reservation not found.",
        );
      }
      await client.query("BEGIN");
      const created = await client.query(
        `INSERT INTO fleet_claim_cases
          (organization_id,booking_id,vehicle_id,reported_by,incident_at,
           description,liability)
         VALUES ($1,$2,$3,$4,$5,$6,'undetermined')
         RETURNING *`,
        [
          PUBLIC_ORGANIZATION_ID,
          booking.id,
          booking.vehicle_id,
          request.user.id,
          incidentAt.toISOString(),
          description,
        ],
      );
      await client.query(
        `INSERT INTO fleet_claim_events
          (organization_id,claim_id,actor_id,action,details_json)
         VALUES ($1,$2,$3,'claim.reported',$4::jsonb)`,
        [
          PUBLIC_ORGANIZATION_ID,
          created.rows[0].id,
          request.user.id,
          JSON.stringify({ description }),
        ],
      );
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        "marketplace.claim.reported",
        "claim",
        created.rows[0].id,
        { bookingId: booking.id },
      );
      await client.query("COMMIT");
      const recipients = await operatorRecipients(
        PUBLIC_ORGANIZATION_ID,
        request.user.id,
      );
      await Promise.all(
        recipients.map(recipient =>
          notify({
            recipientUserId: recipient.id,
            recipientEmail: recipient.email,
            title: "New trip claim requires review",
            message: `A claim was reported for ${booking.reservation_number}.`,
            category: "trip",
            channel: "in_app",
            actionUrl: "/operations?tab=damage-claims",
            notificationKey: "fleet.marketplace.claim_reported",
            sourceId: created.rows[0].id,
            payload: { bookingId: booking.id, claimId: created.rows[0].id },
          }),
        ),
      );
      response.status(201).json({
        success: true,
        data: claimPayload({
          ...created.rows[0],
          reservation_number: booking.reservation_number,
          make: booking.make,
          model: booking.model,
          model_year: booking.model_year,
          evidence: [],
          events: [],
        }),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

router.post(
  "/claims/:claimId/evidence",
  async (request, response, next) => {
    const client = await pool.connect();
    try {
      const record = await claimRecord(request.params.claimId);
      if (!canAccessClaim(request, record)) {
        return fail(
          response,
          404,
          "CLAIM_NOT_FOUND",
          "Claim not found.",
        );
      }
      const evidenceType = clean(request.body?.evidenceType, 40);
      const fileName = clean(request.body?.fileName, 300);
      const fileUrl = clean(request.body?.fileUrl, 2000);
      if (
        !CLAIM_EVIDENCE_TYPES.has(evidenceType) ||
        !fileName ||
        !/^(https:\/\/|\/api\/)/.test(fileUrl)
      ) {
        return fail(
          response,
          400,
          "INVALID_CLAIM_EVIDENCE",
          "Choose an evidence type and a secure uploaded file.",
        );
      }
      await client.query("BEGIN");
      const created = await client.query(
        `INSERT INTO fleet_claim_evidence
          (organization_id,claim_id,uploaded_by,evidence_type,file_name,
           file_url,mime_type,checksum_sha256,note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          PUBLIC_ORGANIZATION_ID,
          record.id,
          request.user.id,
          evidenceType,
          fileName,
          fileUrl,
          clean(request.body?.mimeType, 160) || null,
          clean(request.body?.checksumSha256, 64) || null,
          clean(request.body?.note, 2000) || null,
        ],
      );
      await client.query(
        `INSERT INTO fleet_claim_events
          (organization_id,claim_id,actor_id,action,details_json)
         VALUES ($1,$2,$3,'claim.evidence_added',$4::jsonb)`,
        [
          PUBLIC_ORGANIZATION_ID,
          record.id,
          request.user.id,
          JSON.stringify({
            evidenceId: created.rows[0].id,
            evidenceType,
            fileName,
          }),
        ],
      );
      await client.query(
        `UPDATE fleet_claim_cases
            SET status=CASE WHEN status='reported' THEN 'evidence_review' ELSE status END,
                updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [PUBLIC_ORGANIZATION_ID, record.id],
      );
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        "marketplace.claim.evidence_added",
        "claim",
        record.id,
        { evidenceId: created.rows[0].id, evidenceType },
      );
      await client.query("COMMIT");
      response.status(201).json({
        success: true,
        data: {
          id: created.rows[0].id,
          type: created.rows[0].evidence_type,
          fileName: created.rows[0].file_name,
          fileUrl: created.rows[0].file_url,
          mimeType: created.rows[0].mime_type,
          note: created.rows[0].note,
          createdAt: created.rows[0].created_at,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

router.post(
  "/claims/:claimId/evidence-file",
  receiveClaimEvidence,
  async (request, response, next) => {
    const client = await pool.connect();
    let storedPath = null;
    try {
      const record = await claimRecord(request.params.claimId);
      if (!canAccessClaim(request, record)) {
        return fail(
          response,
          404,
          "CLAIM_NOT_FOUND",
          "Claim not found.",
        );
      }
      const detected = claimEvidenceFileType(request.file);
      if (!detected) {
        return fail(
          response,
          400,
          "INVALID_CLAIM_EVIDENCE_FILE",
          "Upload a JPEG, PNG, WebP, or PDF file.",
        );
      }
      const requestedType = clean(request.body?.evidenceType, 40);
      const evidenceType = CLAIM_EVIDENCE_TYPES.has(requestedType)
        ? requestedType
        : detected.evidenceType;
      const evidenceId = crypto.randomUUID();
      const storedName = `${evidenceId}.${detected.extension}`;
      storedPath = safeClaimEvidencePath(storedName);
      await fs.promises.mkdir(CLAIM_EVIDENCE_ROOT, {
        recursive: true,
        mode: 0o750,
      });
      await fs.promises.writeFile(storedPath, request.file.buffer, {
        mode: 0o640,
        flag: "wx",
      });
      const checksum = crypto
        .createHash("sha256")
        .update(request.file.buffer)
        .digest("hex");
      const fileUrl =
        `/api/fleet/v1/marketplace/claims/evidence/${evidenceId}/file`;
      await client.query("BEGIN");
      const created = await client.query(
        `INSERT INTO fleet_claim_evidence
          (id,organization_id,claim_id,uploaded_by,evidence_type,file_name,
           file_url,mime_type,checksum_sha256,note,storage_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          evidenceId,
          PUBLIC_ORGANIZATION_ID,
          record.id,
          request.user.id,
          evidenceType,
          clean(request.file.originalname, 300) || `claim-evidence.${detected.extension}`,
          fileUrl,
          detected.mimeType,
          checksum,
          clean(request.body?.note, 2000) || null,
          storedName,
        ],
      );
      await client.query(
        `INSERT INTO fleet_claim_events
          (organization_id,claim_id,actor_id,action,details_json)
         VALUES ($1,$2,$3,'claim.evidence_added',$4::jsonb)`,
        [
          PUBLIC_ORGANIZATION_ID,
          record.id,
          request.user.id,
          JSON.stringify({
            evidenceId,
            evidenceType,
            fileName: created.rows[0].file_name,
            checksumSha256: checksum,
          }),
        ],
      );
      await client.query(
        `UPDATE fleet_claim_cases
            SET status=CASE WHEN status='reported' THEN 'evidence_review' ELSE status END,
                updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [PUBLIC_ORGANIZATION_ID, record.id],
      );
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        "marketplace.claim.evidence_added",
        "claim",
        record.id,
        { evidenceId, evidenceType, checksumSha256: checksum },
      );
      await client.query("COMMIT");
      response.status(201).json({
        success: true,
        data: {
          id: evidenceId,
          type: evidenceType,
          fileName: created.rows[0].file_name,
          fileUrl,
          mimeType: detected.mimeType,
          note: created.rows[0].note,
          createdAt: created.rows[0].created_at,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      if (storedPath) await fs.promises.unlink(storedPath).catch(() => null);
      next(error);
    } finally {
      client.release();
    }
  },
);

router.get(
  "/claims/evidence/:evidenceId/file",
  async (request, response, next) => {
    try {
      const result = await query(
        `SELECT evidence.*,claim.booking_id
           FROM fleet_claim_evidence evidence
           JOIN fleet_claim_cases claim
             ON claim.organization_id=evidence.organization_id
            AND claim.id=evidence.claim_id
          WHERE evidence.organization_id=$1 AND evidence.id=$2
          LIMIT 1`,
        [PUBLIC_ORGANIZATION_ID, request.params.evidenceId],
      );
      const evidence = result.rows[0];
      const record = evidence ? await claimRecord(evidence.claim_id) : null;
      if (!canAccessClaim(request, record)) {
        return fail(
          response,
          404,
          "CLAIM_EVIDENCE_NOT_FOUND",
          "Claim evidence not found.",
        );
      }
      const filePath = safeClaimEvidencePath(evidence.storage_reference);
      if (!filePath) {
        return fail(
          response,
          404,
          "CLAIM_EVIDENCE_NOT_FOUND",
          "Claim evidence not found.",
        );
      }
      await fs.promises.access(filePath, fs.constants.R_OK);
      response.set({
        "Content-Type": evidence.mime_type || "application/octet-stream",
        "Content-Disposition":
          `inline; filename="${clean(evidence.file_name, 200).replaceAll('"', "")}"`,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      });
      response.sendFile(filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return fail(
          response,
          404,
          "CLAIM_EVIDENCE_NOT_FOUND",
          "Claim evidence not found.",
        );
      }
      next(error);
    }
  },
);

router.patch(
  "/claims/:claimId",
  requireEmployee,
  async (request, response, next) => {
    const client = await pool.connect();
    try {
      const status = clean(request.body?.status, 40);
      const liability = clean(request.body?.liability, 40);
      if (!CLAIM_STATUSES.has(status)) {
        return fail(
          response,
          400,
          "INVALID_CLAIM_STATUS",
          "Choose a valid claim workflow status.",
        );
      }
      if (liability && !CLAIM_LIABILITY.has(liability)) {
        return fail(
          response,
          400,
          "INVALID_CLAIM_LIABILITY",
          "Choose a valid liability classification.",
        );
      }
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE fleet_claim_cases
            SET status=$3,liability=COALESCE(NULLIF($4,''),liability),
                assigned_to=COALESCE($5,assigned_to),
                estimated_amount=COALESCE($6,estimated_amount),
                final_amount=COALESCE($7,final_amount),
                insurer_name=COALESCE(NULLIF($8,''),insurer_name),
                insurer_claim_reference=COALESCE(NULLIF($9,''),insurer_claim_reference),
                decision_note=COALESCE(NULLIF($10,''),decision_note),
                resolved_at=CASE WHEN $3 IN ('settled','closed','denied') THEN NOW() ELSE NULL END,
                updated_at=NOW()
          WHERE organization_id=$1 AND id=$2
          RETURNING *`,
        [
          PUBLIC_ORGANIZATION_ID,
          request.params.claimId,
          status,
          liability,
          clean(request.body?.assignedTo, 80) || null,
          Number.isFinite(Number(request.body?.estimatedAmount))
            ? Math.max(0, Number(request.body.estimatedAmount))
            : null,
          Number.isFinite(Number(request.body?.finalAmount))
            ? Math.max(0, Number(request.body.finalAmount))
            : null,
          clean(request.body?.insurerName, 300),
          clean(request.body?.insurerClaimReference, 300),
          clean(request.body?.decisionNote, 4000),
        ],
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return fail(
          response,
          404,
          "CLAIM_NOT_FOUND",
          "Claim not found.",
        );
      }
      await client.query(
        `INSERT INTO fleet_claim_events
          (organization_id,claim_id,actor_id,action,details_json)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          PUBLIC_ORGANIZATION_ID,
          updated.rows[0].id,
          request.user.id,
          `claim.${status}`,
          JSON.stringify({
            liability: liability || updated.rows[0].liability,
            decisionNote: clean(request.body?.decisionNote, 4000) || null,
          }),
        ],
      );
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        `marketplace.claim.${status}`,
        "claim",
        updated.rows[0].id,
        { status, liability: updated.rows[0].liability },
      );
      await client.query("COMMIT");
      const hydrated = await claimRecord(updated.rows[0].id);
      const recipients = [
        hydrated?.guest_user_id,
        hydrated?.host_user_id,
      ].filter(Boolean);
      await Promise.all(
        [...new Set(recipients)].map(recipientUserId =>
          notifyBookingParty({
            organizationId: PUBLIC_ORGANIZATION_ID,
            recipientUserId,
            title: "Trip claim updated",
            message: `Claim status changed to ${status.replaceAll("_", " ")}.`,
            bookingId: updated.rows[0].booking_id,
            actionUrl: "/account/trips",
          }),
        ),
      );
      response.json({ success: true, data: claimPayload(hydrated) });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

router.post("/claims/:claimId/dispute", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const note = clean(request.body?.note, 4000);
    if (note.length < 10) {
      return fail(
        response,
        400,
        "DISPUTE_DETAILS_REQUIRED",
        "Explain why this claim needs another review.",
      );
    }
    const record = await claimRecord(request.params.claimId);
    const role = fleetRole(request);
    const allowed =
      record &&
      (record.guest_user_id === request.user.id ||
        record.host_user_id === request.user.id ||
        EMPLOYEE_ROLES.has(role));
    if (!allowed) {
      return fail(response, 404, "CLAIM_NOT_FOUND", "Claim not found.");
    }
    await client.query("BEGIN");
    await client.query(
      `UPDATE fleet_claim_cases
          SET status='disputed',decision_note=$3,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [PUBLIC_ORGANIZATION_ID, record.id, note],
    );
    await client.query(
      `INSERT INTO fleet_claim_events
        (organization_id,claim_id,actor_id,action,details_json)
       VALUES ($1,$2,$3,'claim.disputed',$4::jsonb)`,
      [
        PUBLIC_ORGANIZATION_ID,
        record.id,
        request.user.id,
        JSON.stringify({ note }),
      ],
    );
    await audit(
      client,
      request,
      PUBLIC_ORGANIZATION_ID,
      "marketplace.claim.disputed",
      "claim",
      record.id,
      { note },
    );
    await client.query("COMMIT");
    response.json({
      success: true,
      data: claimPayload(await claimRecord(record.id)),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/host/profile", requireHost, async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const profile =
      (await hostProfileForRequest(client, request)) ||
      (await ensureHostProfile(client, request));
    await client.query("COMMIT");
    response.json({ success: true, data: profile });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.patch("/host/profile", requireHost, async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const profile = await ensureHostProfile(client, request, request.body || {});
    const updated = await client.query(
      `UPDATE fleet_host_profiles
          SET display_name=$3,support_phone=$4,bio=$5,
              onboarding_status=CASE
                WHEN identity_verification_status='verified' THEN 'vehicle_required'
                ELSE 'identity_required'
              END,
              updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
        RETURNING *`,
      [
        PUBLIC_ORGANIZATION_ID,
        profile.id,
        clean(request.body?.displayName, 200) || profile.display_name,
        clean(request.body?.supportPhone, 50) || profile.support_phone,
        clean(request.body?.bio, 2000) || profile.bio,
      ],
    );
    await client.query("COMMIT");
    response.json({ success: true, data: updated.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/host/listings", requireHost, async (request, response, next) => {
  try {
    const result = await query(
      `SELECT listing.*,vehicle.vin,vehicle.license_plate,vehicle.make,
              vehicle.model,vehicle.model_year,vehicle.status AS vehicle_status,
              vehicle.daily_rate,vehicle.registration_expiry,
              vehicle.insurance_expiry,vehicle.payload AS vehicle_payload
         FROM fleet_host_profiles host
         JOIN fleet_vehicle_listings listing
           ON listing.organization_id=host.organization_id
          AND listing.host_profile_id=host.id
         JOIN fleet_vehicles vehicle
           ON vehicle.organization_id=listing.organization_id
          AND vehicle.id=listing.vehicle_id
        WHERE host.organization_id=$1
          AND (
            host.user_id=$2 OR EXISTS (
              SELECT 1
                FROM fleet_host_team_members member
               WHERE member.organization_id=host.organization_id
                 AND member.host_profile_id=host.id
                 AND member.status='active'
                 AND (member.user_id=$2 OR lower(member.invited_email)=lower($3))
                 AND member.permissions_json ?| ARRAY['listing_view','listing_manage']
                 AND (
                   NOT EXISTS (
                     SELECT 1 FROM fleet_host_team_vehicle_access scoped
                      WHERE scoped.organization_id=member.organization_id
                        AND scoped.team_member_id=member.id
                   ) OR EXISTS (
                     SELECT 1 FROM fleet_host_team_vehicle_access scoped
                      WHERE scoped.organization_id=member.organization_id
                        AND scoped.team_member_id=member.id
                        AND scoped.vehicle_id=listing.vehicle_id
                   )
                 )
            )
          )
          AND listing.archived_at IS NULL
          AND vehicle.archived_at IS NULL
        ORDER BY listing.updated_at DESC`,
      [PUBLIC_ORGANIZATION_ID, request.user.id, clean(request.user.email, 320)],
    );
    response.json({
      success: true,
      data: result.rows.map(listingPayload),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/host/listings", requireHost, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const input = request.body || {};
    const photos = listingPhotos(
      input.photos,
      clean(input.imageUrl, 2000) ? [input.imageUrl] : [],
    );
    const availability = listingAvailability(input.availability);
    const year = Number(input.year);
    const dailyRate = Number(input.dailyRate);
    if (
      !clean(input.vin, 80) ||
      !clean(input.licensePlate, 40) ||
      !clean(input.make, 100) ||
      !clean(input.model, 100) ||
      !Number.isInteger(year) ||
      year < 1900 ||
      year > 2200 ||
      !Number.isFinite(dailyRate) ||
      dailyRate < 0
    ) {
      return fail(
        response,
        400,
        "VEHICLE_DETAILS_REQUIRED",
        "VIN, plate, make, model, year, and daily rate are required.",
      );
    }
    await client.query("BEGIN");
    const host =
      (await hostProfileForRequest(client, request)) ||
      (await ensureHostProfile(client, request));
    if (
      host.team_member_id &&
      !(host.team_permissions || []).includes("listing_manage")
    ) {
      await client.query("ROLLBACK");
      return fail(
        response,
        403,
        "HOST_LISTING_MANAGE_REQUIRED",
        "Your host-team assignment does not allow adding vehicles.",
      );
    }
    const vehicle = await client.query(
      `INSERT INTO fleet_vehicles
        (organization_id,vin,license_plate,make,model,model_year,status,
         assigned_branch_id,daily_rate,registration_expiry,insurance_expiry,
         payload,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,'out_of_service',$7,$8,$9,$10,$11::jsonb,$12,$12)
       RETURNING *`,
      [
        PUBLIC_ORGANIZATION_ID,
        clean(input.vin, 80),
        clean(input.licensePlate, 40),
        clean(input.make, 100),
        clean(input.model, 100),
        year,
        clean(input.assignedBranchId, 200) || null,
        dailyRate.toFixed(2),
        clean(input.registrationExpiry, 10) || null,
        clean(input.insuranceExpiry, 10) || null,
        JSON.stringify({
          category: clean(input.category, 80) || "Vehicle",
          imageUrl: photos[0] || null,
          seats: Number(input.seats) || null,
          fuelType: clean(input.fuelType, 80) || null,
          transmission: clean(input.transmission, 80) || null,
          marketplaceVehicle: true,
        }),
        request.user.id,
      ],
    );
    const listing = await client.query(
      `INSERT INTO fleet_vehicle_listings
        (organization_id,vehicle_id,host_profile_id,operator_managed,title,
         description,status,instant_book,delivery_enabled,delivery_radius_miles,
         delivery_fee,minimum_trip_days,maximum_trip_days,advance_notice_hours,
         trip_buffer_hours,mileage_limit_per_day,additional_mile_rate,
         rules_json,features_json,photos_json,availability_json)
       VALUES (
         $1,$2,$3,false,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb
       )
       RETURNING *`,
      [
        PUBLIC_ORGANIZATION_ID,
        vehicle.rows[0].id,
        host.id,
        clean(input.title, 200) ||
          `${year} ${clean(input.make, 100)} ${clean(input.model, 100)}`,
        clean(input.description, 4000),
        Boolean(input.instantBook),
        Boolean(input.deliveryEnabled),
        Number(input.deliveryRadiusMiles) || null,
        Math.max(0, Number(input.deliveryFee) || 0).toFixed(2),
        Math.max(1, Number(input.minimumTripDays) || 1),
        Math.max(1, Number(input.maximumTripDays) || 30),
        Math.max(0, Number(input.advanceNoticeHours) || 12),
        Math.max(0, Number(input.tripBufferHours) || 2),
        Math.max(1, Number(input.mileageLimitPerDay) || 200),
        Math.max(0, Number(input.additionalMileRate) || 0).toFixed(2),
        JSON.stringify(input.rules || {}),
        JSON.stringify(
          Array.isArray(input.features) ? input.features.slice(0, 50) : [],
        ),
        JSON.stringify(photos),
        JSON.stringify(availability),
      ],
    );
    await client.query(
      `UPDATE fleet_host_profiles
          SET onboarding_status=CASE
                WHEN identity_verification_status='verified' THEN 'vehicle_required'
                ELSE 'identity_required'
              END,
              updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [PUBLIC_ORGANIZATION_ID, host.id],
    );
    await audit(
      client,
      request,
      PUBLIC_ORGANIZATION_ID,
      "marketplace.host.listing_created",
      "vehicle_listing",
      listing.rows[0].id,
      { vehicleId: vehicle.rows[0].id, status: "draft" },
    );
    await client.query("COMMIT");
    response.status(201).json({
      success: true,
      data: listingPayload({
        ...listing.rows[0],
        vin: vehicle.rows[0].vin,
        license_plate: vehicle.rows[0].license_plate,
        make: vehicle.rows[0].make,
        model: vehicle.rows[0].model,
        model_year: vehicle.rows[0].model_year,
        vehicle_status: vehicle.rows[0].status,
        daily_rate: vehicle.rows[0].daily_rate,
        registration_expiry: vehicle.rows[0].registration_expiry,
        insurance_expiry: vehicle.rows[0].insurance_expiry,
        vehicle_payload: vehicle.rows[0].payload,
      }),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return fail(
        response,
        409,
        "VEHICLE_ALREADY_EXISTS",
        "This VIN or license plate is already registered.",
      );
    }
    next(error);
  } finally {
    client.release();
  }
});

router.patch(
  "/host/listings/:listingId",
  requireHost,
  async (request, response, next) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT listing.*,host.user_id,
                host.identity_verification_status,
                vehicle.registration_expiry,vehicle.insurance_expiry,
                vehicle.payload AS vehicle_payload
           FROM fleet_vehicle_listings listing
           JOIN fleet_host_profiles host
             ON host.organization_id=listing.organization_id
            AND host.id=listing.host_profile_id
           JOIN fleet_vehicles vehicle
             ON vehicle.organization_id=listing.organization_id
            AND vehicle.id=listing.vehicle_id
          WHERE listing.organization_id=$1
            AND listing.id=$2
            AND (
              host.user_id=$3 OR EXISTS (
                SELECT 1
                  FROM fleet_host_team_members member
                 WHERE member.organization_id=host.organization_id
                   AND member.host_profile_id=host.id
                   AND member.status='active'
                   AND (member.user_id=$3 OR lower(member.invited_email)=lower($4))
                   AND member.permissions_json ? 'listing_manage'
                   AND (
                     NOT EXISTS (
                       SELECT 1 FROM fleet_host_team_vehicle_access scoped
                        WHERE scoped.organization_id=member.organization_id
                          AND scoped.team_member_id=member.id
                     ) OR EXISTS (
                       SELECT 1 FROM fleet_host_team_vehicle_access scoped
                        WHERE scoped.organization_id=member.organization_id
                          AND scoped.team_member_id=member.id
                          AND scoped.vehicle_id=listing.vehicle_id
                     )
                   )
              )
            )
            AND listing.archived_at IS NULL
          FOR UPDATE OF listing`,
        [
          PUBLIC_ORGANIZATION_ID,
          request.params.listingId,
          request.user.id,
          clean(request.user.email, 320),
        ],
      );
      if (!existing.rowCount) {
        await client.query("ROLLBACK");
        return fail(
          response,
          404,
          "LISTING_NOT_FOUND",
          "Host listing not found.",
        );
      }
      const current = existing.rows[0];
      const photos = listingPhotos(
        request.body?.photos,
        current.photos_json || [],
      );
      const availability = listingAvailability(
        request.body?.availability,
        current.availability_json || {},
      );
      const requestedStatus = clean(request.body?.status, 40);
      if (requestedStatus === "pending_review") {
        const complianceReady =
          Boolean(current.registration_expiry) &&
          Boolean(current.insurance_expiry) &&
          new Date(current.registration_expiry) >= new Date() &&
          new Date(current.insurance_expiry) >= new Date();
        if (current.identity_verification_status !== "verified") {
          await client.query("ROLLBACK");
          return fail(
            response,
            409,
            "HOST_IDENTITY_REQUIRED",
            "Complete host identity verification before submitting a vehicle.",
          );
        }
        if (!complianceReady) {
          await client.query("ROLLBACK");
          return fail(
            response,
            409,
            "VEHICLE_COMPLIANCE_REQUIRED",
            "Current registration and insurance are required before review.",
          );
        }
        if (photos.length < 6) {
          await client.query("ROLLBACK");
          return fail(
            response,
            409,
            "LISTING_PHOTOS_REQUIRED",
            "Add at least six current vehicle photos before submitting for review.",
          );
        }
      }
      const nextStatus =
        requestedStatus === "pending_review"
          ? "pending_review"
          : requestedStatus === "paused" && current.status === "active"
            ? "paused"
            : requestedStatus === "active" && current.status === "paused"
              ? "active"
              : current.status;
      const updated = await client.query(
        `UPDATE fleet_vehicle_listings
            SET title=$3,description=$4,status=$5,instant_book=$6,
                delivery_enabled=$7,delivery_radius_miles=$8,delivery_fee=$9,
                minimum_trip_days=$10,maximum_trip_days=$11,
                advance_notice_hours=$12,trip_buffer_hours=$13,
                mileage_limit_per_day=$14,additional_mile_rate=$15,
                rules_json=$16::jsonb,features_json=$17::jsonb,
                photos_json=$18::jsonb,availability_json=$19::jsonb,
                review_note=CASE
                  WHEN $5='pending_review' THEN NULL
                  ELSE review_note
                END,
                updated_at=NOW()
          WHERE organization_id=$1 AND id=$2
          RETURNING *`,
        [
          PUBLIC_ORGANIZATION_ID,
          current.id,
          clean(request.body?.title, 200) || current.title,
          clean(request.body?.description, 4000) || current.description,
          nextStatus,
          request.body?.instantBook === undefined
            ? current.instant_book
            : Boolean(request.body.instantBook),
          request.body?.deliveryEnabled === undefined
            ? current.delivery_enabled
            : Boolean(request.body.deliveryEnabled),
          request.body?.deliveryRadiusMiles === undefined
            ? current.delivery_radius_miles
            : Number(request.body.deliveryRadiusMiles) || null,
          request.body?.deliveryFee === undefined
            ? current.delivery_fee
            : Math.max(0, Number(request.body.deliveryFee) || 0).toFixed(2),
          Number(request.body?.minimumTripDays) ||
            current.minimum_trip_days,
          Number(request.body?.maximumTripDays) ||
            current.maximum_trip_days,
          request.body?.advanceNoticeHours === undefined
            ? current.advance_notice_hours
            : Math.max(0, Number(request.body.advanceNoticeHours) || 0),
          request.body?.tripBufferHours === undefined
            ? current.trip_buffer_hours
            : Math.max(0, Number(request.body.tripBufferHours) || 0),
          Number(request.body?.mileageLimitPerDay) ||
            current.mileage_limit_per_day,
          request.body?.additionalMileRate === undefined
            ? current.additional_mile_rate
            : Math.max(
                0,
                Number(request.body.additionalMileRate) || 0,
              ).toFixed(2),
          JSON.stringify(request.body?.rules || current.rules_json || {}),
          JSON.stringify(
            Array.isArray(request.body?.features)
              ? request.body.features.slice(0, 50)
              : current.features_json || [],
          ),
          JSON.stringify(photos),
          JSON.stringify(availability),
        ],
      );
      await client.query(
        `UPDATE fleet_vehicles
            SET payload=payload||$3::jsonb,updated_by=$4,updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [
          PUBLIC_ORGANIZATION_ID,
          current.vehicle_id,
          JSON.stringify({ imageUrl: photos[0] || null }),
          request.user.id,
        ],
      );
      const hydrated = await marketplaceListing(client, updated.rows[0].id);
      if (nextStatus === "pending_review" && current.status !== nextStatus) {
        await client.query(
          `UPDATE fleet_host_profiles
              SET onboarding_status='under_review',updated_at=NOW()
            WHERE organization_id=$1 AND user_id=$2`,
          [PUBLIC_ORGANIZATION_ID, request.user.id],
        );
      }
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        "marketplace.host.listing_updated",
        "vehicle_listing",
        current.id,
        {
          status: nextStatus,
          photoCount: photos.length,
          unavailableRangeCount: availability.unavailableRanges.length,
        },
      );
      await client.query("COMMIT");
      if (nextStatus === "pending_review" && current.status !== nextStatus) {
        const recipients = await operatorRecipients(
          PUBLIC_ORGANIZATION_ID,
          request.user.id,
        );
        await Promise.all(
          recipients.map(recipient =>
            notify({
              recipientUserId: recipient.id,
              recipientEmail: recipient.email,
              title: "Host vehicle ready for review",
              message: `${hydrated.host_display_name || "A GoodFleet host"} submitted ${hydrated.title}.`,
              category: "reservation",
              channel: "in_app",
              actionUrl: `/marketplace-admin?listing=${encodeURIComponent(hydrated.id)}`,
              notificationKey: "fleet.marketplace.listing_review",
              sourceId: hydrated.id,
            }),
          ),
        );
      }
      response.json({ success: true, data: listingPayload(hydrated) });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

router.get("/host/trips", requireHost, async (request, response, next) => {
  try {
    const result = await query(
      `SELECT booking.*,vehicle.make,vehicle.model,vehicle.model_year,
              vehicle.payload->>'imageUrl' AS vehicle_image_url,
              host.user_id AS host_user_id,host.display_name AS host_display_name,
              customer.full_name AS guest_name,customer.email AS guest_email
         FROM fleet_host_profiles host
         JOIN fleet_vehicle_listings listing
           ON listing.organization_id=host.organization_id
          AND listing.host_profile_id=host.id
         JOIN fleet_bookings booking
           ON booking.organization_id=listing.organization_id
          AND booking.listing_id=listing.id
         JOIN fleet_vehicles vehicle
           ON vehicle.organization_id=booking.organization_id
          AND vehicle.id=booking.vehicle_id
         JOIN fleet_customers customer
           ON customer.organization_id=booking.organization_id
          AND customer.id=booking.customer_id
        WHERE host.organization_id=$1
          AND (
            host.user_id=$2 OR EXISTS (
              SELECT 1
                FROM fleet_host_team_members member
               WHERE member.organization_id=host.organization_id
                 AND member.host_profile_id=host.id
                 AND member.status='active'
                 AND (member.user_id=$2 OR lower(member.invited_email)=lower($3))
                 AND member.permissions_json ?| ARRAY['trips_view','trips_manage']
                 AND (
                   NOT EXISTS (
                     SELECT 1 FROM fleet_host_team_vehicle_access scoped
                      WHERE scoped.organization_id=member.organization_id
                        AND scoped.team_member_id=member.id
                   ) OR EXISTS (
                     SELECT 1 FROM fleet_host_team_vehicle_access scoped
                      WHERE scoped.organization_id=member.organization_id
                        AND scoped.team_member_id=member.id
                        AND scoped.vehicle_id=listing.vehicle_id
                   )
                 )
            )
          )
          AND booking.archived_at IS NULL
        ORDER BY booking.pickup_at DESC`,
      [PUBLIC_ORGANIZATION_ID, request.user.id, clean(request.user.email, 320)],
    );
    response.json({
      success: true,
      data: result.rows.map(bookingPayload),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/hosts", requireEmployee, async (request, response, next) => {
  try {
    const result = await query(
      `SELECT host.*,account.email,
              COUNT(listing.id)::int AS listing_count,
              COUNT(listing.id) FILTER (
                WHERE listing.status='pending_review'
              )::int AS pending_listing_count
         FROM fleet_host_profiles host
         JOIN users account ON account.id=host.user_id
         LEFT JOIN fleet_vehicle_listings listing
           ON listing.organization_id=host.organization_id
          AND listing.host_profile_id=host.id
          AND listing.archived_at IS NULL
        WHERE host.organization_id=$1
        GROUP BY host.id,account.email
        ORDER BY host.updated_at DESC`,
      [PUBLIC_ORGANIZATION_ID],
    );
    response.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get(
  "/admin/listings",
  requireEmployee,
  async (request, response, next) => {
    try {
      const result = await query(
        `SELECT listing.*,vehicle.vin,vehicle.license_plate,vehicle.make,
                vehicle.model,vehicle.model_year,
                vehicle.status AS vehicle_status,vehicle.daily_rate,
                vehicle.registration_expiry,vehicle.insurance_expiry,
                vehicle.payload AS vehicle_payload,
                host.user_id AS host_user_id,
                host.display_name AS host_display_name,
                host.identity_verification_status AS host_identity_verification_status
           FROM fleet_vehicle_listings listing
           JOIN fleet_vehicles vehicle
             ON vehicle.organization_id=listing.organization_id
            AND vehicle.id=listing.vehicle_id
           LEFT JOIN fleet_host_profiles host
             ON host.organization_id=listing.organization_id
            AND host.id=listing.host_profile_id
          WHERE listing.organization_id=$1
            AND listing.archived_at IS NULL
            AND vehicle.archived_at IS NULL
          ORDER BY
            CASE listing.status WHEN 'pending_review' THEN 0 ELSE 1 END,
            listing.updated_at DESC`,
        [PUBLIC_ORGANIZATION_ID],
      );
      response.json({
        success: true,
        data: result.rows.map(listingPayload),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/admin/hosts/:hostId/identity-review",
  requireEmployee,
  async (request, response, next) => {
    const client = await pool.connect();
    try {
      const decision =
        clean(request.body?.decision, 20).toLowerCase() === "verify"
          ? "verify"
          : "fail";
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT host.*,account.email
           FROM fleet_host_profiles host
           JOIN users account ON account.id=host.user_id
          WHERE host.organization_id=$1 AND host.id=$2
          FOR UPDATE OF host`,
        [PUBLIC_ORGANIZATION_ID, request.params.hostId],
      );
      if (!existing.rowCount) {
        await client.query("ROLLBACK");
        return fail(
          response,
          404,
          "HOST_NOT_FOUND",
          "Host profile not found.",
        );
      }
      const status = decision === "verify" ? "verified" : "failed";
      const updated = await client.query(
        `UPDATE fleet_host_profiles
            SET identity_verification_status=$3,
                onboarding_status=CASE
                  WHEN $3='verified' THEN 'vehicle_required'
                  ELSE 'identity_required'
                END,
                status=CASE
                  WHEN $3='failed' THEN 'suspended'
                  WHEN status='suspended' THEN 'pending_review'
                  ELSE status
                END,
                payload=payload||$4::jsonb,
                updated_at=NOW()
          WHERE organization_id=$1 AND id=$2
          RETURNING *`,
        [
          PUBLIC_ORGANIZATION_ID,
          existing.rows[0].id,
          status,
          JSON.stringify({
            identityReview: {
              decision,
              note: clean(request.body?.note, 1000) || null,
              reviewedBy: request.user.id,
              reviewedAt: new Date().toISOString(),
            },
          }),
        ],
      );
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        `marketplace.host.identity_${status}`,
        "host_profile",
        existing.rows[0].id,
        { decision, note: clean(request.body?.note, 1000) || null },
      );
      await client.query("COMMIT");
      await notify({
        recipientUserId: existing.rows[0].user_id,
        recipientEmail: existing.rows[0].email,
        title:
          decision === "verify"
            ? "Host identity verified"
            : "Host identity verification needs attention",
        message:
          clean(request.body?.note, 1000) ||
          (decision === "verify"
            ? "You can now submit compliant vehicles for marketplace review."
            : "Your identity review was not approved. Update your information and contact support."),
        category: "security",
        channel: "in_app",
        actionUrl: "/host/setup",
        notificationKey: "fleet.marketplace.host_identity",
        sourceId: existing.rows[0].id,
      });
      response.json({ success: true, data: updated.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      next(error);
    } finally {
      client.release();
    }
  },
);

router.post(
  "/admin/listings/:listingId/review",
  requireEmployee,
  async (request, response, next) => {
    const client = await pool.connect();
    try {
      const decision =
        clean(request.body?.decision, 20).toLowerCase() === "approve"
          ? "approve"
          : "reject";
      await client.query("BEGIN");
      const existing = await marketplaceListing(
        client,
        request.params.listingId,
        { forUpdate: true },
      );
      if (!existing) {
        await client.query("ROLLBACK");
        return fail(
          response,
          404,
          "LISTING_NOT_FOUND",
          "Listing not found.",
        );
      }
      const complianceReady =
        Boolean(existing.registration_expiry) &&
        Boolean(existing.insurance_expiry) &&
        new Date(existing.registration_expiry) >= new Date() &&
        new Date(existing.insurance_expiry) >= new Date();
      const hostIdentityReady =
        !existing.host_profile_id ||
        existing.host_identity_verification_status === "verified";
      if (decision === "approve" && !hostIdentityReady) {
        await client.query("ROLLBACK");
        return fail(
          response,
          409,
          "HOST_IDENTITY_REQUIRED",
          "The host identity must be verified before publishing a vehicle.",
        );
      }
      if (decision === "approve" && !complianceReady) {
        await client.query("ROLLBACK");
        return fail(
          response,
          409,
          "VEHICLE_COMPLIANCE_REQUIRED",
          "Verified registration and insurance are required before publishing.",
        );
      }
      if (
        decision === "approve" &&
        existing.host_profile_id &&
        listingPhotos(existing.photos_json).length < 6
      ) {
        await client.query("ROLLBACK");
        return fail(
          response,
          409,
          "LISTING_PHOTOS_REQUIRED",
          "Host vehicles need at least six current photos before publishing.",
        );
      }
      const status = decision === "approve" ? "active" : "rejected";
      await client.query(
        `UPDATE fleet_vehicle_listings
            SET status=$3,published_at=CASE WHEN $3='active' THEN NOW() ELSE published_at END,
                review_note=$4,reviewed_by=$5,reviewed_at=NOW(),
                updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [
          PUBLIC_ORGANIZATION_ID,
          existing.id,
          status,
          clean(request.body?.note, 1000) || null,
          request.user.id,
        ],
      );
      await client.query(
        `UPDATE fleet_vehicles
            SET status=CASE WHEN $3='active' THEN 'available' ELSE 'out_of_service' END,
                updated_by=$4,updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [
          PUBLIC_ORGANIZATION_ID,
          existing.vehicle_id,
          status,
          request.user.id,
        ],
      );
      if (existing.host_profile_id) {
        await client.query(
          `UPDATE fleet_host_profiles
              SET status=CASE WHEN $3='active' THEN 'active' ELSE status END,
                  onboarding_status=CASE WHEN $3='active' THEN 'approved' ELSE onboarding_status END,
                  updated_at=NOW()
            WHERE organization_id=$1 AND id=$2`,
          [PUBLIC_ORGANIZATION_ID, existing.host_profile_id, status],
        );
      }
      await audit(
        client,
        request,
        PUBLIC_ORGANIZATION_ID,
        `marketplace.listing.${status}`,
        "vehicle_listing",
        existing.id,
        { decision, note: clean(request.body?.note, 1000) || null },
      );
      await client.query("COMMIT");
      if (existing.host_user_id) {
        await notify({
          recipientUserId: existing.host_user_id,
          title:
            decision === "approve"
              ? "Your vehicle is live"
              : "Your vehicle listing needs changes",
          message:
            clean(request.body?.note, 1000) ||
            (decision === "approve"
              ? `${existing.title} is now visible to GoodFleet guests.`
              : `${existing.title} was not approved. Review its details and resubmit it.`),
          category: "reservation",
          channel: "in_app",
          actionUrl: "/host/listings",
          sourceId: existing.id,
        });
      }
      response.json({ success: true, data: { id: existing.id, status } });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  },
);

module.exports = router;
