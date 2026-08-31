"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applicationHealthUrl,
  deriveStatus,
  healthProbeUrl,
  isReachableHttpStatus,
} = require("../src/services/apps-status.service");

test("Sites health checks use the canonical published application URL", () => {
  assert.equal(
    applicationHealthUrl({
      deploymentType: "sites",
      domain: "supply.goodos.app",
      healthUrl: "https://supply.goodos.app/api/ready",
    }),
    "https://supply.goodos.app"
  );

  assert.equal(
    applicationHealthUrl({
      deploymentType: "sites",
      domain: "trust.goodos.app",
      healthUrl: "https://trust.goodos.app/api/ready",
    }),
    "https://trust.goodos.app"
  );
});

test("Sites probes preserve the exact canonical URL", () => {
  assert.equal(
    healthProbeUrl(
      "https://trust.goodos.app",
      { cacheBust: false }
    ).toString(),
    "https://trust.goodos.app/"
  );

  assert.match(
    healthProbeUrl(
      "https://base.goodos.app/api/health/ready"
    ).search,
    /^\?_goodos_status=\d+$/
  );
});

test("health monitoring treats authentication gates as reachable", () => {
  assert.equal(isReachableHttpStatus(200), true);
  assert.equal(isReachableHttpStatus(302), true);
  assert.equal(isReachableHttpStatus(401), true);
  assert.equal(isReachableHttpStatus(403), true);
});

test("health monitoring still rejects missing and failing services", () => {
  assert.equal(isReachableHttpStatus(404), false);
  assert.equal(isReachableHttpStatus(500), false);
  assert.equal(isReachableHttpStatus(503), false);
});

test("Sites frontends are evaluated by HTTPS instead of a PM2 process", () => {
  const app = {
    registryStatus: "active",
    deploymentType: "sites",
  };

  assert.equal(
    deriveStatus(
      app,
      null,
      {
        url: "https://builder.goodos.app/",
        ok: true,
        responseMs: 120,
      }
    ),
    "online"
  );
  assert.equal(
    deriveStatus(
      app,
      null,
      {
        url: "https://scan.goodos.app/",
        ok: true,
        responseMs: 5076,
      }
    ),
    "online",
    "a single successful Sites cold start must not create a degraded alert"
  );
  assert.equal(
    deriveStatus(
      app,
      null,
      {
        url: "https://supply.goodos.app/",
        ok: false,
        responseMs: 120,
      }
    ),
    "offline"
  );
});

test("reachable VPS applications stay online while deployment metadata is active", () => {
  const app = {
    registryStatus: "active",
    deploymentType: "vps",
    deploymentStatus: "deploying",
    lastRunStatus: "running",
  };

  assert.equal(
    deriveStatus(
      app,
      null,
      {
        url: "https://base.goodos.app/api/health/ready",
        ok: true,
        responseMs: 104,
      }
    ),
    "online",
    "deployment state must not override a successful public health check"
  );
});

test("unreachable VPS applications still report an active deployment", () => {
  const app = {
    registryStatus: "active",
    deploymentType: "vps",
    deploymentStatus: "deploying",
    lastRunStatus: "running",
  };

  assert.equal(
    deriveStatus(
      app,
      null,
      {
        url: "https://base.goodos.app/api/health/ready",
        ok: false,
        responseMs: 104,
      }
    ),
    "deploying"
  );
});
