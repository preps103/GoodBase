"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260819_rename_supplyguyz_to_goodsupply.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodsupply-application-rename";

async function currentName(client) {
  const result = await client.query(
    "SELECT name FROM apps WHERE id = 'supplyguyz' LIMIT 1"
  );
  return result.rows[0]?.name || null;
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
    const before = await currentName(client);
    if (before !== "GoodSupply") await client.query(sql);
    const after = await currentName(client);
    if (after !== "GoodSupply") {
      throw new Error("The GoodSupply application registry rename was not applied.");
    }
    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: before === "GoodSupply" ? "verified" : "applied",
      application: { id: "supplyguyz", name: after },
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
  console.error(`GoodSupply registry migration failed: ${error.message}`);
  process.exitCode = 1;
});
