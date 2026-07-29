"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260729_goodads_publishing_queue.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodads-publishing-queue";

async function schemaState(client) {
  const result = await client.query(
    `
      SELECT
        to_regclass('public.goodads_publish_jobs') IS NOT NULL AS jobs,
        to_regclass('public.goodads_publish_targets') IS NOT NULL AS targets,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'goodads_publish_jobs'
            AND column_name = 'scheduled_for'
        ) AS scheduling,
        EXISTS (
          SELECT 1 FROM backend_jobs
          WHERE id = 'job_goodads_social_publish'
            AND handler_key = 'goodads.social.publish'
            AND status = 'active'
        ) AS worker
    `
  );
  return result.rows[0] || {};
}

function ready(state) {
  return ["jobs", "targets", "scheduling", "worker"].every((key) => state[key] === true);
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
    if (!ready(after)) throw new Error("GoodAds publishing queue schema was not installed completely.");
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
  console.error(`GoodAds publishing migration failed: ${error.message}`);
  process.exitCode = 1;
});
