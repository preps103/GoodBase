"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
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
