"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260822_goodbase_passkeys.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:passkeys";

async function schemaReady(client) {
  const result = await client.query(`
    SELECT
      TO_REGCLASS('public.goodbase_passkey_credentials') IS NOT NULL AS "credentialsReady",
      TO_REGCLASS('public.goodbase_passkey_challenges') IS NOT NULL AS "challengesReady",
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'goodbase_passkey_credentials'
          AND column_name = 'public_key'
          AND is_nullable = 'NO'
      ) AS "publicKeyReady",
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'goodbase_passkey_credentials'
          AND column_name = 'transports_json'
      ) AS "transportsReady"
  `);
  return result.rows[0]?.credentialsReady === true &&
    result.rows[0]?.challengesReady === true &&
    result.rows[0]?.publicKeyReady === true &&
    result.rows[0]?.transportsReady === true;
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
    if (!(await schemaReady(client))) throw new Error("GoodBase passkey storage was not installed completely.");
    console.log(JSON.stringify({ migration: MIGRATION_NAME, status: wasReady ? "verified" : "applied", schemaReady: true }));
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    client.release();
    await database.pool.end();
  }
}

main().catch((error) => {
  console.error(`GoodBase passkey migration failed: ${error.message}`);
  process.exitCode = 1;
});
