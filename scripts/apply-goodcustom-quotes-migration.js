"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260728_goodcustom_quote_requests.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodcustom-quote-requests";

async function schemaReady(client) {
  const result = await client.query(`
    SELECT
      TO_REGCLASS('public.goodcustom_quote_requests') IS NOT NULL AS "tableReady",
      EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'goodcustom_quote_requests'
          AND indexname = 'idx_goodcustom_quote_request_key'
      ) AS "idempotencyReady"
  `);
  const state = result.rows[0] || {};
  return state.tableReady === true && state.idempotencyReady === true;
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
    const wasReady = await schemaReady(client);
    if (!wasReady) await client.query(sql);
    if (!(await schemaReady(client))) {
      throw new Error("GoodCustom quote request schema was not installed completely.");
    }
    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: wasReady ? "verified" : "applied",
      schemaReady: true,
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
  console.error(`GoodCustom quote migration failed: ${error.message}`);
  process.exitCode = 1;
});
