const jwt = require("jsonwebtoken");

const env = require("../config/env");
const { error } = require("../utils/response");
const {
  validateSessionToken,
  getUserApps,
  publicUser
} = require("../services/auth.service");

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || "";

  if (authHeader.startsWith("Bearer ")) {
    return {
      token: authHeader.replace("Bearer ", "").trim(),
      source: "bearer"
    };
  }

  if (req.cookies && req.cookies[env.authCookieName]) {
    return {
      token: req.cookies[env.authCookieName],
      source: "cookie"
    };
  }

  return {
    token: null,
    source: null
  };
}


function mfaCompletionPath(req) {
  const pathname = String(
    req.originalUrl ||
    req.url ||
    ""
  ).split("?")[0];

  return [
    /^\/api\/auth\/session\/?$/i,
    /^\/api\/auth\/logout\/?$/i,
    /^\/api\/auth\/logout-all\/?$/i,
    /^\/api\/auth\/mfa\/setup\/?$/i,
    /^\/api\/auth\/mfa\/verify\/?$/i,
    /^\/api\/security\/health\/?$/i,
    /^\/api\/security\/mfa\/setup\/?$/i,
    /^\/api\/security\/mfa\/verify\/?$/i,
    /^\/api\/security\/mfa\/verify-session\/?$/i,
    /^\/api\/security\/mfa\/recovery\/?$/i,
  ].some(
    pattern => pattern.test(pathname)
  );
}

function mfaStepUpResponse(
  req,
  res,
  sessionUser
) {
  const enabled =
    Boolean(
      sessionUser.mfa_enabled
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
      sessionUser
        .session_auth_level ||
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


async function authRequired(req, res, next) {
  try {
    const { token, source } = getTokenFromRequest(req);

    if (!token) {
      return error(res, "Authorization token required", 401);
    }

    let decoded;

    try {
      decoded = jwt.verify(token, env.jwtSecret);
    } catch (err) {
      return error(res, "Invalid or expired token", 401);
    }

    const sessionUser = await validateSessionToken(token);

    if (!sessionUser) {
      return error(res, "Session expired or revoked", 401);
    }

    req.auth = {
      token,
      decoded,
      source,
      sessionId:
        sessionUser.session_id,
      authLevel:
        sessionUser
          .session_auth_level ||
        "password",
      mfaVerified:
        Boolean(
          sessionUser
            .session_mfa_verified
        ),
      riskScore:
        Number(
          sessionUser
            .session_risk_score ||
          0
        )
    };

    req.user =
      publicUser(sessionUser);

    if (
      sessionUser.mfa_required &&
      !sessionUser
        .session_mfa_verified &&
      !mfaCompletionPath(req)
    ) {
      return mfaStepUpResponse(
        req,
        res,
        sessionUser
      );
    }

    req.apps =
      await getUserApps(
        sessionUser.id
      );

    return next();
  } catch (err) {
    console.error("Auth middleware failed:", err);
    return error(res, "Authentication failed", 500);
  }
}

module.exports = authRequired;
