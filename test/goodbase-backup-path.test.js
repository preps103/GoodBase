"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("the manual production backup uses the canonical GoodBase deployment path", () => {
  const routes = fs.readFileSync(
    path.join(__dirname, "../src/routes/admin.routes.js"),
    "utf8",
  );

  assert.match(
    routes,
    /const scriptPath = "\/var\/www\/GoodBase\/scripts\/create-db-backup\.sh";/,
  );
  assert.doesNotMatch(routes, /\/var\/www\/GoodAppBackEnd\/scripts\/create-db-backup\.sh/);
});
