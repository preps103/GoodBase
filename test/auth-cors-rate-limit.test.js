"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const cors = require("cors");
const express = require("express");

const phase2Database = require("../src/security/phase2-db");
phase2Database.query = async () => ({ rows: [] });

const phase2Security = require("../src/middleware/phase2-security");
const {
  rateLimitIdentity,
} = require("../src/security/rate-limit-identity");

const root = path.resolve(__dirname, "..");

test("CORS is installed before the shared authentication limiter", () => {
  const app = fs.readFileSync(path.join(root, "src/app.js"), "utf8");
  const corsIndex = app.indexOf("cors({");
  const authLimiterIndex = app.indexOf("goodosPhase2Security.authLimiter");

  assert.notEqual(corsIndex, -1, "CORS middleware must be installed");
  assert.notEqual(authLimiterIndex, -1, "authentication limiter must be installed");
  assert.ok(
    corsIndex < authLimiterIndex,
    "CORS must run before authentication throttling so 429 responses remain readable"
  );
});

test("authentication throttling never consumes browser preflight requests", () => {
  const security = fs.readFileSync(
    path.join(root, "src/middleware/phase2-security.js"),
    "utf8"
  );
  const authLimiterStart = security.indexOf("const authLimiter = rateLimit({");
  const authLimiterEnd = security.indexOf("\n});", authLimiterStart);
  const authLimiter = security.slice(authLimiterStart, authLimiterEnd);

  assert.match(authLimiter, /skip:\s*req\s*=>\s*req\.method\s*===\s*"OPTIONS"/);
});

test("general traffic throttling leaves authentication to its dedicated limiters", () => {
  const security = fs.readFileSync(
    path.join(root, "src/middleware/phase2-security.js"),
    "utf8"
  );
  const globalLimiterStart = security.indexOf("const globalLimiter = rateLimit({");
  const globalLimiterEnd = security.indexOf("\n});", globalLimiterStart);
  const globalLimiter = security.slice(globalLimiterStart, globalLimiterEnd);

  assert.match(globalLimiter, /req\.originalUrl === "\/api\/auth"/);
  assert.match(globalLimiter, /req\.originalUrl\.startsWith\("\/api\/auth\/"\)/);
});

test("Cloudflare client identity prevents unrelated visitors from sharing a limiter bucket", () => {
  const first = rateLimitIdentity({
    headers: { "cf-connecting-ip": "203.0.113.10" },
    ip: "198.51.100.5",
  });
  const second = rateLimitIdentity({
    headers: { "cf-connecting-ip": "203.0.113.11" },
    ip: "198.51.100.5",
  });

  assert.notEqual(first, second);
});

test("signed-out session probes never consume the password-attempt budget", async t => {
  const app = express();

  app.use("/api/auth", phase2Security.authLimiter);
  app.get("/api/auth/me", (_req, res) => {
    res.status(401).json({ success: false });
  });
  app.post("/api/auth/login", (_req, res) => {
    res.status(401).json({ success: false });
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const { port } = server.address();
  for (let probe = 0; probe < 40; probe += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    assert.equal(response.status, 401);
  }

  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
  });
  assert.equal(login.status, 401);
});

test("automatic REST preflights allow the PostgREST browser contract", () => {
  const source = fs.readFileSync(path.join(root, "src/app.js"), "utf8");
  const corsStart = source.indexOf("cors({");
  const corsEnd = source.indexOf("\n  })", corsStart);
  const contract = source.slice(corsStart, corsEnd);
  for (const header of [
    "Authorization",
    "Content-Profile",
    "Prefer",
    "Range",
    "Range-Unit",
    "Accept-Profile",
  ]) {
    assert.match(contract, new RegExp(`"${header}"`));
  }
  assert.match(contract, /exposedHeaders/);
  assert.match(contract, /"Content-Range"/);
});

test("a saturated login limit still returns readable CORS responses and allows preflight", async t => {
  const app = express();

  app.use(phase2Security.originGate);
  app.use(cors({ origin: true, credentials: true }));
  app.use("/api/auth", phase2Security.authLimiter);
  app.post("/api/auth/login", (_req, res) => {
    res.status(401).json({ success: false });
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise(resolve => server.close(resolve)));

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/auth/login`;
  const origin = "https://goodos.app";

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Origin: origin,
        "CF-Connecting-IP": "203.0.113.20",
      }
    });
    assert.equal(response.status, 401);
  }

  const limited = await fetch(url, {
    method: "POST",
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.20",
    }
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("access-control-allow-origin"), origin);
  assert.equal((await limited.json()).code, "AUTH_RATE_LIMITED");

  const preflight = await fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type"
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
});
