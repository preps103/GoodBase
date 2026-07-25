const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

// GoodSpeech's API and loopback-only Kokoro service share one protected
// environment file. Loading it here keeps PM2 restarts deterministic and
// avoids copying the same internal token into multiple runtime files.
const goodSpeechEnvFile = path.resolve(
  process.env.GOODSPEECH_ENV_FILE || "/etc/goodbase/goodspeech.env"
);
dotenv.config({
  path: goodSpeechEnvFile,
  override: false,
});

const allowedOrigins = [
  "https://goodos.app",
  "https://fleet.goodos.app",
  "https://qr.goodos.app",
  "https://ads.goodos.app",
  "https://boost.goodos.app",
  "https://customs.goodos.app",
  "https://designer.goodos.app",
  "https://editor.goodos.app",
  "https://escrow.goodos.app",
  "https://scan.goodos.app",
  "https://speech.goodos.app",
  "https://swapz.goodos.app",
  "https://trust.goodos.app",
  "https://goodfleet.us",
  "https://thirddegreeclothing.com",
  "https://ghostcreationz.com",
  "http://localhost:5173",
  "http://localhost:3000"
];

function isAllowedOrigin(origin) {
  if (!origin) return true;

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".goodos.app");
  } catch (err) {
    return false;
  }
}

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 8001),
  serviceName: process.env.SERVICE_NAME || "Goodbase",
  version: process.env.VERSION || "1.0.0",
  databaseUrl: process.env.DATABASE_URL,
  goodSpeechEnvFile,

  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 60000),
  headersTimeoutMs: Number(process.env.HEADERS_TIMEOUT_MS || 15000),
  keepAliveTimeoutMs: Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 5000),
  maxRequestsPerSocket: Number(process.env.MAX_REQUESTS_PER_SOCKET || 1000),
  maxHeadersCount: Number(process.env.MAX_HEADERS_COUNT || 100),

  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  sessionDays: Number(process.env.SESSION_DAYS || 7),

  allowedOrigins,
  isAllowedOrigin,

  authCookieName: process.env.AUTH_COOKIE_NAME || "goodos_session",
  authCookieDomain: process.env.AUTH_COOKIE_DOMAIN || ".goodos.app",
  authCookieSameSite: process.env.AUTH_COOKIE_SAMESITE || "lax",
  authCookieSecure: String(process.env.AUTH_COOKIE_SECURE || "true") === "true"
};

if (!env.jwtSecret) {
  console.warn("JWT_SECRET is not set.");
}

module.exports = env;
