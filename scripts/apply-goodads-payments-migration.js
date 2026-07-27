"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260726_goodads_payments.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodads-payments";

async function schemaState(client) {
  const result = await client.query(
    `
      SELECT
        to_regclass('public.goodads_payment_connections') IS NOT NULL AS connections,
        to_regclass('public.goodads_payment_preferences') IS NOT NULL AS preferences,
        to_regclass('public.goodads_payment_offers') IS NOT NULL AS offers,
        to_regclass('public.goodads_payment_sessions') IS NOT NULL AS sessions,
        to_regclass('public.goodads_payment_webhook_events') IS NOT NULL AS webhooks
    `
  );
  return result.rows[0] || {};
}

function ready(state) {
  return ["connections", "preferences", "offers", "sessions", "webhooks"]
    .every((key) => state[key] === true);
}

async function main() {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is required to apply production migrations.");
  }

  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const client = await database.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    locked = true;
    const before = await schemaState(client);
    if (!ready(before)) await client.query(sql);
    const after = await schemaState(client);
    if (!ready(after)) throw new Error("GoodAds payment schema was not installed completely.");
    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: ready(before) ? "verified" : "applied",
      schema: after,
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    }
    client.release();
    await database.pool.end();
  }
}

main().catch((error) => {
  console.error(`GoodAds payments migration failed: ${error.message}`);
  process.exitCode = 1;
});
