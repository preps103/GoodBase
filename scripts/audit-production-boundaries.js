"use strict";

const manifest = require("../deploy/application-paths.json");

const BASE_URL = String(
  process.env.GOODBASE_AUDIT_BASE_URL || "https://base.goodos.app"
).replace(/\/+$/, "");
const TIMEOUT_MS = Math.max(
  2000,
  Math.min(Number(process.env.GOODBASE_AUDIT_TIMEOUT_MS) || 15000, 30000)
);

const applications = [
  ...(manifest.applications || []),
  ...(manifest.platformServices || []),
  ...(manifest.sharedServices || []),
].filter((application) => application.status === "active" && application.domain);

function reachableStatus(status) {
  return (status >= 200 && status < 400) || status === 401 || status === 403;
}

function securityHeaders(headers) {
  const csp = headers.get("content-security-policy") || "";
  return {
    hsts: /max-age=/i.test(headers.get("strict-transport-security") || ""),
    csp: /(?:default-src|script-src)/i.test(csp),
    noSniff: /nosniff/i.test(headers.get("x-content-type-options") || ""),
    referrerPolicy: Boolean(headers.get("referrer-policy")),
    permissionsPolicy: Boolean(headers.get("permissions-policy")),
    frameProtection:
      /frame-ancestors/i.test(csp) || Boolean(headers.get("x-frame-options")),
  };
}

async function probeApplication(application) {
  const origin = `https://${application.domain}`;
  const startedAt = Date.now();

  try {
    const response = await fetch(origin, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "GoodBase-Production-Boundary-Audit/1.0" },
    });
    const result = {
      id: application.id,
      name: application.name,
      origin,
      finalUrl: response.url,
      status: response.status,
      responseMs: Date.now() - startedAt,
      reachable: reachableStatus(response.status),
      security: securityHeaders(response.headers),
      error: null,
    };
    await response.body?.cancel();
    return result;
  } catch (error) {
    return {
      id: application.id,
      name: application.name,
      origin,
      finalUrl: null,
      status: null,
      responseMs: Date.now() - startedAt,
      reachable: false,
      security: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeCors(application) {
  const origin = `https://${application.domain}`;

  try {
    const response = await fetch(`${BASE_URL}/api/auth/session`, {
      method: "OPTIONS",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    const allowedOrigin = response.headers.get("access-control-allow-origin");
    const allowsCredentials =
      response.headers.get("access-control-allow-credentials") === "true";
    await response.body?.cancel();
    return {
      id: application.id,
      origin,
      status: response.status,
      allowedOrigin,
      allowsCredentials,
      ok:
        reachableStatus(response.status) &&
        allowedOrigin === origin &&
        allowsCredentials,
      error: null,
    };
  } catch (error) {
    return {
      id: application.id,
      origin,
      status: null,
      allowedOrigin: null,
      allowsCredentials: false,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeBackend(pathname) {
  const startedAt = Date.now();
  const url = `${BASE_URL}${pathname}`;

  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "GoodBase-Production-Boundary-Audit/1.0" },
    });
    const body = await response.json().catch(() => null);
    return {
      url,
      status: response.status,
      responseMs: Date.now() - startedAt,
      ok: response.ok && body?.success !== false,
      releaseCommit: body?.releaseCommit || null,
      error: body?.message || null,
    };
  } catch (error) {
    return {
      url,
      status: null,
      responseMs: Date.now() - startedAt,
      ok: false,
      releaseCommit: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const [live, ready, applicationResults, corsResults] = await Promise.all([
    probeBackend("/api/health/live"),
    probeBackend("/api/health/ready"),
    Promise.all(applications.map(probeApplication)),
    Promise.all(applications.map(probeCors)),
  ]);

  const corsById = new Map(corsResults.map((result) => [result.id, result]));
  const rows = applicationResults.map((result) => {
    const cors = corsById.get(result.id);
    const securityPassed = result.security
      ? Object.values(result.security).filter(Boolean).length
      : 0;
    return {
      application: result.name,
      status: result.status || "ERR",
      responseMs: result.responseMs,
      reachable: result.reachable ? "yes" : "no",
      backendCors: cors?.ok ? "yes" : "no",
      securityHeaders: `${securityPassed}/6`,
    };
  });

  console.log(`GoodBase live: ${live.ok ? "PASS" : "FAIL"} (${live.status || "ERR"})`);
  console.log(`GoodBase ready: ${ready.ok ? "PASS" : "FAIL"} (${ready.status || "ERR"})`);
  console.table(rows);

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    backend: { live, ready },
    applications: applicationResults,
    cors: corsResults,
    summary: {
      applications: applications.length,
      reachable: applicationResults.filter((result) => result.reachable).length,
      backendCorsReady: corsResults.filter((result) => result.ok).length,
      fullSecurityHeaders: applicationResults.filter(
        (result) =>
          result.security && Object.values(result.security).every(Boolean)
      ).length,
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (
    !live.ok ||
    !ready.ok ||
    applicationResults.some((result) => !result.reachable) ||
    corsResults.some((result) => !result.ok)
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
