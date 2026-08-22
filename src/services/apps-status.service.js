"use strict";

const path = require("node:path");

const { query } =
  require("../config/database");

const {
  runCommand,
} =
  require(
    "./site-deployment.service"
  );

const applicationManifest = require(
  path.join(
    __dirname,
    "../../deploy/application-paths.json"
  )
);

const PRODUCT_HOSTING_BY_REGISTRY_ID =
  new Map();

for (const application of
  applicationManifest.applications || []) {
  PRODUCT_HOSTING_BY_REGISTRY_ID.set(
    application.id,
    application
  );
}

// Keep the long-lived database key compatible while exposing the canonical
// GoodSupply product and Sites configuration everywhere else.
if (
  PRODUCT_HOSTING_BY_REGISTRY_ID.has(
    "goodsupply"
  )
) {
  PRODUCT_HOSTING_BY_REGISTRY_ID.set(
    "supplyguyz",
    PRODUCT_HOSTING_BY_REGISTRY_ID.get(
      "goodsupply"
    )
  );
}

const CACHE_TTL_MS =
  Math.max(
    10000,
    Math.min(
      Number(
        process.env
          .GOODOS_APP_STATUS_CACHE_MS
      ) ||
      30000,
      300000
    )
  );

const HEALTH_TIMEOUT_MS =
  Math.max(
    2000,
    Math.min(
      Number(
        process.env
          .GOODOS_APP_STATUS_TIMEOUT_MS
      ) ||
      8000,
      20000
    )
  );

let cachedResult = null;
let cacheExpiresAt = 0;
let inFlight = null;

function isReachableHttpStatus(status) {
  return (
    (status >= 200 && status < 400) ||
    status === 401 ||
    status === 403
  );
}

function approvedHealthUrl(value) {
  if (!value) return null;

  let url;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") {
    return null;
  }

  const host =
    url.hostname.toLowerCase();

  if (
    host !== "goodos.app" &&
    !host.endsWith(".goodos.app")
  ) {
    return null;
  }

  return url.toString();
}

function applicationHealthUrl(app) {
  // Sites applications are considered available when their published,
  // canonical frontend is reachable. Database health URLs can outlive an old
  // deployment and must not make a healthy Sites frontend appear offline.
  if (
    app.deploymentType ===
      "sites" &&
    app.domain
  ) {
    return `https://${app.domain}`;
  }

  return (
    app.healthUrl ||
    (
      app.domain
        ? `https://${app.domain}`
        : ""
    )
  );
}

function parsePm2Payload(rawValue) {
  const raw =
    String(rawValue || "")
      .trim();

  if (raw === "[]") {
    return [];
  }

  const start =
    raw.indexOf("[{");

  const end =
    raw.lastIndexOf("}]");

  if (
    start < 0 ||
    end < start
  ) {
    throw new Error(
      "PM2 did not return a JSON array."
    );
  }

  const parsed =
    JSON.parse(
      raw.slice(
        start,
        end + 2
      )
    );

  if (!Array.isArray(parsed)) {
    throw new Error(
      "PM2 status payload was not an array."
    );
  }

  return parsed;
}

async function loadPm2Statuses() {
  const result =
    await runCommand(
      "pm2",
      ["jlist"],
      {
        timeoutMs: 30000,
        maxOutput:
          5 * 1024 * 1024,
      }
    );

  const rows =
    parsePm2Payload(
      result.stdout
    );

  return new Map(
    rows.map((item) => {
      const startedAt =
        Number(
          item.pm2_env
            ?.pm_uptime
        ) ||
        null;

      return [
        item.name,
        {
          status:
            item.pm2_env
              ?.status ||
            "unknown",
          pid:
            item.pid ||
            null,
          restartCount:
            Number(
              item.pm2_env
                ?.restart_time
            ) ||
            0,
          uptimeSeconds:
            startedAt
              ? Math.max(
                  0,
                  Math.floor(
                    (
                      Date.now() -
                      startedAt
                    ) /
                    1000
                  )
                )
              : null,
        },
      ];
    })
  );
}

async function checkHealth(value) {
  const healthUrl =
    approvedHealthUrl(value);

  if (!healthUrl) {
    return {
      url: null,
      ok: false,
      httpStatus: null,
      responseMs: null,
      error:
        "No approved HTTPS health URL is configured.",
    };
  }

  const probeUrl =
    new URL(healthUrl);

  probeUrl.searchParams.set(
    "_goodos_status",
    String(Date.now())
  );

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      HEALTH_TIMEOUT_MS
    );

  const started =
    process.hrtime.bigint();

  try {
    const response =
      await fetch(
        probeUrl,
        {
          method: "GET",
          redirect: "manual",
          signal:
            controller.signal,
          headers: {
            "User-Agent":
              "GoodOS-Live-Status/1.0",
            "Cache-Control":
              "no-cache",
          },
        }
      );

    const responseMs =
      Number(
        (
          process.hrtime.bigint() -
          started
        ) /
        1000000n
      );

    if (response.body) {
      await response.body
        .cancel()
        .catch(() => {});
    }

    return {
      url: healthUrl,
      ok:
        isReachableHttpStatus(
          response.status
        ),
      httpStatus:
        response.status,
      responseMs,
      error: null,
    };
  } catch (error) {
    const responseMs =
      Number(
        (
          process.hrtime.bigint() -
          started
        ) /
        1000000n
      );

    return {
      url: healthUrl,
      ok: false,
      httpStatus: null,
      responseMs,
      error:
        error.name ===
        "AbortError"
          ? `Timed out after ${HEALTH_TIMEOUT_MS}ms.`
          : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function deriveStatus(
  app,
  runtime,
  health
) {
  const registryStatus =
    String(
      app.registryStatus ||
      ""
    ).toLowerCase();

  const deploymentStatus =
    String(
      app.deploymentStatus ||
      ""
    ).toLowerCase();

  const runStatus =
    String(
      app.lastRunStatus ||
      ""
    ).toLowerCase();

  if (
    registryStatus !==
    "active"
  ) {
    return "maintenance";
  }

  if (
    app.deploymentType ===
    "sites"
  ) {
    if (!health.url) {
      return "setup_required";
    }

    if (!health.ok) {
      return "offline";
    }

    return (
      health.responseMs !==
        null &&
      health.responseMs >
        1500
    )
      ? "degraded"
      : "online";
  }

  if (
    [
      "queued",
      "running",
      "deploying",
    ].includes(
      deploymentStatus
    ) ||
    [
      "queued",
      "running",
    ].includes(
      runStatus
    )
  ) {
    return "deploying";
  }

  if (
    !health.url &&
    !runtime
  ) {
    return "setup_required";
  }

  if (
    health.ok &&
    (
      !runtime ||
      runtime.status ===
        "online"
    )
  ) {
    return (
      health.responseMs !==
        null &&
      health.responseMs >
        1500
    )
      ? "degraded"
      : "online";
  }

  if (health.ok) {
    return "degraded";
  }

  if (
    runtime?.status ===
    "online"
  ) {
    return "degraded";
  }

  return "offline";
}

function statusReason(
  status,
  runtime,
  health,
  deploymentType
) {
  if (status === "online") {
    if (
      health.httpStatus === 401 ||
      health.httpStatus === 403
    ) {
      return `HTTP ${health.httpStatus}; access-controlled service reachable.`;
    }

    if (deploymentType === "sites") {
      return `HTTP ${health.httpStatus}; Sites frontend reachable.`;
    }

    return runtime
      ? `HTTP ${health.httpStatus}; PM2 online.`
      : `HTTP ${health.httpStatus}; public service reachable.`;
  }

  if (
    status === "deploying"
  ) {
    return "A deployment is queued or running.";
  }

  if (
    status ===
    "maintenance"
  ) {
    return "The application registry is not marked active.";
  }

  if (
    status ===
    "setup_required"
  ) {
    return "No approved health URL or runtime mapping is available.";
  }

  if (
    status === "degraded"
  ) {
    if (
      health.ok &&
      health.responseMs >
        1500
    ) {
      return `HTTP ${health.httpStatus}; response exceeded 1500ms.`;
    }

    if (health.ok) {
      return `HTTP ${health.httpStatus}; runtime is ${runtime?.status || "unknown"}.`;
    }

    return `PM2 is online, but the public health check failed: ${health.error || "unknown error"}`;
  }

  return (
    health.error ||
    "The public service and mapped runtime are unavailable."
  );
}

async function loadRegistryRows() {
  const result =
    await query(`
      SELECT
        app.id,
        app.name,
        app.domain,
        app.status AS "registryStatus",
        app.description,
        app.created_at AS "createdAt",
        app.updated_at AS "updatedAt",
        site.id AS "deploymentSiteId",
        site.status AS "deploymentStatus",
        site.process_name AS "processName",
        site.health_url AS "healthUrl",
        site.last_deployed_commit AS "lastDeployedCommit",
        site.last_deployed_at AS "lastDeployedAt",
        recent.status AS "lastRunStatus",
        recent.error_message AS "lastRunError",
        recent.completed_at AS "lastRunCompletedAt"
      FROM apps app
      LEFT JOIN LATERAL (
        SELECT
          id,
          status,
          process_name,
          health_url,
          last_deployed_commit,
          last_deployed_at,
          updated_at
        FROM backend_deployment_sites
        WHERE app_id = app.id
        ORDER BY updated_at DESC, id ASC
        LIMIT 1
      ) site ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          status,
          error_message,
          completed_at
        FROM backend_deployment_runs
        WHERE site_id = site.id
        ORDER BY created_at DESC
        LIMIT 1
      ) recent ON TRUE
      ORDER BY app.name ASC
    `);

  return result.rows;
}

async function buildLiveStatus() {
  const checkedAt =
    new Date().toISOString();

  const registryRows =
    await loadRegistryRows();

  const apps =
    registryRows.map((app) => {
      const hosting =
        PRODUCT_HOSTING_BY_REGISTRY_ID.get(
          app.id
        );

      if (!hosting) {
        return {
          ...app,
          deploymentType:
            "vps",
          hostingProjectId:
            null,
        };
      }

      return {
        ...app,
        name:
          hosting.name ||
          app.name,
        domain:
          hosting.domain ||
          app.domain,
        deploymentType:
          hosting.deploymentType,
        hostingProjectId:
          hosting.hostingProjectId ||
          null,
      };
    });

  let pm2Statuses =
    new Map();

  let pm2Error = null;

  try {
    pm2Statuses =
      await loadPm2Statuses();
  } catch (error) {
    pm2Error =
      error.message;
  }

  const healthResults =
    await Promise.all(
      apps.map((app) =>
        checkHealth(
          applicationHealthUrl(
            app
          )
        )
      )
    );

  const liveApps =
    apps.map(
      (app, index) => {
        const runtime =
          app.deploymentType !==
            "sites" &&
          app.processName
            ? pm2Statuses.get(
                app.processName
              ) ||
              null
            : null;

        const health =
          healthResults[index];

        const status =
          deriveStatus(
            app,
            runtime,
            health
          );

        return {
          id: app.id,
          name: app.name,
          domain: app.domain,
          url:
            app.domain
              ? `https://${app.domain}`
              : null,
          description:
            app.description,
          status,
          reason:
            statusReason(
              status,
              runtime,
              health,
              app.deploymentType
            ),
          responseMs:
            health.responseMs,
          httpStatus:
            health.httpStatus,
          runtimeStatus:
            runtime?.status ||
            "unknown",
          runtimeUptimeSeconds:
            runtime
              ?.uptimeSeconds ??
            null,
          restartCount:
            runtime
              ?.restartCount ??
            null,
          deploymentStatus:
            app.deploymentType ===
            "sites"
              ? health.ok
                ? "published"
                : "unreachable"
              : app.deploymentStatus ||
                "setup_required",
          deploymentReady:
            app.deploymentType ===
            "sites"
              ? Boolean(
                  app.hostingProjectId
                )
              : Boolean(
                  app.deploymentSiteId &&
                  app.processName &&
                  app.healthUrl
                ),
          deploymentType:
            app.deploymentType,
          lastRunStatus:
            app.lastRunStatus ||
            null,
          lastRunError:
            app.lastRunError ||
            null,
          lastRunCompletedAt:
            app.lastRunCompletedAt ||
            null,
          lastDeployedAt:
            app.lastDeployedAt ||
            null,
          deployedRevision:
            app.lastDeployedCommit
              ? String(
                  app.lastDeployedCommit
                ).slice(
                  0,
                  12
                )
              : null,
          checkedAt,
          updatedAt:
            app.updatedAt,
        };
      }
    );

  const summary = {
    total:
      liveApps.length,
    online:
      liveApps.filter(
        (app) =>
          app.status ===
          "online"
      ).length,
    degraded:
      liveApps.filter(
        (app) =>
          app.status ===
          "degraded"
      ).length,
    offline:
      liveApps.filter(
        (app) =>
          app.status ===
          "offline"
      ).length,
    deploying:
      liveApps.filter(
        (app) =>
          app.status ===
          "deploying"
      ).length,
    maintenance:
      liveApps.filter(
        (app) =>
          app.status ===
          "maintenance"
      ).length,
    setupRequired:
      liveApps.filter(
        (app) =>
          app.status ===
          "setup_required"
      ).length,
  };

  const measured =
    liveApps
      .map(
        (app) =>
          app.responseMs
      )
      .filter(
        (value) =>
          Number.isFinite(value)
      );

  summary.averageResponseMs =
    measured.length
      ? Math.round(
          measured.reduce(
            (total, value) =>
              total + value,
            0
          ) /
          measured.length
        )
      : null;

  return {
    source:
      "database+sites+pm2+https",
    checkedAt,
    cacheTtlMs:
      CACHE_TTL_MS,
    pm2Discovery:
      pm2Error
        ? {
            status:
              "unavailable",
            error:
              pm2Error,
          }
        : {
            status:
              "available",
          },
    count:
      liveApps.length,
    summary,
    apps:
      liveApps,
  };
}

async function getLiveAppsStatus({
  force = false,
} = {}) {
  if (
    !force &&
    cachedResult &&
    Date.now() <
      cacheExpiresAt
  ) {
    return cachedResult;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight =
    buildLiveStatus();

  try {
    const result =
      await inFlight;

    cachedResult =
      result;

    cacheExpiresAt =
      Date.now() +
      CACHE_TTL_MS;

    return result;
  } finally {
    inFlight = null;
  }
}

module.exports = {
  applicationHealthUrl,
  deriveStatus,
  getLiveAppsStatus,
  isReachableHttpStatus,
};
