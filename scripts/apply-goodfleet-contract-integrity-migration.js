"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260731_goodfleet_contract_integrity_v2.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodfleet-contract-integrity-v2";
const REQUIRED_TRIGGERS = [
  "fleet_contract_template_version_immutable",
  "fleet_contract_envelope_snapshot_immutable",
  "fleet_contract_signed_recipient_immutable",
];

async function installedTriggers(client) {
  const result = await client.query(
    `SELECT trigger_name
       FROM information_schema.triggers
      WHERE event_object_schema='public'
        AND trigger_name=ANY($1::text[])
      ORDER BY trigger_name`,
    [REQUIRED_TRIGGERS]
  );
  return new Set(result.rows.map(row => row.trigger_name));
}

function ready(installed) {
  return REQUIRED_TRIGGERS.every(name => installed.has(name));
}

async function main() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required to apply production migrations.");
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const client = await database.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    locked = true;
    const before = await installedTriggers(client);
    if (!ready(before)) await client.query(sql);
    const after = await installedTriggers(client);
    if (!ready(after)) throw new Error("GoodFleet contract integrity triggers were not installed completely.");
    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: ready(before) ? "verified" : "applied",
      triggers: [...after],
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    client.release();
    await database.pool.end();
  }
}

main().catch(error => {
  console.error(`GoodFleet contract integrity migration failed: ${error.message}`);
  process.exitCode = 1;
});
