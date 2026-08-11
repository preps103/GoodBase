"use strict";

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");

const rateLimit =
  require("express-rate-limit");

const env =
  require("../config/env");

const {
  pool,
  query,
} = require("../config/database");

const authRequired =
  require("../middleware/authRequired");

const tenantContext =
  require("../middleware/tenantContext");

const router = express.Router();

const CALLBACK_URL =
  "https://base.goodos.app/api/oidc/callback";

const DEFAULT_RETURN_TO =
  "https://goodos.app/";

const PROJECT_ID =
  "proj_goodos_platform";

const ENVIRONMENT_ID =
  "env_goodos_production";

const startLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
});

const callbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 80,
  standardHeaders: true,
  legacyHeaders: false,
});

function identifier(prefix) {
  return (
    `${prefix}_` +
    crypto.randomUUID()
      .replaceAll("-", "")
  );
}

function oidcError(
  message,
  statusCode,
  code
) {
  const error = new Error(message);

  error.statusCode = statusCode;
  error.code = code;

  return error;
}

function encryptionKey() {
  const value = String(
    process.env.OIDC_ENCRYPTION_KEY || ""
  );

  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw oidcError(
      "OIDC encryption is not configured.",
      503,
      "OIDC_ENCRYPTION_NOT_CONFIGURED"
    );
  }

  return Buffer.from(value, "hex");
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    encryptionKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(
      String(value),
      "utf8"
    ),
    cipher.final(),
  ]);

  return [
    iv.toString("base64url"),
    cipher.getAuthTag()
      .toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decrypt(value) {
  const parts =
    String(value || "").split(".");

  if (parts.length !== 3) {
    throw oidcError(
      "Stored OIDC transaction value is invalid.",
      500,
      "OIDC_TRANSACTION_ENCRYPTION_INVALID"
    );
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(
      parts[0],
      "base64url"
    )
  );

  decipher.setAuthTag(
    Buffer.from(
      parts[1],
      "base64url"
    )
  );

  return Buffer.concat([
    decipher.update(
      Buffer.from(
        parts[2],
        "base64url"
      )
    ),
    decipher.final(),
  ]).toString("utf8");
}

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex");
}

function normalizeEmail(value) {
  const email =
    String(value || "")
      .trim()
      .toLowerCase();

  if (
    email.length < 3 ||
    email.length > 320 ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/
      .test(email)
  ) {
    return null;
  }

  return email;
}

function emailDomain(email) {
  return String(email)
    .split("@")
    .pop()
    .toLowerCase();
}

function safeReturnTo(value) {
  try {
    const target =
      new URL(
        String(value || DEFAULT_RETURN_TO)
      );

    const allowed = new Set([
      "https://goodos.app",
      "https://base.goodos.app",
      "https://boost.goodos.app",
    ]);

    if (!allowed.has(target.origin)) {
      return DEFAULT_RETURN_TO;
    }

    return target.href;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

function providerMetadata(provider) {
  return (
    provider.metadata_json &&
    typeof provider.metadata_json ===
      "object"
  )
    ? provider.metadata_json
    : {};
}

function providerSecret(provider) {
  const reference =
    String(
      provider.secret_reference || ""
    );

  if (
    !reference ||
    !process.env[reference]
  ) {
    throw oidcError(
      "The OIDC provider secret is not configured.",
      503,
      "OIDC_PROVIDER_SECRET_NOT_CONFIGURED"
    );
  }

  return process.env[reference];
}

async function loadConfiguration(
  provider
) {
  const oidc =
    await import("openid-client");

  const configuration =
    await oidc.discovery(
      new URL(provider.issuer_url),
      provider.client_id,
      providerSecret(provider)
    );

  return {
    oidc,
    configuration,
  };
}

function authCookieOptions() {
  return {
    httpOnly: true,
    secure: env.authCookieSecure,
    sameSite: env.authCookieSameSite,
    domain: env.authCookieDomain,
    path: "/",
    maxAge:
      env.sessionDays *
      24 *
      60 *
      60 *
      1000,
  };
}

function setAuthCookie(
  response,
  token
) {
  response.cookie(
    env.authCookieName,
    token,
    authCookieOptions()
  );
}

function federatedMfaVerified(
  metadata,
  claims
) {
  if (metadata.trustIdpMfa !== true) {
    return false;
  }

  const acceptedAmr =
    Array.isArray(metadata.mfaAmrValues)
      ? metadata.mfaAmrValues.map(String)
      : [];

  const acceptedAcr =
    Array.isArray(metadata.mfaAcrValues)
      ? metadata.mfaAcrValues.map(String)
      : [];

  const claimAmr =
    Array.isArray(claims.amr)
      ? claims.amr.map(String)
      : [];

  const claimAcr =
    claims.acr
      ? String(claims.acr)
      : null;

  return (
    claimAmr.some(
      value =>
        acceptedAmr.includes(value)
    )
    ||
    (
      claimAcr &&
      acceptedAcr.includes(claimAcr)
    )
  );
}

async function activeProvider(
  providerId
) {
  const result = await query(
    `
      SELECT
        provider.*,

        (
          SELECT COUNT(*)::int
          FROM backend_identity_domains
               AS domain
          WHERE domain.provider_id =
                provider.id
            AND domain.status =
                'active'
        ) AS verified_domain_count

      FROM backend_identity_providers
           AS provider

      WHERE provider.id = $1
        AND provider.provider_type =
            'oidc'
        AND provider.status =
            'active'

      LIMIT 1
    `,
    [providerId]
  );

  return result.rows[0] || null;
}

async function identityAdminRequired(
  request,
  response,
  next
) {
  try {
    const result = await query(
      `
        SELECT
          account.platform_role,

          membership.role
            AS membership_role

        FROM users AS account

        JOIN backend_organization_memberships
             AS membership
          ON membership.user_id =
             account.id

        WHERE account.id =
              $1::uuid

          AND membership.organization_id =
              $2

          AND account.status =
              'active'

          AND membership.status =
              'active'

        LIMIT 1
      `,
      [
        request.user.id,
        request.tenantContext
          .organizationId,
      ]
    );

    const identity =
      result.rows[0];

    const allowed =
      identity &&
      (
        [
          "owner",
          "admin",
        ].includes(
          identity.platform_role
        )
        ||
        [
          "owner",
          "admin",
        ].includes(
          identity.membership_role
        )
      );

    if (!allowed) {
      return response
        .status(403)
        .json({
          success: false,
          code:
            "IDENTITY_ADMIN_REQUIRED",
          message:
            "OIDC administration requires owner or administrator access.",
        });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

async function markTransactionFailed(
  state,
  code
) {
  if (!state) {
    return;
  }

  await query(
    `
      UPDATE backend_oidc_transactions
      SET
        status = 'failed',
        failure_code = $2,
        updated_at = NOW()
      WHERE state_hash = $1
        AND status = 'pending'
    `,
    [
      hash(state),
      String(
        code ||
        "OIDC_CALLBACK_FAILED"
      ).slice(0, 150),
    ]
  ).catch(() => {});
}

router.get(
  "/login-health",
  async (
    request,
    response,
    next
  ) => {
    try {
      const result = await query(
        `
          SELECT
            (
              SELECT COUNT(*)::int
              FROM backend_identity_providers
              WHERE provider_type = 'oidc'
                AND status = 'active'
            ) AS active_providers,

            (
              SELECT COUNT(*)::int
              FROM backend_identity_domains
              WHERE status = 'active'
            ) AS verified_domains,

            (
              SELECT COUNT(*)::int
              FROM backend_identity_bindings
              WHERE status = 'active'
            ) AS active_bindings,

            (
              SELECT COUNT(*)::int
              FROM backend_identity_bindings
              WHERE status = 'active'
                AND last_login_at
                    IS NOT NULL
            ) AS completed_external_logins
        `
      );

      response.json({
        success: true,
        status: "ready",
        callbackImplemented: true,
        callbackUrl: CALLBACK_URL,
        authorizationStartPattern:
          "https://base.goodos.app/api/oidc/start/{providerId}",
        ...result.rows[0],
        mandatorySso: false,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/providers",
  async (_request, response, next) => {
    try {
      const result = await query(`
        SELECT id, display_name, metadata_json
        FROM backend_identity_providers
        WHERE provider_type = 'oidc'
          AND status = 'active'
        ORDER BY display_name
      `);
      const supported = new Set(["google", "apple", "microsoft", "github", "facebook"]);
      const providers = result.rows.map(provider => {
        const metadata = providerMetadata(provider);
        const providerType = String(metadata.providerType || metadata.provider || provider.display_name || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");
        return {
          id: provider.id,
          provider_type: providerType,
          display_name: provider.display_name,
          available: supported.has(providerType),
        };
      }).filter(provider => provider.available);
      return response.json({ success: true, providers });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/start/:providerId",
  startLimiter,
  async (
    request,
    response,
    next
  ) => {
    try {
      const provider =
        await activeProvider(
          request.params.providerId
        );

      if (!provider) {
        return response
          .status(404)
          .json({
            success: false,
            code:
              "OIDC_PROVIDER_NOT_AVAILABLE",
            message:
              "The requested OIDC provider is not active.",
          });
      }

      if (
        Number(
          provider
            .verified_domain_count ||
          0
        ) < 1
      ) {
        return response
          .status(409)
          .json({
            success: false,
            code:
              "OIDC_PROVIDER_DOMAIN_REQUIRED",
            message:
              "The provider does not have a verified identity domain.",
          });
      }

      const {
        oidc,
        configuration,
      } = await loadConfiguration(
        provider
      );

      const state =
        oidc.randomState();

      const nonce =
        oidc.randomNonce();

      const codeVerifier =
        oidc.randomPKCECodeVerifier();

      const codeChallenge =
        await oidc
          .calculatePKCECodeChallenge(
            codeVerifier
          );

      const returnTo =
        safeReturnTo(
          request.query.returnTo
        );

      await query(
        `
          UPDATE backend_oidc_transactions
          SET
            status = 'expired',
            updated_at = NOW()
          WHERE status = 'pending'
            AND expires_at <= NOW()
        `
      );

      await query(
        `
          INSERT INTO
            backend_oidc_transactions (
              id,
              organization_id,
              provider_id,
              state_hash,
              nonce_encrypted,
              code_verifier_encrypted,
              return_to,
              status,
              ip_address,
              user_agent,
              expires_at,
              metadata_json
            )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            'pending',
            $8,
            $9,
            NOW() + INTERVAL '10 minutes',
            jsonb_build_object(
              'phase',
              '15C2',
              'callbackUrl',
              $10::text
            )
          )
        `,
        [
          identifier("oidctx"),
          provider.organization_id,
          provider.id,
          hash(state),
          encrypt(nonce),
          encrypt(codeVerifier),
          returnTo,
          request.ip || null,
          request.headers[
            "user-agent"
          ] || null,
          CALLBACK_URL,
        ]
      );

      const authorizationUrl =
        oidc.buildAuthorizationUrl(
          configuration,
          {
            redirect_uri:
              CALLBACK_URL,
            response_type: "code",
            scope:
              "openid profile email",
            code_challenge:
              codeChallenge,
            code_challenge_method:
              "S256",
            state,
            nonce,
          }
        );

      if (
        String(
          request.query.format ||
          ""
        ).toLowerCase() === "json"
      ) {
        return response.json({
          success: true,
          provider: {
            id: provider.id,
            displayName:
              provider.display_name,
          },
          authorizationUrl:
            authorizationUrl.href,
          callbackUrl:
            CALLBACK_URL,
          expiresInSeconds: 600,
        });
      }

      return response.redirect(
        302,
        authorizationUrl.href
      );
    } catch (error) {
      console.error(
        "OIDC authorization start failed:",
        error
      );

      return response
        .status(
          error.statusCode || 400
        )
        .json({
          success: false,
          code:
            error.code ||
            "OIDC_AUTHORIZATION_START_FAILED",
          message:
            error.statusCode
              ? error.message
              : "OIDC authorization could not be started.",
        });
    }
  }
);

router.get(
  "/callback",
  callbackLimiter,
  async (
    request,
    response
  ) => {
    const state =
      String(
        request.query.state || ""
      ).trim();

    const code =
      String(
        request.query.code || ""
      ).trim();

    if (
      request.query.error
    ) {
      await markTransactionFailed(
        state,
        request.query.error
      );

      return response
        .status(400)
        .json({
          success: false,
          code:
            "OIDC_PROVIDER_RETURNED_ERROR",
          message:
            "The identity provider did not complete authentication.",
        });
    }

    if (!state || !code) {
      return response
        .status(400)
        .json({
          success: false,
          code:
            "OIDC_CALLBACK_PARAMETERS_REQUIRED",
          message:
            "This callback must be reached through an OIDC provider authorization response.",
          startPattern:
            "https://base.goodos.app/api/oidc/start/{providerId}",
        });
    }

    let transaction = null;
    let databaseClient = null;

    try {
      const transactionResult =
        await query(
          `
            SELECT
              transaction.*,
              provider.issuer_url,
              provider.client_id,
              provider.secret_reference,
              provider.metadata_json
                AS provider_metadata,
              provider.status
                AS provider_status,
              provider.display_name
                AS provider_display_name

            FROM backend_oidc_transactions
                 AS transaction

            JOIN backend_identity_providers
                 AS provider
              ON provider.id =
                 transaction.provider_id

            WHERE transaction.state_hash =
                  $1

              AND transaction.status =
                  'pending'

            LIMIT 1
          `,
          [hash(state)]
        );

      transaction =
        transactionResult.rows[0];

      if (!transaction) {
        throw oidcError(
          "The OIDC transaction is invalid, expired or already used.",
          400,
          "OIDC_TRANSACTION_INVALID"
        );
      }

      if (
        transaction.provider_status !==
          "active"
      ) {
        throw oidcError(
          "The OIDC provider is no longer active.",
          409,
          "OIDC_PROVIDER_DISABLED"
        );
      }

      if (
        new Date(
          transaction.expires_at
        ).getTime() <= Date.now()
      ) {
        await query(
          `
            UPDATE backend_oidc_transactions
            SET
              status = 'expired',
              failure_code =
                'OIDC_TRANSACTION_EXPIRED',
              updated_at = NOW()
            WHERE id = $1
          `,
          [transaction.id]
        );

        throw oidcError(
          "The OIDC transaction expired. Start again.",
          410,
          "OIDC_TRANSACTION_EXPIRED"
        );
      }

      const provider = {
        id:
          transaction.provider_id,
        organization_id:
          transaction.organization_id,
        issuer_url:
          transaction.issuer_url,
        client_id:
          transaction.client_id,
        secret_reference:
          transaction.secret_reference,
        metadata_json:
          transaction.provider_metadata,
      };

      const {
        oidc,
        configuration,
      } = await loadConfiguration(
        provider
      );

      const callbackUrl =
        new URL(
          request.originalUrl,
          "https://base.goodos.app"
        );

      const tokens =
        await oidc
          .authorizationCodeGrant(
            configuration,
            callbackUrl,
            {
              pkceCodeVerifier:
                decrypt(
                  transaction
                    .code_verifier_encrypted
                ),
              expectedState: state,
              expectedNonce:
                decrypt(
                  transaction
                    .nonce_encrypted
                ),
              idTokenExpected: true,
            }
          );

      const idClaims =
        tokens.claims();

      if (
        !idClaims ||
        !idClaims.sub
      ) {
        throw oidcError(
          "The identity provider did not return a valid subject.",
          400,
          "OIDC_SUBJECT_REQUIRED"
        );
      }

      let userInfo = {};

      if (tokens.access_token) {
        userInfo =
          await oidc.fetchUserInfo(
            configuration,
            tokens.access_token,
            idClaims.sub
          ).catch(() => ({}));
      }

      const claims = {
        ...idClaims,
        ...userInfo,
        sub: idClaims.sub,
      };

      const externalSubject =
        String(claims.sub);

      const email =
        normalizeEmail(
          claims.email
        );

      const emailVerified =
        claims.email_verified === true;

      const metadata =
        providerMetadata({
          metadata_json:
            transaction
              .provider_metadata,
        });

      const defaultRole =
        [
          "user",
          "viewer",
        ].includes(
          String(
            metadata.defaultRole ||
            ""
          )
        )
          ? String(
              metadata.defaultRole
            )
          : "user";

      const jitEnabled =
        metadata.jitEnabled === true;

      const autoLinkVerifiedUsers =
        metadata
          .autoLinkVerifiedUsers === true;

      const idpMfaVerified =
        federatedMfaVerified(
          metadata,
          claims
        );

      databaseClient =
        await pool.connect();

      await databaseClient.query(
        "BEGIN"
      );

      const lockedResult =
        await databaseClient.query(
          `
            SELECT *
            FROM backend_oidc_transactions
            WHERE id = $1
            FOR UPDATE
          `,
          [transaction.id]
        );

      const locked =
        lockedResult.rows[0];

      if (
        !locked ||
        locked.status !== "pending"
      ) {
        throw oidcError(
          "The OIDC transaction was already consumed.",
          409,
          "OIDC_TRANSACTION_ALREADY_USED"
        );
      }

      const bindingResult =
        await databaseClient.query(
          `
            SELECT
              binding.id,
              binding.user_id,
              binding.status,
              account.email,
              account.first_name,
              account.last_name,
              account.display_name,
              account.platform_role,
              account.status
                AS account_status,
              account.email_verified,
              account.mfa_enabled,
              account.mfa_required,
              membership.status
                AS membership_status

            FROM backend_identity_bindings
                 AS binding

            JOIN users AS account
              ON account.id =
                 binding.user_id

            LEFT JOIN
              backend_organization_memberships
              AS membership
              ON membership.user_id =
                 binding.user_id
             AND membership.organization_id =
                 binding.organization_id

            WHERE binding.provider_id =
                  $1

              AND binding.external_subject =
                  $2

            LIMIT 1

            FOR UPDATE OF binding
          `,
          [
            transaction.provider_id,
            externalSubject,
          ]
        );

      const existingBinding =
        bindingResult.rows[0];

      let account = null;
      let bindingId = null;
      let accountCreated = false;

      if (existingBinding) {
        if (
          existingBinding.status !==
            "active" ||
          existingBinding.account_status !==
            "active" ||
          existingBinding.membership_status !==
            "active"
        ) {
          throw oidcError(
            "The external identity binding is inactive.",
            403,
            "OIDC_BINDING_INACTIVE"
          );
        }

        account =
          existingBinding;

        bindingId =
          existingBinding.id;
      } else {
        if (!jitEnabled) {
          throw oidcError(
            "No identity binding exists and JIT provisioning is disabled.",
            403,
            "OIDC_BINDING_REQUIRED"
          );
        }

        if (!email) {
          throw oidcError(
            "The identity provider did not return an email address.",
            400,
            "OIDC_EMAIL_REQUIRED"
          );
        }

        if (!emailVerified) {
          throw oidcError(
            "The identity provider did not confirm the email address.",
            403,
            "OIDC_EMAIL_NOT_VERIFIED"
          );
        }

        const domain =
          emailDomain(email);

        const verifiedDomainResult =
          await databaseClient.query(
            `
              SELECT id
              FROM backend_identity_domains
              WHERE provider_id = $1
                AND organization_id = $2
                AND lower(domain) =
                    lower($3)
                AND status = 'active'
              LIMIT 1
            `,
            [
              transaction.provider_id,
              transaction.organization_id,
              domain,
            ]
          );

        if (
          verifiedDomainResult
            .rows.length !== 1
        ) {
          throw oidcError(
            "The email domain is not verified for this identity provider.",
            403,
            "OIDC_EMAIL_DOMAIN_NOT_VERIFIED"
          );
        }

        const accountResult =
          await databaseClient.query(
            `
              SELECT
                account.*,

                membership.status
                  AS membership_status

              FROM users AS account

              LEFT JOIN
                backend_organization_memberships
                AS membership
                ON membership.user_id =
                   account.id
               AND membership.organization_id =
                   $2

              WHERE lower(account.email) =
                    lower($1)

              LIMIT 1

              FOR UPDATE OF account
            `,
            [
              email,
              transaction.organization_id,
            ]
          );

        account =
          accountResult.rows[0];

        if (account) {
          if (
            !autoLinkVerifiedUsers
          ) {
            throw oidcError(
              "An existing GoodOS account uses this email. An administrator must enable verified-account linking or create a manual binding.",
              409,
              "OIDC_EXISTING_ACCOUNT_LINK_REQUIRED"
            );
          }

          if (
            account.status !==
              "active" ||
            account.email_verified !==
              true ||
            account.membership_status !==
              "active"
          ) {
            throw oidcError(
              "The matching GoodOS account is not eligible for automatic linking.",
              403,
              "OIDC_EXISTING_ACCOUNT_NOT_ELIGIBLE"
            );
          }
        } else {
          const firstName =
            String(
              claims.given_name ||
              ""
            ).trim().slice(0, 100)
            || null;

          const lastName =
            String(
              claims.family_name ||
              ""
            ).trim().slice(0, 100)
            || null;

          const displayName =
            String(
              claims.name ||
              [
                firstName,
                lastName,
              ].filter(Boolean).join(" ") ||
              email.split("@")[0]
            ).trim().slice(0, 200);

          const newAccountResult =
            await databaseClient.query(
              `
                INSERT INTO users (
                  email,
                  password_hash,
                  first_name,
                  last_name,
                  display_name,
                  platform_role,
                  status,
                  email_verified,
                  auth_metadata_json
                )
                VALUES (
                  $1,
                  NULL,
                  $2,
                  $3,
                  $4,
                  $5,
                  'active',
                  true,
                  jsonb_build_object(
                    'registrationSource',
                    'oidc_jit',
                    'providerId',
                    $6,
                    'provisionedAt',
                    NOW()
                  )
                )
                RETURNING *
              `,
              [
                email,
                firstName,
                lastName,
                displayName,
                defaultRole,
                transaction.provider_id,
              ]
            );

          account =
            newAccountResult.rows[0];

          accountCreated = true;

          await databaseClient.query(
            `
              INSERT INTO
                backend_organization_memberships (
                  id,
                  organization_id,
                  user_id,
                  role,
                  status
                )
              VALUES (
                $1,
                $2,
                $3::uuid,
                $4,
                'active'
              )
              ON CONFLICT (
                organization_id,
                user_id
              )
              DO UPDATE SET
                role = EXCLUDED.role,
                status = 'active',
                updated_at = NOW()
            `,
            [
              identifier("orgmember"),
              transaction.organization_id,
              account.id,
              defaultRole,
            ]
          );

          await databaseClient.query(
            `
              INSERT INTO
                backend_project_memberships (
                  id,
                  project_id,
                  user_id,
                  role,
                  status
                )
              VALUES (
                $1,
                $2,
                $3::uuid,
                $4,
                'active'
              )
              ON CONFLICT (
                project_id,
                user_id
              )
              DO UPDATE SET
                role = EXCLUDED.role,
                status = 'active',
                updated_at = NOW()
            `,
            [
              identifier("projectmember"),
              PROJECT_ID,
              account.id,
              defaultRole,
            ]
          );

          await databaseClient.query(
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
              VALUES (
                $1::uuid,
                'goodos',
                'member',
                'active',
                $2,
                $3,
                $4
              )
              ON CONFLICT (
                user_id,
                app_id
              )
              DO UPDATE SET
                role = 'member',
                status = 'active',
                organization_id =
                  EXCLUDED.organization_id,
                project_id =
                  EXCLUDED.project_id,
                environment_id =
                  EXCLUDED.environment_id,
                updated_at = NOW()
            `,
            [
              account.id,
              transaction.organization_id,
              PROJECT_ID,
              ENVIRONMENT_ID,
            ]
          );

          const roleId =
            defaultRole === "viewer"
              ? "role_viewer"
              : "role_user";

          await databaseClient.query(
            `
              INSERT INTO backend_user_roles (
                id,
                user_id,
                role_id,
                role_name,
                scope_type,
                scope_id,
                status,
                metadata_json,
                organization_id,
                project_id,
                environment_id
              )
              VALUES (
                $1,
                $2::uuid,
                $3,
                $4,
                'platform',
                '*',
                'active',
                jsonb_build_object(
                  'assignedBy',
                  'oidc_jit',
                  'providerId',
                  $5
                ),
                $6,
                $7,
                $8
              )
              ON CONFLICT (
                user_id,
                role_id,
                scope_type,
                scope_id
              )
              DO UPDATE SET
                role_name =
                  EXCLUDED.role_name,
                status = 'active',
                revoked_at = NULL,
                metadata_json =
                  backend_user_roles
                    .metadata_json ||
                  EXCLUDED.metadata_json,
                updated_at = NOW()
            `,
            [
              identifier("userrole"),
              account.id,
              roleId,
              defaultRole,
              transaction.provider_id,
              transaction.organization_id,
              PROJECT_ID,
              ENVIRONMENT_ID,
            ]
          );
        }

        const newBindingId =
          identifier("idbind");

        const createdBindingResult =
          await databaseClient.query(
            `
              INSERT INTO
                backend_identity_bindings (
                  id,
                  organization_id,
                  provider_id,
                  user_id,
                  external_subject,
                  external_email,
                  status,
                  last_login_at,
                  metadata_json
                )
              VALUES (
                $1,
                $2,
                $3,
                $4::uuid,
                $5,
                $6,
                'active',
                NOW(),
                jsonb_build_object(
                  'phase',
                  '15C2',
                  'jitProvisioned',
                  $7::boolean,
                  'emailVerified',
                  true
                )
              )
              ON CONFLICT (
                provider_id,
                external_subject
              )
              DO UPDATE SET
                external_email =
                  EXCLUDED.external_email,
                last_login_at = NOW(),
                metadata_json =
                  backend_identity_bindings
                    .metadata_json ||
                  EXCLUDED.metadata_json,
                updated_at = NOW()
              RETURNING
                id,
                user_id
            `,
            [
              newBindingId,
              transaction.organization_id,
              transaction.provider_id,
              account.id,
              externalSubject,
              email,
              accountCreated,
            ]
          );

        const createdBinding =
          createdBindingResult.rows[0];

        if (
          String(
            createdBinding.user_id
          ) !== String(account.id)
        ) {
          throw oidcError(
            "The external subject is already bound to another account.",
            409,
            "OIDC_SUBJECT_ALREADY_BOUND"
          );
        }

        bindingId =
          createdBinding.id;
      }

      await databaseClient.query(
        `
          UPDATE backend_identity_bindings
          SET
            external_email =
              COALESCE(
                $2,
                external_email
              ),
            last_login_at = NOW(),
            metadata_json =
              metadata_json ||
              jsonb_build_object(
                'lastClaims',
                $3::jsonb
              ),
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          bindingId,
          email,
          JSON.stringify({
            issuer:
              claims.iss || null,
            subject:
              externalSubject,
            emailVerified,
            amr:
              Array.isArray(claims.amr)
                ? claims.amr
                : [],
            acr:
              claims.acr || null,
          }),
        ]
      );

      const sessionToken =
        jwt.sign(
          {
            sub: account.id,
            email: account.email,
            platformRole:
              account.platform_role,
            authSource: "oidc",
            providerId:
              transaction.provider_id,
          },
          env.jwtSecret,
          {
            expiresIn:
              env.jwtExpiresIn,
          }
        );

      const sessionResult =
        await databaseClient.query(
          `
            INSERT INTO sessions (
              user_id,
              token_hash,
              ip_address,
              user_agent,
              expires_at,
              auth_level,
              mfa_verified,
              metadata_json,
              organization_id,
              project_id,
              environment_id
            )
            VALUES (
              $1::uuid,
              $2,
              NULLIF($3, '')::inet,
              $4,
              NOW() +
                ($5 || ' days')::interval,
              $6,
              $7::boolean,
              jsonb_build_object(
                'authSource',
                'oidc',
                'providerId',
                $8,
                'bindingId',
                $9,
                'externalSubjectHash',
                $10,
                'idpMfaVerified',
                $7::boolean
              ),
              $11,
              $12,
              $13
            )
            RETURNING
              id,
              expires_at,
              auth_level,
              mfa_verified
          `,
          [
            account.id,
            hash(sessionToken),
            request.ip || null,
            request.headers[
              "user-agent"
            ] || null,
            env.sessionDays,
            idpMfaVerified
              ? "federated_mfa"
              : "federated",
            idpMfaVerified,
            transaction.provider_id,
            bindingId,
            hash(externalSubject),
            transaction.organization_id,
            PROJECT_ID,
            ENVIRONMENT_ID,
          ]
        );

      const session =
        sessionResult.rows[0];

      await databaseClient.query(
        `
          UPDATE users
          SET
            last_login_at = NOW(),
            auth_metadata_json =
              auth_metadata_json ||
              jsonb_build_object(
                'lastAuthSource',
                'oidc',
                'lastProviderId',
                $2
              ),
            updated_at = NOW()
          WHERE id = $1::uuid
        `,
        [
          account.id,
          transaction.provider_id,
        ]
      );

      await databaseClient.query(
        `
          UPDATE backend_oidc_transactions
          SET
            status = 'used',
            used_at = NOW(),
            completed_user_id =
              $2::uuid,
            completed_session_id =
              $3::uuid,
            failure_code = NULL,
            metadata_json =
              metadata_json ||
              jsonb_build_object(
                'bindingId',
                $4,
                'accountCreated',
                $5::boolean,
                'idpMfaVerified',
                $6::boolean
              ),
            updated_at = NOW()
          WHERE id = $1
            AND status = 'pending'
        `,
        [
          transaction.id,
          account.id,
          session.id,
          bindingId,
          accountCreated,
          idpMfaVerified,
        ]
      );

      await databaseClient.query(
        `
          INSERT INTO
            backend_auth_audit_events (
              id,
              user_id,
              event_type,
              status,
              ip_address,
              user_agent,
              metadata_json,
              organization_id,
              project_id,
              environment_id
            )
          VALUES (
            $1,
            $2::uuid,
            'auth.oidc.login',
            'recorded',
            $3,
            $4,
            jsonb_build_object(
              'providerId',
              $5,
              'bindingId',
              $6,
              'accountCreated',
              $7::boolean,
              'idpMfaVerified',
              $8::boolean
            ),
            $9,
            $10,
            $11
          )
        `,
        [
          identifier("authevt"),
          account.id,
          request.ip || null,
          request.headers[
            "user-agent"
          ] || null,
          transaction.provider_id,
          bindingId,
          accountCreated,
          idpMfaVerified,
          transaction.organization_id,
          PROJECT_ID,
          ENVIRONMENT_ID,
        ]
      );

      await databaseClient.query(
        "COMMIT"
      );

      setAuthCookie(
        response,
        sessionToken
      );

      const returnTo =
        safeReturnTo(
          transaction.return_to
        );

      if (
        String(
          request.query.format ||
          ""
        ).toLowerCase() ===
          "json" ||
        String(
          request.get("accept") ||
          ""
        ).includes(
          "application/json"
        )
      ) {
        return response.json({
          success: true,
          message:
            "OIDC authentication completed.",
          user: {
            id: account.id,
            email: account.email,
            displayName:
              account.display_name,
            platformRole:
              account.platform_role,
          },
          session: {
            id: session.id,
            authLevel:
              session.auth_level,
            mfaVerified:
              session.mfa_verified,
            expiresAt:
              session.expires_at,
          },
          providerId:
            transaction.provider_id,
          accountCreated,
          returnTo,
        });
      }

      const target =
        new URL(returnTo);

      target.searchParams.set(
        "sso",
        "success"
      );

      return response.redirect(
        302,
        target.href
      );
    } catch (error) {
      if (databaseClient) {
        await databaseClient
          .query("ROLLBACK")
          .catch(() => {});
      }

      await markTransactionFailed(
        state,
        error.code
      );

      console.error(
        "OIDC callback failed:",
        error
      );

      return response
        .status(
          error.statusCode || 400
        )
        .json({
          success: false,
          code:
            error.code ||
            "OIDC_CALLBACK_FAILED",
          message:
            error.statusCode
              ? error.message
              : "OIDC authentication could not be completed.",
        });
    } finally {
      if (databaseClient) {
        databaseClient.release();
      }
    }
  }
);

router.use(
  "/admin",
  authRequired,
  tenantContext,
  identityAdminRequired
);

router.get(
  "/admin/bindings",
  async (
    request,
    response,
    next
  ) => {
    try {
      const result = await query(
        `
          SELECT
            binding.id,
            binding.provider_id
              AS "providerId",
            provider.display_name
              AS "providerDisplayName",
            binding.user_id
              AS "userId",
            account.email,
            binding.external_email
              AS "externalEmail",
            binding.status,
            binding.last_login_at
              AS "lastLoginAt",
            binding.created_at
              AS "createdAt",
            binding.updated_at
              AS "updatedAt"

          FROM backend_identity_bindings
               AS binding

          JOIN backend_identity_providers
               AS provider
            ON provider.id =
               binding.provider_id

          JOIN users AS account
            ON account.id =
               binding.user_id

          WHERE binding.organization_id =
                $1

          ORDER BY
            binding.created_at DESC
        `,
        [
          request.tenantContext
            .organizationId,
        ]
      );

      response.json({
        success: true,
        bindings: result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/admin/bindings",
  async (
    request,
    response,
    next
  ) => {
    try {
      const organizationId =
        request.tenantContext
          .organizationId;

      const providerId =
        String(
          request.body?.providerId ||
          ""
        ).trim();

      const userId =
        String(
          request.body?.userId ||
          ""
        ).trim();

      const externalSubject =
        String(
          request.body
            ?.externalSubject ||
          ""
        ).trim();

      const externalEmail =
        normalizeEmail(
          request.body
            ?.externalEmail
        );

      if (
        !providerId ||
        !userId ||
        !externalSubject
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Provider ID, user ID and external subject are required.",
          });
      }

      const eligibilityResult =
        await query(
          `
            SELECT
              provider.id
                AS provider_id,
              account.id
                AS user_id

            FROM backend_identity_providers
                 AS provider

            JOIN users AS account
              ON account.id =
                 $3::uuid

            JOIN backend_organization_memberships
                 AS membership
              ON membership.user_id =
                 account.id
             AND membership.organization_id =
                 provider.organization_id

            WHERE provider.id = $1
              AND provider.organization_id =
                  $2
              AND provider.provider_type =
                  'oidc'
              AND account.status =
                  'active'
              AND membership.status =
                  'active'

            LIMIT 1
          `,
          [
            providerId,
            organizationId,
            userId,
          ]
        );

      if (
        eligibilityResult
          .rows.length !== 1
      ) {
        return response
          .status(404)
          .json({
            success: false,
            message:
              "Eligible provider and user combination was not found.",
          });
      }

      const result = await query(
        `
          INSERT INTO
            backend_identity_bindings (
              id,
              organization_id,
              provider_id,
              user_id,
              external_subject,
              external_email,
              status,
              metadata_json
            )
          VALUES (
            $1,
            $2,
            $3,
            $4::uuid,
            $5,
            $6,
            'active',
            jsonb_build_object(
              'createdBy',
              'identity_admin',
              'createdByUserId',
              $7
            )
          )
          ON CONFLICT (
            provider_id,
            external_subject
          )
          DO UPDATE SET
            external_email =
              EXCLUDED.external_email,
            status = 'active',
            metadata_json =
              backend_identity_bindings
                .metadata_json ||
              EXCLUDED.metadata_json,
            updated_at = NOW()
          RETURNING
            id,
            provider_id
              AS "providerId",
            user_id
              AS "userId",
            external_email
              AS "externalEmail",
            status,
            created_at
              AS "createdAt",
            updated_at
              AS "updatedAt"
        `,
        [
          identifier("idbind"),
          organizationId,
          providerId,
          userId,
          externalSubject,
          externalEmail,
          request.user.id,
        ]
      );

      response
        .status(201)
        .json({
          success: true,
          binding:
            result.rows[0],
          message:
            "OIDC identity binding saved.",
        });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/admin/providers/:providerId/login-policy",
  async (
    request,
    response,
    next
  ) => {
    try {
      const organizationId =
        request.tenantContext
          .organizationId;

      const defaultRole =
        [
          "user",
          "viewer",
        ].includes(
          String(
            request.body
              ?.defaultRole ||
            ""
          )
        )
          ? String(
              request.body
                .defaultRole
            )
          : "user";

      const jitEnabled =
        request.body
          ?.jitEnabled === true;

      const autoLinkVerifiedUsers =
        request.body
          ?.autoLinkVerifiedUsers === true;

      const trustIdpMfa =
        request.body
          ?.trustIdpMfa === true;

      const mfaAmrValues =
        Array.isArray(
          request.body
            ?.mfaAmrValues
        )
          ? request.body
              .mfaAmrValues
              .map(String)
              .map(value =>
                value
                  .trim()
                  .slice(0, 100)
              )
              .filter(Boolean)
              .slice(0, 25)
          : [];

      const mfaAcrValues =
        Array.isArray(
          request.body
            ?.mfaAcrValues
        )
          ? request.body
              .mfaAcrValues
              .map(String)
              .map(value =>
                value
                  .trim()
                  .slice(0, 250)
              )
              .filter(Boolean)
              .slice(0, 25)
          : [];

      const result = await query(
        `
          UPDATE backend_identity_providers
          SET
            metadata_json =
              metadata_json ||
              jsonb_build_object(
                'jitEnabled',
                $3::boolean,
                'defaultRole',
                $4,
                'autoLinkVerifiedUsers',
                $5::boolean,
                'trustIdpMfa',
                $6::boolean,
                'mfaAmrValues',
                $7::jsonb,
                'mfaAcrValues',
                $8::jsonb,
                'phase15c2Ready',
                true
              ),
            updated_by =
              $9::uuid,
            updated_at = NOW()
          WHERE id = $1
            AND organization_id = $2
            AND provider_type = 'oidc'
          RETURNING
            id,
            status,
            metadata_json
              AS "metadata",
            updated_at
              AS "updatedAt"
        `,
        [
          request.params
            .providerId,
          organizationId,
          jitEnabled,
          defaultRole,
          autoLinkVerifiedUsers,
          trustIdpMfa,
          JSON.stringify(
            mfaAmrValues
          ),
          JSON.stringify(
            mfaAcrValues
          ),
          request.user.id,
        ]
      );

      if (
        result.rows.length !== 1
      ) {
        return response
          .status(404)
          .json({
            success: false,
            message:
              "OIDC provider was not found.",
          });
      }

      response.json({
        success: true,
        provider:
          result.rows[0],
        warning:
          autoLinkVerifiedUsers
            ? "Verified existing-account linking is enabled for this provider."
            : null,
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
