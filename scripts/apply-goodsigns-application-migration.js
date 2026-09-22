"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260922_goodsigns_application.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodsigns-application";

async function currentApplication(client) {
  const result = await client.query(
    "SELECT id, name, domain, status FROM apps WHERE id = 'goodsigns' LIMIT 1"
  );
  return result.rows[0] || null;
}

function isCurrent(application) {
  return application?.name === "GoodSigns"
    && application?.domain === "signs.goodos.app"
    && application?.status === "active";
}

async function main() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required to apply production migrations.");
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const client = await database.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    locked = true;
    const before = await currentApplication(client);
    if (!isCurrent(before)) await client.query(sql);
    const after = await currentApplication(client);
    if (!isCurrent(after)) throw new Error("The GoodSigns application registry entry was not applied.");
    console.log(JSON.stringify({ migration: MIGRATION_NAME, status: isCurrent(before) ? "verified" : "applied", application: after }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    client.release();
    await database.pool.end();
  }
}

main().catch((error) => {
  console.error(`GoodSigns registry migration failed: ${error.message}`);
  process.exitCode = 1;
});
