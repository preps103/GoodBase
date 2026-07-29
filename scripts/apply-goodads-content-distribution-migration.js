"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260729_goodads_content_distribution.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodads-content-distribution";

async function schemaState(client) {
  const result = await client.query(
    `
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'goodads_resources'::regclass
            AND conname = 'goodads_resource_type_valid'
            AND pg_get_constraintdef(oid) LIKE '%rss_feeds%'
        ) AS rss_type,
        to_regclass('public.idx_goodads_link_hubs_public_slug') IS NOT NULL AS link_hubs,
        to_regclass('public.idx_goodads_rss_feeds_url') IS NOT NULL AS rss_urls,
        to_regclass('public.idx_goodads_calendar_schedule') IS NOT NULL AS calendar_schedule
    `
  );
  return result.rows[0] || {};
}

function ready(state) {
  return ["rss_type", "link_hubs", "rss_urls", "calendar_schedule"]
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
    if (!ready(after)) throw new Error("GoodAds content-distribution schema was not installed completely.");
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
  console.error(`GoodAds content-distribution migration failed: ${error.message}`);
  process.exitCode = 1;
});
