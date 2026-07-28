"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260728_goodcustom_internal_chat.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodcustom-internal-chat";
const REQUIRED_TABLES = [
  "goodcustom_staff",
  "goodcustom_chat_rooms",
  "goodcustom_chat_room_members",
  "goodcustom_chat_messages",
];

async function schemaState(client) {
  const result = await client.query(
    `
      SELECT
        TO_REGCLASS('public.goodcustom_staff') IS NOT NULL AS staff,
        TO_REGCLASS('public.goodcustom_chat_rooms') IS NOT NULL AS rooms,
        TO_REGCLASS('public.goodcustom_chat_room_members') IS NOT NULL AS members,
        TO_REGCLASS('public.goodcustom_chat_messages') IS NOT NULL AS messages
    `,
  );
  const tables = result.rows[0] || {};
  const tableReady = Object.values(tables).every(Boolean);
  let defaultRoom = false;
  if (tableReady) {
    const defaultResult = await client.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM goodcustom_chat_rooms
          WHERE id = '00000000-0000-4000-8000-000000000001'::uuid
            AND is_default = true
            AND archived_at IS NULL
        ) AS ready
      `,
    );
    defaultRoom = defaultResult.rows[0]?.ready === true;
  }
  return { ...tables, defaultRoom };
}

function ready(state) {
  return ["staff", "rooms", "members", "messages", "defaultRoom"]
    .every((key) => state[key] === true);
}

async function main() {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is required to apply production migrations.");
  }

  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const client = await database.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    locked = true;
    const before = await schemaState(client);
    if (!ready(before)) await client.query(sql);
    const after = await schemaState(client);
    if (!ready(after)) {
      throw new Error(
        `GoodCustom chat schema was not installed completely: ${REQUIRED_TABLES.join(", ")}.`,
      );
    }
    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: ready(before) ? "verified" : "applied",
      schema: after,
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    }
    client.release();
    await database.pool.end();
  }
}

main().catch((error) => {
  console.error(`GoodCustom chat migration failed: ${error.message}`);
  process.exitCode = 1;
});
