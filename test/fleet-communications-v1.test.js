"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodFleet communications API is authenticated and mounted on Base", () => {
  const routes = read("src/routes/fleet-communications.routes.js");
  const index = read("src/routes/index.js");
  assert.match(routes, /router\.use\(authRequired\)/);
  assert.match(routes, /tenantContext/);
  assert.match(index, /\/api\/fleet\/v1\/communications/);
});

test("Employee chat is tenant scoped, access checked, and idempotent", () => {
  const routes = read("src/routes/fleet-communications.routes.js");
  assert.match(routes, /channel\.organization_id=\$1/);
  assert.match(routes, /EMPLOYEE_ROLES/);
  assert.match(routes, /client_message_id/);
  assert.match(routes, /ON CONFLICT \(organization_id,sender_id,client_message_id\)/);
});

test("Customer notifications can only be read by their recipient identity", () => {
  const routes = read("src/routes/fleet-communications.routes.js");
  assert.match(routes, /notification\.recipient_user_id=\$1/);
  assert.match(routes, /lower\(notification\.recipient_email\)=lower\(\$2\)/);
  assert.match(routes, /CUSTOMER_SEND_ROLES/);
  assert.match(routes, /router\.get\("\/customer-account"/);
  assert.match(routes, /WHERE lower\(email\)=lower\(\$1\) AND archived_at IS NULL/);
  assert.match(routes, /customer_id=\$2/);
});

test("Communication schema contains read receipts, delivery state, and audit-ready ownership", () => {
  const migration = read("migrations/20260724_goodfleet_communications_v1.sql");
  assert.match(migration, /fleet_chat_reads/);
  assert.match(migration, /fleet_customer_notification_deliveries/);
  assert.match(migration, /client_request_id/);
  assert.match(migration, /created_by uuid NOT NULL REFERENCES users/);
});
