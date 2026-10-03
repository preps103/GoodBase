"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20261003_goodspeech_studio_jobs.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodspeech-studio-jobs";
const TABLES = ["goodspeech_studio_jobs", "goodspeech_studio_job_parts"];

async function schemaState(client) {
  const result = await client.query(`SELECT ${TABLES.map((table) => `to_regclass('public.${table}') IS NOT NULL AS "${table}"`).join(", ")}`);
  return result.rows[0] || {};
}

function ready(state) { return TABLES.every((table) => state[table] === true); }

async function main() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required to apply production migrations.");
  const client = await database.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    locked = true;
    const before = await schemaState(client);
    if (!ready(before)) await client.query(fs.readFileSync(MIGRATION_PATH, "utf8"));
    const after = await schemaState(client);
    if (!ready(after)) throw new Error("GoodSpeech Studio job schema was not installed completely.");
    console.log(JSON.stringify({ migration: MIGRATION_NAME, status: ready(before) ? "verified" : "applied", schema: after }));
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    client.release();
    await database.pool.end();
  }
}

main().catch((error) => { console.error(`GoodSpeech Studio jobs migration failed: ${error.message}`); process.exitCode = 1; });
