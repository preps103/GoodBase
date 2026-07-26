"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("GoodAds authentication responses use the canonical GoodBase origin", () => {
  for (const relativePath of [
    "src/middleware/authRequired.js",
    "src/middleware/phase2-security.js",
    "src/routes/auth.routes.js",
  ]) {
    const contents = source(relativePath);
    assert.match(contents, /https:\/\/base\.goodos\.app\/mfa-enroll/);
  }
});

test("GoodAds production service validates status before database writes", () => {
  const contents = source("src/services/goodads.service.js");
  assert.match(contents, /const RESOURCE_STATUSES = new Set/);
  assert.match(contents, /requireResourceStatus\(data\.status \|\| "draft"\)/);
});

test("GoodAds routes do not expose unexpected production exceptions", () => {
  const contents = source("src/routes/goodads.routes.js");
  assert.match(contents, /const operational = Number\.isInteger\(requestError\.statusCode\)/);
  assert.match(contents, /"The GoodAds request could not be completed\."/);
});
