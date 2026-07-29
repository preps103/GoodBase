"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260729_goodads_competitor_intelligence_v2.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodads-competitor-intelligence-v2";

async function state(client) {
  const result = await client.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname='goodads_competitor_snapshots_source_provider_check'
           AND pg_get_constraintdef(oid) LIKE '%public_web%'
       ) AS public_web,
       EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname='goodads_competitor_snapshots_status_check'
           AND pg_get_constraintdef(oid) LIKE '%partial%'
       ) AS partial_status,
       EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname='goodads_competitor_alerts_alert_type_check'
           AND pg_get_constraintdef(oid) LIKE '%site_change%'
       ) AS site_change`
  );
  return result.rows[0] || {};
}

function ready(value) {
  return value.public_web === true && value.partial_status === true && value.site_change === true;
}

async function main() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required to apply production migrations.");
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const client = await database.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    locked = true;
    const before = await state(client);
    if (!ready(before)) await client.query(sql);
    const after = await state(client);
    if (!ready(after)) throw new Error("GoodAds competitor intelligence v2 schema was not installed completely.");
    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: ready(before) ? "verified" : "applied",
      schema: after,
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    client.release();
    await database.pool.end();
  }
}

main().catch((error) => {
  console.error(`GoodAds competitor intelligence v2 migration failed: ${error.message}`);
  process.exitCode = 1;
});
