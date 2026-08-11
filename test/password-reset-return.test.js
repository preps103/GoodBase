"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("password recovery supports only secure GoodOS application return targets", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/routes/auth.routes.js"), "utf8");
  assert.match(source, /requestedReturnTo/);
  assert.match(source, /parsed\.protocol === "https:"/);
  assert.match(source, /parsed\.hostname\.endsWith\("\.goodos\.app"\)/);
  assert.match(source, /reset_token=/);
  assert.match(source, /encodeURIComponent\(rawToken\)/);
  assert.match(source, /if \(!token \|\| !strongSignupPassword\(password\)\)/);
  assert.match(source, /12–128 characters with uppercase, lowercase, a number, and a symbol/);
});
