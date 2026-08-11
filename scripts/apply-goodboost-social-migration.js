"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATIONS = [
  "20260811_goodboost_production_core.sql",
  "20260801_goodboost_social_connectors.sql",
  "20260802_goodboost_growth_operations.sql",
  "20260811_goodboost_delivery_worker.sql",
  "20260811_goodboost_operational_readiness.sql",
];
const LOCK_NAME = "goodbase:migration:goodboost-production-v2";

async function schemaReady(client) {
  const result = await client.query(`
    SELECT
      to_regclass('public.goodboost_profiles') IS NOT NULL AS profiles,
      to_regclass('public.goodboost_social_connections') IS NOT NULL AS connections,
      to_regclass('public.goodboost_social_relationships') IS NOT NULL AS relationships,
      to_regclass('public.goodboost_social_actions') IS NOT NULL AS actions,
      to_regclass('public.goodboost_social_oauth_states') IS NOT NULL AS oauth_states,
      to_regclass('public.goodboost_publishing_posts') IS NOT NULL AS posts,
      to_regclass('public.goodboost_inbox_items') IS NOT NULL AS inbox,
      to_regclass('public.goodboost_metric_snapshots') IS NOT NULL AS metrics,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='goodboost_publishing_posts'
          AND column_name='provider_receipt'
      ) AS delivery_columns,
      EXISTS (
        SELECT 1 FROM backend_jobs
        WHERE id='job_goodboost_social_publish' AND handler_key='goodboost.social.publish' AND status='active'
      ) AS delivery_worker,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='goodboost_social_connections'
          AND column_name='next_sync_at'
      ) AS sync_columns,
      EXISTS (
        SELECT 1 FROM backend_jobs
        WHERE id='job_goodboost_social_sync' AND handler_key='goodboost.social.sync' AND status='active'
      ) AS sync_worker,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='goodboost_publishing_posts_status_check'
          AND pg_get_constraintdef(oid) LIKE '%cancelled%'
      ) AS cancellation_status,
      EXISTS (
        SELECT 1 FROM goodbase_ai_policies
        WHERE organization_id='org_goodos' AND project_id='proj_goodos_platform'
          AND environment_id='env_goodos_production' AND app_id='goodboost'
          AND name='GoodBoost Growth Tools' AND status='active'
      ) AS ai_policy
  `);
  return result.rows[0] || {};
}

function ready(state) {
  return Object.values(state).length === 14 && Object.values(state).every(Boolean);
}

async function main() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required to apply production migrations.");
  const client = await database.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    locked = true;
    const before = await schemaReady(client);
    await client.query("BEGIN");
    try {
      for (const migration of MIGRATIONS) {
        const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", migration), "utf8");
        await client.query(sql);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    const after = await schemaReady(client);
    if (!ready(after)) throw new Error("GoodBoost production schema was not installed completely.");
    console.log(JSON.stringify({ migration: "goodboost-production-v2", status: ready(before) ? "verified" : "applied", schema: after }));
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    client.release();
    await database.pool.end();
  }
}

main().catch(error => {
  console.error(`GoodBoost production migration failed: ${error.message}`);
  process.exitCode = 1;
});
