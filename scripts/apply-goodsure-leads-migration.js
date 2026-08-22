"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260822_goodsure_leads.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodsure-leads";

async function schemaReady(client) {
  const result = await client.query(`
    SELECT
      TO_REGCLASS('public.goodsure_leads') IS NOT NULL AS "tableReady",
      EXISTS (
        SELECT 1 FROM backend_table_api_rules
        WHERE id = 'tblapi_goodsure_leads'
          AND api_slug = 'goodsure-leads'
          AND status = 'active'
          AND read_enabled = true
          AND write_enabled = true
      ) AS "apiReady"
  `);
  return result.rows[0]?.tableReady === true && result.rows[0]?.apiReady === true;
}

async function main() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required to apply production migrations.");
  const client = await database.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    locked = true;
    const wasReady = await schemaReady(client);
    if (!wasReady) await client.query(fs.readFileSync(MIGRATION_PATH, "utf8"));
    if (!(await schemaReady(client))) throw new Error("GoodSure lead storage was not installed completely.");
    console.log(JSON.stringify({ migration: MIGRATION_NAME, status: wasReady ? "verified" : "applied", schemaReady: true }));
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    client.release();
    await database.pool.end();
  }
}

main().catch((error) => {
  console.error(`GoodSure lead migration failed: ${error.message}`);
  process.exitCode = 1;
});
