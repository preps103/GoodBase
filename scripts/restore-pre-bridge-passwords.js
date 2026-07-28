"use strict";

const database = require("../src/config/database");
const env = require("../src/config/env");

const LOCK_NAME = "goodbase:repair:pre-mail-bridge-passwords";

async function main() {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is required to repair production passwords.");
  }

  const client = await database.pool.connect();
  let locked = false;
  const restored = [];
  const skipped = [];

  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    locked = true;
    await client.query("BEGIN");

    const accounts = (
      await client.query(
        `
          SELECT
            id,
            LOWER(email) AS email,
            password_hash,
            auth_metadata_json,
            auth_metadata_json->>'corporateMailboxLinkedAt' AS linked_at
          FROM users
          WHERE LOWER(email) LIKE '%@goodos.app'
            AND COALESCE(
              (auth_metadata_json->>'corporateMailboxLinked')::BOOLEAN,
              FALSE
            ) = TRUE
            AND COALESCE(
              auth_metadata_json->>'registrationSource',
              ''
            ) <> 'goodmail_identity_bridge'
          ORDER BY LOWER(email)
          FOR UPDATE
        `
      )
    ).rows;

    for (const account of accounts) {
      if (!account.linked_at) {
        skipped.push({ email: account.email, reason: "missing_link_timestamp" });
        continue;
      }

      const previous = (
        await client.query(
          `
            SELECT id, password_hash, created_at
            FROM password_history
            WHERE user_id = $1
              AND password_hash IS DISTINCT FROM $2
              AND ABS(
                EXTRACT(
                  EPOCH FROM (
                    created_at - $3::TIMESTAMPTZ
                  )
                )
              ) <= 2
            ORDER BY
              ABS(
                EXTRACT(
                  EPOCH FROM (
                    created_at - $3::TIMESTAMPTZ
                  )
                )
              ) ASC,
              created_at ASC
            LIMIT 1
          `,
          [account.id, account.password_hash, account.linked_at]
        )
      ).rows[0];

      if (!previous) {
        skipped.push({ email: account.email, reason: "no_recoverable_history" });
        continue;
      }

      await client.query(
        `
          UPDATE users
          SET password_hash = $2,
              password_updated_at = NOW(),
              failed_login_count = 0,
              locked_until = NULL,
              auth_metadata_json =
                COALESCE(auth_metadata_json, '{}'::jsonb) ||
                $3::jsonb,
              updated_at = NOW()
          WHERE id = $1
        `,
        [
          account.id,
          previous.password_hash,
          JSON.stringify({
            corporateMailboxCredentialMode: "additional",
            preBridgePasswordRestored: true,
            preBridgePasswordRestoredAt: new Date().toISOString(),
            requiresPasswordReset: false,
          }),
        ]
      );

      restored.push(account.email);
    }

    await client.query("COMMIT");
    console.log(
      JSON.stringify({
        status: "complete",
        restored,
        skipped,
      })
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
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

main().catch((error) => {
  console.error(`Corporate password repair failed: ${error.message}`);
  process.exitCode = 1;
});
