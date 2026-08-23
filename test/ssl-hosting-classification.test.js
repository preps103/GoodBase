"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Sites applications use platform-managed TLS instead of VPS Certbot checks", () => {
  const service = read("src/services/ssl-certificates.service.js");

  assert.match(service, /application-paths\.json/);
  assert.match(service, /app\.deploymentType ===\s*"sites"/);
  assert.match(service, /state:\s*"managed"/);
  assert.match(service, /platformManaged/);
  assert.match(service, /hosting-classification/);
  assert.match(service, /DEPLOYMENT_TYPE_BY_DOMAIN/);
  assert.match(service, /inspectLocalOriginCertificate/);
  assert.match(service, /host:\s*"127\.0\.0\.1"/);
  assert.match(service, /tls\.checkServerIdentity/);
});

test("revoked API keys have an audited permanent-delete contract", () => {
  const service = read("src/services/api-access.service.js");
  const routes = read("src/routes/api-access.routes.js");

  assert.match(service, /Only a revoked API key can be permanently deleted/);
  assert.match(service, /api_key\.deleted/);
  assert.match(routes, /router\.delete\(/);
  assert.match(routes, /deleteRevokedKeyForUser/);
});
