"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260729_goodads_paid_campaigns.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodads-paid-campaigns";

async function schemaState(client) {
  const result = await client.query(
    `SELECT
       to_regclass('public.goodads_ad_accounts') IS NOT NULL AS ad_accounts,
       to_regclass('public.goodads_provider_campaigns') IS NOT NULL AS provider_campaigns,
       to_regclass('public.goodads_ad_operations') IS NOT NULL AS ad_operations,
       to_regclass('public.idx_goodads_ad_operations_dispatch') IS NOT NULL AS dispatch_index,
       EXISTS (
         SELECT 1 FROM backend_jobs
         WHERE id = 'job_goodads_ad_operations_dispatch'
           AND handler_key = 'goodads.ads.dispatch'
           AND status = 'active'
       ) AS dispatch_job`
  );
  return result.rows[0] || {};
}

function ready(state) {
  return ["ad_accounts", "provider_campaigns", "ad_operations", "dispatch_index", "dispatch_job"]
    .every((key) => state[key] === true);
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
    if (!ready(after)) throw new Error("GoodAds paid-campaign schema was not installed completely.");
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
  console.error(`GoodAds paid-campaign migration failed: ${error.message}`);
  process.exitCode = 1;
});
