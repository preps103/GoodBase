"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const MIGRATION_PATHS = [
  "20260810_goodscan_production_workspace.sql",
  "20260810_goodscan_credit_billing.sql",
].map(fileName => path.join(__dirname, "..", "migrations", fileName));

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to apply the GoodScan migration.");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: "goodscan-migration" });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('goodscan-production-migrations'))");
    for (const migrationPath of MIGRATION_PATHS) {
      await client.query(fs.readFileSync(migrationPath, "utf8"));
      console.log(`${path.basename(migrationPath)} applied.`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('goodscan-production-migrations'))").catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
