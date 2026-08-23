"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const tls = require("node:tls");
const {
  X509Certificate,
} = require("node:crypto");
const {
  execFile,
} = require("node:child_process");
const {
  promisify,
} = require("node:util");

const {
  query,
} = require("../config/database");

const applicationManifest =
  require("../../deploy/application-paths.json");

const DEPLOYMENT_TYPE_BY_APP_ID =
  new Map(
    applicationManifest.applications.map(
      (app) => [
        String(app.id || "")
          .trim()
          .toLowerCase(),
        String(
          app.deploymentType ||
          "vps"
        )
          .trim()
          .toLowerCase(),
      ]
    )
  );

const execFileAsync =
  promisify(execFile);

const NGINX_ENABLED_DIRECTORY =
  "/etc/nginx/sites-enabled";

const LETS_ENCRYPT_LIVE_DIRECTORY =
  "/etc/letsencrypt/live";

const CACHE_TTL_MS =
  Math.max(
    30000,
    Math.min(
      Number(
        process.env
          .GOODOS_SSL_STATUS_CACHE_MS
      ) || 60000,
      300000
    )
  );

const TLS_TIMEOUT_MS =
  Math.max(
    3000,
    Math.min(
      Number(
        process.env
          .GOODOS_SSL_TLS_TIMEOUT_MS
      ) || 10000,
      20000
    )
  );

let cachedSnapshot = null;
let cacheExpiresAt = 0;
let inFlight = null;

function approvedDomain(value) {
  const domain =
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");

  if (
    !/^[a-z0-9.-]+$/.test(domain)
  ) {
    return null;
  }

  if (
    domain !== "goodos.app" &&
    !domain.endsWith(".goodos.app")
  ) {
    return null;
  }

  return domain;
}

function approvedCertificatePath(value) {
  const candidate =
    String(value || "").trim();

  if (!candidate) {
    return null;
  }

  const normalized =
    path.resolve(candidate);

  if (
    !normalized.startsWith(
      `${LETS_ENCRYPT_LIVE_DIRECTORY}/`
    ) ||
    !normalized.endsWith(
      "/fullchain.pem"
    )
  ) {
    return null;
  }

  return normalized;
}

function daysRemaining(validTo) {
  const expiry =
    Date.parse(validTo || "");

  if (!Number.isFinite(expiry)) {
    return null;
  }

  return Math.floor(
    (expiry - Date.now()) /
      86400000
  );
}

function certificateState(
  validTo,
  identityValid = true
) {
  if (!identityValid) {
    return "invalid";
  }

  const remaining =
    daysRemaining(validTo);

  if (remaining === null) {
    return "unavailable";
  }

  if (remaining < 0) {
    return "expired";
  }

  if (remaining <= 14) {
    return "critical";
  }

  if (remaining <= 30) {
    return "expiring";
  }

  return "valid";
}

function distinguishedName(value) {
  if (
    !value ||
    typeof value !== "object"
  ) {
    return null;
  }

  return Object.entries(value)
    .map(([key, item]) => {
      const rendered =
        Array.isArray(item)
          ? item.join(", ")
          : String(item);

      return `${key}=${rendered}`;
    })
    .join(", ");
}

function unavailableCertificate(error) {
  return {
    available: false,
    authorized: false,
    hostnameValid: false,
    state: "unavailable",
    error:
      error instanceof Error
        ? error.message
        : String(error || "Unavailable"),
    commonName: null,
    subject: null,
    issuer: null,
    issuerCommonName: null,
    issuerOrganization: null,
    validFrom: null,
    validTo: null,
    daysRemaining: null,
    serialNumber: null,
    fingerprint256: null,
    subjectAlternativeName: null,
  };
}

function managedCertificate() {
  return {
    available: true,
    authorized: true,
    hostnameValid: true,
    state: "managed",
    error: null,
    commonName: null,
    subject: null,
    issuer: "GoodOS Sites managed TLS",
    issuerCommonName: null,
    issuerOrganization: "GoodOS Sites",
    validFrom: null,
    validTo: null,
    daysRemaining: null,
    serialNumber: null,
    fingerprint256: null,
    subjectAlternativeName: null,
  };
}

function inspectPublicCertificate(domain) {
  return new Promise((resolve) => {
    let finished = false;
    let socket = null;

    const finish = (result) => {
      if (finished) {
        return;
      }

      finished = true;

      if (socket) {
        socket.destroy();
      }

      resolve(result);
    };

    socket = tls.connect({
      host: domain,
      port: 443,
      servername: domain,
      rejectUnauthorized: true,
      timeout: TLS_TIMEOUT_MS,
    });

    socket.once(
      "secureConnect",
      () => {
        const certificate =
          socket.getPeerCertificate(true);

        if (
          !certificate ||
          Object.keys(certificate).length ===
            0
        ) {
          finish(
            unavailableCertificate(
              new Error(
                "No peer certificate was returned."
              )
            )
          );

          return;
        }

        const authorized =
          socket.authorized === true;

        const validTo =
          certificate.valid_to || null;

        finish({
          available: true,
          authorized,
          hostnameValid: authorized,
          state:
            certificateState(
              validTo,
              authorized
            ),
          error:
            socket.authorizationError ||
            null,
          commonName:
            certificate.subject?.CN ||
            null,
          subject:
            distinguishedName(
              certificate.subject
            ),
          issuer:
            distinguishedName(
              certificate.issuer
            ),
          issuerCommonName:
            certificate.issuer?.CN ||
            null,
          issuerOrganization:
            certificate.issuer?.O ||
            null,
          validFrom:
            certificate.valid_from ||
            null,
          validTo,
          daysRemaining:
            daysRemaining(validTo),
          serialNumber:
            certificate.serialNumber ||
            null,
          fingerprint256:
            certificate.fingerprint256 ||
            null,
          subjectAlternativeName:
            certificate.subjectaltname ||
            null,
        });
      }
    );

    socket.once(
      "timeout",
      () => {
        finish(
          unavailableCertificate(
            new Error(
              `TLS inspection timed out after ${TLS_TIMEOUT_MS}ms.`
            )
          )
        );
      }
    );

    socket.once(
      "error",
      (error) => {
        finish(
          unavailableCertificate(error)
        );
      }
    );
  });
}

async function inspectOriginCertificate(
  domain,
  certificatePath
) {
  if (!certificatePath) {
    return unavailableCertificate(
      new Error(
        "No approved origin certificate path is configured."
      )
    );
  }

  try {
    const certificate =
      new X509Certificate(
        await fsp.readFile(
          certificatePath
        )
      );

    const hostMatch =
      certificate.checkHost(domain);

    const hostnameValid =
      Boolean(hostMatch);

    return {
      available: true,
      authorized: null,
      hostnameValid,
      state:
        certificateState(
          certificate.validTo,
          hostnameValid
        ),
      error:
        hostnameValid
          ? null
          : "The origin certificate does not match the application domain.",
      commonName:
        certificate.subject
          .split(/\n/)
          .find(
            (part) =>
              part.startsWith("CN=")
          )
          ?.slice(3) ||
        null,
      subject:
        certificate.subject || null,
      issuer:
        certificate.issuer || null,
      issuerCommonName:
        certificate.issuer
          .split(/\n/)
          .find(
            (part) =>
              part.startsWith("CN=")
          )
          ?.slice(3) ||
        null,
      issuerOrganization:
        certificate.issuer
          .split(/\n/)
          .find(
            (part) =>
              part.startsWith("O=")
          )
          ?.slice(2) ||
        null,
      validFrom:
        certificate.validFrom ||
        null,
      validTo:
        certificate.validTo ||
        null,
      daysRemaining:
        daysRemaining(
          certificate.validTo
        ),
      serialNumber:
        certificate.serialNumber ||
        null,
      fingerprint256:
        certificate.fingerprint256 ||
        null,
      subjectAlternativeName:
        certificate.subjectAltName ||
        null,
    };
  } catch (error) {
    return unavailableCertificate(error);
  }
}

function inspectLocalOriginCertificate(domain) {
  return new Promise((resolve) => {
    let finished = false;
    let socket = null;

    const finish = (result) => {
      if (finished) {
        return;
      }

      finished = true;

      if (socket) {
        socket.destroy();
      }

      resolve(result);
    };

    socket = tls.connect({
      host: "127.0.0.1",
      port: 443,
      servername: domain,
      rejectUnauthorized: false,
      timeout: TLS_TIMEOUT_MS,
    });

    socket.once("secureConnect", () => {
      const certificate =
        socket.getPeerCertificate(true);

      if (
        !certificate ||
        Object.keys(certificate).length === 0
      ) {
        finish(
          unavailableCertificate(
            new Error(
              "No local origin certificate was returned."
            )
          )
        );
        return;
      }

      const hostnameError =
        tls.checkServerIdentity(
          domain,
          certificate
        );
      const hostnameValid = !hostnameError;
      const validTo =
        certificate.valid_to || null;

      finish({
        available: true,
        authorized: null,
        hostnameValid,
        state: certificateState(
          validTo,
          hostnameValid
        ),
        error:
          hostnameError?.message || null,
        commonName:
          certificate.subject?.CN || null,
        subject:
          distinguishedName(
            certificate.subject
          ),
        issuer:
          distinguishedName(
            certificate.issuer
          ),
        issuerCommonName:
          certificate.issuer?.CN || null,
        issuerOrganization:
          certificate.issuer?.O || null,
        validFrom:
          certificate.valid_from || null,
        validTo,
        daysRemaining:
          daysRemaining(validTo),
        serialNumber:
          certificate.serialNumber || null,
        fingerprint256:
          certificate.fingerprint256 ||
          null,
        subjectAlternativeName:
          certificate.subjectaltname || null,
      });
    });

    socket.once("timeout", () => {
      finish(
        unavailableCertificate(
          new Error(
            `Local TLS inspection timed out after ${TLS_TIMEOUT_MS}ms.`
          )
        )
      );
    });

    socket.once("error", (error) => {
      finish(unavailableCertificate(error));
    });
  });
}

function parseProperties(value) {
  const result = {};

  for (
    const line
    of String(value || "").split(/\r?\n/)
  ) {
    if (!line.includes("=")) {
      continue;
    }

    const separator =
      line.indexOf("=");

    result[
      line.slice(0, separator)
    ] =
      line.slice(separator + 1);
  }

  return result;
}

async function systemctlProperties(
  unit,
  properties
) {
  try {
    const result =
      await execFileAsync(
        "systemctl",
        [
          "show",
          unit,
          "--no-pager",
          ...properties.map(
            (property) =>
              `--property=${property}`
          ),
        ],
        {
          timeout: 10000,
          maxBuffer:
            1024 * 1024,
        }
      );

    return {
      ...parseProperties(
        result.stdout
      ),
      error: null,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

async function loadNginxIndex() {
  const mappings =
    new Map();

  const redirects = [];

  let entries = [];

  try {
    entries =
      await fsp.readdir(
        NGINX_ENABLED_DIRECTORY,
        {
          withFileTypes: true,
        }
      );
  } catch {
    return {
      mappings,
      redirects,
    };
  }

  for (const entry of entries) {
    if (
      !entry.isFile() &&
      !entry.isSymbolicLink()
    ) {
      continue;
    }

    const siteFile =
      entry.name;

    const fullPath =
      path.join(
        NGINX_ENABLED_DIRECTORY,
        siteFile
      );

    let text = "";

    try {
      text =
        await fsp.readFile(
          fullPath,
          "utf8"
        );
    } catch {
      continue;
    }

    const serverNames =
      Array.from(
        text.matchAll(
          /^\s*server_name\s+([^;]+);/gm
        )
      )
        .flatMap(
          (match) =>
            match[1]
              .trim()
              .split(/\s+/)
        )
        .map(approvedDomain)
        .filter(Boolean);

    const certificatePaths =
      Array.from(
        text.matchAll(
          /^\s*ssl_certificate\s+([^;]+);/gm
        )
      )
        .map(
          (match) =>
            approvedCertificatePath(
              match[1]
            )
        )
        .filter(Boolean);

    const certificatePath =
      certificatePaths[0] ||
      null;

    for (
      const domain
      of serverNames
    ) {
      const current =
        mappings.get(domain);

      if (
        !current ||
        (
          !current.certificatePath &&
          certificatePath
        )
      ) {
        mappings.set(
          domain,
          {
            configured: true,
            siteFile,
            certificatePath,
          }
        );
      }
    }

    const redirectMatches =
      Array.from(
        text.matchAll(
          /^\s*return\s+(301|302|307|308)\s+https:\/\/([^\/$;]+)[^;]*;/gm
        )
      );

    for (
      const match
      of redirectMatches
    ) {
      const targetDomain =
        approvedDomain(match[2]);

      if (!targetDomain) {
        continue;
      }

      for (
        const sourceDomain
        of serverNames
      ) {
        if (
          sourceDomain === targetDomain
        ) {
          continue;
        }

        redirects.push({
          sourceDomain,
          targetDomain,
          statusCode:
            Number(match[1]),
          siteFile,
        });
      }
    }
  }

  return {
    mappings,
    redirects,
  };
}

async function loadApplications() {
  const result =
    await query(`
      SELECT
        id,
        name,
        domain,
        status
      FROM apps
      WHERE domain IS NOT NULL
        AND BTRIM(domain) <> ''
        AND status = 'active'
      ORDER BY name ASC
    `);

  return result.rows
    .map((app) => ({
      ...app,
      deploymentType:
        DEPLOYMENT_TYPE_BY_APP_ID.get(
          String(app.id || "")
            .trim()
            .toLowerCase()
        ) || "vps",
      domain:
        approvedDomain(app.domain),
    }))
    .filter(
      (app) =>
        Boolean(app.domain)
    );
}

async function buildSnapshot() {
  const checkedAt =
    new Date().toISOString();

  const [
    applications,
    nginxIndex,
    timerProperties,
    serviceProperties,
  ] =
    await Promise.all([
      loadApplications(),
      loadNginxIndex(),
      systemctlProperties(
        "certbot.timer",
        [
          "LoadState",
          "ActiveState",
          "SubState",
          "UnitFileState",
          "LastTriggerUSec",
          "NextElapseUSecRealtime",
        ]
      ),
      systemctlProperties(
        "certbot.service",
        [
          "LoadState",
          "ActiveState",
          "SubState",
          "Result",
          "ExecMainStatus",
          "ExecMainStartTimestamp",
          "ExecMainExitTimestamp",
        ]
      ),
    ]);

  const canonicalDomains =
    new Set(
      applications.map(
        (app) => app.domain
      )
    );

  const certificates =
    await Promise.all(
      applications.map(
        async (app) => {
          const platformManaged =
            app.deploymentType ===
            "sites";

          const nginx =
            platformManaged
              ? null
              : (
                  nginxIndex.mappings.get(
                    app.domain
                  ) ||
                  null
                );

          const fallbackPath =
            path.join(
              LETS_ENCRYPT_LIVE_DIRECTORY,
              app.domain,
              "fullchain.pem"
            );

          const originPath =
            platformManaged
              ? null
              : (
                  approvedCertificatePath(
                    nginx?.certificatePath
                  ) ||
                  (
                    fs.existsSync(
                      fallbackPath
                    )
                      ? fallbackPath
                      : null
                  )
                );

          const [
            publicTls,
            originTls,
          ] =
            await Promise.all([
              inspectPublicCertificate(
                app.domain
              ),
              inspectOriginCertificate(
                app.domain,
                originPath
              ),
            ]);

          const hostingTls =
            platformManaged
              ? managedCertificate()
              : (
                  originTls.available
                    ? originTls
                    : await inspectLocalOriginCertificate(
                        app.domain
                      )
                );

          return {
            appId: app.id,
            appName: app.name,
            domain: app.domain,
            registryStatus:
              app.status,
            deploymentType:
              app.deploymentType,
            publicTls,
            originTls:
              hostingTls,
            nginx: {
              configured:
                platformManaged ||
                Boolean(nginx),
              managedBy:
                platformManaged
                  ? "sites"
                  : "nginx",
              siteFile:
                nginx?.siteFile ||
                null,
              certificateConfigured:
                Boolean(originPath),
              certificateName:
                originPath
                  ? path.basename(
                      path.dirname(
                        originPath
                      )
                    )
                  : null,
              certificatePath:
                originPath,
            },
            checkedAt,
          };
        }
      )
    );

  const aliasKeys =
    new Set();

  const aliases =
    nginxIndex.redirects
      .filter(
        (alias) =>
          canonicalDomains.has(
            alias.targetDomain
          ) &&
          alias.sourceDomain !==
            alias.targetDomain
      )
      .filter((alias) => {
        const key =
          [
            alias.sourceDomain,
            alias.targetDomain,
            alias.statusCode,
          ].join("|");

        if (aliasKeys.has(key)) {
          return false;
        }

        aliasKeys.add(key);
        return true;
      })
      .sort(
        (left, right) =>
          left.sourceDomain.localeCompare(
            right.sourceDomain
          )
      );

  const publicValid =
    certificates.filter(
      (item) =>
        item.publicTls.state ===
        "valid"
    ).length;

  const originValid =
    certificates.filter(
      (item) =>
        item.originTls.state ===
        "valid"
    ).length;

  const platformManaged =
    certificates.filter(
      (item) =>
        item.originTls.state ===
        "managed"
    ).length;

  const attention =
    certificates.filter(
      (item) =>
        item.publicTls.state !==
          "valid" ||
        ![
          "valid",
          "managed",
        ].includes(
          item.originTls.state
        ) ||
        !item.nginx.configured
    ).length;

  return {
    source:
      "apps+hosting-classification+public-tls+origin-x509+nginx+systemd",
    checkedAt,
    cacheTtlMs:
      CACHE_TTL_MS,
    counts: {
      domains:
        certificates.length,
      publicValid,
      originValid,
      platformManaged,
      attention,
      aliases:
        aliases.length,
    },
    renewal: {
      timer: {
        loadState:
          timerProperties.LoadState ||
          null,
        activeState:
          timerProperties.ActiveState ||
          null,
        subState:
          timerProperties.SubState ||
          null,
        unitFileState:
          timerProperties.UnitFileState ||
          null,
        lastTrigger:
          timerProperties.LastTriggerUSec ||
          null,
        nextRun:
          timerProperties
            .NextElapseUSecRealtime ||
          null,
        error:
          timerProperties.error ||
          null,
      },
      lastRun: {
        loadState:
          serviceProperties.LoadState ||
          null,
        activeState:
          serviceProperties.ActiveState ||
          null,
        subState:
          serviceProperties.SubState ||
          null,
        result:
          serviceProperties.Result ||
          null,
        execMainStatus:
          serviceProperties
            .ExecMainStatus ??
          null,
        startedAt:
          serviceProperties
            .ExecMainStartTimestamp ||
          null,
        finishedAt:
          serviceProperties
            .ExecMainExitTimestamp ||
          null,
        error:
          serviceProperties.error ||
          null,
      },
    },
    aliases,
    certificates,
  };
}

async function getSslCertificatesSnapshot({
  force = false,
} = {}) {
  if (
    !force &&
    cachedSnapshot &&
    Date.now() < cacheExpiresAt
  ) {
    return cachedSnapshot;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight =
    buildSnapshot();

  try {
    const snapshot =
      await inFlight;

    cachedSnapshot =
      snapshot;

    cacheExpiresAt =
      Date.now() +
      CACHE_TTL_MS;

    return snapshot;
  } finally {
    inFlight = null;
  }
}

module.exports = {
  getSslCertificatesSnapshot,
};
