"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260930_goodads_major_ad_platforms.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodads-major-ad-platforms";
const EXPECTED_PROVIDERS = [
  "google",
  "meta",
  "youtube",
  "tiktok",
  "linkedin",
  "x",
  "pinterest",
  "snapchat",
];

async function state(client) {
  const result = await client.query(
    `SELECT table_record.relname AS table_name, pg_get_constraintdef(constraint_record.oid) AS definition
     FROM pg_constraint constraint_record
     JOIN pg_class table_record ON table_record.oid = constraint_record.conrelid
     JOIN pg_namespace namespace_record ON namespace_record.oid = table_record.relnamespace
     WHERE namespace_record.nspname = 'public'
       AND constraint_record.contype = 'c'
       AND constraint_record.conname IN (
         'goodads_ad_accounts_provider_check',
         'goodads_provider_campaigns_provider_check',
         'goodads_analytics_snapshots_provider_check'
       )`
  );
  return Object.fromEntries(result.rows.map((row) => [row.table_name, row.definition]));
}

function ready(value) {
  const definitions = [
    value.goodads_ad_accounts,
    value.goodads_provider_campaigns,
    value.goodads_analytics_snapshots,
  ];
  return definitions.every((definition) => (
    typeof definition === "string"
    && EXPECTED_PROVIDERS.every((provider) => definition.includes(`'${provider}'`))
  ));
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
    if (!ready(after)) throw new Error("GoodAds major-platform provider constraints were not installed completely.");
    console.log(JSON.stringify({ migration: MIGRATION_NAME, status: ready(before) ? "verified" : "applied" }));
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
  console.error(`GoodAds major-platform migration failed: ${error.message}`);
  process.exitCode = 1;
});
