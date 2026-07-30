"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260729_goodfleet_advanced_operations_v1.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodfleet-advanced-operations-v1";

async function schemaState(client) {
  const result = await client.query(
    `SELECT
       to_regclass('public.fleet_host_team_members') IS NOT NULL AS host_team,
       to_regclass('public.fleet_host_team_vehicle_access') IS NOT NULL AS vehicle_access,
       to_regclass('public.fleet_roadside_cases') IS NOT NULL AS roadside,
       to_regclass('public.fleet_roadside_events') IS NOT NULL AS roadside_events,
       to_regclass('public.fleet_telematics_connections') IS NOT NULL AS telematics,
       to_regclass('public.fleet_telematics_snapshots') IS NOT NULL AS snapshots,
       to_regclass('public.fleet_telematics_commands') IS NOT NULL AS commands`,
  );
  return result.rows[0] || {};
}

function ready(state) {
  return [
    "host_team",
    "vehicle_access",
    "roadside",
    "roadside_events",
    "telematics",
    "snapshots",
    "commands",
  ].every(key => state[key] === true);
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
      throw new Error("GoodFleet advanced operations schema was not installed completely.");
    }
    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: ready(before) ? "verified" : "applied",
      schema: after,
    }));
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME])
        .catch(() => {});
    }
    client.release();
    await database.pool.end();
  }
}

main().catch(error => {
  console.error(`GoodFleet advanced operations migration failed: ${error.message}`);
  process.exitCode = 1;
});
