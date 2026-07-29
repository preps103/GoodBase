"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260729_goodspeech_collaboration.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodspeech-collaboration";
const TABLES = [
  "goodspeech_projects",
  "goodspeech_project_members",
  "goodspeech_project_tasks",
  "goodspeech_chat_channels",
  "goodspeech_chat_channel_members",
  "goodspeech_chat_messages",
];

async function schemaState(client) {
  const result = await client.query(
    `SELECT ${TABLES.map((table) => `to_regclass('public.${table}') IS NOT NULL AS "${table}"`).join(", ")}`
  );
  return result.rows[0] || {};
}

function ready(state) {
  return TABLES.every((table) => state[table] === true);
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
    if (!ready(after)) {
      throw new Error("GoodSpeech collaboration schema was not installed completely.");
    }
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
  console.error(`GoodSpeech collaboration migration failed: ${error.message}`);
  process.exitCode = 1;
});
