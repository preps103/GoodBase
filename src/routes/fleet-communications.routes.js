"use strict";

const crypto = require("crypto");
const express = require("express");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { pool, query } = require("../config/database");

const router = express.Router();
router.use(authRequired);

const EMPLOYEE_ROLES = new Set(["owner", "admin", "manager", "staff", "mechanic"]);
const CUSTOMER_SEND_ROLES = new Set(["owner", "admin", "manager", "staff"]);
const NOTIFICATION_CATEGORIES = new Set(["reservation", "payment", "trip", "support", "general"]);
const NOTIFICATION_CHANNELS = new Set(["in_app", "email"]);

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
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
  return clean(request.tenantContext.organization?.membershipRole, 40).toLowerCase();
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
    ["operations", "Operations", "Daily reservations, handoffs, and branch coordination."],
    ["front-desk", "Front desk", "Customer arrivals, departures, and reservation support."],
    ["fleet-service", "Fleet & service", "Vehicle readiness, maintenance, and turnaround."],
  ];
  for (const [slug, name, description] of defaults) {
    await client.query(
      `INSERT INTO fleet_chat_channels
        (organization_id, channel_type, name, slug, description, created_by)
       VALUES ($1,'group',$2,$3,$4,$5)
       ON CONFLICT (organization_id, slug) DO NOTHING`,
      [organization(request), name, slug, description, request.user.id],
    );
  }
}

async function requireChannelAccess(client, request, channelId) {
  const result = await client.query(
    `SELECT channel.*
       FROM fleet_chat_channels channel
       LEFT JOIN fleet_chat_channel_members member
         ON member.channel_id=channel.id AND member.user_id=$3
      WHERE channel.organization_id=$1 AND channel.id=$2
        AND (channel.channel_type='group' OR member.user_id IS NOT NULL)
      LIMIT 1`,
    [organization(request), channelId, request.user.id],
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
                channel.channel_type AS "channelType", channel.updated_at AS "updatedAt",
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
            AND (channel.channel_type='group' OR membership.user_id IS NOT NULL)
          GROUP BY channel.id, read_state.last_read_at
          ORDER BY COALESCE(MAX(message.created_at), channel.updated_at) DESC`,
        [organization(request), request.user.id],
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
        (organization_id,channel_type,name,slug,description,created_by)
       VALUES ($1,'direct',$2,$3,'Private employee conversation',$4)
       ON CONFLICT (organization_id,slug) DO UPDATE SET updated_at=NOW()
       RETURNING id,name,slug,description,channel_type AS "channelType",updated_at AS "updatedAt"`,
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
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO fleet_customer_notifications
        (organization_id,customer_id,recipient_user_id,recipient_email,title,body,category,channels,status,action_url,client_request_id,created_by)
       VALUES ($1,$2,$3,lower($4),$5,$6,$7,$8,'queued',$9,$10,$11)
       ON CONFLICT (organization_id,created_by,client_request_id)
       DO UPDATE SET client_request_id=fleet_customer_notifications.client_request_id
       RETURNING *`,
      [
        organization(request),
        customerId,
        recipient.recipient_user_id || null,
        recipient.email,
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
      const deliveryStatus = channel === "in_app" ? "delivered" : "pending";
      await client.query(
        `INSERT INTO fleet_customer_notification_deliveries
          (notification_id,channel,status,delivered_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (notification_id,channel) DO NOTHING`,
        [notification.id, channel, deliveryStatus, deliveryStatus === "delivered" ? new Date().toISOString() : null],
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
    }
    const status = channels.includes("email") ? "partially_delivered" : "delivered";
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
