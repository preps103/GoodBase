"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260726_goodswapz_marketplace_handoff.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodswapz-marketplace-handoff";

async function schemaState(client) {
  const result = await client.query(
    `
      SELECT
        to_regclass('public.goodswapz_listings') IS NOT NULL AS listings,
        to_regclass('public.goodswapz_offers') IS NOT NULL AS offers,
        to_regclass('public.goodswapz_identity_verifications') IS NOT NULL AS identity,
        to_regclass('public.goodswapz_escrow_transactions') IS NOT NULL AS transactions,
        to_regclass('public.goodswapz_handoffs') IS NOT NULL AS handoffs,
        to_regclass('public.goodswapz_handoff_steps') IS NOT NULL AS steps,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'goodswapz_listings'
            AND column_name = 'organization_id'
        ) AS organization_scope,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'goodswapz_listings'
            AND column_name = 'price_cents'
        ) AS integer_money
    `
  );
  return result.rows[0] || {};
}

function ready(state) {
  return [
    "listings",
    "offers",
    "identity",
    "transactions",
    "handoffs",
    "steps",
    "organization_scope",
    "integer_money",
  ].every((key) => state[key] === true);
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

    if (!ready(before)) {
      await client.query(sql);
    }

    const after = await schemaState(client);
    if (!ready(after)) {
      throw new Error("GoodSwapz marketplace and handoff schema was not installed completely.");
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
  console.error(`GoodSwapz marketplace migration failed: ${error.message}`);
  process.exitCode = 1;
});
