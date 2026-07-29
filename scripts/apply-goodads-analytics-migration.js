"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260729_goodads_analytics.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodads-analytics";

async function state(client) {
  const result = await client.query(
    `SELECT
       to_regclass('public.goodads_analytics_snapshots') IS NOT NULL AS snapshots,
       to_regclass('public.idx_goodads_analytics_workspace') IS NOT NULL AS analytics_index,
       EXISTS (
         SELECT 1 FROM backend_jobs
         WHERE id = 'job_goodads_analytics_sync'
           AND handler_key = 'goodads.analytics.sync'
           AND status = 'active'
       ) AS analytics_job`
  );
  return result.rows[0] || {};
}

function ready(value) {
  return value.snapshots === true && value.analytics_index === true && value.analytics_job === true;
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
    if (!ready(after)) throw new Error("GoodAds analytics schema was not installed completely.");
    console.log(JSON.stringify({ migration: MIGRATION_NAME, status: ready(before) ? "verified" : "applied", schema: after }));
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
  console.error(`GoodAds analytics migration failed: ${error.message}`);
  process.exitCode = 1;
});
