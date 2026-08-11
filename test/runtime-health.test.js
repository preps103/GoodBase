"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createLifecycleState } = require("../src/runtime/lifecycle");
const { runReadinessChecks } = require("../src/services/readiness.service");
const { createShutdownController } = require("../src/runtime/graceful-shutdown");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function healthyQuery(sql) {
  if (sql.includes("backend_worker_heartbeats")) {
    return Promise.resolve({ rows: [{ activeWorkers: 1 }] });
  }
  return Promise.resolve({ rows: [{ ready: 1 }] });
}

function healthyFetch() {
  return Promise.resolve({
    ok: true,
    status: 200,
    body: { cancel: async () => {} },
  });
}

test("runtime readiness validates critical dependencies", async () => {
  const readiness = await runReadinessChecks({
    queryFn: healthyQuery,
    fetchFn: healthyFetch,
    lifecycle: createLifecycleState(),
    goodSpeechRequired: false,
    kokoroUrl: "",
    kokoroToken: "",
  });

  assert.equal(readiness.status, "ready");
  assert.equal(readiness.trafficReady, true);
  assert.deepEqual(
    readiness.checks.map((check) => check.name),
    ["runtime", "postgresql", "automatic-rest", "background-worker"]
  );
});

test("draining instances immediately fail readiness", async () => {
  const lifecycle = createLifecycleState();
  lifecycle.beginDrain("SIGTERM");

  const readiness = await runReadinessChecks({
    queryFn: healthyQuery,
    fetchFn: healthyFetch,
    lifecycle,
  });

  assert.equal(readiness.status, "unready");
  assert.equal(readiness.trafficReady, false);
  assert.equal(readiness.lifecycle.shutdownSignal, "SIGTERM");
});

test("critical automatic REST failure makes the instance unready", async () => {
  const readiness = await runReadinessChecks({
    queryFn: healthyQuery,
    fetchFn: async () => ({ ok: false, status: 503 }),
    lifecycle: createLifecycleState(),
  });

  assert.equal(readiness.status, "unready");
  assert.equal(readiness.trafficReady, false);
  assert.equal(
    readiness.checks.find((check) => check.name === "automatic-rest").status,
    "down"
  );
});

test("worker degradation is visible without removing a request-serving instance", async () => {
  const readiness = await runReadinessChecks({
    queryFn: async (sql) => sql.includes("backend_worker_heartbeats")
      ? { rows: [{ activeWorkers: 0 }] }
      : { rows: [{ ready: 1 }] },
    fetchFn: healthyFetch,
    lifecycle: createLifecycleState(),
  });

  assert.equal(readiness.status, "degraded");
  assert.equal(readiness.trafficReady, true);
});

test("required GoodSpeech inference participates in traffic readiness", async () => {
  const authorization = `Bearer ${"k".repeat(32)}`;
  const ready = await runReadinessChecks({
    queryFn: healthyQuery,
    fetchFn: async (url, options) => {
      if (String(url).includes(":8880/health/ready")) {
        assert.equal(options.headers.Authorization, authorization);
      }
      return healthyFetch();
    },
    lifecycle: createLifecycleState(),
    goodSpeechRequired: true,
    kokoroUrl: "http://127.0.0.1:8880",
    kokoroToken: "k".repeat(32),
  });
  assert.equal(ready.checks.find((check) => check.name === "goodspeech-kokoro").status, "ready");
  assert.equal(ready.trafficReady, true);

  const unavailable = await runReadinessChecks({
    queryFn: healthyQuery,
    fetchFn: healthyFetch,
    lifecycle: createLifecycleState(),
    goodSpeechRequired: true,
    kokoroUrl: "",
    kokoroToken: "",
  });
  assert.equal(unavailable.checks.find((check) => check.name === "goodspeech-kokoro").status, "degraded");
  assert.equal(unavailable.trafficReady, false);
});

test("graceful shutdown drains traffic and closes runtime resources", async () => {
  const events = [];
  const lifecycle = createLifecycleState();
  const realtimeClient = { close: () => events.push("realtime-client") };
  const controller = createShutdownController({
    lifecycle,
    timeoutMs: 1000,
    server: {
      close: (callback) => {
        events.push("http");
        callback();
      },
      closeIdleConnections: () => events.push("idle"),
    },
    realtimeServer: {
      clients: new Set([realtimeClient]),
      close: (callback) => {
        events.push("realtime-server");
        callback();
      },
    },
    pool: { end: async () => events.push("database") },
    flushMetrics: async () => events.push("metrics"),
    logger: { info: () => {}, error: () => {} },
    exit: (code) => events.push(`exit:${code}`),
  });

  await controller.shutdown("SIGTERM", 0);

  assert.equal(lifecycle.isDraining(), true);
  for (const event of ["http", "idle", "realtime-client", "realtime-server", "metrics", "database", "exit:0"]) {
    assert.ok(events.includes(event), `${event} should occur during shutdown`);
  }
});

test("health routes preserve compatibility and expose live and ready probes", () => {
  const routes = read("src/routes/health.routes.js");
  const index = read("src/routes/index.js");
  const server = read("src/server.js");

  assert.match(routes, /router\.get\("\/live"/);
  assert.match(routes, /router\.get\("\/ready"/);
  assert.match(index, /router\.use\("\/api\/health", healthRoutes\)/);
  assert.match(server, /createShutdownController/);
});
