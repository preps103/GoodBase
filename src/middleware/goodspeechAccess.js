"use strict";

const authRequired = require("./authRequired");
const tenantContext = require("./tenantContext");
const { resolveTenantContext } = require("../services/tenant-context.service");
const { requireGoodSpeechAccess } = require("../routes/goodspeech-collaboration.routes");
const publicApi = require("../routes/public-api.routes");

function isApiKeyRequest(request) {
  if (request.get("X-Goodbase-API-Key") || request.get("X-GoodOS-API-Key")) return true;
  const authorization = String(request.get("Authorization") || "");
  return /^Bearer\s+gos_live_/i.test(authorization);
}

function denied(response, message, code = "GOODSPEECH_API_KEY_DENIED") {
  return response.status(403).json({ success: false, code, message });
}

function runSessionAccess(request, response, next) {
  return authRequired(request, response, () => tenantContext(request, response, () => (
    requireGoodSpeechAccess(request, response, next)
  )));
}

function goodspeechAccess(requiredScope) {
  return async function authenticateGoodSpeech(request, response, next) {
    if (!isApiKeyRequest(request)) return runSessionAccess(request, response, next);
    return publicApi.apiKeyRequired(request, response, async () => {
      try {
        const apiKey = request.goodosApiKey;
        const apps = publicApi.allowedApps(apiKey);
        if (!apps.includes("*") && !apps.some((app) => ["goodspeech", "good-speech", "speech"].includes(String(app).toLowerCase()))) {
          return denied(response, "This API key is not authorized for GoodSpeech.", "GOODSPEECH_API_KEY_APP_DENIED");
        }
        if (!publicApi.hasScope(apiKey, requiredScope)) {
          return denied(response, `API key missing required scope: ${requiredScope}`, "GOODSPEECH_API_KEY_SCOPE_REQUIRED");
        }
        if (!apiKey.createdBy) {
          return denied(response, "This API key is not linked to an active GoodBase user.", "GOODSPEECH_API_KEY_OWNER_REQUIRED");
        }
        request.user = { id: apiKey.createdBy, role: "api_key", platformRole: "api_key" };
        request.auth = { source: "api_key", apiKeyId: apiKey.id, mfaVerified: true };
        request.tenantContext = await resolveTenantContext({
          userId: apiKey.createdBy,
          organizationId: apiKey.organizationId,
          projectId: apiKey.projectId,
          environmentId: apiKey.environmentId,
        });
        request.goodspeechApiKey = apiKey;
        return next();
      } catch (error) {
        console.error("[GoodSpeech API key] access failed:", error.message);
        return response.status(error.statusCode || 500).json({
          success: false,
          code: error.code || "GOODSPEECH_API_KEY_CONTEXT_FAILED",
          message: Number.isInteger(error.statusCode) ? error.message : "GoodSpeech API key access could not be verified.",
        });
      }
    });
  };
}

module.exports = goodspeechAccess;
module.exports.isApiKeyRequest = isApiKeyRequest;
