"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const MIGRATION_PATH = path.join(__dirname, "..", "migrations", "20260810_goodscan_production_workspace.sql");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to apply the GoodScan migration.");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: "goodscan-migration" });
  try {
    await pool.query(fs.readFileSync(MIGRATION_PATH, "utf8"));
    console.log("GoodScan production workspace migration applied.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
