"use strict";

const crypto = require("node:crypto");
const database = require("../config/database");
const notificationService = require("./notification.service");

const APP_ID = "goodcustom";
const APP_URL = "https://custom.goodos.app";
const DEFAULT_ROOM_ID = "00000000-0000-4000-8000-000000000001";
const MANAGEMENT_ROLES = new Set(["owner", "manager"]);

async function health() {
  const result = await database.query(`
    SELECT
      TO_REGCLASS('public.goodcustom_staff') IS NOT NULL AS "staffReady",
      TO_REGCLASS('public.goodcustom_chat_rooms') IS NOT NULL AS "roomsReady",
      TO_REGCLASS('public.goodcustom_chat_room_members') IS NOT NULL AS "membersReady",
      TO_REGCLASS('public.goodcustom_chat_messages') IS NOT NULL AS "messagesReady"
  `);
  const tables = result.rows[0] || {};
  const schemaReady = Object.values(tables).every(Boolean);
  return {
    service: "GoodCustom Chat",
    status: schemaReady ? "ok" : "setup_required",
    schemaReady,
    tables,
  };
}

function serviceError(message, statusCode = 400, code = "GOODCUSTOM_CHAT_REQUEST_FAILED") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanText(value, maximum = 500) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maximum);
}

function cleanMessage(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, 4000);
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function platformRole(user) {
  return String(user?.platformRole || user?.role || "").toLowerCase();
}

function isPlatformManager(user) {
  return ["owner", "admin"].includes(platformRole(user));
}

function isChatManager(staff) {
  return MANAGEMENT_ROLES.has(String(staff?.role || "").toLowerCase());
}

function requireManagement(staff) {
  if (!isChatManager(staff)) {
    throw serviceError(
      "GoodCustom management access is required.",
      403,
      "GOODCUSTOM_CHAT_MANAGEMENT_REQUIRED",
    );
  }
}

function validTimestamp(value) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const STAFF_SELECT = `
  SELECT
    staff.user_id AS "userId",
    account.email,
    COALESCE(
      NULLIF(account.display_name, ''),
      NULLIF(CONCAT_WS(' ', account.first_name, account.last_name), ''),
      SPLIT_PART(account.email, '@', 1)
    ) AS "displayName",
    COALESCE(
      account.auth_metadata_json ->> 'avatarUrl',
      account.auth_metadata_json ->> 'avatar_url',
      account.auth_metadata_json ->> 'profileImageUrl',
      account.auth_metadata_json ->> 'picture',
      account.auth_metadata_json ->> 'photoURL'
    ) AS "avatarUrl",
    staff.role,
    staff.status,
    staff.joined_at AS "joinedAt",
    staff.last_seen_at AS "lastSeenAt",
    account.platform_role AS "platformRole"
  FROM goodcustom_staff staff
  JOIN users account ON account.id = staff.user_id
`;

async function getStaffRecord(userId) {
  const result = await database.query(
    `${STAFF_SELECT} WHERE staff.user_id = $1::uuid LIMIT 1`,
    [userId],
  );
  return result.rows[0] || null;
}

async function ensureDefaultRoomMembership(userId, role) {
  await database.query(
    `
      INSERT INTO goodcustom_chat_room_members (
        room_id,
        user_id,
        role
      )
      VALUES ($1::uuid, $2::uuid, $3)
      ON CONFLICT (room_id, user_id) DO UPDATE
      SET
        role = EXCLUDED.role,
        removed_at = NULL
    `,
    [DEFAULT_ROOM_ID, userId, MANAGEMENT_ROLES.has(role) ? "admin" : "member"],
  );
}

async function requireStaff(user) {
  if (!user?.id) {
    throw serviceError(
      "GoodBase sign-in is required.",
      401,
      "GOODCUSTOM_CHAT_AUTH_REQUIRED",
    );
  }

  if (isPlatformManager(user)) {
    const role = platformRole(user) === "owner" ? "owner" : "manager";
    await database.query(
      `
        INSERT INTO goodcustom_staff (
          user_id,
          role,
          status,
          invited_by,
          last_seen_at
        )
        VALUES ($1::uuid, $2, 'active', $1::uuid, NOW())
        ON CONFLICT (user_id) DO UPDATE
        SET
          role = CASE
            WHEN EXCLUDED.role = 'owner' THEN 'owner'
            WHEN goodcustom_staff.role = 'employee' THEN 'manager'
            ELSE goodcustom_staff.role
          END,
          status = 'active',
          last_seen_at = NOW()
      `,
      [user.id, role],
    );
  } else {
    const current = await getStaffRecord(user.id);
    if (!current || current.status !== "active") {
      throw serviceError(
        "Your account is not an active GoodCustom staff member.",
        403,
        "GOODCUSTOM_CHAT_STAFF_REQUIRED",
      );
    }
    await database.query(
      "UPDATE goodcustom_staff SET last_seen_at = NOW() WHERE user_id = $1::uuid",
      [user.id],
    );
  }

  const staff = await getStaffRecord(user.id);
  if (!staff || staff.status !== "active") {
    throw serviceError(
      "Your account is not an active GoodCustom staff member.",
      403,
      "GOODCUSTOM_CHAT_STAFF_REQUIRED",
    );
  }
  await ensureDefaultRoomMembership(user.id, staff.role);
  return staff;
}

async function requireRoomMembership(userId, roomId) {
  const result = await database.query(
    `
      SELECT
        room.id,
        room.kind,
        room.name,
        member.role AS "memberRole"
      FROM goodcustom_chat_room_members member
      JOIN goodcustom_chat_rooms room ON room.id = member.room_id
      WHERE member.user_id = $1::uuid
        AND member.room_id = $2::uuid
        AND member.removed_at IS NULL
        AND room.archived_at IS NULL
      LIMIT 1
    `,
    [userId, roomId],
  );
  const room = result.rows[0];
  if (!room) {
    throw serviceError(
      "This GoodCustom conversation is not available to your account.",
      403,
      "GOODCUSTOM_CHAT_ROOM_ACCESS_REQUIRED",
    );
  }
  return room;
}

async function listStaff({ includeSuspended = false } = {}) {
  const result = await database.query(
    `
      ${STAFF_SELECT}
      ${includeSuspended ? "" : "WHERE staff.status = 'active'"}
      ORDER BY
        CASE staff.role
          WHEN 'owner' THEN 1
          WHEN 'manager' THEN 2
          ELSE 3
        END,
        LOWER(COALESCE(account.display_name, account.email))
    `,
  );
  return result.rows;
}

async function listRooms(userId) {
  const result = await database.query(
    `
      SELECT
        room.id,
        room.kind,
        room.name,
        room.description,
        room.is_default AS "isDefault",
        membership.role AS "memberRole",
        membership.last_read_at AS "lastReadAt",
        room.created_at AS "createdAt",
        room.updated_at AS "updatedAt",
        COALESCE((
          SELECT COUNT(*)::int
          FROM goodcustom_chat_messages unread_message
          WHERE unread_message.room_id = room.id
            AND unread_message.deleted_at IS NULL
            AND unread_message.sender_user_id <> $1::uuid
            AND unread_message.created_at > membership.last_read_at
        ), 0) AS "unreadCount",
        COALESCE((
          SELECT JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'userId', room_member.user_id,
              'email', room_account.email,
              'displayName', COALESCE(
                NULLIF(room_account.display_name, ''),
                NULLIF(CONCAT_WS(' ', room_account.first_name, room_account.last_name), ''),
                SPLIT_PART(room_account.email, '@', 1)
              ),
              'avatarUrl', COALESCE(
                room_account.auth_metadata_json ->> 'avatarUrl',
                room_account.auth_metadata_json ->> 'avatar_url',
                room_account.auth_metadata_json ->> 'profileImageUrl',
                room_account.auth_metadata_json ->> 'picture',
                room_account.auth_metadata_json ->> 'photoURL'
              ),
              'role', room_staff.role,
              'lastSeenAt', room_staff.last_seen_at
            )
            ORDER BY LOWER(COALESCE(room_account.display_name, room_account.email))
          )
          FROM goodcustom_chat_room_members room_member
          JOIN users room_account ON room_account.id = room_member.user_id
          JOIN goodcustom_staff room_staff ON room_staff.user_id = room_member.user_id
          WHERE room_member.room_id = room.id
            AND room_member.removed_at IS NULL
            AND room_staff.status = 'active'
        ), '[]'::jsonb) AS members,
        (
          SELECT JSONB_BUILD_OBJECT(
            'id', latest.id,
            'body', CASE WHEN latest.deleted_at IS NULL THEN latest.body ELSE NULL END,
            'senderUserId', latest.sender_user_id,
            'senderName', COALESCE(
              NULLIF(latest_account.display_name, ''),
              NULLIF(CONCAT_WS(' ', latest_account.first_name, latest_account.last_name), ''),
              SPLIT_PART(latest_account.email, '@', 1)
            ),
            'createdAt', latest.created_at,
            'deletedAt', latest.deleted_at
          )
          FROM goodcustom_chat_messages latest
          JOIN users latest_account ON latest_account.id = latest.sender_user_id
          WHERE latest.room_id = room.id
          ORDER BY latest.created_at DESC
          LIMIT 1
        ) AS "lastMessage"
      FROM goodcustom_chat_room_members membership
      JOIN goodcustom_chat_rooms room ON room.id = membership.room_id
      WHERE membership.user_id = $1::uuid
        AND membership.removed_at IS NULL
        AND room.archived_at IS NULL
      ORDER BY
        COALESCE((
          SELECT MAX(message.created_at)
          FROM goodcustom_chat_messages message
          WHERE message.room_id = room.id
        ), room.updated_at) DESC
    `,
    [userId],
  );
  return result.rows;
}

async function unreadSummary(userId) {
  const result = await database.query(
    `
      SELECT
        COUNT(message.id)::int AS unread
      FROM goodcustom_chat_room_members membership
      JOIN goodcustom_chat_rooms room ON room.id = membership.room_id
      LEFT JOIN goodcustom_chat_messages message
        ON message.room_id = membership.room_id
       AND message.deleted_at IS NULL
       AND message.sender_user_id <> $1::uuid
       AND message.created_at > membership.last_read_at
      WHERE membership.user_id = $1::uuid
        AND membership.removed_at IS NULL
        AND room.archived_at IS NULL
    `,
    [userId],
  );
  return Number(result.rows[0]?.unread || 0);
}

async function bootstrap(user) {
  const currentUser = await requireStaff(user);
  const manageStaff = isChatManager(currentUser);
  const [rooms, staff, unread] = await Promise.all([
    listRooms(user.id),
    listStaff({ includeSuspended: manageStaff }),
    unreadSummary(user.id),
  ]);
  return {
    currentUser,
    permissions: {
      manageStaff,
      createChannels: manageStaff,
      moderateMessages: manageStaff,
    },
    rooms,
    staff,
    unread,
    pollIntervalMs: 3500,
  };
}

async function unread(user) {
  const currentUser = await requireStaff(user);
  return {
    unread: await unreadSummary(user.id),
    staff: true,
    role: currentUser.role,
  };
}

function messageSelect(whereClause) {
  return `
    SELECT
      message.id,
      message.room_id AS "roomId",
      message.sender_user_id AS "senderUserId",
      CASE WHEN message.deleted_at IS NULL THEN message.body ELSE NULL END AS body,
      message.reply_to_message_id AS "replyToMessageId",
      message.edited_at AS "editedAt",
      message.deleted_at AS "deletedAt",
      message.created_at AS "createdAt",
      message.updated_at AS "updatedAt",
      COALESCE(
        NULLIF(sender.display_name, ''),
        NULLIF(CONCAT_WS(' ', sender.first_name, sender.last_name), ''),
        SPLIT_PART(sender.email, '@', 1)
      ) AS "senderName",
      sender.email AS "senderEmail",
      COALESCE(
        sender.auth_metadata_json ->> 'avatarUrl',
        sender.auth_metadata_json ->> 'avatar_url',
        sender.auth_metadata_json ->> 'profileImageUrl',
        sender.auth_metadata_json ->> 'picture',
        sender.auth_metadata_json ->> 'photoURL'
      ) AS "senderAvatarUrl",
      COALESCE(sender_staff.role, 'employee') AS "senderRole",
      CASE
        WHEN reply.id IS NULL THEN NULL
        ELSE JSONB_BUILD_OBJECT(
          'id', reply.id,
          'body', CASE WHEN reply.deleted_at IS NULL THEN reply.body ELSE NULL END,
          'senderUserId', reply.sender_user_id,
          'senderName', COALESCE(
            NULLIF(reply_sender.display_name, ''),
            NULLIF(CONCAT_WS(' ', reply_sender.first_name, reply_sender.last_name), ''),
            SPLIT_PART(reply_sender.email, '@', 1)
          ),
          'deletedAt', reply.deleted_at
        )
      END AS reply
    FROM goodcustom_chat_messages message
    JOIN users sender ON sender.id = message.sender_user_id
    LEFT JOIN goodcustom_staff sender_staff ON sender_staff.user_id = message.sender_user_id
    LEFT JOIN goodcustom_chat_messages reply ON reply.id = message.reply_to_message_id
    LEFT JOIN users reply_sender ON reply_sender.id = reply.sender_user_id
    ${whereClause}
  `;
}

async function getMessages({ user, roomId, before, after, limit }) {
  await requireStaff(user);
  await requireRoomMembership(user.id, roomId);
  const pageSize = positiveInteger(limit, 60, 100);
  const afterTimestamp = validTimestamp(after);
  const beforeTimestamp = validTimestamp(before);
  const params = [roomId];
  let timeClause = "";

  if (afterTimestamp) {
    params.push(afterTimestamp);
    timeClause = `AND message.created_at > $${params.length}::timestamptz`;
  } else if (beforeTimestamp) {
    params.push(beforeTimestamp);
    timeClause = `AND message.created_at < $${params.length}::timestamptz`;
  }
  params.push(pageSize + 1);

  const ascending = Boolean(afterTimestamp);
  const result = await database.query(
    `
      ${messageSelect(`
        WHERE message.room_id = $1::uuid
          ${timeClause}
      `)}
      ORDER BY message.created_at ${ascending ? "ASC" : "DESC"}
      LIMIT $${params.length}
    `,
    params,
  );

  const hasMore = result.rows.length > pageSize;
  let messages = result.rows.slice(0, pageSize);
  if (!ascending) messages = messages.reverse();
  return { messages, hasMore };
}

async function getRoomForUser(userId, roomId) {
  const rooms = await listRooms(userId);
  return rooms.find((room) => room.id === roomId) || null;
}

async function createDirectRoom({ user, targetUserId }) {
  const currentUser = await requireStaff(user);
  const targetId = cleanText(targetUserId, 64);
  if (!targetId || targetId === user.id) {
    throw serviceError("Choose another GoodCustom staff member.");
  }
  const target = await getStaffRecord(targetId);
  if (!target || target.status !== "active") {
    throw serviceError("That GoodCustom staff member is not available.", 404);
  }
  const directKey = [user.id, targetId].sort().join(":");
  const client = await database.pool.connect();
  let roomId;
  try {
    await client.query("BEGIN");
    const roomResult = await client.query(
      `
        INSERT INTO goodcustom_chat_rooms (
          id,
          kind,
          direct_key,
          created_by
        )
        VALUES ($1::uuid, 'direct', $2, $3::uuid)
        ON CONFLICT (direct_key) DO UPDATE
        SET archived_at = NULL
        RETURNING id
      `,
      [crypto.randomUUID(), directKey, user.id],
    );
    roomId = roomResult.rows[0].id;
    await client.query(
      `
        INSERT INTO goodcustom_chat_room_members (room_id, user_id, role)
        VALUES
          ($1::uuid, $2::uuid, $4),
          ($1::uuid, $3::uuid, $5)
        ON CONFLICT (room_id, user_id) DO UPDATE
        SET removed_at = NULL
      `,
      [
        roomId,
        user.id,
        targetId,
        isChatManager(currentUser) ? "admin" : "member",
        isChatManager(target) ? "admin" : "member",
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getRoomForUser(user.id, roomId);
}

async function createChannel({ user, name, description, memberUserIds }) {
  const currentUser = await requireStaff(user);
  requireManagement(currentUser);
  const channelName = cleanText(name, 80);
  if (channelName.length < 2) {
    throw serviceError("A channel name is required.");
  }
  const channelDescription = cleanText(description, 240) || null;
  const requestedIds = Array.isArray(memberUserIds)
    ? memberUserIds.map((value) => cleanText(value, 64)).filter(Boolean).slice(0, 100)
    : [];
  const uniqueIds = [...new Set([user.id, ...requestedIds])];
  const validMembers = await database.query(
    `
      SELECT user_id AS "userId", role
      FROM goodcustom_staff
      WHERE user_id = ANY($1::uuid[])
        AND status = 'active'
    `,
    [uniqueIds],
  );
  if (!validMembers.rows.some((member) => member.userId === user.id)) {
    throw serviceError("The channel creator must be an active staff member.", 403);
  }

  const roomId = crypto.randomUUID();
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO goodcustom_chat_rooms (
          id,
          kind,
          name,
          description,
          created_by
        )
        VALUES ($1::uuid, 'channel', $2, $3, $4::uuid)
      `,
      [roomId, channelName, channelDescription, user.id],
    );
    for (const member of validMembers.rows) {
      await client.query(
        `
          INSERT INTO goodcustom_chat_room_members (
            room_id,
            user_id,
            role
          )
          VALUES ($1::uuid, $2::uuid, $3)
        `,
        [
          roomId,
          member.userId,
          MANAGEMENT_ROLES.has(member.role) ? "admin" : "member",
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getRoomForUser(user.id, roomId);
}

async function notifyDirectRecipients({ roomId, sender, messageId, body }) {
  try {
    const result = await database.query(
      `
        SELECT
          recipient.user_id AS "userId",
          recipient_account.email,
          room.kind
        FROM goodcustom_chat_room_members recipient
        JOIN goodcustom_chat_rooms room ON room.id = recipient.room_id
        JOIN goodcustom_staff recipient_staff ON recipient_staff.user_id = recipient.user_id
        JOIN users recipient_account ON recipient_account.id = recipient.user_id
        WHERE recipient.room_id = $1::uuid
          AND recipient.user_id <> $2::uuid
          AND recipient.removed_at IS NULL
          AND recipient_staff.status = 'active'
          AND room.kind = 'direct'
      `,
      [roomId, sender.userId],
    );
    await Promise.all(result.rows.map((recipient) => (
      notificationService.createNotification({
        recipientUserId: recipient.userId,
        recipientEmail: recipient.email,
        appId: APP_ID,
        title: `Message from ${sender.displayName}`,
        message: body.length > 180 ? `${body.slice(0, 177)}...` : body,
        severity: "info",
        source: "goodcustom-chat",
        sourceId: messageId,
        actionUrl: `${APP_URL}/chat?room=${encodeURIComponent(roomId)}`,
        eventType: "goodcustom.chat.message",
        category: "chat",
        metadata: { appId: APP_ID, roomId },
      })
    )));
  } catch (error) {
    console.error("GoodCustom chat notification failed:", error.message);
  }
}

async function sendMessage({ user, roomId, body, replyToMessageId }) {
  const sender = await requireStaff(user);
  await requireRoomMembership(user.id, roomId);
  const messageBody = cleanMessage(body);
  if (!messageBody) throw serviceError("Write a message before sending.");
  let replyId = cleanText(replyToMessageId, 64) || null;
  if (replyId) {
    const replyResult = await database.query(
      `
        SELECT id
        FROM goodcustom_chat_messages
        WHERE id = $1::uuid
          AND room_id = $2::uuid
        LIMIT 1
      `,
      [replyId, roomId],
    );
    if (!replyResult.rows[0]) replyId = null;
  }
  const messageId = crypto.randomUUID();
  const result = await database.query(
    `
      INSERT INTO goodcustom_chat_messages (
        id,
        room_id,
        sender_user_id,
        body,
        reply_to_message_id
      )
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)
      RETURNING id
    `,
    [messageId, roomId, user.id, messageBody, replyId],
  );
  await markRead({ user, roomId });
  await notifyDirectRecipients({
    roomId,
    sender,
    messageId,
    body: messageBody,
  });
  const messageResult = await database.query(
    `${messageSelect("WHERE message.id = $1::uuid")} LIMIT 1`,
    [result.rows[0].id],
  );
  return messageResult.rows[0];
}

async function markRead({ user, roomId }) {
  await requireStaff(user);
  await requireRoomMembership(user.id, roomId);
  await database.query(
    `
      UPDATE goodcustom_chat_room_members
      SET last_read_at = NOW()
      WHERE room_id = $1::uuid
        AND user_id = $2::uuid
        AND removed_at IS NULL
    `,
    [roomId, user.id],
  );
  return { roomId, readAt: new Date().toISOString() };
}

async function editMessage({ user, messageId, body }) {
  await requireStaff(user);
  const messageBody = cleanMessage(body);
  if (!messageBody) throw serviceError("A message cannot be empty.");
  const result = await database.query(
    `
      UPDATE goodcustom_chat_messages message
      SET
        body = $3,
        edited_at = NOW()
      FROM goodcustom_chat_room_members membership
      WHERE message.id = $1::uuid
        AND message.sender_user_id = $2::uuid
        AND message.deleted_at IS NULL
        AND membership.room_id = message.room_id
        AND membership.user_id = $2::uuid
        AND membership.removed_at IS NULL
      RETURNING message.id
    `,
    [messageId, user.id, messageBody],
  );
  if (!result.rows[0]) {
    throw serviceError("You can only edit your own active messages.", 403);
  }
  const messageResult = await database.query(
    `${messageSelect("WHERE message.id = $1::uuid")} LIMIT 1`,
    [messageId],
  );
  return messageResult.rows[0];
}

async function deleteMessage({ user, messageId }) {
  const staff = await requireStaff(user);
  const result = await database.query(
    `
      UPDATE goodcustom_chat_messages message
      SET deleted_at = NOW()
      FROM goodcustom_chat_room_members membership
      WHERE message.id = $1::uuid
        AND message.deleted_at IS NULL
        AND membership.room_id = message.room_id
        AND membership.user_id = $2::uuid
        AND membership.removed_at IS NULL
        AND (
          message.sender_user_id = $2::uuid
          OR $3::boolean = true
        )
      RETURNING message.id, message.room_id AS "roomId"
    `,
    [messageId, user.id, isChatManager(staff)],
  );
  if (!result.rows[0]) {
    throw serviceError("This message cannot be deleted by your account.", 403);
  }
  return result.rows[0];
}

async function addStaff({ actor, email, role }) {
  const currentUser = await requireStaff(actor);
  requireManagement(currentUser);
  const normalizedEmail = cleanText(email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw serviceError("Enter a valid GoodOS account email.");
  }
  const requestedRole = cleanText(role, 20).toLowerCase() || "employee";
  if (!["employee", "manager"].includes(requestedRole)) {
    throw serviceError("Choose employee or manager access.");
  }
  if (requestedRole === "manager" && currentUser.role !== "owner") {
    throw serviceError("Only the GoodCustom owner can add managers.", 403);
  }

  const accountResult = await database.query(
    `
      SELECT
        account.id,
        account.email,
        account.platform_role AS "platformRole",
        EXISTS (
          SELECT 1
          FROM app_memberships membership
          JOIN apps app ON app.id = membership.app_id
          WHERE membership.user_id = account.id
            AND membership.status = 'active'
            AND app.status = 'active'
            AND (
              LOWER(app.id) IN ('goodcustom', 'good-custom', 'goodloecustom')
              OR LOWER(app.domain) = 'custom.goodos.app'
            )
        ) AS entitled
      FROM users account
      WHERE LOWER(account.email) = LOWER($1)
        AND account.status = 'active'
      LIMIT 1
    `,
    [normalizedEmail],
  );
  const account = accountResult.rows[0];
  if (!account) {
    throw serviceError("No active GoodOS account was found for that email.", 404);
  }
  if (
    !account.entitled
    && !["owner", "admin"].includes(String(account.platformRole || "").toLowerCase())
  ) {
    throw serviceError("Assign GoodCustom access to this GoodOS account before adding it to staff.");
  }

  await database.query(
    `
      INSERT INTO goodcustom_staff (
        user_id,
        role,
        status,
        invited_by,
        last_seen_at
      )
      VALUES ($1::uuid, $2, 'active', $3::uuid, NULL)
      ON CONFLICT (user_id) DO UPDATE
      SET
        role = EXCLUDED.role,
        status = 'active',
        invited_by = EXCLUDED.invited_by
    `,
    [account.id, requestedRole, actor.id],
  );
  await ensureDefaultRoomMembership(account.id, requestedRole);
  return getStaffRecord(account.id);
}

async function updateStaff({ actor, userId, role, status }) {
  const currentUser = await requireStaff(actor);
  requireManagement(currentUser);
  const target = await getStaffRecord(userId);
  if (!target) throw serviceError("GoodCustom staff member not found.", 404);
  if (target.userId === actor.id && status === "suspended") {
    throw serviceError("You cannot suspend your own GoodCustom access.");
  }
  if (
    currentUser.role !== "owner"
    && ["owner", "manager"].includes(target.role)
  ) {
    throw serviceError("Only the GoodCustom owner can manage leadership access.", 403);
  }

  const nextRole = role ? cleanText(role, 20).toLowerCase() : target.role;
  const nextStatus = status ? cleanText(status, 20).toLowerCase() : target.status;
  if (!["employee", "manager", "owner"].includes(nextRole)) {
    throw serviceError("Choose a valid GoodCustom staff role.");
  }
  if (!["active", "suspended"].includes(nextStatus)) {
    throw serviceError("Choose active or suspended staff status.");
  }
  if (nextRole === "owner" && target.role !== "owner") {
    throw serviceError("Ownership cannot be reassigned from chat settings.", 403);
  }
  if (nextRole === "manager" && currentUser.role !== "owner") {
    throw serviceError("Only the GoodCustom owner can promote managers.", 403);
  }

  await database.query(
    `
      UPDATE goodcustom_staff
      SET role = $2, status = $3
      WHERE user_id = $1::uuid
    `,
    [target.userId, nextRole, nextStatus],
  );
  if (nextStatus === "suspended") {
    await database.query(
      `
        UPDATE goodcustom_chat_room_members
        SET removed_at = NOW()
        WHERE user_id = $1::uuid
          AND removed_at IS NULL
      `,
      [target.userId],
    );
  } else {
    await ensureDefaultRoomMembership(target.userId, nextRole);
  }
  return getStaffRecord(target.userId);
}

module.exports = {
  APP_ID,
  addStaff,
  bootstrap,
  cleanMessage,
  createChannel,
  createDirectRoom,
  deleteMessage,
  editMessage,
  getMessages,
  health,
  isPlatformManager,
  markRead,
  requireStaff,
  sendMessage,
  unread,
  updateStaff,
};
