"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("backend console exposes user, business, and personal settings navigation", () => {
  const consoleHtml = read("src/public/console.html");
  assert.match(consoleHtml, /data-view="profile">User Profile/);
  assert.match(consoleHtml, /data-view="business-profile">Business Profile/);
  assert.match(consoleHtml, /data-view="preferences">My Settings/);
  assert.match(consoleHtml, /src="\/account-settings\.js(?:\?[^"]*)?"/);
});

test("account settings client wires profile, logo, preferences, password, sessions, and export APIs", () => {
  const client = read("src/public/account-settings.js");
  for (const endpoint of [
    "/api/settings/overview",
    "/api/settings/profile",
    "/api/settings/avatar",
    "/api/settings/business-profile",
    "/api/settings/business-logo",
    "/api/settings/preferences",
    "/api/settings/password",
    "/api/settings/sessions/",
    "/api/settings/export",
  ]) {
    assert.ok(client.includes(endpoint), `${endpoint} must be wired into the console`);
  }
});

test("account settings populate the expanded top-bar identity", () => {
  const client = read("src/public/account-settings.js");

  assert.match(client, /topbar-user-name/);
  assert.match(client, /topbar-user-role/);
  assert.match(client, /user\.avatarUrl/);
  assert.match(client, /user\.firstName/);
  assert.match(client, /user\.lastName/);
});

test("business profile migration includes managed logo and contact fields", () => {
  const migration = read("migrations/20260720_profile_business_settings.sql");
  for (const column of [
    "legal_name",
    "website_url",
    "business_email",
    "phone",
    "industry",
    "company_size",
    "address_line_1",
    "country_code",
    "logo_url",
    "logo_file_name",
    "logo_content_type",
    "logo_size_bytes",
    "logo_updated_at",
  ]) {
    assert.ok(migration.includes(column), `${column} must be persisted`);
  }
});
