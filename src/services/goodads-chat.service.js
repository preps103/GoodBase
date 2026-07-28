"use strict";

const { pool, query } = require("../config/database");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANNEL_TYPES = new Set(["public", "private", "management", "announcements", "direct"]);
const MANAGEMENT_ROLES = new Set(["owner", "admin", "manager"]);
const MODERATION_ROLES = new Set(["owner", "admin"]);

function serviceError(message, statusCode = 400, code = "GOODADS_CHAT_REQUEST_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function requireUuid(value, label = "ID") {
  const id = String(value || "").trim();
  if (!UUID_PATTERN.test(id)) {
    throw serviceError(`A valid ${label} is required.`, 400, "GOODADS_CHAT_ID_INVALID");
  }
  return id;
}

function roleFromContext(context) {
  return String(context?.organization?.membershipRole || "").trim().toLowerCase();
}

function isManagement(context) {
  return MANAGEMENT_ROLES.has(roleFromContext(context));
}

function boundedText(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function requireMessageBody(value) {
  const body = boundedText(value, 4001);
  if (!body) {
    throw serviceError("Enter a message.", 400, "GOODADS_CHAT_MESSAGE_REQUIRED");
  }
  if (body.length > 4000) {
    throw serviceError("Messages cannot exceed 4,000 characters.", 413, "GOODADS_CHAT_MESSAGE_TOO_LONG");
  }
  return body;
}

function normalizeChannelType(value) {
  const channelType = String(value || "public").trim().toLowerCase();
  if (!CHANNEL_TYPES.has(channelType) || channelType === "direct") {
    throw serviceError("Choose a valid channel visibility.", 400, "GOODADS_CHAT_CHANNEL_TYPE_INVALID");
  }
  return channelType;
}

function slugifyChannel(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  if (!slug) {
    throw serviceError("Enter a channel name.", 400, "GOODADS_CHAT_CHANNEL_NAME_REQUIRED");
  }
  return slug;
}

function uniqueUserIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value || "").trim()).filter((value) => UUID_PATTERN.test(value)))].slice(0, 100);
}

function normalizeClientMessageKey(value) {
  const key = boundedText(value, 129);
  if (!key) return null;
  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw serviceError("The message idempotency key is invalid.", 400, "GOODADS_CHAT_IDEMPOTENCY_INVALID");
  }
  return key;
}

function directSlug(userIds) {
  return `dm-${[...userIds].sort().map((id) => id.replaceAll("-", "")).join("-")}`;
}

function rowToChannel(row) {
  return {
    id: row.id,
    name: row.channel_type === "direct" && row.direct_partner_name
      ? row.direct_partner_name
      : row.name,
    slug: row.slug,
    description: row.description,
    type: row.channel_type,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    unreadCount: Number(row.unread_count || 0),
    memberCount: Number(row.member_count || 0),
    lastReadAt: row.last_read_at || null,
    muted: Boolean(row.muted),
    directParticipant: row.direct_partner_id ? {
      id: row.direct_partner_id,
      displayName: row.direct_partner_name,
      avatarUrl: row.direct_partner_avatar_url || null,
    } : null,
    lastMessage: row.last_message_id ? {
      id: row.last_message_id,
      body: row.last_message_body,
      createdAt: row.last_message_created_at,
      sender: {
        id: row.last_message_sender_id,
        displayName: row.last_message_sender_name,
      },
    } : null,
  };
}

function rowToMessage(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    senderUserId: row.sender_user_id,
    replyToMessageId: row.reply_to_message_id,
    type: row.message_type,
    body: row.deleted_at ? "" : row.body,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    sender: {
      id: row.sender_user_id,
      email: row.sender_email,
      firstName: row.sender_first_name,
      lastName: row.sender_last_name,
      displayName: row.sender_display_name,
      avatarUrl: row.sender_avatar_url || null,
      role: row.sender_role || "member",
    },
  };
}

function channelAccessSql(alias = "channel_record", userParameter = "$2", managementParameter = "$3") {
  return `(
    ${alias}.channel_type IN ('public', 'announcements')
    OR (${alias}.channel_type = 'management' AND ${managementParameter}::boolean)
    OR EXISTS (
      SELECT 1
      FROM goodads_chat_channel_members access_member
      WHERE access_member.channel_id = ${alias}.id
        AND access_member.user_id = ${userParameter}::uuid
    )
  )`;
}

async function ensureDefaultChannels({ context, userId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const defaults = [
      ["general", "General", "Company-wide collaboration and campaign coordination.", "public"],
      ["announcements", "Announcements", "Management updates and important company notices.", "announcements"],
    ];
    for (const [slug, name, description, channelType] of defaults) {
      await client.query(
        `INSERT INTO goodads_chat_channels (
           organization_id, name, slug, description, channel_type, created_by_user_id
         ) VALUES ($1, $2, $3, $4, $5, $6::uuid)
         ON CONFLICT (organization_id, slug) WHERE archived_at IS NULL DO NOTHING`,
        [context.organizationId, name, slug, description, channelType, userId]
      );
    }
    await client.query(
      `INSERT INTO goodads_chat_channel_members (channel_id, user_id)
       SELECT channel_record.id, $2::uuid
       FROM goodads_chat_channels channel_record
       WHERE channel_record.organization_id = $1
         AND channel_record.archived_at IS NULL
         AND (
           channel_record.channel_type IN ('public', 'announcements')
           OR (channel_record.channel_type = 'management' AND $3::boolean)
         )
       ON CONFLICT (channel_id, user_id) DO NOTHING`,
      [context.organizationId, userId, isManagement(context)]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function requireChannelAccess({ channelId, context, userId }) {
  const result = await query(
    `SELECT channel_record.*
     FROM goodads_chat_channels channel_record
     WHERE channel_record.id = $1::uuid
       AND channel_record.organization_id = $2
       AND channel_record.archived_at IS NULL
       AND ${channelAccessSql("channel_record", "$4", "$3")}
     LIMIT 1`,
    [requireUuid(channelId, "channel ID"), context.organizationId, isManagement(context), userId]
  );
  if (!result.rows[0]) {
    throw serviceError("Chat channel not found.", 404, "GOODADS_CHAT_CHANNEL_NOT_FOUND");
  }
  return result.rows[0];
}

async function listChannels({ context, userId }) {
  await ensureDefaultChannels({ context, userId });
  const result = await query(
    `SELECT
       channel_record.*,
       member.last_read_at,
       member.muted,
       COALESCE(unread.unread_count, 0)::integer AS unread_count,
       COALESCE(member_total.member_count, 0)::integer AS member_count,
       last_message.id AS last_message_id,
       last_message.body AS last_message_body,
       last_message.created_at AS last_message_created_at,
       last_message.sender_user_id AS last_message_sender_id,
       COALESCE(
         NULLIF(last_sender.display_name, ''),
         NULLIF(CONCAT_WS(' ', last_sender.first_name, last_sender.last_name), ''),
         SPLIT_PART(last_sender.email, '@', 1),
         'Team member'
       ) AS last_message_sender_name,
       direct_partner.id AS direct_partner_id,
       direct_partner.display_name AS direct_partner_name,
       direct_partner.avatar_url AS direct_partner_avatar_url
     FROM goodads_chat_channels channel_record
     LEFT JOIN goodads_chat_channel_members member
       ON member.channel_id = channel_record.id
      AND member.user_id = $2::uuid
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::integer AS unread_count
       FROM goodads_chat_messages unread_message
       WHERE unread_message.channel_id = channel_record.id
         AND unread_message.deleted_at IS NULL
         AND unread_message.sender_user_id <> $2::uuid
         AND unread_message.created_at > COALESCE(member.last_read_at, 'epoch'::timestamptz)
     ) unread ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::integer AS member_count
       FROM goodads_chat_channel_members channel_member
       WHERE channel_member.channel_id = channel_record.id
     ) member_total ON TRUE
     LEFT JOIN LATERAL (
       SELECT message_record.*
       FROM goodads_chat_messages message_record
       WHERE message_record.channel_id = channel_record.id
         AND message_record.deleted_at IS NULL
       ORDER BY message_record.created_at DESC
       LIMIT 1
     ) last_message ON TRUE
     LEFT JOIN users last_sender ON last_sender.id = last_message.sender_user_id
     LEFT JOIN LATERAL (
       SELECT
         direct_user.id,
         COALESCE(
           NULLIF(direct_user.display_name, ''),
           NULLIF(CONCAT_WS(' ', direct_user.first_name, direct_user.last_name), ''),
           SPLIT_PART(direct_user.email, '@', 1),
           'Direct message'
         ) AS display_name,
         COALESCE(
           TO_JSONB(direct_user)->>'avatar_url',
           TO_JSONB(direct_user)->>'profile_image_url',
           TO_JSONB(direct_user)->'auth_metadata_json'->>'picture'
         ) AS avatar_url
       FROM goodads_chat_channel_members direct_member
       JOIN users direct_user ON direct_user.id = direct_member.user_id
       WHERE direct_member.channel_id = channel_record.id
         AND direct_member.user_id <> $2::uuid
       ORDER BY direct_member.joined_at ASC
       LIMIT 1
     ) direct_partner ON channel_record.channel_type = 'direct'
     WHERE channel_record.organization_id = $1
       AND channel_record.archived_at IS NULL
       AND ${channelAccessSql("channel_record")}
     ORDER BY
       CASE channel_record.channel_type
         WHEN 'announcements' THEN 0
         WHEN 'public' THEN 1
         WHEN 'management' THEN 2
         WHEN 'private' THEN 3
         ELSE 4
       END,
       channel_record.updated_at DESC`,
    [context.organizationId, userId, isManagement(context)]
  );
  const items = result.rows.map(rowToChannel);
  return {
    items,
    unreadTotal: items.reduce((sum, channel) => sum + channel.unreadCount, 0),
  };
}

async function listMembers({ context, search = "", limit = 100 }) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const searchTerm = boundedText(search, 120).toLowerCase();
  const result = await query(
    `SELECT
       user_account.id,
       user_account.email,
       user_account.first_name AS "firstName",
       user_account.last_name AS "lastName",
       user_account.display_name AS "displayName",
       membership.role,
       COALESCE(
         TO_JSONB(user_account)->>'avatar_url',
         TO_JSONB(user_account)->>'profile_image_url',
         TO_JSONB(user_account)->'auth_metadata_json'->>'picture'
       ) AS "avatarUrl"
     FROM backend_organization_memberships membership
     JOIN users user_account ON user_account.id = membership.user_id
     WHERE membership.organization_id = $1
       AND membership.status = 'active'
       AND user_account.status <> 'deleted'
       AND (
         $2 = ''
         OR LOWER(COALESCE(user_account.display_name, '')) LIKE '%' || $2 || '%'
         OR LOWER(COALESCE(user_account.first_name, '')) LIKE '%' || $2 || '%'
         OR LOWER(COALESCE(user_account.last_name, '')) LIKE '%' || $2 || '%'
         OR LOWER(user_account.email) LIKE '%' || $2 || '%'
       )
     ORDER BY
       CASE membership.role
         WHEN 'owner' THEN 0
         WHEN 'admin' THEN 1
         WHEN 'manager' THEN 2
         ELSE 3
       END,
       COALESCE(NULLIF(user_account.display_name, ''), user_account.email)
     LIMIT $3`,
    [context.organizationId, searchTerm, boundedLimit]
  );
  return { items: result.rows };
}

async function validateParticipants(client, organizationId, userIds) {
  if (!userIds.length) return [];
  const result = await client.query(
    `SELECT membership.user_id
     FROM backend_organization_memberships membership
     JOIN users user_account ON user_account.id = membership.user_id
     WHERE membership.organization_id = $1
       AND membership.status = 'active'
       AND user_account.status <> 'deleted'
       AND membership.user_id = ANY($2::uuid[])`,
    [organizationId, userIds]
  );
  if (result.rows.length !== userIds.length) {
    throw serviceError("Every channel participant must be an active organization member.", 400, "GOODADS_CHAT_MEMBER_INVALID");
  }
  return result.rows.map((row) => row.user_id);
}

async function createChannel({ payload, context, userId }) {
  const name = boundedText(payload?.name, 80);
  const description = boundedText(payload?.description, 300);
  const channelType = normalizeChannelType(payload?.type);
  if (!name) {
    throw serviceError("Enter a channel name.", 400, "GOODADS_CHAT_CHANNEL_NAME_REQUIRED");
  }
  if (["management", "announcements"].includes(channelType) && !isManagement(context)) {
    throw serviceError("Management access is required for this channel type.", 403, "GOODADS_CHAT_MANAGEMENT_REQUIRED");
  }
  const participantUserIds = uniqueUserIds(payload?.participantUserIds);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await validateParticipants(client, context.organizationId, participantUserIds);
    const inserted = await client.query(
      `INSERT INTO goodads_chat_channels (
         organization_id, name, slug, description, channel_type, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6::uuid)
       RETURNING *`,
      [context.organizationId, name, slugifyChannel(payload?.slug || name), description, channelType, userId]
    );
    const memberIds = [...new Set([userId, ...participantUserIds])];
    await client.query(
      `INSERT INTO goodads_chat_channel_members (channel_id, user_id, member_role)
       SELECT $1::uuid, member_id, CASE WHEN member_id = $2::uuid THEN 'owner' ELSE 'member' END
       FROM UNNEST($3::uuid[]) AS member_id
       ON CONFLICT (channel_id, user_id) DO NOTHING`,
      [inserted.rows[0].id, userId, memberIds]
    );
    await client.query("COMMIT");
    return rowToChannel(inserted.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      throw serviceError("A channel with that name already exists.", 409, "GOODADS_CHAT_CHANNEL_EXISTS");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function openDirectChannel({ participantUserId, context, userId }) {
  const otherUserId = requireUuid(participantUserId, "team member ID");
  if (otherUserId === userId) {
    throw serviceError("Choose another team member.", 400, "GOODADS_CHAT_DIRECT_SELF");
  }
  const userIds = [userId, otherUserId];
  const slug = directSlug(userIds);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await validateParticipants(client, context.organizationId, userIds);
    const inserted = await client.query(
      `INSERT INTO goodads_chat_channels (
         organization_id, name, slug, description, channel_type, created_by_user_id
       ) VALUES ($1, 'Direct message', $2, '', 'direct', $3::uuid)
       ON CONFLICT (organization_id, slug) WHERE archived_at IS NULL
       DO UPDATE SET updated_at = goodads_chat_channels.updated_at
       RETURNING *`,
      [context.organizationId, slug, userId]
    );
    await client.query(
      `INSERT INTO goodads_chat_channel_members (channel_id, user_id)
       SELECT $1::uuid, member_id
       FROM UNNEST($2::uuid[]) AS member_id
       ON CONFLICT (channel_id, user_id) DO NOTHING`,
      [inserted.rows[0].id, userIds]
    );
    await client.query("COMMIT");
    return rowToChannel(inserted.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listMessages({ channelId, context, userId, limit = 50, before = null }) {
  const channel = await requireChannelAccess({ channelId, context, userId });
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const beforeDate = before ? new Date(String(before)) : null;
  if (beforeDate && Number.isNaN(beforeDate.getTime())) {
    throw serviceError("The message cursor is invalid.", 400, "GOODADS_CHAT_CURSOR_INVALID");
  }
  const result = await query(
    `SELECT
       message_record.*,
       sender.email AS sender_email,
       sender.first_name AS sender_first_name,
       sender.last_name AS sender_last_name,
       COALESCE(
         NULLIF(sender.display_name, ''),
         NULLIF(CONCAT_WS(' ', sender.first_name, sender.last_name), ''),
         SPLIT_PART(sender.email, '@', 1),
         'Team member'
       ) AS sender_display_name,
       COALESCE(
         TO_JSONB(sender)->>'avatar_url',
         TO_JSONB(sender)->>'profile_image_url',
         TO_JSONB(sender)->'auth_metadata_json'->>'picture'
       ) AS sender_avatar_url,
       membership.role AS sender_role
     FROM goodads_chat_messages message_record
     JOIN users sender ON sender.id = message_record.sender_user_id
     LEFT JOIN backend_organization_memberships membership
       ON membership.organization_id = message_record.organization_id
      AND membership.user_id = message_record.sender_user_id
      AND membership.status = 'active'
     WHERE message_record.channel_id = $1::uuid
       AND message_record.organization_id = $2
       AND ($3::timestamptz IS NULL OR message_record.created_at < $3::timestamptz)
     ORDER BY message_record.created_at DESC
     LIMIT $4`,
    [channel.id, context.organizationId, beforeDate ? beforeDate.toISOString() : null, boundedLimit + 1]
  );
  const hasMore = result.rows.length > boundedLimit;
  const rows = result.rows.slice(0, boundedLimit).reverse();
  return {
    channel: rowToChannel(channel),
    items: rows.map(rowToMessage),
    hasMore,
    nextCursor: hasMore ? rows[0]?.created_at || null : null,
  };
}

async function sendMessage({ channelId, payload, context, userId, idempotencyKey = null }) {
  const channel = await requireChannelAccess({ channelId, context, userId });
  if (channel.channel_type === "announcements" && !isManagement(context)) {
    throw serviceError("Only management can post announcements.", 403, "GOODADS_CHAT_ANNOUNCEMENT_FORBIDDEN");
  }
  const body = requireMessageBody(payload?.body);
  const replyToMessageId = payload?.replyToMessageId
    ? requireUuid(payload.replyToMessageId, "reply message ID")
    : null;
  const clientMessageKey = normalizeClientMessageKey(idempotencyKey);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (replyToMessageId) {
      const reply = await client.query(
        `SELECT id
         FROM goodads_chat_messages
         WHERE id = $1::uuid AND channel_id = $2::uuid AND deleted_at IS NULL`,
        [replyToMessageId, channel.id]
      );
      if (!reply.rows[0]) {
        throw serviceError("The message being replied to is unavailable.", 404, "GOODADS_CHAT_REPLY_NOT_FOUND");
      }
    }
    const inserted = await client.query(
      `INSERT INTO goodads_chat_messages (
         channel_id, organization_id, sender_user_id, reply_to_message_id,
         client_message_key, message_type, body
       ) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7)
       ON CONFLICT (organization_id, sender_user_id, client_message_key)
       WHERE client_message_key IS NOT NULL
       DO UPDATE SET updated_at = goodads_chat_messages.updated_at
       RETURNING *`,
      [
        channel.id,
        context.organizationId,
        userId,
        replyToMessageId,
        clientMessageKey,
        channel.channel_type === "announcements" ? "announcement" : "message",
        body,
      ]
    );
    await client.query(
      `INSERT INTO goodads_chat_channel_members (channel_id, user_id, last_read_at)
       VALUES ($1::uuid, $2::uuid, NOW())
       ON CONFLICT (channel_id, user_id)
       DO UPDATE SET last_read_at = NOW(), updated_at = NOW()`,
      [channel.id, userId]
    );
    await client.query(
      `UPDATE goodads_chat_channels SET updated_at = NOW() WHERE id = $1::uuid`,
      [channel.id]
    );
    const hydrated = await client.query(
      `SELECT
         message_record.*,
         sender.email AS sender_email,
         sender.first_name AS sender_first_name,
         sender.last_name AS sender_last_name,
         COALESCE(
           NULLIF(sender.display_name, ''),
           NULLIF(CONCAT_WS(' ', sender.first_name, sender.last_name), ''),
           SPLIT_PART(sender.email, '@', 1),
           'Team member'
         ) AS sender_display_name,
         COALESCE(
           TO_JSONB(sender)->>'avatar_url',
           TO_JSONB(sender)->>'profile_image_url',
           TO_JSONB(sender)->'auth_metadata_json'->>'picture'
         ) AS sender_avatar_url,
         membership.role AS sender_role
       FROM goodads_chat_messages message_record
       JOIN users sender ON sender.id = message_record.sender_user_id
       LEFT JOIN backend_organization_memberships membership
         ON membership.organization_id = message_record.organization_id
        AND membership.user_id = message_record.sender_user_id
        AND membership.status = 'active'
       WHERE message_record.id = $1::uuid`,
      [inserted.rows[0].id]
    );
    await client.query("COMMIT");
    return rowToMessage(hydrated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function editMessage({ channelId, messageId, payload, context, userId }) {
  await requireChannelAccess({ channelId, context, userId });
  const body = requireMessageBody(payload?.body);
  const result = await query(
    `UPDATE goodads_chat_messages
     SET body = $1, edited_at = NOW(), updated_at = NOW()
     WHERE id = $2::uuid
       AND channel_id = $3::uuid
       AND organization_id = $4
       AND deleted_at IS NULL
       AND sender_user_id = $5::uuid
     RETURNING id`,
    [
      body,
      requireUuid(messageId, "message ID"),
      requireUuid(channelId, "channel ID"),
      context.organizationId,
      userId,
    ]
  );
  if (!result.rows[0]) {
    throw serviceError("You cannot edit this message.", 403, "GOODADS_CHAT_EDIT_FORBIDDEN");
  }
  return { id: result.rows[0].id, body, editedAt: new Date().toISOString() };
}

async function deleteMessage({ channelId, messageId, context, userId }) {
  await requireChannelAccess({ channelId, context, userId });
  const result = await query(
    `UPDATE goodads_chat_messages
     SET body = '[deleted]', deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1::uuid
       AND channel_id = $2::uuid
       AND organization_id = $3
       AND deleted_at IS NULL
       AND (sender_user_id = $4::uuid OR $5::boolean)
     RETURNING id`,
    [
      requireUuid(messageId, "message ID"),
      requireUuid(channelId, "channel ID"),
      context.organizationId,
      userId,
      MODERATION_ROLES.has(roleFromContext(context)),
    ]
  );
  if (!result.rows[0]) {
    throw serviceError("You cannot delete this message.", 403, "GOODADS_CHAT_DELETE_FORBIDDEN");
  }
  return { id: result.rows[0].id, deleted: true };
}

async function markRead({ channelId, context, userId }) {
  const channel = await requireChannelAccess({ channelId, context, userId });
  await query(
    `INSERT INTO goodads_chat_channel_members (channel_id, user_id, last_read_at)
     VALUES ($1::uuid, $2::uuid, NOW())
     ON CONFLICT (channel_id, user_id)
     DO UPDATE SET last_read_at = NOW(), updated_at = NOW()`,
    [channel.id, userId]
  );
  return { channelId: channel.id, readAt: new Date().toISOString() };
}

module.exports = {
  createChannel,
  deleteMessage,
  editMessage,
  listChannels,
  listMembers,
  listMessages,
  markRead,
  openDirectChannel,
  sendMessage,
  _test: {
    directSlug,
    normalizeChannelType,
    normalizeClientMessageKey,
    requireMessageBody,
    slugifyChannel,
    uniqueUserIds,
  },
};
