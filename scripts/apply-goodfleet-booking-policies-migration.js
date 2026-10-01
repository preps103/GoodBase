"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20261001_goodfleet_booking_policies_v1.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodfleet-booking-policies-v1";

async function schemaState(client) {
  const result = await client.query(
    `SELECT
       to_regclass('public.fleet_booking_policy_actions') IS NOT NULL AS policy_actions,
       to_regclass('public.fleet_inventory_transfer_plans') IS NOT NULL AS transfer_plans`,
  );
  return result.rows[0] || {};
}

function ready(state) {
  return Object.values(state).length === 2 && Object.values(state).every(value => value === true);
}

async function main() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required to apply production migrations.");
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const client = await database.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    locked = true;
    const before = await schemaState(client);
    if (!ready(before)) await client.query(sql);
    const after = await schemaState(client);
    if (!ready(after)) throw new Error("GoodFleet booking policy schema was not installed completely.");
    console.log(JSON.stringify({ migration: MIGRATION_NAME, status: ready(before) ? "verified" : "applied", schema: after }));
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    client.release();
    await database.pool.end();
  }
}

main().catch(error => {
  console.error(`GoodFleet booking policy migration failed: ${error.message}`);
  process.exitCode = 1;
});
