"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260730_goodfleet_constraint_validation_v1.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodfleet-constraint-validation-v1";
const REQUIRED_CONSTRAINTS = [
  "fleet_vehicles_status_v2_check",
  "fleet_customers_status_v2_check",
  "fleet_customers_license_status_v2_check",
  "fleet_customers_license_verification_method_check",
  "fleet_bookings_payment_status_v2_check",
];

async function schemaState(client) {
  const result = await client.query(
    `SELECT constraint_record.conname AS name,
            constraint_record.convalidated AS validated
       FROM pg_constraint constraint_record
      WHERE constraint_record.conname=ANY($1::text[])
      ORDER BY constraint_record.conname`,
    [REQUIRED_CONSTRAINTS],
  );
  return Object.fromEntries(
    result.rows.map(row => [row.name, Boolean(row.validated)]),
  );
}

function ready(state) {
  return REQUIRED_CONSTRAINTS.every(name => state[name] === true);
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
      throw new Error("GoodFleet constraints were not validated completely.");
    }
    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: ready(before) ? "verified" : "applied",
      constraints: after,
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
  console.error(`GoodFleet constraint validation failed: ${error.message}`);
  process.exitCode = 1;
});
