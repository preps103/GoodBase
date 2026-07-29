"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260729_goodfleet_marketplace_parity_v2.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodfleet-marketplace-parity-v2";

async function schemaState(client) {
  const result = await client.query(
    `SELECT
       to_regclass('public.fleet_claim_cases') IS NOT NULL AS claims,
       to_regclass('public.fleet_claim_evidence') IS NOT NULL AS evidence,
       to_regclass('public.fleet_claim_events') IS NOT NULL AS claim_events,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='fleet_vehicle_listings'
            AND column_name='photos_json'
       ) AS listing_photos,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='fleet_vehicle_listings'
            AND column_name='availability_json'
       ) AS listing_availability,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='fleet_booking_additional_drivers'
            AND column_name='user_id'
       ) AS linked_drivers,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='fleet_booking_change_requests'
            AND column_name='applied_at'
       ) AS applied_changes,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='fleet_trip_reviews'
            AND column_name='response'
       ) AS review_responses,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='fleet_claim_evidence'
            AND column_name='storage_reference'
       ) AS evidence_storage`,
  );
  return result.rows[0] || {};
}

function ready(state) {
  return [
    "claims",
    "evidence",
    "claim_events",
    "listing_photos",
    "listing_availability",
    "linked_drivers",
    "applied_changes",
    "review_responses",
    "evidence_storage",
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
      throw new Error("GoodFleet marketplace parity schema was not installed completely.");
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
  console.error(`GoodFleet marketplace parity migration failed: ${error.message}`);
  process.exitCode = 1;
});
