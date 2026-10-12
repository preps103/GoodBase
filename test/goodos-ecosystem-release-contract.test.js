"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const manifest = require("../deploy/application-paths.json");

test("the GoodOS ecosystem is managed as one thirty-application release contract", () => {
  const active = manifest.applications.filter((application) => application.status === "active");
  assert.equal(active.length, 30);
  assert.equal(manifest.ecosystemRelease.managementMode, "goodbase-control-plane");
  assert.equal(manifest.ecosystemRelease.hostingContract, "sites");
  assert.equal(manifest.ecosystemRelease.allowIndependentDeployments, false);
  assert.equal(manifest.ecosystemRelease.sharedWidgetRequired, true);
  assert.equal(manifest.ecosystemRelease.requiredApplicationCount, 30);
  assert.equal(manifest.canonicalLogin.version, "4.20.1");
  for (const application of active) {
    assert.equal(application.deploymentManaged, true, `${application.name} must be control-plane managed`);
    assert.equal(application.deploymentType, "sites", `${application.name} must use the Sites hosting contract`);
    assert.equal(application.canonicalLoginRequired, true, `${application.name} must use the shared GoodOS widget`);
  }
});
