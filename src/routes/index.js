const express = require("express");
const path = require("path");
const env = require("../config/env");
const { success } = require("../utils/response");

const healthRoutes = require("./health.routes");
const appsRoutes = require("./apps.routes");
const dbRoutes = require("./db.routes");
const authRoutes = require("./auth.routes");
const adminRoutes = require("./admin.routes");
const consoleRoutes = require("./console.routes");
const publicApiRoutes = require("./public-api.routes");
const storageRoutes = require("./storage.routes");
const webhookTestRoutes = require("./webhook-test.routes");
const tableEditorRoutes = require("./table-editor.routes");
const sqlEditorRoutes = require("./sql-editor.routes");
const databaseManagementRoutes = require("./database-management.routes");
const voiceRoutes = require("./voice.routes");
const goodSpeechRoutes = require("./goodspeech.routes");
const teamsRoutes = require("./teams.routes");
const goodboostRoutes = require("./goodboost.routes");
const goodbuilderRoutes = require("./goodbuilder.routes");
const goodswapzRoutes = require("./goodswapz.routes");
const goodAdsRoutes = require("./goodads.routes");
const fleetRoutes = require("./fleet.routes");
const fleetCommunicationsRoutes = require("./fleet-communications.routes");
const goodDesignerRoutes = require("./gooddesigner.routes");
const fleetPaymentsRoutes = require("./fleet-payments.routes");
const fleetPublicRoutes = require("./fleet-public.routes");
const goodCustomChatRoutes = require("./goodcustom-chat.routes");
const goodCustomQuotesRoutes = require("./goodcustom-quotes.routes");


const billingRoutes = require("./billing.routes");


/* GOODOS_SETTINGS_LIVE_V1 */
const settingsRoutes =
  require("./settings.routes");
/* END GOODOS_SETTINGS_LIVE_V1 */

/* GOODOS_API_ACCESS_LIVE_V1 */
const apiAccessRoutes =
  require("./api-access.routes");
/* END GOODOS_API_ACCESS_LIVE_V1 */

const apiGatewayV2PublicRoutes =
  require("./api-gateway-v2-public.routes");

const apiGatewayV2AdminRoutes =
  require("./api-gateway-v2-admin.routes");

const policyEngineV2AdminRoutes =
  require("./policy-engine-v2-admin.routes");

const storageV2AdminRoutes =
  require("./storage-v2-admin.routes");

const storageV2CdnRoutes =
  require("./storage-v2-cdn.routes");

const updateSitesRoutes =
  require("./update-sites.routes");

/* GOODOS_ROLES_CONSOLE_V1 */
const rolesConsoleRoutes =
  require("./roles-console.routes");
/* END GOODOS_ROLES_CONSOLE_V1 */

/* GOODOS_NOTIFICATION_CENTER_V1 */
const notificationCenterRoutes =
  require("./notification-center.routes");
/* END GOODOS_NOTIFICATION_CENTER_V1 */

/* GOODOS_ENTERPRISE_FOUNDATION_V1 */
const enterpriseFoundationRoutes =
  require("./enterprise-foundation.routes");

const {
  requestContextMiddleware,
  structuredAccessLogMiddleware,
  enterpriseErrorHandler,
} = require(
  "../middleware/enterprise-observability"
);

const {
  initializeEnterpriseFoundation,
} = require(
  "../enterprise/enterprise-foundation.service"
);
/* END GOODOS_ENTERPRISE_FOUNDATION_V1 */

const tenantRoutes = require("./tenant.routes");

const identityGovernanceRoutes = require("./identity-governance.routes");
const oidcLoginRoutes =
  require("./oidc-login.routes");

const oidcRoutes =
  require("./oidc.routes");

const scimRoutes =
  require("./scim.routes");


const operationsRoutes = require("./operations.routes");

const releaseGovernanceRoutes = require("./release-governance.routes");

const privacyGovernanceRoutes = require("./privacy-governance.routes");

const environmentGovernanceRoutes = require("./environment-governance.routes");

const dataPlaneRoutes =
  require("./data-plane.routes");

const graphqlRoutes =
  require("./graphql.routes");

const goodbasePlatformRoutes =
  require("./goodbase-platform.routes");

const goodbaseAdvancedPlatformRoutes =
  require("./goodbase-advanced-platform.routes");

const goodbaseAuthProductRoutes =
  require("./goodbase-auth-product.routes");

const goodbaseDeveloperPlatformRoutes =
  require("./goodbase-developer-platform.routes");

const goodbaseEnterprisePlatformRoutes =
  require("./goodbase-enterprise-platform.routes");

const goodbaseProductionRoutes =
  require("./goodbase-production.routes");

const goodbaseGrowthRoutes =
  require("./goodbase-growth.routes");

const goodbaseProductRoutes =
  require("./goodbase-product.routes");

const goodbaseExperienceRoutes =
  require("./goodbase-experience.routes");
const goodbaseControllerCallbackRoutes =
  require("./goodbase-controller-callback.routes");
const goodbaseEcosystemRoutes =
  require("./goodbase-ecosystem.routes");
const goodbaseAlertDeliveryRoutes =
  require("./goodbase-alert-delivery.routes");

const router = express.Router();

/* GOODOS_ENTERPRISE_FOUNDATION_V1_INITIALIZE */
initializeEnterpriseFoundation();

router.use(
  requestContextMiddleware
);

router.use(
  structuredAccessLogMiddleware
);
/* END GOODOS_ENTERPRISE_FOUNDATION_V1_INITIALIZE */


// GoodOS Console V2 route 26C
router.get("/voice", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/voice.html"));
});

router.get("/voice-console.js", (req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "../public/voice-console.js"));
});

router.get("/voice.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/voice.html"));
});

router.get("/console", (req, res) => {
  res.sendFile(require("path").join(__dirname, "../public/console.html"));
});

router.get("/console.html", (req, res) => {
  res.redirect("/console");
});

router.get("/console-voice-link.js", (req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "../public/console-voice-link.js"));
});

router.get("/console-v2.js", (req, res) => {
  res.sendFile(require("path").join(__dirname, "../public/console-v2.js"));
});

router.get("/account-settings.js", (req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "../public/account-settings.js"));
});

router.get("/account-settings.css", (req, res) => {
  res.type("text/css");
  res.sendFile(path.join(__dirname, "../public/account-settings.css"));
});

router.get("/auth/ui", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "../public/goodbase-auth.html"));
});

router.get("/register", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "../public/goodbase-auth.html"));
});

router.get("/goodbase-auth.js", (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "../public/goodbase-auth.js"));
});

router.get("/backend-ada.js", (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "../public/backend-ada.js"));
});

router.get("/backend-ada.css", (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.type("text/css");
  res.sendFile(path.join(__dirname, "../public/backend-ada.css"));
});

router.get("/backend-topbar.css", (req, res) => {
  const crossOriginResourcePolicy = "Cross-Origin-Resource-Policy";
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set(crossOriginResourcePolicy, "cross-origin");
  res.type("text/css");
  res.sendFile(path.join(__dirname, "../public/backend-topbar.css"));
});

router.get("/backend-login.css", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.type("text/css");
  res.sendFile(path.join(__dirname, "../public/backend-login.css"));
});

router.get("/app-notification-center.js", (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "../public/app-notification-center.js"));
});

router.get("/backend-collapsible-sections.js", (req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "../public/backend-collapsible-sections.js"));
});

router.get("/backend-collapsible-sections.css", (req, res) => {
  res.type("text/css");
  res.sendFile(path.join(__dirname, "../public/backend-collapsible-sections.css"));
});

/* GOODOS_UPDATE_SITES_PAGE */
router.get("/update-sites", (req, res) => {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.sendFile(
    path.join(
      __dirname,
      "../public/update-sites.html"
    )
  );
});

router.get("/update-sites.html", (req, res) => {
  res.redirect("/update-sites");
});


router.get("/update-sites.js", (req, res) => {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.type(
    "application/javascript"
  );

  res.sendFile(
    path.join(
      __dirname,
      "../public/update-sites.js"
    )
  );
});
/* END GOODOS_UPDATE_SITES_PAGE */


router.get("/api", (req, res) => {
  return success(res, {
    message: "GoodAppBackEnd API is running",
    service: env.serviceName,
  });
});

router.use("/health", healthRoutes);
router.use("/api/health", healthRoutes);
router.use("/api/internal/observability", goodbaseAlertDeliveryRoutes.receiverRouter);
router.use("/api/apps/goodads/v1", goodAdsRoutes);
router.use("/api/gooddesigner/v1", goodDesignerRoutes);
router.use("/api/apps/goodcustom/v1/chat", goodCustomChatRoutes);
router.use("/api/apps/goodcustom/v1/quotes", goodCustomQuotesRoutes);
router.use("/api/apps", appsRoutes);
router.use("/api/db", dbRoutes);
router.use("/api/auth", authRoutes);
router.use("/api/goodboost", goodboostRoutes);
router.use("/api/goodbuilder", goodbuilderRoutes);
router.use("/api/swapz/v1", goodswapzRoutes);
router.use("/api/auth/v3", goodbaseAuthProductRoutes);
router.use("/api/admin", adminRoutes);
router.use("/api/v1", publicApiRoutes);

router.use(
  "/api/v2",
  apiGatewayV2PublicRoutes
);
router.use("/api/voice", voiceRoutes);
router.use("/api/goodspeech/v1", goodSpeechRoutes);
router.use("/api/teams", teamsRoutes);
router.use("/api/fleet/v1/public", fleetPublicRoutes);
router.use("/api/fleet/v1/communications", fleetCommunicationsRoutes);
router.use("/api/fleet/v1/payments", fleetPaymentsRoutes);
router.use("/api/fleet/v1", fleetRoutes);
router.use(
  "/storage/v2",
  storageV2CdnRoutes
);

router.use("/storage", storageRoutes);
router.use("/webhook-test-receiver", webhookTestRoutes);


function developerPublicFile(relativePath) {
  return path.join(__dirname, "..", "public", relativePath);
}

router.get("/docs", (req, res) => {
  res.type("html").sendFile(developerPublicFile("developer/docs.html"));
});

router.get("/api-docs", (req, res) => {
  res.type("html").sendFile(developerPublicFile("developer/api-docs.html"));
});

router.get("/openapi.json", (req, res) => {
  res.type("json").sendFile(developerPublicFile("developer/openapi.json"));
});

router.get("/sdk/goodbase.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "..", "public", "sdk", "goodos.js"));
});

router.get("/sdk/goodbase.d.ts", (req, res) => {
  res.type("text/plain").sendFile(path.join(__dirname, "..", "public", "sdk", "goodos.d.ts"));
});

router.get("/sdk/goodbase-offline.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "..", "public", "sdk", "goodbase-offline.js"));
});

router.get("/sdk/goodos.js", (req, res) => {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", "Wed, 21 Jan 2027 00:00:00 GMT");
  res.setHeader("Link", '<https://base.goodos.app/sdk/goodbase.js>; rel="successor-version"');
  res.type("application/javascript").sendFile(path.join(__dirname, "..", "public", "sdk", "goodos.js"));
});

router.get("/sdk/goodos.d.ts", (req, res) => {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", "Wed, 21 Jan 2027 00:00:00 GMT");
  res.setHeader("Link", '<https://base.goodos.app/sdk/goodbase.d.ts>; rel="successor-version"');
  res.type("text/plain").sendFile(path.join(__dirname, "..", "public", "sdk", "goodos.d.ts"));
});

router.get("/postman/goodos-postman-collection.json", (req, res) => {
  res.type("json").sendFile(developerPublicFile("postman/goodos-postman-collection.json"));
});

function sendGoodBaseBrandAsset(res, contentType, relativePath) {
  res.set("Cache-Control", "public, max-age=300, must-revalidate");
  res.type(contentType).sendFile(developerPublicFile(relativePath));
}

router.get("/favicon.svg", (req, res) => {
  sendGoodBaseBrandAsset(res, "image/svg+xml", "favicon.svg");
});

router.get("/favicon.ico", (req, res) => {
  sendGoodBaseBrandAsset(res, "image/x-icon", "favicon.ico");
});

router.get("/favicon-16x16.png", (req, res) => {
  sendGoodBaseBrandAsset(res, "image/png", "favicon-16x16.png");
});

router.get("/favicon-32x32.png", (req, res) => {
  sendGoodBaseBrandAsset(res, "image/png", "favicon-32x32.png");
});

router.get("/apple-touch-icon.png", (req, res) => {
  sendGoodBaseBrandAsset(res, "image/png", "apple-touch-icon.png");
});

router.get("/icons/goodbase-192.png", (req, res) => {
  sendGoodBaseBrandAsset(res, "image/png", "icons/goodbase-192.png");
});

router.get("/icons/goodbase-512.png", (req, res) => {
  sendGoodBaseBrandAsset(res, "image/png", "icons/goodbase-512.png");
});

router.get("/site.webmanifest", (req, res) => {
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res
    .type("application/manifest+json")
    .sendFile(developerPublicFile("site.webmanifest"));
});


/* GOODOS_SETTINGS_LIVE_V1_MOUNT */
router.use(
  "/api/settings",
  settingsRoutes
);
/* END GOODOS_SETTINGS_LIVE_V1_MOUNT */

/* GOODOS_API_ACCESS_LIVE_V1_MOUNT */
router.use(
  "/api/api-access",
  apiAccessRoutes
);
/* END GOODOS_API_ACCESS_LIVE_V1_MOUNT */

router.use(
  "/api/api-gateway-v2",
  apiGatewayV2AdminRoutes
);

router.use(
  "/api/policy-engine-v2",
  policyEngineV2AdminRoutes
);

router.use(
  "/api/storage-v2",
  storageV2AdminRoutes
);

/* GOODOS_UPDATE_SITES_API */
router.use(
  "/api/update-sites",
  updateSitesRoutes
);
/* END GOODOS_UPDATE_SITES_API */

/* GOODOS_ROLES_CONSOLE_V1_MOUNT */
router.use(
  "/api/roles-console",
  rolesConsoleRoutes
);
/* END GOODOS_ROLES_CONSOLE_V1_MOUNT */

router.use("/api", tenantRoutes);
router.use("/api/identity", identityGovernanceRoutes);
router.use(
  "/api/oidc",
  oidcLoginRoutes
);

router.use(
  "/api/oidc",
  oidcRoutes
);

router.use(
  "/",
  scimRoutes
);

router.use("/api/operations", operationsRoutes);
router.use(
  "/api/data-platform",
  dataPlaneRoutes.controlRouter
);
router.use(
  "/rest/v1",
  dataPlaneRoutes.restRouter
);
router.use(
  "/api/data-platform/graphql",
  graphqlRoutes.healthRouter
);
router.use(
  "/graphql/v1",
  graphqlRoutes.router
);
router.use(
  "/api/data-platform",
  goodbasePlatformRoutes.router
);
router.use(
  "/api/goodbase/v1/platform",
  goodbaseAdvancedPlatformRoutes
);
router.use(
  "/api/goodbase/v1/developer",
  goodbaseDeveloperPlatformRoutes
);
router.use(
  "/api/goodbase/v1/enterprise",
  goodbaseEnterprisePlatformRoutes
);
router.use(
  "/api/goodbase/v1/production",
  goodbaseProductionRoutes
);
router.use(
  "/api/goodbase/v1/production/observability",
  goodbaseAlertDeliveryRoutes.adminRouter
);
router.use(
  "/api/goodbase/v1/ecosystem",
  goodbaseEcosystemRoutes.clientRouter
);
router.use(
  "/api/goodbase/v1/ecosystem",
  goodbaseEcosystemRoutes.adminRouter
);
router.use(
  "/api/goodbase/v1/growth",
  goodbaseGrowthRoutes.publicRouter
);
router.use(
  "/api/goodbase/v1/growth",
  goodbaseGrowthRoutes.authenticatedRouter
);
router.use(
  "/api/goodbase/v1/product",
  goodbaseProductRoutes.publicRouter
);
router.use(
  "/api/goodbase/v1/product",
  goodbaseProductRoutes.authenticatedRouter
);
router.use(
  "/api/goodbase/v1/experience",
  goodbaseExperienceRoutes.publicRouter
);
router.use(
  "/api/goodbase/v1/controller-callbacks",
  goodbaseControllerCallbackRoutes
);
router.use(
  "/api/goodbase/v1/experience",
  goodbaseExperienceRoutes.authenticatedRouter
);

router.get("/studio", (req, res) => {
  res.type("html").sendFile(developerPublicFile("studio.html"));
});
router.get("/studio.js", (req, res) => {
  res.type("application/javascript").sendFile(developerPublicFile("studio.js"));
});
router.get("/studio.css", (req, res) => {
  res.type("text/css").sendFile(developerPublicFile("studio.css"));
});
router.use("/api/releases", releaseGovernanceRoutes);
router.use("/api/privacy", privacyGovernanceRoutes);
router.use("/api/environment-governance", environmentGovernanceRoutes);
router.use("/", consoleRoutes);



// GoodOS public homepage and console routes - safe route fix 26B
router.get("/", (req, res) => {
  res.sendFile(require("path").join(__dirname, "../public/landing.html"));
});

router.get("/console", (req, res) => {
  res.sendFile(require("path").join(__dirname, "../public/console.html"));
});

router.get("/console.html", (req, res) => {
  res.redirect("/console");
});

router.use("/admin/table-editor", tableEditorRoutes);
router.use("/api/admin/table-editor", tableEditorRoutes);

router.use("/admin/sql-editor", sqlEditorRoutes);
router.use("/api/admin/sql-editor", sqlEditorRoutes);

router.use("/admin/database-management", databaseManagementRoutes);

router.use("/api/admin/database-management", databaseManagementRoutes);

router.use("/api/billing", billingRoutes);

/* GOODOS_NOTIFICATION_CENTER_V1_MOUNT */
router.use(
  "/api/notifications",
  notificationCenterRoutes
);
/* END GOODOS_NOTIFICATION_CENTER_V1_MOUNT */

/* GOODOS_ENTERPRISE_FOUNDATION_V1_MOUNT */
router.use(
  "/api/enterprise",
  enterpriseFoundationRoutes
);

router.use(
  enterpriseErrorHandler
);
/* END GOODOS_ENTERPRISE_FOUNDATION_V1_MOUNT */

module.exports = router;
