"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const env = require("../src/config/env");

const MIGRATION_NAME = "20260727_manager_testers_access.sql";
const MIGRATION_PATH = path.join(__dirname, "..", "migrations", MIGRATION_NAME);
const LOCK_NAME = "goodbase:migration:manager-testers-access";
const MANAGER_EMAILS = ["ryan@goodos.app", "marissa@goodos.app"];

async function accessState(client) {
  const result = await client.query(
    `
      WITH active_apps AS (
        SELECT COUNT(*)::INTEGER AS count
        FROM apps
        WHERE status = 'active'
      )
      SELECT
        LOWER(account.email) AS email,
        account.platform_role,
        account.status,
        account.email_verified,
        account.password_hash IS NOT NULL
          AND LENGTH(account.password_hash) > 0 AS password_configured,
        account.failed_login_count,
        account.locked_until,
        (
          SELECT COUNT(*)::INTEGER
          FROM app_memberships membership
          JOIN apps application ON application.id = membership.app_id
          WHERE membership.user_id = account.id
            AND membership.role = 'manager'
            AND membership.status = 'active'
            AND application.status = 'active'
        ) AS manager_memberships,
        (SELECT count FROM active_apps) AS active_apps,
        (
          SELECT COUNT(*)::INTEGER
          FROM backend_user_roles user_role
          WHERE user_role.user_id = account.id
            AND user_role.role_id = 'role_manager'
            AND user_role.role_name = 'manager'
            AND user_role.scope_type = 'platform'
            AND user_role.scope_id = '*'
            AND user_role.status = 'active'
            AND user_role.revoked_at IS NULL
        ) AS active_manager_roles
      FROM users account
      WHERE LOWER(account.email) = ANY($1::TEXT[])
      ORDER BY LOWER(account.email)
    `,
    [MANAGER_EMAILS]
  );
  return result.rows;
}

function ready(rows) {
  return rows.length === MANAGER_EMAILS.length
    && rows.every((row) =>
      MANAGER_EMAILS.includes(row.email)
      && row.platform_role === "manager"
      && row.status === "active"
      && row.email_verified === true
      && row.password_configured === true
      && Number(row.failed_login_count) === 0
      && row.locked_until === null
      && Number(row.manager_memberships) === Number(row.active_apps)
      && Number(row.active_manager_roles) === 1
    );
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
    const before = await accessState(client);
    if (!ready(before)) await client.query(sql);
    const after = await accessState(client);
    if (!ready(after)) {
      throw new Error("Ryan and Marissa manager access was not installed completely.");
    }
    console.log(JSON.stringify({
      migration: MIGRATION_NAME,
      status: ready(before) ? "verified" : "applied",
      users: after.map((row) => ({
        email: row.email,
        platformRole: row.platform_role,
        status: row.status,
        emailVerified: row.email_verified,
        passwordConfigured: row.password_configured,
        activeAppMemberships: Number(row.manager_memberships),
        activeApps: Number(row.active_apps),
        activeManagerRoles: Number(row.active_manager_roles),
      })),
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (locked) {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext($1))",
        [LOCK_NAME]
      ).catch(() => {});
    }
    client.release();
    await database.pool.end();
  }
}

main().catch((error) => {
  console.error(`Manager tester access migration failed: ${error.message}`);
  process.exitCode = 1;
});
