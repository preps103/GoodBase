"use strict";

const crypto = require("crypto");
const express = require("express");
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

router.use(authRequired);

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
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

function requireHost(request, response, next) {
  if (fleetRole(request) !== "host") {
    return fail(
      response,
      403,
      "HOST_ACCESS_REQUIRED",
      "An active GoodFleet host account is required.",
    );
  }
  return next();
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listingPayload(row) {
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
    vehicle: {
      id: row.vehicle_id,
      vin: row.vin,
      licensePlate: row.license_plate,
      make: row.make,
      model: row.model,
      year: row.model_year,
      status: row.vehicle_status,
      dailyRate: Number(row.daily_rate),
      imageUrl: row.vehicle_payload?.imageUrl || null,
      registrationExpiry: row.registration_expiry,
      insuranceExpiry: row.insurance_expiry,
    },
    publishedAt: row.published_at,
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
    `SELECT conversation.*,booking.reservation_number,
            customer.full_name AS guest_name,
            host.display_name AS host_name
       FROM fleet_trip_conversations conversation
       JOIN fleet_bookings booking
         ON booking.organization_id=conversation.organization_id
        AND booking.id=conversation.booking_id
       JOIN fleet_customers customer
         ON customer.organization_id=booking.organization_id
        AND customer.id=booking.customer_id
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
    EMPLOYEE_ROLES.has(role);
  return allowed ? conversation : null;
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

router.post(
  "/reservations/:bookingId/additional-drivers",
  async (request, response, next) => {
    const client = await pool.connect();
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
        `SELECT id
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
      const created = await client.query(
        `INSERT INTO fleet_booking_additional_drivers
          (organization_id,booking_id,invited_by,full_name,email)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (organization_id,booking_id,email)
         DO UPDATE SET full_name=EXCLUDED.full_name,status='invited',
                       invited_at=NOW(),updated_at=NOW()
         RETURNING *`,
        [
          PUBLIC_ORGANIZATION_ID,
          booking.rows[0].id,
          request.user.id,
          fullName,
          email,
        ],
      );
      response.status(201).json({ success: true, data: created.rows[0] });
    } catch (error) {
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
         LEFT JOIN fleet_host_profiles host
           ON host.organization_id=conversation.organization_id
          AND host.user_id=conversation.host_user_id
        WHERE conversation.organization_id=$1
          AND (
            conversation.guest_user_id=$2
            OR conversation.host_user_id=$2
            OR $3::boolean
          )
        ORDER BY COALESCE(conversation.last_message_at,conversation.created_at) DESC`,
      [
        PUBLIC_ORGANIZATION_ID,
        request.user.id,
        EMPLOYEE_ROLES.has(role),
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
          : conversation.host_user_id === request.user.id
            ? "host"
            : "staff";
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

router.get("/host/profile", requireHost, async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const profile = await ensureHostProfile(client, request);
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
          AND host.user_id=$2
          AND listing.archived_at IS NULL
          AND vehicle.archived_at IS NULL
        ORDER BY listing.updated_at DESC`,
      [PUBLIC_ORGANIZATION_ID, request.user.id],
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
    const host = await ensureHostProfile(client, request);
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
          imageUrl: clean(input.imageUrl, 1000) || null,
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
         rules_json,features_json)
       VALUES (
         $1,$2,$3,false,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16::jsonb,$17::jsonb
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
                vehicle.registration_expiry,vehicle.insurance_expiry
           FROM fleet_vehicle_listings listing
           JOIN fleet_host_profiles host
             ON host.organization_id=listing.organization_id
            AND host.id=listing.host_profile_id
           JOIN fleet_vehicles vehicle
             ON vehicle.organization_id=listing.organization_id
            AND vehicle.id=listing.vehicle_id
          WHERE listing.organization_id=$1
            AND listing.id=$2
            AND host.user_id=$3
            AND listing.archived_at IS NULL
          FOR UPDATE OF listing`,
        [
          PUBLIC_ORGANIZATION_ID,
          request.params.listingId,
          request.user.id,
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
                rules_json=$16::jsonb,features_json=$17::jsonb,updated_at=NOW()
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
              host.user_id AS host_user_id,host.display_name AS host_display_name
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
        WHERE host.organization_id=$1
          AND host.user_id=$2
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
      const status = decision === "approve" ? "active" : "rejected";
      await client.query(
        `UPDATE fleet_vehicle_listings
            SET status=$3,published_at=CASE WHEN $3='active' THEN NOW() ELSE published_at END,
                updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [PUBLIC_ORGANIZATION_ID, existing.id, status],
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
