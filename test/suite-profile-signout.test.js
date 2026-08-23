"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const widget = fs.readFileSync(
  path.join(root, "vendor/goodos-topbar-widget/index.js"),
  "utf8"
);

test("canonical top bar exposes a profile-image sign-out menu", () => {
  assert.match(widget, /UniversalProfileMenu/);
  assert.match(widget, /data-goodos-profile-menu/);
  assert.match(widget, /Open user profile menu/);
  assert.match(widget, /api\/auth\/logout/);
  assert.match(widget, /Sign out/);
  assert.match(widget, /credentials:\s*"include"/);
  assert.match(widget, /window\.location\.replace/);
});
