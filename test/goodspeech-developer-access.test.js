"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.MFA_ENCRYPTION_KEY ||= "0".repeat(64);

const root = path.join(__dirname, "..");
const access = require("../src/middleware/goodspeechAccess");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function request(headers = {}) {
  return { get(name) { return headers[name.toLowerCase()] || ""; } };
}

test("GoodSpeech distinguishes scoped API keys from session bearer tokens", () => {
  assert.equal(access.isApiKeyRequest(request({ "x-goodbase-api-key": "gos_live_example" })), true);
  assert.equal(access.isApiKeyRequest(request({ authorization: "Bearer gos_live_example" })), true);
  assert.equal(access.isApiKeyRequest(request({ authorization: "Bearer jwt.header.signature" })), false);
});

test("GoodSpeech API keys are owner-bound, tenant-resolved, app-bound, and scope-gated", () => {
  const middleware = read("src/middleware/goodspeechAccess.js");
  const routes = read("src/routes/goodspeech.routes.js");
  const transcriptionRoutes = read("src/routes/goodspeech-transcription.routes.js");
  assert.match(middleware, /apiKey\.createdBy/);
  assert.match(middleware, /resolveTenantContext/);
  assert.match(middleware, /allowedApps/);
  assert.match(middleware, /hasScope/);
  assert.match(routes, /goodspeechAccess\("read:goodspeech"\)/);
  assert.match(routes, /goodspeechAccess\("write:goodspeech"\)/);
  assert.match(transcriptionRoutes, /goodspeechAccess\("write:goodspeech"\)/);
});

test("GoodBase API Access exposes dedicated GoodSpeech read and create scopes", () => {
  const service = read("src/services/api-access.service.js");
  assert.match(service, /"read:goodspeech"/);
  assert.match(service, /"write:goodspeech"/);
  assert.match(service, /Read GoodSpeech/);
  assert.match(service, /Create with GoodSpeech/);
});

test("GoodSpeech OpenAPI documents API-key access only on supported endpoints", () => {
  const openapi = JSON.parse(read("docs/openapi.json"));
  for (const endpoint of [
    "/api/goodspeech/v1/health",
    "/api/goodspeech/v1/capabilities",
    "/api/goodspeech/v1/speech",
    "/api/goodspeech/v1/speech/stream",
    "/api/goodspeech/v1/transcriptions",
    "/api/goodspeech/v1/transcriptions/health",
    "/api/goodspeech/v1/usage",
    "/api/goodspeech/v1/usage/preferences",
  ]) {
    const operation = openapi.paths[endpoint].get || openapi.paths[endpoint].post;
    assert.ok(operation.security.some((item) => Object.hasOwn(item, "GoodOSApiKey")), endpoint);
  }
  assert.ok(openapi.paths["/api/goodspeech/v1/usage/preferences"].patch.security.some((item) => Object.hasOwn(item, "GoodOSApiKey")));
  assert.ok(!openapi.paths["/api/goodspeech/v1/library/bootstrap"].get.security.some((item) => Object.hasOwn(item, "GoodOSApiKey")));
});
