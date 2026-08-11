const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const speakeasy = require("speakeasy");
const qrcode = require("qrcode");
const notificationService = require("../services/notification.service");
const transactionalEmailService = require("../services/transactional-email.service");


const env = require("../config/env");
const { success, error } = require("../utils/response");
const {
  login,
  revokeSessionById,
  revokeAllUserSessions,
  listUserSessions
} = require("../services/auth.service");
const { logAudit } = require("../services/audit.service");
const authRequired = require("../middleware/authRequired");
const database = require("../config/database");


function authV2MfaKeyBuffer() {
  const key = String(
    process.env.MFA_ENCRYPTION_KEY || ""
  );

  if (!/^[a-f0-9]{64}$/i.test(key)) {
    const error = new Error(
      "MFA encryption is not configured."
    );

    error.statusCode = 503;
    throw error;
  }

  return Buffer.from(key, "hex");
}

function authV2EncryptMfaSecret(value) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    authV2MfaKeyBuffer(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);

  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function authV2DecryptMfaSecret(value) {
  const parts = String(value || "").split(".");

  if (parts.length !== 3) {
    throw new Error(
      "Stored MFA secret is not encrypted."
    );
  }

  const [
    ivValue,
    tagValue,
    encryptedValue,
  ] = parts;

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    authV2MfaKeyBuffer(),
    Buffer.from(ivValue, "base64url")
  );

  decipher.setAuthTag(
    Buffer.from(tagValue, "base64url")
  );

  return Buffer.concat([
    decipher.update(
      Buffer.from(
        encryptedValue,
        "base64url"
      )
    ),
    decipher.final(),
  ]).toString("utf8");
}

function authV2RecoveryCode() {
  const value = crypto
    .randomBytes(8)
    .toString("hex")
    .toUpperCase();

  return (
    value.slice(0, 8) +
    "-" +
    value.slice(8)
  );
}

function authV2RecoveryHash(value) {
  return crypto
    .createHmac(
      "sha256",
      authV2MfaKeyBuffer()
    )
    .update(
      String(value || "")
        .replace(/[^A-Za-z0-9]/g, "")
        .toUpperCase()
    )
    .digest("hex");
}


function authV2DbQuery(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  if (database.default && typeof database.default.query === "function") return database.default.query(sql, params);
  throw new Error("Database query function not found");
}

function authV2Hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function authV2PublicFactor(row = {}) {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    status: row.status,
    verifiedAt: row.verified_at || row.verifiedAt || null,
    lastUsedAt: row.last_used_at || row.lastUsedAt || null,
    createdAt: row.created_at || row.createdAt || null,
  };
}

function authV2Token(prefix = "tok") {
  return `${prefix}_${crypto.randomBytes(32).toString("hex")}`;
}

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many password reset attempts. Please try again later."
  }
});



// GOODOS_PUBLIC_SIGNUP_V1

const signupLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message:
      "Too many account creation attempts. Please try again later."
  }
});

const verificationResendLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message:
      "Too many verification requests. Please try again later."
  }
});

function normalizeSignupEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function validSignupEmail(email) {
  return (
    email.length >= 3 &&
    email.length <= 320 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
  );
}

function cleanSignupName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function strongSignupPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 12 &&
    password.length <= 128 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

function signupDatabasePool() {
  if (
    database.pool &&
    typeof database.pool.connect === "function"
  ) {
    return database.pool;
  }

  if (typeof database.getPool === "function") {
    return database.getPool();
  }

  throw new Error(
    "Database connection pool is unavailable."
  );
}

async function createVerificationToken({
  client,
  userId,
  ipAddress,
  userAgent
}) {
  const rawToken = authV2Token("verify");

  const tokenId =
    `verify_${crypto.randomUUID().replace(/-/g, "")}`;

  await client.query(
    `
      UPDATE backend_email_verification_tokens
      SET status = 'revoked',
          updated_at = NOW()
      WHERE user_id = $1::uuid
        AND status = 'active'
    `,
    [userId]
  );

  await client.query(
    `
      INSERT INTO backend_email_verification_tokens (
        id,
        user_id,
        token_hash,
        status,
        requested_ip,
        user_agent,
        expires_at
      )
      VALUES (
        $1,
        $2::uuid,
        $3,
        'active',
        $4,
        $5,
        NOW() + INTERVAL '24 hours'
      )
    `,
    [
      tokenId,
      userId,
      authV2Hash(rawToken),
      ipAddress || null,
      userAgent || null
    ]
  );

  return {
    rawToken,
    tokenId
  };
}


const router = express.Router();

function authCookieOptions() {
  return {
    httpOnly: true,
    secure: env.authCookieSecure,
    sameSite: env.authCookieSameSite,
    domain: env.authCookieDomain,
    path: "/",
    maxAge: env.sessionDays * 24 * 60 * 60 * 1000
  };
}

function clearAuthCookieOptions() {
  return {
    httpOnly: true,
    secure: env.authCookieSecure,
    sameSite: env.authCookieSameSite,
    domain: env.authCookieDomain,
    path: "/"
  };
}

function setAuthCookie(res, token) {
  res.cookie(env.authCookieName, token, authCookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(env.authCookieName, clearAuthCookieOptions());
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    message: "Too many login attempts. Please try again later."
  }
});


router.post(
  "/register",
  signupLimiter,
  async (req, res) => {
    const email =
      normalizeSignupEmail(req.body?.email);

    const firstName =
      cleanSignupName(req.body?.firstName);

    const lastName =
      cleanSignupName(req.body?.lastName);

    const password =
      String(req.body?.password || "");

    const confirmPassword =
      String(req.body?.confirmPassword || "");

    const requestedApp =
      String(req.body?.app || "")
        .trim()
        .toLowerCase();

    const isGoodFleetRegistration =
      requestedApp === "fleet" ||
      requestedApp === "goodfleet";

    const requestedAccountType =
      String(req.body?.accountType || "")
        .trim()
        .toLowerCase();

    const goodFleetRole =
      requestedAccountType === "host"
        ? "host"
        : "customer";

    const phone =
      String(req.body?.phone || "")
        .trim()
        .slice(0, 40);

    const company =
      String(req.body?.company || "")
        .trim()
        .slice(0, 160);

    if (!validSignupEmail(email)) {
      return error(
        res,
        "Enter a valid email address.",
        400
      );
    }

    if (
      firstName.length < 1 ||
      firstName.length > 80 ||
      lastName.length < 1 ||
      lastName.length > 80
    ) {
      return error(
        res,
        "First and last name are required.",
        400
      );
    }

    if (
      !strongSignupPassword(password) ||
      password !== confirmPassword
    ) {
      return error(
        res,
        "Use 12–128 characters with uppercase, lowercase, a number, and a symbol.",
        400
      );
    }

    const pool = signupDatabasePool();
    const client = await pool.connect();

    let user = null;
    let verification = null;

    try {
      await client.query("BEGIN");

      const existingResult = await client.query(
        `
          SELECT
            id,
            email,
            status,
            email_verified
          FROM users
          WHERE lower(email) = lower($1)
          LIMIT 1
          FOR UPDATE
        `,
        [email]
      );

      const existing = existingResult.rows[0];

      if (existing) {
        await client.query("ROLLBACK");

        if (
          !existing.email_verified ||
          existing.status === "pending"
        ) {
          return error(
            res,
            "An account already exists but has not been verified. Use resend verification.",
            409
          );
        }

        return error(
          res,
          "An account already exists for that email address.",
          409
        );
      }

      const passwordHash =
        await bcrypt.hash(password, 12);

      const displayName =
        `${firstName} ${lastName}`.trim();

      const userResult = await client.query(
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
            password_updated_at,
            auth_metadata_json
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            'user',
            'pending',
            false,
            NOW(),
            $6::jsonb
          )
          RETURNING
            id,
            email,
            first_name,
            last_name,
            display_name,
            platform_role,
            status,
            email_verified,
            created_at,
            updated_at
        `,
        [
          email,
          passwordHash,
          firstName,
          lastName,
          displayName,
          JSON.stringify({
            registrationSource:
              isGoodFleetRegistration
                ? "goodfleet_public_signup"
                : "goodos_public_signup",
            registrationApp:
              isGoodFleetRegistration
                ? "goodfleet"
                : "goodos",
            accountType:
              isGoodFleetRegistration
                ? goodFleetRole
                : "member",
            ...(phone ? { phone } : {}),
            ...(company ? { company } : {}),
            registeredAt:
              new Date().toISOString()
          })
        ]
      );

      user = userResult.rows[0];

      await client.query(
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
            $1::uuid,
            'goodos',
            'member',
            'pending',
            'org_goodos',
            'proj_goodos_platform',
            'env_goodos_production'
          WHERE EXISTS (
            SELECT 1
            FROM apps
            WHERE id = 'goodos'
              AND status = 'active'
          )
          ON CONFLICT (user_id, app_id)
          DO UPDATE SET
            role = 'member',
            status = 'pending',
            organization_id =
              EXCLUDED.organization_id,
            project_id =
              EXCLUDED.project_id,
            environment_id =
              EXCLUDED.environment_id,
            updated_at = NOW()
        `,
        [user.id]
      );

      if (isGoodFleetRegistration) {
        await client.query(
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
              $1::uuid,
              'goodfleet',
              $2,
              'pending',
              'org_goodos',
              'proj_goodos_platform',
              'env_goodos_production'
            WHERE EXISTS (
              SELECT 1
              FROM apps
              WHERE id = 'goodfleet'
                AND status = 'active'
            )
            ON CONFLICT (user_id, app_id)
            DO UPDATE SET
              role = EXCLUDED.role,
              status = 'pending',
              organization_id =
                EXCLUDED.organization_id,
              project_id =
                EXCLUDED.project_id,
              environment_id =
                EXCLUDED.environment_id,
              updated_at = NOW()
          `,
          [user.id, goodFleetRole]
        );
      }

      verification =
        await createVerificationToken({
          client,
          userId: user.id,
          ipAddress: req.ip,
          userAgent:
            req.headers["user-agent"] || null
        });

      await client.query("COMMIT");
    } catch (err) {
      await client
        .query("ROLLBACK")
        .catch(() => {});

      if (err.code === "23505") {
        return error(
          res,
          "An account already exists for that email address.",
          409
        );
      }

      console.error(
        "Public registration failed:",
        err
      );

      return error(
        res,
        "The account could not be created.",
        500
      );
    } finally {
      client.release();
    }

    let emailSent = false;

    try {
      await transactionalEmailService
        .sendVerificationEmail({
          to: user.email,
          firstName: user.first_name,
          token: verification.rawToken
        });

      emailSent = true;
    } catch (mailError) {
      console.error(
        "Registration verification email failed:",
        mailError.message
      );
    }

    await logAudit({
      userId: user.id,
      action: "auth.register",
      entityType: "user",
      entityId: user.id,
      ipAddress: req.ip,
      metadata: {
        email: user.email,
        emailSent,
        membershipAppId:
          isGoodFleetRegistration
            ? "goodfleet"
            : "goodos",
        membershipRole:
          isGoodFleetRegistration
            ? goodFleetRole
            : "member",
        userAgent:
          req.headers["user-agent"] || null
      }
    }).catch((auditError) => {
      console.error(
        "Registration audit failed:",
        auditError.message
      );
    });

    return success(
      res,
      {
        message: emailSent
          ? "Account created. Check your email to verify your account."
          : "Account created, but the verification email could not be delivered. Use resend verification.",
        accountCreated: true,
        emailSent,
        email: user.email
      },
      201
    );
  }
);

router.post(
  "/verification/resend",
  verificationResendLimiter,
  async (req, res) => {
    const email =
      normalizeSignupEmail(req.body?.email);

    const genericMessage =
      "If an unverified account exists, a new verification email has been sent.";

    if (!validSignupEmail(email)) {
      return success(res, {
        message: genericMessage
      });
    }

    try {
      const userResult = await authV2DbQuery(
        `
          SELECT
            id,
            email,
            first_name,
            status,
            email_verified
          FROM users
          WHERE lower(email) = lower($1)
          LIMIT 1
        `,
        [email]
      );

      const user = userResult.rows[0];

      if (
        !user ||
        user.email_verified ||
        user.status !== "pending"
      ) {
        return success(res, {
          message: genericMessage
        });
      }

      const pool = signupDatabasePool();
      const client = await pool.connect();

      let verification;

      try {
        await client.query("BEGIN");

        verification =
          await createVerificationToken({
            client,
            userId: user.id,
            ipAddress: req.ip,
            userAgent:
              req.headers["user-agent"] || null
          });

        await client.query("COMMIT");
      } catch (err) {
        await client
          .query("ROLLBACK")
          .catch(() => {});

        throw err;
      } finally {
        client.release();
      }

      await transactionalEmailService
        .sendVerificationEmail({
          to: user.email,
          firstName: user.first_name,
          token: verification.rawToken
        });

      await logAudit({
        userId: user.id,
        action:
          "auth.verification_resent",
        entityType:
          "email_verification",
        entityId:
          verification.tokenId,
        ipAddress: req.ip,
        metadata: {
          email: user.email
        }
      }).catch(() => {});
    } catch (err) {
      console.error(
        "Verification resend failed:",
        err.message
      );
    }

    return success(res, {
      message: genericMessage
    });
  }
);

router.get(
  "/verify-email",
  async (req, res) => {
    const token =
      String(req.query?.token || "").trim();

    if (
      token.length < 20 ||
      token.length > 200
    ) {
      return error(
        res,
        "This verification link is invalid or has expired.",
        400
      );
    }

    const pool = signupDatabasePool();
    const client = await pool.connect();

    let verifiedUser = null;
    let verificationId = null;

    try {
      await client.query("BEGIN");

      const tokenResult = await client.query(
        `
          SELECT
            token.id,
            token.user_id,
            user_record.email,
            user_record.email_verified,
            user_record.status
          FROM backend_email_verification_tokens
            AS token
          JOIN users AS user_record
            ON user_record.id = token.user_id
          WHERE token.token_hash = $1
            AND token.status = 'active'
            AND token.used_at IS NULL
            AND token.expires_at > NOW()
          LIMIT 1
          FOR UPDATE OF token, user_record
        `,
        [authV2Hash(token)]
      );

      const verification =
        tokenResult.rows[0];

      if (!verification) {
        await client.query("ROLLBACK");

        return error(
          res,
          "This verification link is invalid or has expired.",
          400
        );
      }

      verificationId = verification.id;

      const userResult = await client.query(
        `
          UPDATE users
          SET
            email_verified = true,
            status = 'active',
            updated_at = NOW()
          WHERE id = $1::uuid
          RETURNING
            id,
            email,
            first_name,
            last_name,
            display_name,
            platform_role,
            status,
            email_verified,
            created_at,
            updated_at
        `,
        [verification.user_id]
      );

      verifiedUser = userResult.rows[0];

      await client.query(
        `
          UPDATE app_memberships
          SET
            status = 'active',
            updated_at = NOW()
          WHERE user_id = $1::uuid
            AND app_id IN ('goodos', 'goodfleet')
            AND status = 'pending'
        `,
        [verification.user_id]
      );

      await client.query(
        `
          UPDATE backend_email_verification_tokens
          SET
            status = 'used',
            used_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
        `,
        [verification.id]
      );

      await client.query(
        `
          UPDATE backend_email_verification_tokens
          SET
            status = 'revoked',
            updated_at = NOW()
          WHERE user_id = $1::uuid
            AND id <> $2
            AND status = 'active'
        `,
        [
          verification.user_id,
          verification.id
        ]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client
        .query("ROLLBACK")
        .catch(() => {});

      console.error(
        "Email verification failed:",
        err
      );

      return error(
        res,
        "The email address could not be verified.",
        500
      );
    } finally {
      client.release();
    }

    await logAudit({
      userId: verifiedUser.id,
      action: "auth.email_verified",
      entityType:
        "email_verification",
      entityId: verificationId,
      ipAddress: req.ip,
      metadata: {
        email: verifiedUser.email
      }
    }).catch(() => {});

    return success(res, {
      message:
        "Your email has been verified. You can now sign in.",
      user: {
        id: verifiedUser.id,
        email: verifiedUser.email,
        firstName:
          verifiedUser.first_name,
        lastName:
          verifiedUser.last_name,
        displayName:
          verifiedUser.display_name,
        platformRole:
          verifiedUser.platform_role,
        status: verifiedUser.status,
        emailVerified:
          verifiedUser.email_verified,
        createdAt:
          verifiedUser.created_at,
        updatedAt:
          verifiedUser.updated_at
      }
    });
  }
);


router.post("/login", loginLimiter, async (req, res) => {
  try {
    const result = await login({
      email: req.body.email,
      password: req.body.password,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"]
    });

    setAuthCookie(res, result.token);

    await logAudit({
      userId: result.user.id,
      action: "auth.login",
      entityType: "session",
      entityId: result.session.id,
      ipAddress: req.ip,
      metadata: {
        email: result.user.email,
        userAgent: req.headers["user-agent"] || null,
        authCookie: true
      }
    });

    const mfaRequired =
      Boolean(
        result.user.mfaRequired
      );

    const mfaEnabled =
      Boolean(
        result.user.mfaEnabled
      );

    return success(res, {
      message:
        mfaRequired
          ? "Password verified. Complete MFA to continue."
          : "Login successful",
      token: result.token,
      session: result.session,
      user: result.user,
      apps:
        mfaRequired
          ? []
          : result.apps,
      mfa: {
        required:
          mfaRequired,
        enabled:
          mfaEnabled,
        verified:
          Boolean(
            result.session
              .mfaVerified
          ),
        nextAction:
          mfaRequired
            ? (
                mfaEnabled
                  ? "verify_mfa"
                  : "enroll_mfa"
              )
            : null,
        enrollmentUrl:
          "https://base.goodos.app/mfa-enroll"
      }
    });
  } catch (err) {
    console.error("Login failed:", err.message);

    await logAudit({
      userId: null,
      action: "auth.login_failed",
      entityType: "auth",
      entityId: null,
      ipAddress: req.ip,
      metadata: {
        email: req.body.email || null,
        reason: err.message || "Login failed",
        userAgent: req.headers["user-agent"] || null
      }
    }).catch((auditErr) => {
      console.error("Failed login audit failed:", auditErr.message);
    });

    return error(res, err.message || "Login failed", err.statusCode || 500);
  }
});

router.get("/me", authRequired, async (req, res) => {
  return success(res, {
    user: req.user,
    apps: req.apps,
    authSource: req.auth.source
  });
});

router.get("/authorize/:appId", authRequired, async (req, res) => {
  const requestedAppId = String(req.params.appId || "").trim().toLowerCase();
  const membership = (req.apps || []).find((app) =>
    String(app.id || "").trim().toLowerCase() === requestedAppId
  );
  const authorized = Boolean(
    membership &&
    String(membership.appStatus || "").toLowerCase() === "active" &&
    String(membership.membershipStatus || "").toLowerCase() === "active"
  );

  await logAudit({
    userId: req.user.id,
    action: authorized ? "auth.app_access_granted" : "auth.app_access_denied",
    entityType: "application",
    entityId: requestedAppId || null,
    ipAddress: req.ip,
    metadata: {
      role: membership?.role || null,
      authSource: req.auth.source
    }
  }).catch(() => {});

  if (!authorized) {
    return error(res, "Your GoodOS account does not have access to this application.", 403, {
      code: "APPLICATION_ACCESS_DENIED",
      appId: requestedAppId
    });
  }

  return success(res, {
    authorized: true,
    app: membership
  });
});

router.get("/sessions", authRequired, async (req, res) => {
  try {
    const sessions = await listUserSessions(req.user.id);

    return success(res, {
      count: sessions.length,
      sessions
    });
  } catch (err) {
    console.error("Session list failed:", err);
    return error(res, "Failed to load sessions", 500);
  }
});

router.post("/logout", authRequired, async (req, res) => {
  try {
    const revokedSession = await revokeSessionById(req.auth.sessionId);
    clearAuthCookie(res);

    await logAudit({
      userId: req.user.id,
      action: "auth.logout",
      entityType: "session",
      entityId: req.auth.sessionId,
      ipAddress: req.ip,
      metadata: {
        revoked: Boolean(revokedSession),
        authSource: req.auth.source
      }
    });

    return success(res, {
      message: "Logout successful",
      revoked: Boolean(revokedSession)
    });
  } catch (err) {
    console.error("Logout failed:", err);
    return error(res, "Logout failed", 500);
  }
});

router.post("/logout-all", authRequired, async (req, res) => {
  try {
    const revokedSessions = await revokeAllUserSessions(req.user.id);
    clearAuthCookie(res);

    await logAudit({
      userId: req.user.id,
      action: "auth.logout_all",
      entityType: "user",
      entityId: req.user.id,
      ipAddress: req.ip,
      metadata: {
        revokedSessions: revokedSessions.length,
        authSource: req.auth.source
      }
    });

    return success(res, {
      message: "All sessions logged out",
      revokedSessions: revokedSessions.length
    });
  } catch (err) {
    console.error("Logout all failed:", err);
    return error(res, "Logout all failed", 500);
  }
});


router.get("/session", authRequired, async (req, res) => {
  try {
    const sessionResult = await authV2DbQuery(
      `
        SELECT
          id,
          user_id AS "userId",
          ip_address AS "ipAddress",
          user_agent AS "userAgent",
          auth_level AS "authLevel",
          mfa_verified AS "mfaVerified",
          risk_score AS "riskScore",
          device_label AS "deviceLabel",
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          revoked_at AS "revokedAt",
          last_seen_at AS "lastSeenAt"
        FROM sessions
        WHERE id = $1
        LIMIT 1
      `,
      [req.auth.sessionId]
    );

    const rolesResult = await authV2DbQuery(
      `
        SELECT role_name AS "roleName", scope_type AS "scopeType", scope_id AS "scopeId", status
        FROM backend_user_roles
        WHERE user_id = $1::uuid
        ORDER BY assigned_at DESC
      `,
      [req.user.id]
    );

    const factorsResult = await authV2DbQuery(
      `
        SELECT id, type, label, status, verified_at, last_used_at, created_at
        FROM backend_mfa_factors
        WHERE user_id = $1::uuid
        ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    await authV2DbQuery(
      "UPDATE sessions SET last_seen_at = NOW() WHERE id = $1",
      [req.auth.sessionId]
    ).catch(() => null);

    return success(res, {
      user: req.user,
      session: sessionResult.rows[0] || null,
      roles: rolesResult.rows,
      mfa: {
        enabled:
          factorsResult.rows.some(
            factor =>
              factor.status ===
              "active"
          ),
        required:
          Boolean(
            req.user.mfaRequired
          ),
        sessionVerified:
          Boolean(
            sessionResult
              .rows[0]
              ?.mfaVerified
          ),
        nextAction:
          req.user.mfaRequired
            ? (
                factorsResult.rows.some(
                  factor =>
                    factor.status ===
                    "active"
                )
                  ? (
                      sessionResult
                        .rows[0]
                        ?.mfaVerified
                        ? null
                        : "verify_mfa"
                    )
                  : "enroll_mfa"
              )
            : null,
        enrollmentUrl:
          "https://base.goodos.app/mfa-enroll",
        factors:
          factorsResult.rows.map(
            authV2PublicFactor
          ),
      },
      authSource: req.auth.source,
    });
  } catch (err) {
    console.error("Auth V2 session failed:", err);
    return error(res, "Failed to load auth session", 500);
  }
});

router.get("/roles", authRequired, async (req, res) => {
  try {
    const rolesResult = await authV2DbQuery(`
      SELECT id, name, display_name AS "displayName", description, level, status
      FROM backend_roles
      WHERE status = 'active'
      ORDER BY level ASC
    `);

    const userRolesResult = await authV2DbQuery(
      `
        SELECT role_id AS "roleId", role_name AS "roleName", scope_type AS "scopeType", scope_id AS "scopeId", status
        FROM backend_user_roles
        WHERE user_id = $1::uuid
        ORDER BY assigned_at DESC
      `,
      [req.user.id]
    );

    return success(res, {
      roles: rolesResult.rows,
      userRoles: userRolesResult.rows,
    });
  } catch (err) {
    console.error("Auth V2 roles failed:", err);
    return error(res, "Failed to load roles", 500);
  }
});

router.post("/mfa/setup", authRequired, async (req, res) => {
  try {
    const label = String(req.body?.label || "Authenticator App").trim().slice(0, 80) || "Authenticator App";
    const secret = speakeasy.generateSecret({
      length: 20,
      name: `GoodOS (${req.user.email})`,
      issuer: "GoodOS",
    });

    const factorId = `mfa_${crypto.randomUUID().replace(/-/g, "")}`;
    const secretHash = authV2Hash(secret.base32);
    const recoveryCodes = Array.from(
      { length: 10 },
      authV2RecoveryCode
    );
    const otpauthUrl = secret.otpauth_url;
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl);

    await authV2DbQuery(
      `
        INSERT INTO backend_mfa_factors (
          id,
          user_id,
          type,
          label,
          status,
          secret_hash,
          secret_prefix,
          secret_encrypted,
          recovery_codes_hash,
          metadata_json,
          organization_id,
          project_id,
          environment_id
        )
        VALUES ($1,$2::uuid,'totp',$3,'pending',$4,$5,$6,$7::jsonb,$8::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production')
      `,
      [
        factorId,
        req.user.id,
        label,
        secretHash,
        secret.base32.slice(0, 6),
        authV2EncryptMfaSecret(
          secret.base32
        ),
        JSON.stringify(
          recoveryCodes.map(
            authV2RecoveryHash
          )
        ),
        JSON.stringify({
          createdFrom: "Auth V2 setup",
          encryptedAtRest: true,
          recoveryCodesReturnedOnce: true,
        }),
      ]
    );

    await authV2DbQuery(
      `
        INSERT INTO backend_auth_audit_events (
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
        VALUES ($1,$2::uuid,'auth.mfa.setup_started','recorded',$3,$4,$5::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production')
      `,
      [
        `authevt_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user.id,
        req.ip,
        req.headers["user-agent"] || null,
        JSON.stringify({ factorId, label }),
      ]
    );

    return success(res, {
      factorId,
      label,
      type: "totp",
      secret: secret.base32,
      otpauthUrl,
      qrDataUrl,
      recoveryCodes,
      warning:
        "Recovery codes are displayed only during setup.",
      message:
        "Scan the QR code, save the recovery codes, then verify a TOTP code to activate MFA.",
    });
  } catch (err) {
    console.error("MFA setup failed:", err);
    return error(res, "Failed to start MFA setup", 500);
  }
});

router.post("/mfa/verify", authRequired, async (req, res) => {
  try {
    const factorId = String(req.body?.factorId || req.body?.factor_id || "").trim();
    const token = String(req.body?.token || "").replace(/\s+/g, "");
    const requireOnLogin =
      req.body?.requireOnLogin === true ||
      req.body?.require_on_login === true ||
      req.body?.mfaRequired === true ||
      req.body?.mfa_required === true;

    if (!factorId || !token) {
      return error(res, "factorId and token are required", 400);
    }

    const factorResult = await authV2DbQuery(
      `
        SELECT *
        FROM backend_mfa_factors
        WHERE id = $1
          AND user_id = $2::uuid
          AND status IN ('pending','active')
        LIMIT 1
      `,
      [factorId, req.user.id]
    );

    const factor = factorResult.rows[0];

    if (!factor) {
      return error(res, "MFA factor not found", 404);
    }

    const verified = speakeasy.totp.verify({
      secret: authV2DecryptMfaSecret(
        factor.secret_encrypted
      ),
      encoding: "base32",
      token,
      window: 1,
    });

    const challengeId = `mfach_${crypto.randomUUID().replace(/-/g, "")}`;

    await authV2DbQuery(
      `
        INSERT INTO backend_mfa_challenges (
          id,
          user_id,
          factor_id,
          challenge_type,
          status,
          attempts,
          ip_address,
          user_agent,
          verified_at,
          metadata_json,
          organization_id,
          project_id,
          environment_id
        )
        VALUES ($1,$2::uuid,$3,'totp',$4,1,$5,$6,CASE WHEN $4 = 'verified' THEN NOW() ELSE NULL END,$7::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production')
      `,
      [
        challengeId,
        req.user.id,
        factorId,
        verified ? "verified" : "failed",
        req.ip,
        req.headers["user-agent"] || null,
        JSON.stringify({ factorId }),
      ]
    );

    if (!verified) {
      return error(res, "Invalid MFA code", 400);
    }

    await authV2DbQuery(
      `
        UPDATE backend_mfa_factors
        SET status = 'active',
            verified_at = COALESCE(verified_at, NOW()),
            last_used_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [factorId]
    );

    await authV2DbQuery(
      `
        UPDATE users
        SET mfa_enabled = true,
            mfa_required = $2,
            auth_metadata_json =
              COALESCE(auth_metadata_json, '{}'::jsonb) ||
              jsonb_build_object(
                'mfa',
                'enabled',
                'mfaRequired',
                $2,
                'mfaPreferenceSource',
                CASE WHEN $2 THEN 'user_selection' ELSE 'optional_enrollment' END
              ),
            updated_at = NOW()
        WHERE id = $1::uuid
      `,
      [
        req.user.id,
        requireOnLogin,
      ]
    );

    await authV2DbQuery(
      "UPDATE sessions SET mfa_verified = true, auth_level = 'mfa', last_seen_at = NOW() WHERE id = $1",
      [req.auth.sessionId]
    );

    await authV2DbQuery(
      `
        UPDATE sessions
        SET revoked_at = NOW(),
            metadata_json =
              COALESCE(
                metadata_json,
                '{}'::jsonb
              ) ||
              jsonb_build_object(
                'revokedBy',
                'mfa_enrollment',
                'keptSessionId',
                $2::text
              )
        WHERE user_id = $1::uuid
          AND id <> $2::uuid
          AND revoked_at IS NULL
      `,
      [
        req.user.id,
        req.auth.sessionId,
      ]
    );

    return success(res, {
      verified: true,
      factorId,
      required:
        requireOnLogin,
      message:
        requireOnLogin
          ? "MFA factor verified and will be required at sign-in."
          : "MFA factor verified. MFA remains optional until you require it.",
    });
  } catch (err) {
    console.error("MFA verify failed:", err);
    return error(res, "Failed to verify MFA", 500);
  }
});

router.post("/mfa/disable", authRequired, async (req, res) => {
  try {
    const factorId = String(
      req.body?.factorId ||
      req.body?.factor_id ||
      ""
    ).trim();

    const token = String(
      req.body?.token || ""
    ).replace(/\s+/g, "");

    if (!token) {
      return error(
        res,
        "A current authenticator code is required.",
        400
      );
    }

    const userResult = await authV2DbQuery(
      `
        SELECT mfa_required
        FROM users
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [req.user.id]
    );

    if (
      userResult.rows[0]?.mfa_required
    ) {
      return error(
        res,
        "MFA is required for this account and cannot be disabled.",
        409
      );
    }

    const factorResult = await authV2DbQuery(
      `
        SELECT
          id,
          secret_encrypted
        FROM backend_mfa_factors
        WHERE user_id = $1::uuid
          AND status = 'active'
          AND (
            $2::text = ''
            OR id = $2
          )
        ORDER BY verified_at DESC
        LIMIT 1
      `,
      [
        req.user.id,
        factorId,
      ]
    );

    const factor =
      factorResult.rows[0];

    if (!factor) {
      return error(
        res,
        "Active MFA factor was not found.",
        404
      );
    }

    const verified =
      speakeasy.totp.verify({
        secret:
          authV2DecryptMfaSecret(
            factor.secret_encrypted
          ),
        encoding: "base32",
        token,
        window: 1,
      });

    if (!verified) {
      return error(
        res,
        "Invalid MFA code.",
        401
      );
    }

    await authV2DbQuery(
      `
        UPDATE backend_mfa_factors
        SET status = 'disabled',
            updated_at = NOW()
        WHERE id = $1
          AND user_id = $2::uuid
      `,
      [
        factor.id,
        req.user.id,
      ]
    );

    const activeResult =
      await authV2DbQuery(
        `
          SELECT COUNT(*)::int AS count
          FROM backend_mfa_factors
          WHERE user_id = $1::uuid
            AND status = 'active'
        `,
        [req.user.id]
      );

    const enabled =
      Number(
        activeResult.rows[0]?.count || 0
      ) > 0;

    await authV2DbQuery(
      `
        UPDATE users
        SET mfa_enabled = $2,
            updated_at = NOW()
        WHERE id = $1::uuid
      `,
      [
        req.user.id,
        enabled,
      ]
    );

    if (!enabled) {
      await authV2DbQuery(
        `
          UPDATE sessions
          SET mfa_verified = false,
              auth_level = 'password',
              last_seen_at = NOW()
          WHERE id = $1::uuid
        `,
        [req.auth.sessionId]
      );
    }

    await logAudit({
      userId: req.user.id,
      action: "auth.mfa.disabled",
      entityType: "mfa_factor",
      entityId: factor.id,
      ipAddress: req.ip,
      metadata: {
        remainingActiveFactors:
          Number(
            activeResult.rows[0]?.count || 0
          ),
      },
    });

    return success(res, {
      enabled,
      message:
        enabled
          ? "MFA factor disabled."
          : "MFA disabled for user.",
    });
  } catch (err) {
    console.error(
      "MFA disable failed:",
      err
    );

    return error(
      res,
      err.message ||
        "Failed to disable MFA",
      err.statusCode || 500
    );
  }
});

router.post("/password-reset/request", passwordResetLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const requestedReturnTo = String(req.body?.returnTo || "").trim();
    let resetReturnTo = "https://base.goodos.app/password-reset";

    if (requestedReturnTo) {
      try {
        const parsed = new URL(requestedReturnTo);
        const allowedHost =
          parsed.hostname === "goodos.app" ||
          parsed.hostname.endsWith(".goodos.app");

        if (
          parsed.protocol === "https:" &&
          allowedHost &&
          !parsed.username &&
          !parsed.password &&
          !parsed.port
        ) {
          parsed.search = "";
          parsed.hash = "";
          resetReturnTo =
            parsed.toString().replace(/\/+$/, "");
        }
      } catch {
        // Invalid return targets fall back to the canonical GoodBase page.
      }
    }

    if (!email || !email.includes("@")) {
      return error(res, "Valid email is required", 400);
    }

    const userResult = await authV2DbQuery(
      "SELECT id, email, status FROM users WHERE lower(email) = lower($1) LIMIT 1",
      [email]
    );

    const user = userResult.rows[0];

    if (user && user.status === "active") {
      const rawToken = authV2Token("reset");
      const tokenId = `reset_${crypto.randomUUID().replace(/-/g, "")}`;

      await authV2DbQuery(
        `
          INSERT INTO backend_password_reset_tokens (
            id,
            user_id,
            token_hash,
            requested_by,
            ip_address,
            user_agent,
            expires_at,
            metadata_json,
            organization_id,
            project_id,
            environment_id
          )
          VALUES ($1,$2::uuid,$3,'self_service',$4,$5,NOW() + INTERVAL '1 hour',$6::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production')
        `,
        [
          tokenId,
          user.id,
          authV2Hash(rawToken),
          req.ip,
          req.headers["user-agent"] || null,
          JSON.stringify({ route: "/api/auth/password-reset/request", rawTokenShown: false }),
        ]
      );

      await notificationService.createNotification({
        templateKey: "auth.password_reset",
        title: "Reset your GoodOS password",
        message: "A password reset was requested for your GoodOS account.",
        category: "auth",
        severity: "info",
        channel: "email",
        recipientUserId: user.id,
        recipientEmail: user.email,
        source: "auth.password-reset",
        sourceId: tokenId,
        queueEmail: true,
        variables: {
          email: user.email,
          resetUrl: `${resetReturnTo}?reset_token=${encodeURIComponent(rawToken)}`
        },
        payload: {
          resetTokenId: tokenId
        }
      }).catch((notificationError) => {
        console.warn("Password reset notification queue failed:", notificationError.message);
      });
    }

    return success(res, {
      message: "If an active account exists, a password reset token has been created.",
    });
  } catch (err) {
    console.error("Password reset request failed:", err);
    return error(res, "Failed to request password reset", 500);
  }
});

router.post("/password-reset/complete", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const password = String(req.body?.password || "");

    if (!token || !strongSignupPassword(password)) {
      return error(res, "Token and a password using 12–128 characters with uppercase, lowercase, a number, and a symbol are required", 400);
    }

    const tokenHash = authV2Hash(token);

    const resetResult = await authV2DbQuery(
      `
        SELECT *
        FROM backend_password_reset_tokens
        WHERE token_hash = $1
          AND status = 'active'
          AND used_at IS NULL
          AND expires_at > NOW()
        LIMIT 1
      `,
      [tokenHash]
    );

    const reset = resetResult.rows[0];

    if (!reset) {
      return error(res, "Invalid or expired reset token", 400);
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await authV2DbQuery(
      `
        UPDATE users
        SET password_hash = $2,
            failed_login_count = 0,
            locked_until = NULL,
            password_updated_at = NOW(),
            last_password_reset_at = NOW(),
            updated_at = NOW()
        WHERE id = $1::uuid
      `,
      [reset.user_id, passwordHash]
    );

    await authV2DbQuery(
      "UPDATE backend_password_reset_tokens SET status = 'used', used_at = NOW(), updated_at = NOW() WHERE id = $1",
      [reset.id]
    );

    await authV2DbQuery(
      "UPDATE sessions SET revoked_at = NOW(), metadata_json = COALESCE(metadata_json, '{}'::jsonb) || '{\"revokedBy\":\"password_reset\"}'::jsonb WHERE user_id = $1::uuid AND revoked_at IS NULL",
      [reset.user_id]
    );

    return success(res, {
      message: "Password reset complete. Please log in again.",
    });
  } catch (err) {
    console.error("Password reset complete failed:", err);
    return error(res, "Failed to complete password reset", 500);
  }
});


module.exports = router;
