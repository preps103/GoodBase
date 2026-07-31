"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const routes = fs.readFileSync(
  path.join(__dirname, "..", "src", "routes", "fleet.routes.js"),
  "utf8"
);

test("GoodFleet customer deletion is management-only and preserves history", () => {
  assert.match(routes, /const CUSTOMER_DELETE_ROLES = new Set\(\["owner", "admin", "manager"\]\)/);
  assert.match(routes, /router\.delete\("\/customers\/:customerId", requireCustomerManager/);
  assert.match(routes, /CUSTOMER_DELETE_ACCESS_REQUIRED/);
  assert.match(routes, /CUSTOMER_HAS_ACTIVE_BOOKING/);
  assert.match(routes, /archived_at=NOW\(\)/);
  assert.match(routes, /customer\.archived/);
});
