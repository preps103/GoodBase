"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260729_goodfleet_managed_assets_v1.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodfleet-managed-assets-v1";

async function schemaState(client) {
  const result = await client.query(
    `SELECT
       to_regclass('public.fleet_managed_assets') IS NOT NULL AS assets,
       EXISTS (
         SELECT 1
           FROM pg_constraint constraint_record
           JOIN pg_class table_record ON table_record.oid = constraint_record.conrelid
          WHERE table_record.relname = 'fleet_managed_assets'
            AND constraint_record.contype = 'c'
            AND pg_get_constraintdef(constraint_record.oid) LIKE '%vehicle_image%'
       ) AS vehicle_images,
       EXISTS (
         SELECT 1
           FROM pg_constraint constraint_record
           JOIN pg_class table_record ON table_record.oid = constraint_record.conrelid
          WHERE table_record.relname = 'fleet_managed_assets'
            AND constraint_record.contype = 'c'
            AND pg_get_constraintdef(constraint_record.oid) LIKE '%expense_receipt%'
       ) AS expense_receipts`,
  );
  return result.rows[0] || {};
}

function ready(state) {
  return state.assets === true &&
    state.vehicle_images === true &&
    state.expense_receipts === true;
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
      throw new Error("GoodFleet managed asset storage was not installed completely.");
    }
    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: ready(before) ? "verified" : "applied",
      schema: after,
    }));
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    }
    client.release();
    await database.pool.end();
  }
}

main().catch(error => {
  console.error(`GoodFleet managed assets migration failed: ${error.message}`);
  process.exitCode = 1;
});
