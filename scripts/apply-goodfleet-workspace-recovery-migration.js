"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260731_goodfleet_workspace_recovery_v1.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:goodfleet-workspace-recovery-v1";

async function schemaState(client) {
  const result = await client.query(
    `SELECT
       to_regclass('public.fleet_workspace_revisions') IS NOT NULL AS revisions,
       EXISTS (
         SELECT 1
           FROM pg_trigger
          WHERE tgname='fleet_workspace_revision_capture'
            AND NOT tgisinternal
       ) AS capture_trigger,
       EXISTS (
         SELECT 1
           FROM pg_trigger
          WHERE tgname='fleet_workspace_revision_append_only'
            AND NOT tgisinternal
       ) AS append_only_trigger,
       NOT EXISTS (
         SELECT 1
           FROM fleet_workspace_state workspace
          WHERE NOT EXISTS (
            SELECT 1
              FROM fleet_workspace_revisions revision
             WHERE revision.organization_id=workspace.organization_id
               AND revision.workspace_version=workspace.version
               AND revision.state_json=workspace.state_json
          )
       ) AS current_workspace_captured`,
  );
  return result.rows[0] || {};
}

function ready(state) {
  return state.revisions === true &&
    state.capture_trigger === true &&
    state.append_only_trigger === true &&
    state.current_workspace_captured === true;
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
    const tableCheck = await client.query(
      `SELECT to_regclass('public.fleet_workspace_revisions') IS NOT NULL AS revisions`,
    );
    const before = tableCheck.rows[0] || {};
    if (!before.revisions || !ready(await schemaState(client))) {
      await client.query(sql);
    }
    const after = await schemaState(client);
    if (!ready(after)) {
      throw new Error("GoodFleet workspace recovery was not installed completely.");
    }
    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: tableCheck.rows[0]?.revisions ? "verified" : "applied",
      schema: after,
    }));
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => {});
    }
    client.release();
    await database.pool.end();
  }
}

main().catch(error => {
  console.error(`GoodFleet workspace recovery migration failed: ${error.message}`);
  process.exitCode = 1;
});
