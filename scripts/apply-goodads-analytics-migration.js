"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const database = require("../src/config/database");
const env = require("../src/config/env");

const BASE_MIGRATION_NAME = "20260729_goodads_analytics.sql";
const ATTRIBUTION_MIGRATION_NAME = "20261001_goodads_first_party_attribution.sql";
const LOCK_NAME = "goodbase:migration:goodads-analytics";

async function state(client) {
  const result = await client.query(
    `SELECT
       to_regclass('public.goodads_analytics_snapshots') IS NOT NULL AS snapshots,
       to_regclass('public.idx_goodads_analytics_workspace') IS NOT NULL AS analytics_index,
       to_regclass('public.uq_goodads_attribution_event_id') IS NOT NULL AS attribution_idempotency,
       to_regclass('public.idx_goodads_attribution_reporting') IS NOT NULL AS attribution_reporting,
       EXISTS (
         SELECT 1 FROM backend_jobs
         WHERE id = 'job_goodads_analytics_sync'
           AND handler_key = 'goodads.analytics.sync'
           AND status = 'active'
       ) AS analytics_job`
  );
  return result.rows[0] || {};
}

function coreReady(value) {
  return value.snapshots === true
    && value.analytics_index === true
    && value.analytics_job === true;
}

function attributionReady(value) {
  return value.attribution_idempotency === true
    && value.attribution_reporting === true;
}

function ready(value) {
  return coreReady(value) && attributionReady(value);
}

function applyOwnerMigration(databaseName, sql) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("The GoodAds attribution indexes require the root-owned production migration runner.");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(databaseName)) {
    throw new Error("The production database name is invalid.");
  }
  execFileSync(
    "/usr/sbin/runuser",
    [
      "-u", "postgres", "--", "/usr/bin/psql", "-X",
      "--dbname", databaseName,
      "--set", "ON_ERROR_STOP=1",
      "--command", sql,
    ],
    { encoding: "utf8", stdio: "pipe" }
  );
}

async function main() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required to apply production migrations.");
  const baseSql = fs.readFileSync(path.join(__dirname, "..", "migrations", BASE_MIGRATION_NAME), "utf8");
  const attributionSql = fs.readFileSync(path.join(__dirname, "..", "migrations", ATTRIBUTION_MIGRATION_NAME), "utf8");
  const client = await database.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    locked = true;
    const before = await state(client);
    const applied = [];
    if (!coreReady(before)) {
      await client.query(baseSql);
      applied.push(BASE_MIGRATION_NAME);
    }
    const current = await state(client);
    if (!attributionReady(current)) {
      const databaseName = (await client.query("SELECT current_database() AS name")).rows[0]?.name || "";
      applyOwnerMigration(databaseName, attributionSql);
      applied.push(ATTRIBUTION_MIGRATION_NAME);
    }
    const after = await state(client);
    if (!ready(after)) throw new Error("GoodAds analytics schema was not installed completely.");
    console.log(JSON.stringify({ migrations: applied, status: applied.length ? "applied" : "verified", schema: after }));
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
