"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260725_goodads_growth_engine.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodads-growth-engine";

function hasGrowthTypes(definition) {
  const value = String(definition || "");
  return ["funnels", "lead_forms", "leads"].every((type) => value.includes(`'${type}'`));
}

async function constraintDefinition(client) {
  const result = await client.query(
    `
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'goodads_resources'::regclass
        AND conname = 'goodads_resource_type_valid'
      LIMIT 1
    `
  );
  return result.rows[0]?.definition || "";
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
    const before = await constraintDefinition(client);

    if (!hasGrowthTypes(before)) {
      await client.query(sql);
    }

    const after = await constraintDefinition(client);
    if (!hasGrowthTypes(after)) {
      throw new Error("GoodAds growth resource types were not installed.");
    }

    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: hasGrowthTypes(before) ? "verified" : "applied",
      growthTypes: ["funnels", "lead_forms", "leads"],
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
  console.error(`GoodAds growth migration failed: ${error.message}`);
  process.exitCode = 1;
});
