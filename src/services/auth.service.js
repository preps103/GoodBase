const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const env = require("../config/env");
const { query } = require("../config/database");
const {
  ensureCorporateAppAccess,
  isCorporateMailbox,
  synchronizeCorporateIdentity
} = require("./corporate-mail-identity.service");
const {
  profileAvatarUrl
} = require("../utils/managedAssetUrl");

function publicUser(row) {
  if (!row) return null;

  const authMetadata = typeof row.auth_metadata_json === "string"
    ? JSON.parse(row.auth_metadata_json || "{}")
    : (row.auth_metadata_json || {});
  const anonymous = authMetadata.anonymous === true;

  return {
    id: row.id,
    email: anonymous ? null : row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    avatarUrl: profileAvatarUrl(row),
    avatarUpdatedAt:
      row.avatar_updated_at || null,
    platformRole: row.platform_role,
    status: row.status,
    emailVerified: anonymous ? false : row.email_verified,
    mfaEnabled: Boolean(row.mfa_enabled),
    mfaRequired: Boolean(row.mfa_required),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function getUserByEmail(email) {
  const result = await query(
    `
    SELECT *
    FROM users
    WHERE LOWER(email) = LOWER($1)
    LIMIT 1
    `,
    [email]
  );

  return result.rows[0] || null;
}

async function getUserById(userId) {
  const result = await query(
    `
    SELECT *
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
}

async function getUserApps(userId) {
  const result = await query(
    `
    SELECT
      a.id,
      a.name,
      a.domain,
      a.status AS "appStatus",
      a.description,
      am.role,
      am.status AS "membershipStatus"
    FROM app_memberships am
    JOIN apps a ON a.id = am.app_id
    WHERE am.user_id = $1
    ORDER BY a.name ASC
    `,
    [userId]
  );

  return result.rows;
}

async function createSession({ userId, token, ipAddress, userAgent }) {
  const tokenHash = hashToken(token);

  const result = await query(
    `
    INSERT INTO sessions (
      user_id,
      token_hash,
      ip_address,
      user_agent,
      expires_at
    )
    VALUES (
      $1,
      $2,
      NULLIF($3, '')::inet,
      $4,
      NOW() + ($5 || ' days')::interval
    )
    RETURNING
      id,
      expires_at,
      auth_level,
      mfa_verified;
    `,
    [userId, tokenHash, ipAddress || null, userAgent || null, env.sessionDays]
  );

  return result.rows[0];
}

async function issueSessionForUser({ user, ipAddress, userAgent, authMethod = "password" }) {
  if (!user || user.status !== "active" || !user.email_verified) {
    const err = new Error("Account is not eligible for sign in.");
    err.statusCode = 403;
    throw err;
  }

  const authMetadata = typeof user.auth_metadata_json === "string"
    ? JSON.parse(user.auth_metadata_json || "{}")
    : (user.auth_metadata_json || {});
  const token = jwt.sign(
    {
      sub: user.id,
      email: authMetadata.anonymous === true ? null : user.email,
      platformRole: user.platform_role,
      authMethod
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
  const session = await createSession({ userId: user.id, token, ipAddress, userAgent });
  await query(`UPDATE sessions SET auth_level=$2 WHERE id=$1`, [session.id, authMethod]);
  await query(`UPDATE users SET last_login_at=NOW() WHERE id=$1`, [user.id]);

  return {
    token,
    session: {
      id: session.id,
      expiresAt: session.expires_at,
      authLevel: authMethod,
      mfaVerified: session.mfa_verified
    },
    user: publicUser(user),
    apps: await getUserApps(user.id)
  };
}

async function validateSessionToken(token) {
  const tokenHash = hashToken(token);

  const result = await query(
    `
    SELECT
      s.id AS session_id,
      s.expires_at,
      s.auth_level
        AS session_auth_level,
      s.mfa_verified
        AS session_mfa_verified,
      s.risk_score
        AS session_risk_score,
      u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1
      AND s.revoked_at IS NULL
      AND s.expires_at > NOW()
      AND u.status = 'active'
    LIMIT 1
    `,
    [tokenHash]
  );

  return result.rows[0] || null;
}

async function revokeSessionById(sessionId) {
  const result = await query(
    `
    UPDATE sessions
    SET revoked_at = NOW()
    WHERE id = $1
      AND revoked_at IS NULL
    RETURNING id, user_id, revoked_at;
    `,
    [sessionId]
  );

  return result.rows[0] || null;
}

async function revokeAllUserSessions(userId) {
  const result = await query(
    `
    UPDATE sessions
    SET revoked_at = NOW()
    WHERE user_id = $1
      AND revoked_at IS NULL
    RETURNING id, revoked_at;
    `,
    [userId]
  );

  return result.rows;
}

async function listUserSessions(userId) {
  const result = await query(
    `
    SELECT
      id,
      ip_address::text AS "ipAddress",
      user_agent AS "userAgent",
      expires_at AS "expiresAt",
      revoked_at AS "revokedAt",
      created_at AS "createdAt",
      CASE
        WHEN revoked_at IS NOT NULL THEN 'revoked'
        WHEN expires_at <= NOW() THEN 'expired'
        ELSE 'active'
      END AS status
    FROM sessions
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 25;
    `,
    [userId]
  );

  return result.rows;
}

async function login({ email, password, ipAddress, userAgent }) {
  if (!email || !password) {
    const err = new Error("Email and password are required.");
    err.statusCode = 400;
    throw err;
  }

  let user = await getUserByEmail(email);

  if (user && !user.email_verified) {
    const err = new Error(
      "Verify your email before signing in."
    );
    err.statusCode = 403;
    throw err;
  }

  if (user && user.status !== "active") {
    const err = new Error("Account is not active.");
    err.statusCode = 403;
    throw err;
  }

  let passwordMatches = Boolean(
    user?.password_hash &&
    await bcrypt.compare(password, user.password_hash)
  );

  if (!passwordMatches) {
    const synchronizedUser =
      await synchronizeCorporateIdentity({
        email,
        password,
        user,
      });

    if (synchronizedUser) {
      user = synchronizedUser;
      passwordMatches = true;
    }
  }

  if (!user || !passwordMatches) {
    const err = new Error("Invalid email or password.");
    err.statusCode = 401;
    throw err;
  }

  if (isCorporateMailbox(email)) {
    await ensureCorporateAppAccess(email, user.id);
  }

  return issueSessionForUser({ user, ipAddress, userAgent, authMethod: "password" });
}

module.exports = {
  login,
  getUserById,
  getUserApps,
  validateSessionToken,
  revokeSessionById,
  revokeAllUserSessions,
  listUserSessions,
  getUserByEmail,
  issueSessionForUser,
  publicUser
};
