"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20261007_goodads_connection_ownership.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodads-connection-ownership";

async function installed(client) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'goodads_oauth_states'
       AND column_name = 'connection_context'`
  );
  return result.rowCount === 1;
}

async function main() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required to apply production migrations.");
  const client = await database.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    locked = true;
    const before = await installed(client);
    if (!before) await client.query(fs.readFileSync(MIGRATION_PATH, "utf8"));
    if (!await installed(client)) throw new Error("GoodAds connection ownership storage was not installed completely.");
    console.log(JSON.stringify({ migration: MIGRATION_NAME, status: before ? "verified" : "applied" }));
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    client.release();
    await database.pool.end();
  }
}

main().catch((error) => {
  console.error(`GoodAds connection ownership migration failed: ${error.message}`);
  process.exitCode = 1;
});
