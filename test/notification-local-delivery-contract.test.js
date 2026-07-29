"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "services", "notification.service.js"),
  "utf8"
);

test("company email delivery uses the local mail transport", () => {
  assert.match(source, /isLocalCompanyRecipient/);
  assert.match(source, /goodos\\?\.app/);
  assert.match(source, /ghostcreationz\\?\.com/);
  assert.match(source, /host: "127\.0\.0\.1"/);
  assert.match(source, /port: 25/);
  assert.match(source, /ignoreTLS: true/);
  assert.match(source, /selectedTransporter\.sendMail/);
  assert.match(source, /connectionTimeout: 10000/);
  assert.match(source, /socketTimeout: 20000/);
  assert.match(source, /error_message = NULL/);
});
