"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260729_goodads_creative_studios.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodads-creative-studios";

async function state(client) {
  const result = await client.query(
    `SELECT
       to_regclass('public.goodads_creative_jobs') IS NOT NULL AS jobs,
       to_regclass('public.idx_goodads_creative_jobs_workspace') IS NOT NULL AS workspace_index,
       to_regclass('public.idx_goodads_creative_jobs_idempotency') IS NOT NULL AS idempotency_index,
       EXISTS (
         SELECT 1
         FROM backend_storage_buckets
         WHERE id = 'bucket_goodads_creative_assets'
           AND status = 'active'
           AND public_read_enabled = TRUE
       ) AS creative_bucket`
  );
  return result.rows[0] || {};
}

function ready(value) {
  return value.jobs === true
    && value.workspace_index === true
    && value.idempotency_index === true
    && value.creative_bucket === true;
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
    if (!ready(after)) throw new Error("GoodAds creative studio storage was not installed completely.");
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
  console.error(`GoodAds creative studios migration failed: ${error.message}`);
  process.exitCode = 1;
});
