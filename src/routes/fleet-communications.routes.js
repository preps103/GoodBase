"use strict";

const crypto = require("crypto");
const express = require("express");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { pool, query } = require("../config/database");
const { encryptValue } = require("../services/secret.service");

const router = express.Router();
router.use(authRequired);
const PUBLIC_APP_URL = String(
  process.env.GOODFLEET_PUBLIC_URL || "https://fleet.goodos.app",
).replace(/\/$/, "");

const EMPLOYEE_ROLES = new Set(["owner", "admin", "manager", "staff", "mechanic"]);
const MANAGEMENT_ROLES = new Set(["owner", "admin", "manager"]);
const CUSTOMER_SEND_ROLES = new Set(["owner", "admin", "manager", "staff"]);
const NOTIFICATION_CATEGORIES = new Set(["reservation", "payment", "trip", "support", "general"]);
const NOTIFICATION_CHANNELS = new Set(["in_app", "email", "sms"]);
const CUSTOMER_SUPPORT_CATEGORIES = new Set(["reservation", "roadside", "billing", "documents", "other"]);
const CUSTOMER_CHECKIN_BOOKING_STATUSES = new Set(["confirmed", "assigned"]);
const REQUIRED_CHECKIN_ACKNOWLEDGEMENTS = [
  "contactConfirmed",
  "rentalTermsAccepted",
  "conditionPolicyAcknowledged",
  "arrivalInstructionsReviewed",
];

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizePhone(value) {
  const digits = clean(value, 50).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function customerActionUrl(value) {
  const actionUrl = clean(value, 500);
  return /^\/account(?:\/|$)/.test(actionUrl) ? actionUrl : null;
}

function fail(response, status, code, message) {
  return response.status(status).json({ success: false, code, message });
}

function organization(request) {
  return request.tenantContext.organizationId;
}

function membershipRole(request) {
  const organizationRole = clean(request.tenantContext.organization?.membershipRole, 40).toLowerCase();
  if (["owner", "admin", "manager"].includes(organizationRole)) return organizationRole;
  const appMembership = (request.apps || []).find(app =>
    clean(app?.membershipStatus, 40).toLowerCase() === "active" &&
    (clean(app?.id, 80).toLowerCase() === "goodfleet" ||
      clean(app?.domain, 160).toLowerCase() === "fleet.goodos.app")
  );
  const appRole = clean(appMembership?.role, 40).toLowerCase();
  return EMPLOYEE_ROLES.has(appRole) ? appRole : organizationRole;
}

function requireEmployee(request, response, next) {
  if (!EMPLOYEE_ROLES.has(membershipRole(request))) {
    return fail(response, 403, "EMPLOYEE_ACCESS_REQUIRED", "GoodFleet employee access is required.");
  }
  return next();
}

function requireCustomerSender(request, response, next) {
  if (!CUSTOMER_SEND_ROLES.has(membershipRole(request))) {
    return fail(response, 403, "CUSTOMER_MESSAGING_FORBIDDEN", "Your role cannot send customer notifications.");
  }
  return next();
}

function employeeScope(request, response, next) {
  return tenantContext(request, response, error => {
    if (error) return next(error);
    return requireEmployee(request, response, next);
  });
}

function messagePayload(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    body: row.body,
    sender: {
      id: row.sender_id,
      name: row.sender_name,
      email: row.sender_email,
      avatarUrl: row.sender_avatar_url,
    },
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };
}

function notificationPayload(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    recipientEmail: row.recipient_email,
    title: row.title,
    body: row.body,
    category: row.category,
    channels: row.channels,
    status: row.status,
    actionUrl: row.action_url,
    createdBy: row.created_by,
    createdAt: row.created_at,
    readAt: row.read_at,
    deliveries: row.deliveries || [],
  };
}

function customerAccountPayload(row) {
  return {
    ...(row.payload || {}),
    id: row.id,
    name: row.full_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    licenseNumber: row.license_number,
    licenseExpiry: row.license_expiry,
    licenseVerificationStatus: row.license_verification_status,
    createdAt: row.created_at
  };
}

function customerBookingPayload(row) {
  const pickup = new Date(row.pickup_at);
  const returned = new Date(row.return_at);
  return {
    ...(row.payload || {}),
    id: row.id,
    reservationNumber: row.reservation_number,
    customerId: row.customer_id,
    carId: row.vehicle_id || undefined,
    startDate: pickup.toISOString().slice(0, 10),
    endDate: returned.toISOString().slice(0, 10),
    pickupTime: pickup.toISOString().slice(11, 16),
    dropoffTime: returned.toISOString().slice(11, 16),
    pickupLocationId: row.pickup_branch_id,
    returnLocationId: row.return_branch_id,
    status: row.status,
    paymentStatus: row.payment_status,
    totalAmount: Number(row.total_amount),
    depositAmount: Number(row.deposit_amount),
    paidAmount: Number(row.paid_amount),
    createdAt: row.created_at
  };
}

function customerCheckinPayload(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    customerId: row.customer_id,
    status: row.status,
    checklist: row.checklist_json || {},
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note || null,
    updatedAt: row.updated_at,
  };
}

function customerSupportTicketPayload(row, messages = []) {
  return {
    id: row.id,
    customerId: row.customer_id,
    bookingId: row.booking_id || null,
    ticketNumber: row.ticket_number,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: messages.map(message => ({
      id: message.id,
      senderType: message.sender_type,
      body: message.body,
      createdAt: message.created_at,
    })),
  };
}

async function customerRecordForIdentity(client, request) {
  const email = clean(request.user.email, 320).toLowerCase();
  const result = await client.query(
    `SELECT *
       FROM fleet_customers
      WHERE lower(email)=lower($1) AND archived_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1`,
    [email],
  );
  return result.rows[0] || null;
}

async function auditCustomerAction(client, request, organizationId, action, entityType, entityId, after) {
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

async function audit(client, request, action, entityType, entityId, after) {
  await client.query(
    `INSERT INTO fleet_audit_events
      (organization_id, actor_id, action, entity_type, entity_id, after_json, request_id, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [
      organization(request),
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

async function ensureDefaultChannels(client, request) {
  const defaults = [
    ["operations", "Operations", "Daily reservations, handoffs, and branch coordination.", "workspace"],
    ["front-desk", "Front desk", "Customer arrivals, departures, and reservation support.", "workspace"],
    ["fleet-service", "Fleet & service", "Vehicle readiness, maintenance, and turnaround.", "workspace"],
    ["management", "Management", "Private leadership planning, staffing, and operating decisions.", "management"],
  ];
  for (const [slug, name, description, visibility] of defaults) {
    await client.query(
      `INSERT INTO fleet_chat_channels
        (organization_id, channel_type, name, slug, description, visibility, created_by)
       VALUES ($1,'group',$2,$3,$4,$5,$6)
       ON CONFLICT (organization_id, slug) DO NOTHING`,
      [organization(request), name, slug, description, visibility, request.user.id],
    );
  }
}

async function requireChannelAccess(client, request, channelId) {
  const role = membershipRole(request);
  const result = await client.query(
    `SELECT channel.*
       FROM fleet_chat_channels channel
       LEFT JOIN fleet_chat_channel_members member
         ON member.channel_id=channel.id AND member.user_id=$3
      WHERE channel.organization_id=$1 AND channel.id=$2
        AND (
          (channel.channel_type='group' AND channel.visibility='workspace')
          OR (channel.channel_type='group' AND channel.visibility='management' AND $4=ANY($5::text[]))
          OR member.user_id IS NOT NULL
        )
      LIMIT 1`,
    [organization(request), channelId, request.user.id, role, [...MANAGEMENT_ROLES]],
  );
  return result.rows[0] || null;
}

router.get("/health", async (_request, response, next) => {
  try {
    const result = await query(
      `SELECT
        to_regclass('public.fleet_chat_messages') IS NOT NULL AS chat_ready,
        to_regclass('public.fleet_customer_notifications') IS NOT NULL AS notifications_ready`,
    );
    const row = result.rows[0] || {};
    response.json({
      success: true,
      service: "goodfleet-communications",
      databaseReady: Boolean(row.chat_ready && row.notifications_ready),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/bootstrap", employeeScope, async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureDefaultChannels(client, request);
    const [channels, staff] = await Promise.all([
      client.query(
        `SELECT channel.id,
                CASE
                  WHEN channel.channel_type='direct' THEN COALESCE(
                    (
                      SELECT COALESCE(other_user.display_name, other_user.email)
                        FROM fleet_chat_channel_members other_member
                        JOIN users other_user ON other_user.id=other_member.user_id
                       WHERE other_member.channel_id=channel.id
                         AND other_member.user_id<>$2
                       LIMIT 1
                    ),
                    channel.name
                  )
                  ELSE channel.name
                END AS name,
                channel.slug, channel.description,
                channel.visibility,
                channel.channel_type AS "channelType", channel.updated_at AS "updatedAt",
                (
                  SELECT COUNT(*)::int
                    FROM fleet_chat_channel_members member_count
                   WHERE member_count.channel_id=channel.id
                ) AS "memberCount",
                COUNT(message.id)::int AS "messageCount",
                COUNT(message.id) FILTER (
                  WHERE message.sender_id<>$2
                    AND message.created_at>COALESCE(read_state.last_read_at, to_timestamp(0))
                )::int AS "unreadCount",
                MAX(message.created_at) AS "lastMessageAt"
           FROM fleet_chat_channels channel
           LEFT JOIN fleet_chat_channel_members membership
             ON membership.channel_id=channel.id AND membership.user_id=$2
           LEFT JOIN fleet_chat_reads read_state
             ON read_state.channel_id=channel.id AND read_state.user_id=$2
           LEFT JOIN fleet_chat_messages message
             ON message.channel_id=channel.id AND message.deleted_at IS NULL
          WHERE channel.organization_id=$1
            AND (
              (channel.channel_type='group' AND channel.visibility='workspace')
              OR (channel.channel_type='group' AND channel.visibility='management' AND $3=ANY($4::text[]))
              OR membership.user_id IS NOT NULL
            )
          GROUP BY channel.id, read_state.last_read_at
          ORDER BY COALESCE(MAX(message.created_at), channel.updated_at) DESC`,
        [organization(request), request.user.id, membershipRole(request), [...MANAGEMENT_ROLES]],
      ),
      client.query(
        `SELECT users.id, users.display_name AS name, users.email,
                users.platform_role AS "platformRole",
                users.avatar_url AS "avatarUrl",
                membership.role AS role
           FROM backend_organization_memberships membership
           JOIN users ON users.id=membership.user_id
          WHERE membership.organization_id=$1
            AND membership.status='active'
            AND users.status='active'
          ORDER BY users.display_name, users.email`,
        [organization(request)],
      ),
    ]);
    await client.query("COMMIT");
    response.json({
      success: true,
      data: {
        channels: channels.rows,
        staff: staff.rows,
        currentUserId: request.user.id,
        canNotifyCustomers: CUSTOMER_SEND_ROLES.has(membershipRole(request)),
        canCreateChannels: true,
        canCreateManagementChannels: MANAGEMENT_ROLES.has(membershipRole(request)),
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/channels/group", employeeScope, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const name = clean(request.body?.name, 80);
    const description = clean(request.body?.description, 240) || null;
    const requestedVisibility = clean(request.body?.visibility || "private", 20);
    const visibility = ["workspace", "management", "private"].includes(requestedVisibility)
      ? requestedVisibility
      : "private";
    const requestedMembers = Array.isArray(request.body?.memberIds)
      ? [...new Set(request.body.memberIds.map(value => clean(value, 80)).filter(Boolean))]
      : [];
    if (name.length < 2) {
      return fail(response, 400, "CHANNEL_NAME_REQUIRED", "Enter a team conversation name.");
    }
    if (visibility === "management" && !MANAGEMENT_ROLES.has(membershipRole(request))) {
      return fail(response, 403, "MANAGEMENT_CHANNEL_FORBIDDEN", "Only management can create a management conversation.");
    }
    const memberIds = [...new Set([request.user.id, ...requestedMembers])];
    const members = await client.query(
      `SELECT users.id
         FROM backend_organization_memberships membership
         JOIN users ON users.id=membership.user_id
        WHERE membership.organization_id=$1
          AND membership.status='active'
          AND users.status='active'
          AND users.id=ANY($2::uuid[])`,
      [organization(request), memberIds],
    );
    if (members.rowCount !== memberIds.length) {
      return fail(response, 400, "INVALID_CHANNEL_MEMBERS", "Every participant must be an active employee in this workspace.");
    }
    const baseSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "team";
    const slug = `${baseSlug}-${crypto.randomBytes(3).toString("hex")}`;
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO fleet_chat_channels
        (organization_id,channel_type,name,slug,description,visibility,created_by)
       VALUES ($1,'group',$2,$3,$4,$5,$6)
       RETURNING id,name,slug,description,visibility,
                 channel_type AS "channelType",updated_at AS "updatedAt"`,
      [organization(request), name, slug, description, visibility, request.user.id],
    );
    for (const memberId of memberIds) {
      await client.query(
        `INSERT INTO fleet_chat_channel_members (channel_id,user_id,membership_role)
         VALUES ($1,$2,$3) ON CONFLICT (channel_id,user_id) DO NOTHING`,
        [inserted.rows[0].id, memberId, memberId === request.user.id ? "owner" : "member"],
      );
    }
    await audit(client, request, "chat.channel.created", "chat_channel", inserted.rows[0].id, {
      name,
      visibility,
      memberCount: memberIds.length,
    });
    await client.query("COMMIT");
    response.status(201).json({
      success: true,
      data: {
        ...inserted.rows[0],
        unreadCount: 0,
        messageCount: 0,
        memberCount: memberIds.length,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/channels/direct", employeeScope, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const memberId = clean(request.body?.memberId, 80);
    if (!memberId || memberId === request.user.id) {
      return fail(response, 400, "INVALID_DIRECT_MEMBER", "Choose another employee.");
    }
    const membership = await client.query(
      `SELECT users.id, COALESCE(users.display_name, users.email) AS name
         FROM backend_organization_memberships member
         JOIN users ON users.id=member.user_id
        WHERE member.organization_id=$1 AND member.user_id=$2
          AND member.status='active' AND users.status='active'`,
      [organization(request), memberId],
    );
    if (!membership.rowCount) {
      return fail(response, 404, "EMPLOYEE_NOT_FOUND", "Employee not found in this workspace.");
    }
    const members = [request.user.id, memberId].sort();
    const slug = `direct-${members.join("-")}`;
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO fleet_chat_channels
        (organization_id,channel_type,name,slug,description,visibility,created_by)
       VALUES ($1,'direct',$2,$3,'Private employee conversation','private',$4)
       ON CONFLICT (organization_id,slug) DO UPDATE SET updated_at=NOW()
       RETURNING id,name,slug,description,visibility,
                 channel_type AS "channelType",updated_at AS "updatedAt"`,
      [organization(request), membership.rows[0].name, slug, request.user.id],
    );
    for (const userId of members) {
      await client.query(
        `INSERT INTO fleet_chat_channel_members (channel_id,user_id,membership_role)
         VALUES ($1,$2,$3) ON CONFLICT (channel_id,user_id) DO NOTHING`,
        [result.rows[0].id, userId, userId === request.user.id ? "owner" : "member"],
      );
    }
    await audit(client, request, "chat.channel.created", "chat_channel", result.rows[0].id, result.rows[0]);
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/channels/:channelId/messages", employeeScope, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const channel = await requireChannelAccess(client, request, request.params.channelId);
    if (!channel) return fail(response, 404, "CHANNEL_NOT_FOUND", "Conversation not found.");
    const limit = Math.min(Math.max(Number(request.query.limit) || 80, 1), 100);
    const result = await client.query(
      `SELECT message.*, COALESCE(users.display_name, users.email) AS sender_name,
              users.email AS sender_email, users.avatar_url AS sender_avatar_url
         FROM fleet_chat_messages message
         JOIN users ON users.id=message.sender_id
        WHERE message.organization_id=$1 AND message.channel_id=$2
          AND message.deleted_at IS NULL
        ORDER BY message.created_at DESC
        LIMIT $3`,
      [organization(request), channel.id, limit],
    );
    response.json({ success: true, data: result.rows.reverse().map(messagePayload) });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.post("/channels/:channelId/messages", employeeScope, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const body = clean(request.body?.body, 4000);
    const clientMessageId = clean(request.body?.clientMessageId || request.get("Idempotency-Key"), 200);
    if (!body) return fail(response, 400, "MESSAGE_REQUIRED", "Enter a message.");
    if (!clientMessageId) return fail(response, 400, "IDEMPOTENCY_KEY_REQUIRED", "A client message ID is required.");
    const channel = await requireChannelAccess(client, request, request.params.channelId);
    if (!channel) return fail(response, 404, "CHANNEL_NOT_FOUND", "Conversation not found.");
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO fleet_chat_channel_members (channel_id,user_id,membership_role)
       VALUES ($1,$2,'member') ON CONFLICT (channel_id,user_id) DO NOTHING`,
      [channel.id, request.user.id],
    );
    const result = await client.query(
      `INSERT INTO fleet_chat_messages
        (organization_id,channel_id,sender_id,body,client_message_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organization_id,sender_id,client_message_id)
       DO UPDATE SET body=fleet_chat_messages.body
       RETURNING *`,
      [organization(request), channel.id, request.user.id, body, clientMessageId],
    );
    await client.query(`UPDATE fleet_chat_channels SET updated_at=NOW() WHERE id=$1`, [channel.id]);
    await client.query(
      `INSERT INTO fleet_chat_reads (channel_id,user_id,last_read_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (channel_id,user_id) DO UPDATE SET last_read_at=NOW()`,
      [channel.id, request.user.id],
    );
    await audit(client, request, "chat.message.sent", "chat_message", result.rows[0].id, {
      channelId: channel.id,
      length: body.length,
    });
    const sender = await client.query(
      `SELECT COALESCE(display_name,email) AS sender_name, email AS sender_email,
              avatar_url AS sender_avatar_url FROM users WHERE id=$1`,
      [request.user.id],
    );
    await client.query("COMMIT");
    response.status(201).json({
      success: true,
      data: messagePayload({ ...result.rows[0], ...sender.rows[0] }),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/channels/:channelId/read", employeeScope, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const channel = await requireChannelAccess(client, request, request.params.channelId);
    if (!channel) return fail(response, 404, "CHANNEL_NOT_FOUND", "Conversation not found.");
    await client.query(
      `INSERT INTO fleet_chat_reads (channel_id,user_id,last_read_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (channel_id,user_id) DO UPDATE SET last_read_at=NOW()`,
      [channel.id, request.user.id],
    );
    response.json({ success: true, data: { channelId: channel.id, unreadCount: 0 } });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.get("/customer-notifications", employeeScope, requireCustomerSender, async (request, response, next) => {
  try {
    const result = await query(
      `SELECT notification.*,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object('channel',delivery.channel,'status',delivery.status)
                  ORDER BY delivery.channel
                ) FILTER (WHERE delivery.id IS NOT NULL),
                '[]'::jsonb
              ) AS deliveries
         FROM fleet_customer_notifications notification
         LEFT JOIN fleet_customer_notification_deliveries delivery
           ON delivery.notification_id=notification.id
        WHERE notification.organization_id=$1
        GROUP BY notification.id
        ORDER BY notification.created_at DESC
        LIMIT 100`,
      [organization(request)],
    );
    response.json({ success: true, data: result.rows.map(notificationPayload) });
  } catch (error) {
    next(error);
  }
});

router.post("/customer-notifications", employeeScope, requireCustomerSender, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const customerId = clean(request.body?.customerId, 80);
    const title = clean(request.body?.title, 160);
    const body = clean(request.body?.body, 4000);
    const category = clean(request.body?.category || "general", 40);
    const clientRequestId = clean(request.body?.clientRequestId || request.get("Idempotency-Key"), 200);
    const requestedChannels = Array.isArray(request.body?.channels) ? request.body.channels : ["in_app"];
    const channels = [...new Set(requestedChannels.map(value => clean(value, 20)).filter(value => NOTIFICATION_CHANNELS.has(value)))];
    if (!customerId || !title || !body) {
      return fail(response, 400, "INVALID_NOTIFICATION", "Customer, title, and message are required.");
    }
    if (!NOTIFICATION_CATEGORIES.has(category)) {
      return fail(response, 400, "INVALID_CATEGORY", "Choose a valid notification category.");
    }
    if (!clientRequestId) {
      return fail(response, 400, "IDEMPOTENCY_KEY_REQUIRED", "A client request ID is required.");
    }
    if (!channels.includes("in_app")) channels.unshift("in_app");
    const customer = await client.query(
      `SELECT customer.*, users.id AS recipient_user_id
         FROM fleet_customers customer
         LEFT JOIN users ON lower(users.email)=lower(customer.email) AND users.status='active'
        WHERE customer.organization_id=$1 AND customer.id=$2
        LIMIT 1`,
      [organization(request), customerId],
    );
    if (!customer.rowCount) return fail(response, 404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    const recipient = customer.rows[0];
    const phone = channels.includes("sms")
      ? normalizePhone(recipient.phone)
      : null;
    if (channels.includes("sms") && !phone) {
      return fail(
        response,
        409,
        "CUSTOMER_PHONE_REQUIRED",
        "Add a valid customer mobile number before sending a text message.",
      );
    }
    const providerResult = channels.includes("sms")
      ? await client.query(
          `SELECT id,organization_id,project_id,environment_id
             FROM goodbase_consumer_auth_providers
            WHERE organization_id=$1
              AND provider_type IN ('phone_otp','sms_mfa')
              AND status='enabled'
              AND controller_url IS NOT NULL
              AND secret_ref IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 1`,
          [organization(request)],
        )
      : { rows: [] };
    const smsProvider = providerResult.rows[0] || null;
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO fleet_customer_notifications
        (organization_id,customer_id,recipient_user_id,recipient_email,
         recipient_phone,title,body,category,channels,status,action_url,
         client_request_id,created_by)
       VALUES ($1,$2,$3,lower($4),$5,$6,$7,$8,$9,'queued',$10,$11,$12)
       ON CONFLICT (organization_id,created_by,client_request_id)
       DO UPDATE SET client_request_id=fleet_customer_notifications.client_request_id
       RETURNING *`,
      [
        organization(request),
        customerId,
        recipient.recipient_user_id || null,
        recipient.email,
        phone,
        title,
        body,
        category,
        channels,
        customerActionUrl(request.body?.actionUrl),
        clientRequestId,
        request.user.id,
      ],
    );
    const notification = inserted.rows[0];
    for (const channel of channels) {
      const deliveryStatus =
        channel === "in_app"
          ? "delivered"
          : channel === "sms" && !smsProvider
            ? "failed"
            : "pending";
      await client.query(
        `INSERT INTO fleet_customer_notification_deliveries
          (notification_id,channel,status,delivered_at,error_code)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (notification_id,channel) DO NOTHING`,
        [
          notification.id,
          channel,
          deliveryStatus,
          deliveryStatus === "delivered" ? new Date().toISOString() : null,
          channel === "sms" && !smsProvider
            ? "SMS_PROVIDER_UNAVAILABLE"
            : null,
        ],
      );
      if (channel === "email") {
        const queueId = `gfemail_${notification.id}`;
        await client.query(
          `INSERT INTO backend_email_queue
            (id,notification_id,to_email,to_name,subject,body_text,provider,status,organization_id,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'internal','pending',$7,NOW(),NOW())
           ON CONFLICT (id) DO NOTHING`,
          [queueId, String(notification.id), recipient.email, recipient.full_name, title, body, organization(request)],
        );
      }
      if (channel === "sms" && smsProvider) {
        const actionPath = customerActionUrl(request.body?.actionUrl);
        const secureUrl = actionPath ? `${PUBLIC_APP_URL}${actionPath}` : null;
        const smsBody = [
          `GoodFleet: ${title}`,
          body,
          secureUrl ? `Open securely: ${secureUrl}` : "",
          "Do not forward secure account links.",
        ]
          .filter(Boolean)
          .join(" ")
          .slice(0, 1500);
        await client.query(
          `INSERT INTO goodbase_sms_deliveries (
             organization_id,project_id,environment_id,user_id,
             destination_hash,encrypted_payload,provider_id,purpose,
             expires_at,fleet_notification_id
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,'fleet_notification',
                   NOW()+INTERVAL '7 days',$8)
           ON CONFLICT DO NOTHING`,
          [
            smsProvider.organization_id,
            smsProvider.project_id,
            smsProvider.environment_id,
            recipient.recipient_user_id || null,
            sha256(phone),
            encryptValue(
              JSON.stringify({
                phone,
                message: smsBody,
                actionUrl: secureUrl,
                notificationId: notification.id,
              }),
            ),
            smsProvider.id,
            notification.id,
          ],
        );
      }
    }
    const status = channels.some(channel => channel !== "in_app")
      ? "partially_delivered"
      : "delivered";
    const updated = await client.query(
      `UPDATE fleet_customer_notifications SET status=$2 WHERE id=$1 RETURNING *`,
      [notification.id, status],
    );
    await audit(client, request, "customer.notification.sent", "customer_notification", notification.id, {
      customerId,
      category,
      channels,
    });
    const deliveries = await client.query(
      `SELECT channel,status FROM fleet_customer_notification_deliveries WHERE notification_id=$1 ORDER BY channel`,
      [notification.id],
    );
    await client.query("COMMIT");
    response.status(201).json({
      success: true,
      data: notificationPayload({ ...updated.rows[0], deliveries: deliveries.rows }),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/sms-readiness", employeeScope, requireCustomerSender, async (request, response, next) => {
  try {
    const result = await query(
      `SELECT
         EXISTS (
           SELECT 1
             FROM goodbase_consumer_auth_providers provider
            WHERE provider.organization_id=$1
              AND provider.provider_type IN ('phone_otp','sms_mfa')
              AND provider.status='enabled'
              AND provider.controller_url IS NOT NULL
              AND provider.secret_ref IS NOT NULL
         ) AS provider_configured,
         COUNT(*) FILTER (WHERE delivery.status='queued')::integer AS queued,
         COUNT(*) FILTER (WHERE delivery.status='sending')::integer AS sending,
         COUNT(*) FILTER (WHERE delivery.status='delivered')::integer AS delivered,
         COUNT(*) FILTER (WHERE delivery.status='failed')::integer AS failed,
         MAX(delivery.completed_at) FILTER (
           WHERE delivery.status='delivered'
         ) AS last_delivered_at,
         (
           SELECT failed_delivery.error_code
             FROM goodbase_sms_deliveries failed_delivery
            WHERE failed_delivery.organization_id=$1
              AND failed_delivery.status='failed'
            ORDER BY failed_delivery.created_at DESC
            LIMIT 1
         ) AS last_error_code
       FROM goodbase_sms_deliveries delivery
      WHERE delivery.organization_id=$1
        AND delivery.created_at>=NOW()-INTERVAL '30 days'`,
      [organization(request)],
    );
    const data = result.rows[0] || {};
    response.json({
      success: true,
      data: {
        softwareReady: true,
        providerConfigured: Boolean(data.provider_configured),
        workerReady: true,
        queue: {
          queued: Number(data.queued || 0),
          sending: Number(data.sending || 0),
          delivered: Number(data.delivered || 0),
          failed: Number(data.failed || 0),
        },
        lastDeliveredAt: data.last_delivered_at || null,
        lastErrorCode: data.last_error_code || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/checkins", employeeScope, requireCustomerSender, async (request, response, next) => {
  try {
    const result = await query(
      `SELECT checkin.*,
              booking.reservation_number,
              customer.full_name AS customer_name,
              customer.email AS customer_email
         FROM fleet_customer_checkins checkin
         JOIN fleet_bookings booking
           ON booking.organization_id=checkin.organization_id AND booking.id=checkin.booking_id
         JOIN fleet_customers customer
           ON customer.organization_id=checkin.organization_id AND customer.id=checkin.customer_id
        WHERE checkin.organization_id=$1
        ORDER BY checkin.updated_at DESC
        LIMIT 200`,
      [organization(request)],
    );
    response.json({
      success: true,
      data: result.rows.map(row => ({
        ...customerCheckinPayload(row),
        reservationNumber: row.reservation_number,
        customerName: row.customer_name,
        customerEmail: row.customer_email,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/checkins/:checkinId", employeeScope, requireCustomerSender, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const status = clean(request.body?.status, 40);
    const reviewNote = clean(request.body?.reviewNote, 2000) || null;
    if (!["approved", "rejected"].includes(status)) {
      return fail(response, 400, "INVALID_CHECKIN_REVIEW", "Choose approved or rejected.");
    }
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE fleet_customer_checkins
          SET status=$3,review_note=$4,reviewed_by=$5,reviewed_at=NOW(),updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
        RETURNING *`,
      [organization(request), request.params.checkinId, status, reviewNote, request.user.id],
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "CHECKIN_NOT_FOUND", "Digital check-in not found.");
    }
    await audit(client, request, `customer.checkin.${status}`, "customer_checkin", result.rows[0].id, {
      bookingId: result.rows[0].booking_id,
      reviewNote,
    });
    await client.query("COMMIT");
    response.json({ success: true, data: customerCheckinPayload(result.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/support-tickets", employeeScope, requireCustomerSender, async (request, response, next) => {
  try {
    const tickets = await query(
      `SELECT ticket.*, customer.full_name AS customer_name, customer.email AS customer_email
         FROM fleet_customer_support_tickets ticket
         JOIN fleet_customers customer
           ON customer.organization_id=ticket.organization_id AND customer.id=ticket.customer_id
        WHERE ticket.organization_id=$1
        ORDER BY ticket.updated_at DESC
        LIMIT 200`,
      [organization(request)],
    );
    const messages = tickets.rowCount
      ? await query(
        `SELECT *
           FROM fleet_customer_support_messages
          WHERE organization_id=$1 AND ticket_id=ANY($2::uuid[])
          ORDER BY created_at`,
        [organization(request), tickets.rows.map(ticket => ticket.id)],
      )
      : { rows: [] };
    response.json({
      success: true,
      data: tickets.rows.map(ticket => ({
        ...customerSupportTicketPayload(
          ticket,
          messages.rows.filter(message => message.ticket_id === ticket.id),
        ),
        customerName: ticket.customer_name,
        customerEmail: ticket.customer_email,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/support-tickets/:ticketId/messages", employeeScope, requireCustomerSender, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const body = clean(request.body?.body, 4000);
    const nextStatus = clean(request.body?.status || "in_progress", 40);
    if (!body) return fail(response, 400, "SUPPORT_MESSAGE_REQUIRED", "Enter a support response.");
    if (!["open", "in_progress", "waiting_on_customer", "resolved", "closed"].includes(nextStatus)) {
      return fail(response, 400, "INVALID_SUPPORT_STATUS", "Choose a valid support status.");
    }
    await client.query("BEGIN");
    const ticket = await client.query(
      `UPDATE fleet_customer_support_tickets
          SET status=$3,
              assigned_to=COALESCE(assigned_to,$4),
              resolved_at=CASE WHEN $3 IN ('resolved','closed') THEN NOW() ELSE NULL END,
              updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
        RETURNING *`,
      [organization(request), request.params.ticketId, nextStatus, request.user.id],
    );
    if (!ticket.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "SUPPORT_TICKET_NOT_FOUND", "Support ticket not found.");
    }
    const message = await client.query(
      `INSERT INTO fleet_customer_support_messages
        (organization_id,ticket_id,sender_type,sender_user_id,body)
       VALUES ($1,$2,'employee',$3,$4)
       RETURNING *`,
      [organization(request), ticket.rows[0].id, request.user.id, body],
    );
    await audit(client, request, "customer.support.responded", "customer_support_ticket", ticket.rows[0].id, {
      status: nextStatus,
    });
    await client.query("COMMIT");
    response.status(201).json({
      success: true,
      data: customerSupportTicketPayload(ticket.rows[0], message.rows),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/customer-inbox", async (request, response, next) => {
  try {
    const email = clean(request.user.email, 320).toLowerCase();
    const result = await query(
      `SELECT notification.*,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object('channel',delivery.channel,'status',delivery.status)
                  ORDER BY delivery.channel
                ) FILTER (WHERE delivery.id IS NOT NULL),
                '[]'::jsonb
              ) AS deliveries
         FROM fleet_customer_notifications notification
         LEFT JOIN fleet_customer_notification_deliveries delivery
           ON delivery.notification_id=notification.id
        WHERE notification.archived_at IS NULL
          AND (
            notification.recipient_user_id=$1
            OR (notification.recipient_user_id IS NULL AND lower(notification.recipient_email)=lower($2))
          )
        GROUP BY notification.id
        ORDER BY notification.created_at DESC
        LIMIT 100`,
      [request.user.id, email],
    );
    response.json({ success: true, data: result.rows.map(notificationPayload) });
  } catch (error) {
    next(error);
  }
});

router.get("/customer-checkins", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const customer = await customerRecordForIdentity(client, request);
    if (!customer) return response.json({ success: true, data: [] });
    const result = await client.query(
      `SELECT checkin.*
         FROM fleet_customer_checkins checkin
        WHERE checkin.organization_id=$1 AND checkin.customer_id=$2
        ORDER BY checkin.updated_at DESC`,
      [customer.organization_id, customer.id],
    );
    response.json({ success: true, data: result.rows.map(customerCheckinPayload) });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.post("/customer-checkins", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const bookingId = clean(request.body?.bookingId, 80);
    const checklist = request.body?.checklist && typeof request.body.checklist === "object"
      ? request.body.checklist
      : {};
    if (!bookingId) return fail(response, 400, "BOOKING_REQUIRED", "Choose a reservation to check in.");
    if (!REQUIRED_CHECKIN_ACKNOWLEDGEMENTS.every(key => checklist[key] === true)) {
      return fail(response, 400, "CHECKIN_ACKNOWLEDGEMENTS_REQUIRED", "Complete every check-in acknowledgement.");
    }
    const customer = await customerRecordForIdentity(client, request);
    if (!customer) return fail(response, 404, "CUSTOMER_ACCOUNT_NOT_FOUND", "A GoodFleet customer record is required.");
    if (customer.license_verification_status !== "verified") {
      return fail(response, 409, "CUSTOMER_VERIFICATION_REQUIRED", "Driver license verification must be completed before digital check-in.");
    }
    const booking = await client.query(
      `SELECT *
         FROM fleet_bookings
        WHERE organization_id=$1 AND id=$2 AND customer_id=$3 AND archived_at IS NULL
        LIMIT 1`,
      [customer.organization_id, bookingId, customer.id],
    );
    if (!booking.rowCount) return fail(response, 404, "BOOKING_NOT_FOUND", "Reservation not found.");
    if (!CUSTOMER_CHECKIN_BOOKING_STATUSES.has(booking.rows[0].status)) {
      return fail(response, 409, "BOOKING_NOT_READY_FOR_CHECKIN", "This reservation is not ready for digital check-in.");
    }
    if (booking.rows[0].payment_status !== "paid") {
      return fail(response, 409, "PAYMENT_REQUIRED", "The reservation balance must be paid before digital check-in.");
    }
    await client.query("BEGIN");
    const saved = await client.query(
      `INSERT INTO fleet_customer_checkins
        (organization_id,booking_id,customer_id,status,checklist_json,submitted_by,submitted_at)
       VALUES ($1,$2,$3,'submitted',$4::jsonb,$5,NOW())
       ON CONFLICT (organization_id,booking_id)
       DO UPDATE SET
         status='submitted',
         checklist_json=EXCLUDED.checklist_json,
         submitted_by=EXCLUDED.submitted_by,
         submitted_at=NOW(),
         reviewed_by=NULL,
         reviewed_at=NULL,
         review_note=NULL,
         updated_at=NOW()
       RETURNING *`,
      [
        customer.organization_id,
        bookingId,
        customer.id,
        JSON.stringify(checklist),
        request.user.id,
      ],
    );
    await auditCustomerAction(
      client,
      request,
      customer.organization_id,
      "customer.checkin.submitted",
      "customer_checkin",
      saved.rows[0].id,
      { bookingId, customerId: customer.id },
    );
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: customerCheckinPayload(saved.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/customer-support-tickets", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const customer = await customerRecordForIdentity(client, request);
    if (!customer) return response.json({ success: true, data: [] });
    const tickets = await client.query(
      `SELECT *
         FROM fleet_customer_support_tickets
        WHERE organization_id=$1 AND customer_id=$2
        ORDER BY updated_at DESC`,
      [customer.organization_id, customer.id],
    );
    const messages = tickets.rowCount
      ? await client.query(
        `SELECT *
           FROM fleet_customer_support_messages
          WHERE organization_id=$1 AND ticket_id=ANY($2::uuid[])
          ORDER BY created_at`,
        [customer.organization_id, tickets.rows.map(ticket => ticket.id)],
      )
      : { rows: [] };
    response.json({
      success: true,
      data: tickets.rows.map(ticket => customerSupportTicketPayload(
        ticket,
        messages.rows.filter(message => message.ticket_id === ticket.id),
      )),
    });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.post("/customer-support-tickets", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const subject = clean(request.body?.subject, 160);
    const body = clean(request.body?.body, 4000);
    const category = clean(request.body?.category || "other", 40);
    const bookingId = clean(request.body?.bookingId, 80) || null;
    if (!subject || !body) return fail(response, 400, "SUPPORT_DETAILS_REQUIRED", "Subject and message are required.");
    if (!CUSTOMER_SUPPORT_CATEGORIES.has(category)) {
      return fail(response, 400, "INVALID_SUPPORT_CATEGORY", "Choose a valid support category.");
    }
    const customer = await customerRecordForIdentity(client, request);
    if (!customer) return fail(response, 404, "CUSTOMER_ACCOUNT_NOT_FOUND", "A GoodFleet customer record is required.");
    if (bookingId) {
      const booking = await client.query(
        `SELECT id FROM fleet_bookings
          WHERE organization_id=$1 AND id=$2 AND customer_id=$3 AND archived_at IS NULL`,
        [customer.organization_id, bookingId, customer.id],
      );
      if (!booking.rowCount) return fail(response, 404, "BOOKING_NOT_FOUND", "Reservation not found.");
    }
    const ticketNumber = `GF-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const priority = category === "roadside" ? "urgent" : "normal";
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO fleet_customer_support_tickets
        (organization_id,customer_id,booking_id,ticket_number,subject,category,priority,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8)
       RETURNING *`,
      [customer.organization_id, customer.id, bookingId, ticketNumber, subject, category, priority, request.user.id],
    );
    const message = await client.query(
      `INSERT INTO fleet_customer_support_messages
        (organization_id,ticket_id,sender_type,sender_user_id,body)
       VALUES ($1,$2,'customer',$3,$4)
       RETURNING *`,
      [customer.organization_id, inserted.rows[0].id, request.user.id, body],
    );
    await auditCustomerAction(
      client,
      request,
      customer.organization_id,
      "customer.support.opened",
      "customer_support_ticket",
      inserted.rows[0].id,
      { customerId: customer.id, category, bookingId },
    );
    await client.query("COMMIT");
    response.status(201).json({
      success: true,
      data: customerSupportTicketPayload(inserted.rows[0], message.rows),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/customer-support-tickets/:ticketId/messages", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const body = clean(request.body?.body, 4000);
    if (!body) return fail(response, 400, "SUPPORT_MESSAGE_REQUIRED", "Enter a support message.");
    const customer = await customerRecordForIdentity(client, request);
    if (!customer) return fail(response, 404, "CUSTOMER_ACCOUNT_NOT_FOUND", "A GoodFleet customer record is required.");
    await client.query("BEGIN");
    const ticket = await client.query(
      `UPDATE fleet_customer_support_tickets
          SET status=CASE WHEN status='waiting_on_customer' THEN 'open' ELSE status END,
              updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 AND customer_id=$3
          AND status NOT IN ('closed')
        RETURNING *`,
      [customer.organization_id, request.params.ticketId, customer.id],
    );
    if (!ticket.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "SUPPORT_TICKET_NOT_FOUND", "Open support ticket not found.");
    }
    const message = await client.query(
      `INSERT INTO fleet_customer_support_messages
        (organization_id,ticket_id,sender_type,sender_user_id,body)
       VALUES ($1,$2,'customer',$3,$4)
       RETURNING *`,
      [customer.organization_id, ticket.rows[0].id, request.user.id, body],
    );
    await auditCustomerAction(
      client,
      request,
      customer.organization_id,
      "customer.support.replied",
      "customer_support_ticket",
      ticket.rows[0].id,
      { customerId: customer.id },
    );
    await client.query("COMMIT");
    response.status(201).json({
      success: true,
      data: customerSupportTicketPayload(ticket.rows[0], message.rows),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/customer-account", async (request, response, next) => {
  try {
    const email = clean(request.user.email, 320).toLowerCase();
    const customer = await query(
      `SELECT * FROM fleet_customers
       WHERE lower(email)=lower($1) AND archived_at IS NULL
       ORDER BY updated_at DESC LIMIT 1`,
      [email]
    );
    if (!customer.rowCount) {
      return response.json({
        success: true,
        data: { customer: null, bookings: [], payments: [] }
      });
    }
    const record = customer.rows[0];
    const [bookings, payments] = await Promise.all([
      query(
        `SELECT * FROM fleet_bookings
         WHERE organization_id=$1 AND customer_id=$2 AND archived_at IS NULL
         ORDER BY pickup_at DESC`,
        [record.organization_id, record.id]
      ),
      query(
        `SELECT * FROM fleet_payment_operations
         WHERE organization_id=$1 AND customer_id=$2
         ORDER BY created_at DESC`,
        [record.organization_id, record.id]
      )
    ]);
    response.json({
      success: true,
      data: {
        customer: customerAccountPayload(record),
        bookings: bookings.rows.map(customerBookingPayload),
        payments: payments.rows.map(payment => ({
          id: payment.id,
          bookingId: payment.booking_id,
          amount: Number(payment.amount),
          currency: payment.currency,
          status: payment.status === "succeeded"
            ? "completed"
            : payment.status === "failed"
              ? "failed"
              : "pending",
          method: "Credit Card",
          transactionId: payment.provider_reference || undefined,
          createdAt: payment.created_at,
          description: payment.operation_type.replaceAll("_", " "),
          type: payment.operation_type === "refund" ? "refund" : "rental",
          refunded: payment.operation_type === "refund" && payment.status === "succeeded"
        }))
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post("/customer-inbox/:notificationId/read", async (request, response, next) => {
  try {
    const email = clean(request.user.email, 320).toLowerCase();
    const result = await query(
      `UPDATE fleet_customer_notifications
          SET read_at=COALESCE(read_at,NOW())
        WHERE id=$1 AND archived_at IS NULL
          AND (
            recipient_user_id=$2
            OR (recipient_user_id IS NULL AND lower(recipient_email)=lower($3))
          )
        RETURNING *`,
      [request.params.notificationId, request.user.id, email],
    );
    if (!result.rowCount) return fail(response, 404, "NOTIFICATION_NOT_FOUND", "Notification not found.");
    response.json({ success: true, data: notificationPayload(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
