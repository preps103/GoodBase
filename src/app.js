const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

const env = require("./config/env");
const routes = require("./routes");
const requestLogger = require("./middleware/requestLogger");
const notFound = require("./middleware/notFound");
const errorHandler = require("./middleware/errorHandler");

const app = express();

// GOODOS_SECURITY_PHASE2_EARLY
const goodosPhase2Security =
  require("./middleware/phase2-security");

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Goodbase-Canonical-Origin", "https://base.goodos.app");
  if (["GET", "HEAD"].includes(req.method)) {
    const canonical = new URL(req.path, "https://base.goodos.app").toString();
    res.setHeader("Link", `<${canonical}>; rel="canonical"`);
    res.setHeader("Content-Location", canonical);
  }
  next();
});

app.use(
  goodosPhase2Security.originGate
);

app.use(
  goodosPhase2Security.securityHeaders
);

app.use(
  goodosPhase2Security.globalLimiter
);

app.use(
  "/api/auth",
  goodosPhase2Security.authLimiter
);

app.use(
  "/api/admin",
  goodosPhase2Security.adminBoundary
);

app.use(
  "/admin",
  goodosPhase2Security.adminBoundary
);

app.use(
  "/api/authentication-console",
  goodosPhase2Security.adminBoundary
);




/* GOODTRUSTS HEALTH ALIAS */
app.get("/api/goodtrusts/health", (req, res) => {
  return res.json({
    success: true,
    status: "online",
    service: "goodtrusts",
    timestamp: new Date().toISOString()
  });
});
/* END GOODTRUSTS HEALTH ALIAS */

/* GOODOS DATABASE CONSOLE V121 API MOUNT */
try {
  const goodosDatabaseConsoleRouterV121 = require('./routes/database-console.routes');

  app.use('/api/admin/database-console', goodosDatabaseConsoleRouterV121);
  app.use('/api/database-console', goodosDatabaseConsoleRouterV121);

  console.log('GOODOS V121 Database Console API mounted');
} catch (err) {
  console.error('GOODOS V121 Database Console API mount failed:', err && err.message ? err.message : err);
}
/* END GOODOS DATABASE CONSOLE V121 API MOUNT */



/* GOODOS PROJECT SETTINGS V107 API MOUNT */
try {
  const goodosProjectSettingsRouterV107 = require('./routes/project-settings-console.routes');

  app.use('/api/admin/project-settings-console', goodosProjectSettingsRouterV107);
  app.use('/api/admin/project-settings', goodosProjectSettingsRouterV107);
  app.use('/api/project-settings-console', goodosProjectSettingsRouterV107);

  console.log('GOODOS V107 Project Settings API mounted');
} catch (err) {
  console.error('GOODOS V107 Project Settings API mount failed:', err && err.message ? err.message : err);
}
/* END GOODOS PROJECT SETTINGS V107 API MOUNT */



/* GOODOS OBSERVABILITY V105 MISSING CARDS API MOUNT */
try {
  const goodosObservabilityV105Router = require('./routes/observability-v105.routes');

  app.use('/api/admin/operate-console/observability', goodosObservabilityV105Router);
  app.use('/api/operate-console/observability', goodosObservabilityV105Router);

  console.log('GOODOS V105 Observability missing-card API mounted');
} catch (err) {
  console.error('GOODOS V105 Observability missing-card API mount failed:', err && err.message ? err.message : err);
}
/* END GOODOS OBSERVABILITY V105 MISSING CARDS API MOUNT */



/* GOODOS OPERATE CONSOLES V104 API MOUNT */
try {
  const goodosOperateConsolesRouterV104 = require('./routes/operate-consoles.routes');

  app.use('/api/admin/operate-console', goodosOperateConsolesRouterV104);
  app.use('/api/operate-console', goodosOperateConsolesRouterV104);

  console.log('GOODOS V104 Operate Consoles API mounted');
} catch (err) {
  console.error('GOODOS V104 Operate Consoles API mount failed:', err && err.message ? err.message : err);
}
/* END GOODOS OPERATE CONSOLES V104 API MOUNT */



/* GOODOS REALTIME CONSOLE V103 API MOUNT */
try {
  const goodosRealtimeConsoleRouterV103 = require('./routes/realtime-console.routes');

  app.use('/api/admin/realtime-console', goodosRealtimeConsoleRouterV103);
  app.use('/api/admin/realtime', goodosRealtimeConsoleRouterV103);
  app.use('/api/realtime-console', goodosRealtimeConsoleRouterV103);

  console.log('GOODOS V103 Realtime Console API mounted');
} catch (err) {
  console.error('GOODOS V103 Realtime Console API mount failed:', err && err.message ? err.message : err);
}
/* END GOODOS REALTIME CONSOLE V103 API MOUNT */



/* GOODOS EDGE FUNCTIONS CONSOLE V102 API MOUNT */
try {
  const goodosEdgeFunctionsConsoleRouterV102 = require('./routes/edge-functions-console.routes');

  app.use('/api/admin/edge-functions-console', goodosEdgeFunctionsConsoleRouterV102);
  app.use('/api/admin/edge-functions', goodosEdgeFunctionsConsoleRouterV102);
  app.use('/api/edge-functions-console', goodosEdgeFunctionsConsoleRouterV102);

  console.log('GOODOS V102 Edge Functions Console API mounted');
} catch (err) {
  console.error('GOODOS V102 Edge Functions Console API mount failed:', err && err.message ? err.message : err);
}
/* END GOODOS EDGE FUNCTIONS CONSOLE V102 API MOUNT */



/* GOODOS STORAGE CONSOLE V101 API MOUNT */
try {
  const goodosStorageConsoleRouterV101 = require('./routes/storage-console.routes');

  app.use('/api/admin/storage-console', goodosStorageConsoleRouterV101);
  app.use('/api/storage-console', goodosStorageConsoleRouterV101);
  app.use('/api/admin/storage', goodosStorageConsoleRouterV101);

  console.log('GOODOS V101 Storage Console API mounted');
} catch (err) {
  console.error('GOODOS V101 Storage Console API mount failed:', err && err.message ? err.message : err);
}
/* END GOODOS STORAGE CONSOLE V101 API MOUNT */



/* GOODOS AUTH CONSOLE V99 EARLY API NORMALIZER - HARD FIX FOR 404 */
try {
  const goodosAuthConsoleRouterV99 = require('./routes/authentication-console.routes');

  const goodosAuthConsoleSectionMapV99 = {
    users: 'users',
    user: 'users',
    apps: 'oauth-apps',
    oauthapps: 'oauth-apps',
    'oauth-apps': 'oauth-apps',
    oauthApps: 'oauth-apps',
    templates: 'email-templates',
    emailtemplates: 'email-templates',
    'email-templates': 'email-templates',
    emailTemplates: 'email-templates',
    policies: 'policies',
    policy: 'policies',
    providers: 'providers',
    provider: 'providers',
    passkeys: 'passkeys',
    passkey: 'passkeys',
    sessions: 'sessions',
    session: 'sessions',
    mfa: 'mfa',
    ratelimits: 'rate-limits',
    'rate-limits': 'rate-limits',
    rateLimits: 'rate-limits',
    hooks: 'hooks',
    hook: 'hooks',
    auditlogs: 'audit-logs',
    'audit-logs': 'audit-logs',
    auditLogs: 'audit-logs',
    logs: 'audit-logs',
    performance: 'performance',
    perf: 'performance',
    summary: 'summary'
  };

  const goodosAuthConsoleKnownSectionsV99 = new Set([
    'users',
    'oauth-apps',
    'email-templates',
    'policies',
    'providers',
    'passkeys',
    'sessions',
    'mfa',
    'rate-limits',
    'hooks',
    'audit-logs',
    'performance'
  ]);

  function goodosCleanAuthConsoleKeyV99(value) {
    let key = String(value || '')
      .trim()
      .replace(/<[^>]*>/g, '')
      .replace(/[+"'\`]/g, '')
      .replace(/[.)\];,]+$/g, '')
      .replace(/^\/+|\/+$/g, '');

    return (
      goodosAuthConsoleSectionMapV99[key] ||
      goodosAuthConsoleSectionMapV99[key.toLowerCase()] ||
      key.toLowerCase()
    );
  }

  function goodosNormalizeAuthConsoleUrlV99(req, res, next) {
    try {
      const originalUrl = String(req.url || '/');
      const queryIndex = originalUrl.indexOf('?');
      let pathname = queryIndex >= 0 ? originalUrl.slice(0, queryIndex) : originalUrl;
      const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';

      try {
        pathname = decodeURI(pathname);
      } catch (_) {}

      pathname = pathname
        .replace(/<[^>]*>/g, '')
        .replace(/\\+/g, '/')
        .replace(/\/+/g, '/')
        .replace(/[+"'\`]/g, '')
        .replace(/[.)\];,]+$/g, '');

      pathname = pathname.replace(/\/sections\//i, '/section/');

      const parts = pathname.split('/').filter(Boolean);

      if (parts.length === 0) {
        req.url = '/summary' + query;
        return next();
      }

      const first = goodosCleanAuthConsoleKeyV99(parts[0]);
      const second = goodosCleanAuthConsoleKeyV99(parts[1] || '');

      if (first === 'summary') {
        req.url = '/summary' + query;
        return next();
      }

      if (first === 'section' || first === 'sections') {
        if (goodosAuthConsoleKnownSectionsV99.has(second)) {
          req.url = '/section/' + second + query;
          return next();
        }
      }

      if (goodosAuthConsoleKnownSectionsV99.has(first)) {
        req.url = '/section/' + first + query;
        return next();
      }

      req.url = pathname + query;
      return next();
    } catch (err) {
      return next();
    }
  }

  app.use('/api/admin/authentication-console', goodosNormalizeAuthConsoleUrlV99, goodosAuthConsoleRouterV99);
  app.use('/api/admin/auth-console', goodosNormalizeAuthConsoleUrlV99, goodosAuthConsoleRouterV99);
  app.use('/api/authentication-console', goodosNormalizeAuthConsoleUrlV99, goodosAuthConsoleRouterV99);

  console.log('GOODOS V99 Auth Console early normalizer mounted');
} catch (err) {
  console.error('GOODOS V99 Auth Console early normalizer failed:', err && err.message ? err.message : err);
}
/* END GOODOS AUTH CONSOLE V99 EARLY API NORMALIZER */



// GoodOS Console V2 app route 26C
app.get("/console", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public/console.html"));
});

app.get("/console.html", (req, res) => {
  res.redirect("/console");
});

app.get("/console-v2.js", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public/console-v2.js"));
});

const allowedOrigins = [
  "https://goodos.app",
  "https://base.goodos.app",
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
];

function isAllowedOrigin(origin) {
  if (!origin) return true;

  try {
    const url = new URL(origin);

    if (url.hostname === "goodos.app") return true;
    if (url.hostname.endsWith(".goodos.app")) return true;
    if (url.hostname === "localhost") return true;
    if (url.hostname === "127.0.0.1") return true;

    return allowedOrigins.includes(origin);
  } catch {
    return false;
  }
}


app.use(helmet());


// GOODOS_SECURITY_PHASE2_CORS
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: [
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
      "X-Requested-With",
      "X-Goodbase-API-Key",
      "X-GoodOS-API-Key",
      "X-GoodBase-Client",
      "X-Request-ID",
      "Traceparent",
      "Idempotency-Key"
    ]
  })
);

app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buffer) => {
      if (
        req.originalUrl?.startsWith("/api/apps/goodads/v1/public/payment-webhooks/") ||
        req.originalUrl?.startsWith("/api/apps/goodads/v1/public/engagement-webhooks/") ||
        req.originalUrl?.startsWith("/api/fleet/v1/payments/webhooks/stripe")
      ) {
        req.rawBody = Buffer.from(buffer);
      }
    },

    type: [
      "application/json",
      "application/scim+json",
      "application/*+json",
    ],
  })
);

// GOODOS_SECURITY_PHASE2_BODY
app.use(
  goodosPhase2Security.passwordPolicy
);

app.use(
  "/api/auth/login",
  goodosPhase2Security.loginGuard
);

app.use(
  "/api/security",
  require(
    "./routes/security-foundation.routes"
  )
);

app.get("/mfa-enroll", (req, res) => {
  res.set(
    "Cache-Control",
    "no-store"
  );

  res.sendFile(
    require("path").join(
      __dirname,
      "public",
      "mfa-enroll.html"
    )
  );
});

app.get("/mfa-enroll.js", (req, res) => {
  res.set(
    "Cache-Control",
    "no-store"
  );

  res.type(
    "application/javascript"
  );

  res.sendFile(
    require("path").join(
      __dirname,
      "public",
      "mfa-enroll.js"
    )
  );
});

app.get("/oidc-admin", (req, res) => {
  res.set(
    "Cache-Control",
    "no-store"
  );

  res.sendFile(
    require("path").join(
      __dirname,
      "public",
      "oidc-admin.html"
    )
  );
});

app.get("/oidc-admin.js", (req, res) => {
  res.set(
    "Cache-Control",
    "no-store"
  );

  res.type(
    "application/javascript"
  );

  res.sendFile(
    require("path").join(
      __dirname,
      "public",
      "oidc-admin.js"
    )
  );
});

app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(requestLogger);

app.use(routes);

app.use(notFound);
app.use(errorHandler);


// GoodOS landing route 26A
app.get("/", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public/landing.html"));
});

app.get("/console", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public/console.html"));
});


// GOODOS V94 DATABASE MANAGEMENT DIRECT API MOUNT START
try {
  const databaseManagementRoutes = require("./routes/database-management.routes");

  if (app && typeof app.use === "function") {
    app.use("/api/admin/database-management", databaseManagementRoutes);
    console.log("GoodOS Database Management API mounted at /api/admin/database-management");
  }
} catch (err) {
  console.error("GoodOS Database Management API mount failed:", err && err.message ? err.message : err);
}
// GOODOS V94 DATABASE MANAGEMENT DIRECT API MOUNT END


// GOODOS V97 AUTHENTICATION CONSOLE DIRECT API MOUNT START
try {
  const authenticationConsoleRoutes = require("./routes/authentication-console.routes");

  if (app && typeof app.use === "function") {
    app.use("/api/admin/authentication-console", authenticationConsoleRoutes);
/* GOODOS AUTH CONSOLE V98 API ALIAS MOUNTS */
app.use('/api/admin/auth-console', authenticationConsoleRoutes);
app.use('/api/authentication-console', authenticationConsoleRoutes);
/* END GOODOS AUTH CONSOLE V98 API ALIAS MOUNTS */

    console.log("GoodOS Authentication Console API mounted at /api/admin/authentication-console");
  }
} catch (err) {
  console.error("GoodOS Authentication Console API mount failed:", err && err.message ? err.message : err);
}
// GOODOS V97 AUTHENTICATION CONSOLE DIRECT API MOUNT END

module.exports = app;
