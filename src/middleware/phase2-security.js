"use strict";

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const {
  rateLimit
} = require("express-rate-limit");

const database =
  require("../security/phase2-db");

const configuredOrigins = String(
  process.env.PHASE2_ALLOWED_ORIGINS || ""
)
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

const exactOrigins = new Set(
  configuredOrigins
);

function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }

  if (exactOrigins.has(origin)) {
    return true;
  }

  if (
    /^https:\/\/([a-z0-9-]+\.)*goodos\.app$/i.test(
      origin
    )
  ) {
    return true;
  }

  if (
    process.env.NODE_ENV !== "production" &&
    /^https?:\/\/localhost(?::\d+)?$/i.test(origin)
  ) {
    return true;
  }

  return false;
}

function audit({
  userId = null,
  action,
  entityType = "security",
  entityId = null,
  metadata = {}
}) {
  database.query(
    `
      INSERT INTO audit_logs (
        user_id,
        action,
        entity_type,
        entity_id,
        metadata
      )
      VALUES ($1,$2,$3,$4,$5::jsonb)
    `,
    [
      userId,
      action,
      entityType,
      entityId,
      JSON.stringify(metadata)
    ]
  ).catch(() => {});
}

function originGate(req, res, next) {
  const origin = String(
    req.headers.origin || ""
  );

  if (isAllowedOrigin(origin)) {
    return next();
  }

  audit({
    action: "security.cors.denied",
    metadata: {
      origin,
      method: req.method,
      path: req.originalUrl
    }
  });

  return res.status(403).json({
    success: false,
    code: "ORIGIN_NOT_ALLOWED",
    message: "Request origin is not allowed."
  });
}

function securityHeaders(req, res, next) {
  res.removeHeader("X-Powered-By");

  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  );

  res.setHeader(
    "X-Permitted-Cross-Domain-Policies",
    "none"
  );

  if (
    req.originalUrl.startsWith("/api/auth") ||
    req.originalUrl.startsWith("/api/security")
  ) {
    res.setHeader(
      "Cache-Control",
      "no-store, max-age=0"
    );

    res.setHeader("Pragma", "no-cache");
  }

  return next();
}

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: req =>
    req.method === "OPTIONS" ||
    req.originalUrl.startsWith("/health") ||
    req.originalUrl.startsWith(
      "/api/enterprise/ready"
    ),
  handler: (req, res) => {
    audit({
      action: "security.rate_limit.global",
      metadata: {
        method: req.method,
        path: req.originalUrl
      }
    });

    return res.status(429).json({
      success: false,
      code: "RATE_LIMITED",
      message:
        "Too many requests. Try again later."
    });
  }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    audit({
      action:
        "security.rate_limit.authentication",
      metadata: {
        method: req.method,
        path: req.originalUrl
      }
    });

    return res.status(429).json({
      success: false,
      code: "AUTH_RATE_LIMITED",
      message:
        "Too many authentication attempts. Try again later."
    });
  }
});

function parseCookies(header) {
  const cookies = {};

  String(header || "")
    .split(";")
    .forEach(part => {
      const separator = part.indexOf("=");

      if (separator < 1) {
        return;
      }

      const key =
        part.slice(0, separator).trim();

      const value =
        part.slice(separator + 1).trim();

      try {
        cookies[key] =
          decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    });

  return cookies;
}

function extractToken(req) {
  const authorization = String(
    req.headers.authorization || ""
  );

  if (/^Bearer\s+/i.test(authorization)) {
    return authorization
      .replace(/^Bearer\s+/i, "")
      .trim();
  }

  const cookies =
    parseCookies(req.headers.cookie);

  const names = [
    process.env.AUTH_COOKIE_NAME,
    "goodos_session",
    "token",
    "session"
  ].filter(Boolean);

  for (const name of names) {
    if (cookies[name]) {
      return cookies[name];
    }
  }

  return null;
}

async function resolveAuthentication(req) {
  const token = extractToken(req);

  if (!token || !process.env.JWT_SECRET) {
    return null;
  }

  let decoded;

  try {
    decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );
  } catch {
    return null;
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const sessionId = String(
    decoded.sessionId ||
    decoded.session_id ||
    decoded.sid ||
    ""
  );

  const result = await database.query(
    `
      SELECT
        s.id AS session_id,
        s.user_id,
        s.mfa_verified,
        s.auth_level,
        s.risk_score,
        u.email,
        u.display_name,
        u.platform_role,
        u.mfa_enabled,
        u.mfa_required
      FROM sessions s
      JOIN users u
        ON u.id = s.user_id
      WHERE (
          s.token_hash = $1
          OR s.id::text = NULLIF($2, '')
        )
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND u.status = 'active'
      ORDER BY s.created_at DESC
      LIMIT 1
    `,
    [
      tokenHash,
      sessionId
    ]
  );

  if (!result.rows.length) {
    return null;
  }

  const authentication =
    result.rows[0];

  database.query(
    `
      UPDATE sessions
      SET last_seen_at = NOW()
      WHERE id = $1
    `,
    [authentication.session_id]
  ).catch(() => {});

  return authentication;
}


function phase2MfaCompletionPath(req) {
  const pathname = String(
    req.originalUrl ||
    req.url ||
    ""
  ).split("?")[0];

  return [
    /^\/api\/security\/health\/?$/i,
    /^\/api\/security\/mfa\/setup\/?$/i,
    /^\/api\/security\/mfa\/verify\/?$/i,
    /^\/api\/security\/mfa\/verify-session\/?$/i,
    /^\/api\/security\/mfa\/recovery\/?$/i,
  ].some(
    pattern => pattern.test(pathname)
  );
}

function phase2MfaStepUpResponse(
  req,
  res,
  authentication
) {
  const enabled =
    Boolean(
      authentication.mfa_enabled
    );

  return res.status(428).json({
    success: false,
    code:
      "MFA_VERIFICATION_REQUIRED",
    message:
      enabled
        ? "Verify MFA before continuing."
        : "Enroll in MFA before continuing.",
    mfaRequired: true,
    mfaEnabled: enabled,
    mfaVerified: false,
    authLevel:
      authentication.auth_level ||
      "password",
    nextAction:
      enabled
        ? "verify_mfa"
        : "enroll_mfa",
    enrollmentUrl:
      "https://base.goodos.app/mfa-enroll",
    requestedPath:
      String(
        req.originalUrl ||
        req.url ||
        ""
      ).split("?")[0],
  });
}


async function authenticateRequest(
  req,
  res,
  next
) {
  try {
    const authentication =
      await resolveAuthentication(req);

    if (!authentication) {
      return res.status(401).json({
        success: false,
        code:
          "AUTHENTICATION_REQUIRED",
        message:
          "Authentication is required."
      });
    }

    req.phase2Auth =
      authentication;

    if (
      authentication.mfa_required &&
      !authentication.mfa_verified &&
      !phase2MfaCompletionPath(req)
    ) {
      return phase2MfaStepUpResponse(
        req,
        res,
        authentication
      );
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

async function adminBoundary(
  req,
  res,
  next
) {
  if (req.method === "OPTIONS") {
    return next();
  }

  try {
    const authentication =
      await resolveAuthentication(req);

    if (!authentication) {
      return res.status(401).json({
        success: false,
        code:
          "ADMIN_AUTHENTICATION_REQUIRED",
        message:
          "Administrator authentication is required."
      });
    }

    const allowedRoles = new Set([
      "owner",
      "admin",
      "super_admin",
      "superadmin"
    ]);

    const role = String(
      authentication.platform_role || ""
    ).toLowerCase();

    if (!allowedRoles.has(role)) {
      audit({
        userId: authentication.user_id,
        action:
          "security.admin.role_denied",
        metadata: {
          role,
          path: req.originalUrl
        }
      });

      return res.status(403).json({
        success: false,
        code: "ADMIN_ROLE_REQUIRED",
        message:
          "Administrator authorization is required."
      });
    }

    if (
      authentication.mfa_required &&
      !authentication.mfa_verified
    ) {
      return res.status(428).json({
        success: false,
        code:
          "MFA_VERIFICATION_REQUIRED",
        message:
          "MFA verification is required for this administrator session."
      });
    }

    req.phase2Auth = authentication;
    return next();
  } catch (error) {
    return next(error);
  }
}

function passwordPolicy(req, res, next) {
  if (
    req.method === "GET" ||
    req.method === "OPTIONS" ||
    /\/api\/auth\/login\/?$/i.test(
      req.originalUrl
    )
  ) {
    return next();
  }

  const body = req.body || {};

  const passwords = [
    body.password,
    body.newPassword,
    body.new_password
  ].filter(
    value => typeof value === "string"
  );

  for (const password of passwords) {
    const valid =
      password.length >= 12 &&
      /[A-Z]/.test(password) &&
      /[a-z]/.test(password) &&
      /\d/.test(password) &&
      /[^A-Za-z0-9]/.test(password);

    if (!valid) {
      return res.status(400).json({
        success: false,
        code:
          "PASSWORD_POLICY_FAILED",
        message:
          "Passwords require at least 12 characters, uppercase and lowercase letters, a number, and a symbol."
      });
    }
  }

  return next();
}

async function loginGuard(req, res, next) {
  const email = String(
    req.body?.email || ""
  )
    .trim()
    .toLowerCase();

  if (!email) {
    return next();
  }

  try {
    const result = await database.query(
      `
        SELECT
          id,
          locked_until
        FROM users
        WHERE lower(email) = $1
        LIMIT 1
      `,
      [email]
    );

    const user = result.rows[0];

    if (
      user?.locked_until &&
      new Date(
        user.locked_until
      ).getTime() > Date.now()
    ) {
      return res.status(423).json({
        success: false,
        code:
          "ACCOUNT_TEMPORARILY_LOCKED",
        message:
          "This account is temporarily locked."
      });
    }

    res.on("finish", () => {
      if (!user) {
        return;
      }

      if (
        res.statusCode >= 200 &&
        res.statusCode < 300
      ) {
        database.query(
          `
            UPDATE users
            SET
              failed_login_count = 0,
              locked_until = NULL
            WHERE id = $1
          `,
          [user.id]
        ).catch(() => {});

        return;
      }

      if (res.statusCode === 401) {
        database.query(
          `
            UPDATE users
            SET
              failed_login_count =
                failed_login_count + 1,
              locked_until =
                CASE
                  WHEN failed_login_count + 1 >= 5
                    THEN NOW() +
                      INTERVAL '15 minutes'
                  ELSE locked_until
                END
            WHERE id = $1
          `,
          [user.id]
        ).catch(() => {});
      }
    });

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  originGate,
  securityHeaders,
  globalLimiter,
  authLimiter,
  authenticateRequest,
  adminBoundary,
  passwordPolicy,
  loginGuard,
  audit
};
