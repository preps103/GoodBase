"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("application access manager replaces enforced app memberships atomically", () => {
  const service = read("src/services/roles-console.service.js");
  const routes = read("src/routes/roles-console.routes.js");

  assert.match(routes, /application-access\/:targetUserId/);
  assert.match(service, /replaceApplicationAccessForUser/);
  assert.match(service, /UPDATE app_memberships/);
  assert.match(service, /ON CONFLICT \(user_id, app_id\)/);
  assert.match(service, /application_access\.replaced/);
  assert.match(service, /await client\.query\("BEGIN"\)/);
  assert.match(service, /await client\.query\("COMMIT"\)/);
});
