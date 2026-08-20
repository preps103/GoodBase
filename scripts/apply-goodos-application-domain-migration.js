"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260820_align_goodos_application_domains.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:canonical-application-domains";
const EXPECTED = new Map([
  ["goodsure", { name: "GoodSure", domain: "sure.goodos.app" }],
  ["supplyguyz", { name: "GoodSupply", domain: "supply.goodos.app" }],
]);

async function currentApplications(client) {
  const result = await client.query(
    "SELECT id, name, domain, status FROM apps WHERE id = ANY($1::text[]) ORDER BY id",
    [[...EXPECTED.keys()]]
  );
  return result.rows;
}

function isAligned(rows) {
  const actual = new Map(rows.map((row) => [row.id, row]));
  return [...EXPECTED].every(([id, expected]) => {
    const row = actual.get(id);
    return row?.name === expected.name
      && row?.domain === expected.domain
      && row?.status === "active";
  });
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
    const before = await currentApplications(client);
    if (!isAligned(before)) await client.query(sql);
    const after = await currentApplications(client);
    if (!isAligned(after)) {
      throw new Error("The canonical GoodOS application domains were not applied.");
    }
    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: isAligned(before) ? "verified" : "applied",
      applications: after,
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
  console.error(`GoodOS application domain migration failed: ${error.message}`);
  process.exitCode = 1;
});
