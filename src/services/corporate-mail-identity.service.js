"use strict";

const bcrypt = require("bcryptjs");
const database = require("../config/database");

const GOODMAIL_LOGIN_URL =
  process.env.GOODMAIL_ACCOUNT_LOGIN_URL ||
  "http://127.0.0.1:3021/api/login";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isCorporateMailbox(email) {
  return /^[^@\s]+@goodos\.app$/i.test(email);
}

function displayNameForEmail(email) {
  return email
    .split("@", 1)[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function grantAllActiveAppAccess(queryable, userId) {
  await queryable.query(
    `
      INSERT INTO app_memberships (
        user_id,
        app_id,
        role,
        status,
        organization_id,
        project_id,
        environment_id
      )
      SELECT
        $1,
        application.id,
        'admin',
        'active',
        COALESCE(application.organization_id, 'org_goodos'),
        COALESCE(application.project_id, 'proj_goodos_platform'),
        COALESCE(application.environment_id, 'env_goodos_production')
      FROM apps application
      WHERE application.status = 'active'
      ON CONFLICT (user_id, app_id) DO UPDATE
      SET role = CASE
            WHEN app_memberships.role = 'owner' THEN 'owner'
            ELSE 'admin'
          END,
          status = 'active',
          organization_id = EXCLUDED.organization_id,
          project_id = EXCLUDED.project_id,
          environment_id = EXCLUDED.environment_id,
          updated_at = NOW()
    `,
    [userId]
  );
}

async function ensureCorporateAppAccess(email, userId) {
  if (!isCorporateMailbox(normalizeEmail(email)) || !userId) return;
  await grantAllActiveAppAccess(database, userId);
}

async function verifyGoodMailPassword(email, password) {
  if (!isCorporateMailbox(email) || typeof password !== "string") {
    return false;
  }

  try {
    const response = await fetch(GOODMAIL_LOGIN_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    await response.body?.cancel?.();
    return response.ok;
  } catch {
    return false;
  }
}

async function synchronizeCorporateIdentity({ email, password, user }) {
  const normalizedEmail = normalizeEmail(email);
  if (!isCorporateMailbox(normalizedEmail)) return null;
  if (user && (user.status !== "active" || !user.email_verified)) return null;

  const verified = await verifyGoodMailPassword(normalizedEmail, password);
  if (!verified) return null;

  const client = await database.pool.connect();

  try {
    await client.query("BEGIN");

    let account = (
      await client.query(
        `
          SELECT *
          FROM users
          WHERE LOWER(email) = $1
          LIMIT 1
          FOR UPDATE
        `,
        [normalizedEmail]
      )
    ).rows[0];

    if (account && (account.status !== "active" || !account.email_verified)) {
      await client.query("ROLLBACK");
      return null;
    }

    const verifiedAt = new Date().toISOString();

    if (account) {
      const metadata =
        account.auth_metadata_json &&
        typeof account.auth_metadata_json === "object"
          ? account.auth_metadata_json
          : {};

      account = (
        await client.query(
          `
            UPDATE users
            SET failed_login_count = 0,
                locked_until = NULL,
                auth_metadata_json =
                  COALESCE(auth_metadata_json, '{}'::jsonb) ||
                  $2::jsonb,
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
          `,
          [
            account.id,
            JSON.stringify({
              corporateMailboxLinked: true,
              corporateMailboxLinkedAt:
                metadata.corporateMailboxLinkedAt || verifiedAt,
              corporateMailboxLastVerifiedAt: verifiedAt,
              corporateMailboxCredentialMode: "additional",
              requiresPasswordReset: false,
            }),
          ]
        )
      ).rows[0];
    } else {
      const displayName = displayNameForEmail(normalizedEmail);
      const passwordHash = await bcrypt.hash(password, 12);
      account = (
        await client.query(
          `
            INSERT INTO users (
              email,
              password_hash,
              first_name,
              display_name,
              platform_role,
              status,
              email_verified,
              password_updated_at,
              auth_metadata_json
            )
            VALUES (
              $1,
              $2,
              $3,
              $3,
              'user',
              'active',
              TRUE,
              NOW(),
              $4::jsonb
            )
            RETURNING *
          `,
          [
            normalizedEmail,
            passwordHash,
            displayName,
            JSON.stringify({
              registrationSource: "goodmail_identity_bridge",
              corporateMailboxLinked: true,
              corporateMailboxLinkedAt: verifiedAt,
              corporateMailboxLastVerifiedAt: verifiedAt,
              corporateMailboxCredentialMode: "primary",
            }),
          ]
        )
      ).rows[0];
    }

    await grantAllActiveAppAccess(client, account.id);

    await client.query("COMMIT");
    return account;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ensureCorporateAppAccess,
  isCorporateMailbox,
  synchronizeCorporateIdentity,
  verifyGoodMailPassword,
};
