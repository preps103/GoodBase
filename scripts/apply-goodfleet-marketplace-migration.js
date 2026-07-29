"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260729_goodfleet_marketplace_v1.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodfleet-marketplace-v1";

async function schemaState(client) {
  const result = await client.query(
    `SELECT
       to_regclass('public.fleet_host_profiles') IS NOT NULL AS hosts,
       to_regclass('public.fleet_vehicle_listings') IS NOT NULL AS listings,
       to_regclass('public.fleet_booking_change_requests') IS NOT NULL AS changes,
       to_regclass('public.fleet_trip_conversations') IS NOT NULL AS conversations,
       to_regclass('public.fleet_trip_messages') IS NOT NULL AS messages,
       to_regclass('public.fleet_trip_message_reads') IS NOT NULL AS reads,
       to_regclass('public.fleet_trip_message_reports') IS NOT NULL AS reports,
       EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name='fleet_bookings'
            AND column_name='guest_user_id'
       ) AS guest_booking_owner`,
  );
  return result.rows[0] || {};
}

function ready(state) {
  return [
    "hosts",
    "listings",
    "changes",
    "conversations",
    "messages",
    "reads",
    "reports",
    "guest_booking_owner",
  ].every(key => state[key] === true);
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
      throw new Error("GoodFleet marketplace schema was not installed completely.");
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
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME])
        .catch(() => {});
    }
    client.release();
    await database.pool.end();
  }
}

main().catch(error => {
  console.error(`GoodFleet marketplace migration failed: ${error.message}`);
  process.exitCode = 1;
});
