"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applicationHealthUrl,
  deriveStatus,
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
        url: "https://supply.goodos.app/",
        ok: false,
        responseMs: 120,
      }
    ),
    "offline"
  );
});
