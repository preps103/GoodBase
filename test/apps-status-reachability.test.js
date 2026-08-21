"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  deriveStatus,
  isReachableHttpStatus,
} = require("../src/services/apps-status.service");

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
