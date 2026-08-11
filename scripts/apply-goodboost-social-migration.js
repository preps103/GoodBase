"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATIONS = [
  "20260811_goodboost_production_core.sql",
  "20260801_goodboost_social_connectors.sql",
  "20260802_goodboost_growth_operations.sql",
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
      to_regclass('public.goodboost_metric_snapshots') IS NOT NULL AS metrics
  `);
  return result.rows[0] || {};
}

function ready(state) {
  return Object.values(state).length === 8 && Object.values(state).every(Boolean);
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
