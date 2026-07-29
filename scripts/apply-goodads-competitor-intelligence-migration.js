"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260729_goodads_competitor_intelligence.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodads-competitor-intelligence";

async function state(client) {
  const result = await client.query(
    `SELECT
       to_regclass('public.goodads_competitors') IS NOT NULL AS competitors,
       to_regclass('public.goodads_competitor_creatives') IS NOT NULL AS creatives,
       to_regclass('public.goodads_competitor_snapshots') IS NOT NULL AS snapshots,
       to_regclass('public.goodads_competitor_alerts') IS NOT NULL AS alerts,
       EXISTS (
         SELECT 1 FROM backend_jobs
         WHERE id = 'job_goodads_competitor_sync'
           AND handler_key = 'goodads.competitors.sync'
           AND status = 'active'
       ) AS sync_job`
  );
  return result.rows[0] || {};
}

function ready(value) {
  return value.competitors === true
    && value.creatives === true
    && value.snapshots === true
    && value.alerts === true
    && value.sync_job === true;
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
    if (!ready(after)) throw new Error("GoodAds competitor intelligence schema was not installed completely.");
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
  console.error(`GoodAds competitor intelligence migration failed: ${error.message}`);
  process.exitCode = 1;
});
