"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20261003_goodspeech_usage_preferences.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodspeech-usage-preferences";

async function installed(client) {
  const result = await client.query("SELECT to_regclass('public.goodspeech_usage_preferences') IS NOT NULL AS ready");
  return result.rows[0]?.ready === true;
}

async function main() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required to apply production migrations.");
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const client = await database.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    locked = true;
    const before = await installed(client);
    if (!before) await client.query(sql);
    if (!(await installed(client))) throw new Error("GoodSpeech usage preferences were not installed completely.");
    console.log(JSON.stringify({ migration: MIGRATION_NAME, status: before ? "verified" : "applied" }));
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    client.release();
    await database.pool.end();
  }
}

main().catch((error) => {
  console.error(`GoodSpeech usage preferences migration failed: ${error.message}`);
  process.exitCode = 1;
});
