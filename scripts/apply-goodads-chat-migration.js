"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260728_goodads_internal_chat.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodads-internal-chat";

async function schemaState(client) {
  const result = await client.query(
    `
      SELECT
        to_regclass('public.goodads_chat_channels') IS NOT NULL AS channels,
        to_regclass('public.goodads_chat_channel_members') IS NOT NULL AS members,
        to_regclass('public.goodads_chat_messages') IS NOT NULL AS messages
    `
  );
  return result.rows[0] || {};
}

function ready(state) {
  return ["channels", "members", "messages"].every((key) => state[key] === true);
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
      throw new Error("GoodAds internal chat schema was not installed completely.");
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
  console.error(`GoodAds chat migration failed: ${error.message}`);
  process.exitCode = 1;
});
