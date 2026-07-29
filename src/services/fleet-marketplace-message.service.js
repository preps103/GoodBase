"use strict";

const database = require("../config/database");
const notificationService = require("./notification.service");

const pool =
  database.pool ||
  (typeof database.getPool === "function" ? database.getPool() : null);

async function processScheduledTripMessages(limit = 25) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("GoodOS PostgreSQL pool could not be resolved.");
  }

  const client = await pool.connect();
  let due = [];
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `WITH selected AS (
         SELECT message.id
           FROM fleet_trip_messages message
          WHERE message.scheduled_at IS NOT NULL
            AND message.scheduled_at<=NOW()
            AND message.delivered_at IS NULL
            AND message.deleted_at IS NULL
            AND message.moderation_status='accepted'
          ORDER BY message.scheduled_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE fleet_trip_messages message
          SET delivered_at=NOW()
         FROM selected
        WHERE message.id=selected.id
       RETURNING message.*`,
      [Math.min(Math.max(Number(limit || 25), 1), 100)],
    );
    due = claimed.rows;
    if (due.length) {
      await client.query(
        `UPDATE fleet_trip_conversations conversation
            SET last_message_at=GREATEST(
                  COALESCE(conversation.last_message_at,'epoch'::timestamptz),
                  delivered.latest_delivery
                ),
                updated_at=NOW()
           FROM (
             SELECT conversation_id,MAX(delivered_at) AS latest_delivery
               FROM fleet_trip_messages
              WHERE id=ANY($1::uuid[])
              GROUP BY conversation_id
           ) delivered
          WHERE conversation.id=delivered.conversation_id`,
        [due.map(message => message.id)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const results = [];
  for (const message of due) {
    try {
      const conversation = await database.query(
        `SELECT conversation.guest_user_id,conversation.booking_id,
                booking.reservation_number
           FROM fleet_trip_conversations conversation
           JOIN fleet_bookings booking
             ON booking.organization_id=conversation.organization_id
            AND booking.id=conversation.booking_id
          WHERE conversation.organization_id=$1
            AND conversation.id=$2`,
        [message.organization_id, message.conversation_id],
      );
      const row = conversation.rows[0];
      if (row?.guest_user_id) {
        await notificationService.createNotification({
          id: `gftripmsg_${message.id}`,
          recipientUserId: row.guest_user_id,
          title: `New message for ${row.reservation_number}`,
          message: "Your GoodFleet host sent a trip message.",
          category: "reservation",
          channel: "in_app",
          actionUrl: `/account/messages?booking=${encodeURIComponent(row.booking_id)}`,
          notificationKey: "fleet.marketplace.message_scheduled",
          source: "goodfleet-marketplace-worker",
          sourceId: row.booking_id,
          organizationId: message.organization_id,
          projectId: "proj_goodos_platform",
          environmentId: "env_goodos_production",
          payload: {
            appId: "goodfleet",
            bookingId: row.booking_id,
            conversationId: message.conversation_id,
            messageId: message.id,
          },
        });
      }
      results.push({ id: message.id, status: "delivered" });
    } catch (error) {
      results.push({
        id: message.id,
        status: "delivered_notification_failed",
        error: String(error.message || error).slice(0, 500),
      });
    }
  }
  return results;
}

module.exports = {
  processScheduledTripMessages,
};
