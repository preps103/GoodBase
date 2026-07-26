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
const teamsRoutes = require("./teams.routes");
const goodAdsRoutes = require("./goodads.routes");
const goodDesignerRoutes = require("./gooddesigner.routes");
const goodSwapzRoutes = require("./goodswapz.routes");


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
router.use("/api/apps/goodads/v1", goodAdsRoutes);
router.use("/api/gooddesigner/v1", goodDesignerRoutes);
router.use("/api/swapz/v1", goodSwapzRoutes);
router.use("/api/apps", appsRoutes);
router.use("/api/db", dbRoutes);
router.use("/api/auth", authRoutes);
router.use("/api/admin", adminRoutes);
router.use("/api/v1", publicApiRoutes);

router.use(
  "/api/v2",
  apiGatewayV2PublicRoutes
);
router.use("/api/voice", voiceRoutes);
router.use("/api/teams", teamsRoutes);
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

router.get("/sdk/goodos.js", (req, res) => {
  res.type("application/javascript").sendFile(developerPublicFile("sdk/goodos.js"));
});

router.get("/sdk/goodos.d.ts", (req, res) => {
  res.type("text/plain").sendFile(developerPublicFile("sdk/goodos.d.ts"));
});

router.get("/postman/goodos-postman-collection.json", (req, res) => {
  res.type("json").sendFile(developerPublicFile("postman/goodos-postman-collection.json"));
});

router.get("/favicon.ico", (req, res) => res.status(204).end());


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

router.use("/admin/sql-editor", sqlEditorRoutes);

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
