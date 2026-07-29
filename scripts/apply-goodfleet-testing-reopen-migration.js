"use strict";

const fs = require("fs");
const path = require("path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260729_goodfleet_testing_reopen_v1.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodfleet-testing-reopen-v1";

async function schemaReady(client) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_constraint constraint_record
         JOIN pg_class table_record ON table_record.oid=constraint_record.conrelid
        WHERE table_record.relname='fleet_bookings'
          AND constraint_record.conname='fleet_bookings_status_v2_check'
          AND pg_get_constraintdef(constraint_record.oid) LIKE '%needs_attention%'
     ) AS needs_attention_status`
  );
  return result.rows[0]?.needs_attention_status === true;
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
    const before = await schemaReady(client);
    if (!before) await client.query(sql);
    const after = await schemaReady(client);
    if (!after) throw new Error("GoodFleet needs-attention booking status was not installed.");
    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: before ? "verified" : "applied",
      schema: { needsAttentionStatus: after },
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
  console.error(`GoodFleet testing reopen migration failed: ${error.message}`);
  process.exitCode = 1;
});
