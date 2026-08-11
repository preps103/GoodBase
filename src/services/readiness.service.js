"use strict";

const database = require("../config/database");
const { runtimeLifecycle } = require("../runtime/lifecycle");

const POSTGREST_HOST = process.env.GOODOS_POSTGREST_HOST || "127.0.0.1";
const POSTGREST_PORT = Number(process.env.GOODOS_POSTGREST_PORT || 8300);

function elapsedMilliseconds(started) {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function booleanSetting(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return String(value).toLowerCase() === "true";
}

async function runCheck({ name, type, critical, action }) {
  const started = process.hrtime.bigint();

  try {
    const result = await action();
    const ready = result?.ready !== false;

    return {
      name,
      type,
      critical,
      status: ready ? "ready" : "degraded",
      latencyMs: Number(elapsedMilliseconds(started).toFixed(2)),
      message: result?.message || (ready ? `${name} is ready.` : `${name} is degraded.`),
    };
  } catch {
    return {
      name,
      type,
      critical,
      status: "down",
      latencyMs: Number(elapsedMilliseconds(started).toFixed(2)),
      message: `${name} did not pass its readiness check.`,
    };
  }
}

async function runReadinessChecks({
  queryFn = database.query,
  fetchFn = global.fetch,
  lifecycle = runtimeLifecycle,
  postgrestRequired = booleanSetting(process.env.GOODOS_POSTGREST_REQUIRED, true),
  workerRequired = booleanSetting(process.env.GOODOS_WORKER_REQUIRED, false),
  goodSpeechRequired = booleanSetting(process.env.GOODSPEECH_REQUIRED, false),
  kokoroUrl = String(process.env.KOKORO_TTS_URL || "").trim(),
  kokoroToken = String(process.env.KOKORO_TTS_TOKEN || "").trim(),
} = {}) {
  const lifecycleState = lifecycle.snapshot();
  const checks = [];

  checks.push({
    name: "runtime",
    type: "process",
    critical: true,
    status: lifecycleState.draining ? "down" : "ready",
    latencyMs: 0,
    message: lifecycleState.draining
      ? "The instance is draining and cannot accept new traffic."
      : "The instance is accepting traffic.",
  });

  checks.push(await runCheck({
    name: "postgresql",
    type: "database",
    critical: true,
    action: async () => {
      await queryFn("SELECT 1 AS ready");
      return { message: "PostgreSQL accepted a readiness query." };
    },
  }));

  if (goodSpeechRequired || kokoroUrl) {
    checks.push(await runCheck({
      name: "goodspeech-kokoro",
      type: "inference",
      critical: goodSpeechRequired,
      action: async () => {
        if (!kokoroUrl || kokoroToken.length < 32 || typeof fetchFn !== "function") {
          return { ready: false, message: "GoodSpeech Kokoro is not configured." };
        }
        const endpoint = new URL(kokoroUrl);
        if (!["http:", "https:"].includes(endpoint.protocol)) {
          return { ready: false, message: "GoodSpeech Kokoro has an invalid endpoint." };
        }
        endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/health/ready`;
        endpoint.search = "";
        endpoint.hash = "";
        const response = await fetchFn(endpoint.toString(), {
          signal: AbortSignal.timeout(2500),
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${kokoroToken}`,
            "X-GoodBase-Service": "GoodSpeech",
          },
        });
        if (!response.ok) throw new Error("Kokoro is unavailable");
        await response.body?.cancel?.();
        return { message: `GoodSpeech Kokoro returned HTTP ${response.status}.` };
      },
    }));
  }

  checks.push(await runCheck({
    name: "automatic-rest",
    type: "data-api",
    critical: postgrestRequired,
    action: async () => {
      if (typeof fetchFn !== "function") throw new Error("Fetch is unavailable");

      const response = await fetchFn(`http://${POSTGREST_HOST}:${POSTGREST_PORT}/`, {
        signal: AbortSignal.timeout(2500),
        headers: { Accept: "application/openapi+json, application/json" },
      });

      if (!response.ok) throw new Error("Automatic REST is unavailable");
      await response.body?.cancel?.();
      return { message: `Automatic REST returned HTTP ${response.status}.` };
    },
  }));

  checks.push(await runCheck({
    name: "background-worker",
    type: "worker",
    critical: workerRequired,
    action: async () => {
      const result = await queryFn(`
        SELECT COUNT(*)::integer AS "activeWorkers"
        FROM backend_worker_heartbeats
        WHERE status = 'online'
          AND last_seen_at >= NOW() - INTERVAL '2 minutes'
      `);
      const activeWorkers = Number(result.rows?.[0]?.activeWorkers || 0);

      return {
        ready: activeWorkers > 0,
        message: activeWorkers > 0
          ? `${activeWorkers} background worker${activeWorkers === 1 ? " is" : "s are"} online.`
          : "No current background-worker heartbeat was found.",
      };
    },
  }));

  const criticalChecks = checks.filter((check) => check.critical);
  const trafficReady = criticalChecks.every((check) => check.status === "ready");
  const degraded = checks.some((check) => check.status !== "ready");

  return {
    status: trafficReady ? (degraded ? "degraded" : "ready") : "unready",
    trafficReady,
    checkedAt: new Date().toISOString(),
    lifecycle: lifecycleState,
    checks,
  };
}

module.exports = {
  booleanSetting,
  runCheck,
  runReadinessChecks,
};
