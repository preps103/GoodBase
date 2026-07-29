"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const startupMigrations = require("../src/runtime/goodcustom-migrations");

test("GoodCustom startup verifies chat and quote storage before serving production traffic", () => {
  assert.deepEqual(startupMigrations.MIGRATIONS, [
    "apply-goodcustom-chat-migration.js",
    "apply-goodcustom-quotes-migration.js",
  ]);

  const server = fs.readFileSync(
    path.join(__dirname, "../src/server.js"),
    "utf8",
  );
  assert.match(server, /runGoodCustomMigrations\(\);[\s\S]+app\.listen/);
});

test("GoodCustom startup migrations run only in production or when explicitly enabled", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOverride = process.env.GOODCUSTOM_MIGRATIONS_ON_STARTUP;
  try {
    process.env.NODE_ENV = "test";
    delete process.env.GOODCUSTOM_MIGRATIONS_ON_STARTUP;
    assert.equal(startupMigrations.shouldRun(), false);

    process.env.GOODCUSTOM_MIGRATIONS_ON_STARTUP = "1";
    assert.equal(startupMigrations.shouldRun(), true);

    process.env.GOODCUSTOM_MIGRATIONS_ON_STARTUP = "0";
    process.env.NODE_ENV = "production";
    assert.equal(startupMigrations.shouldRun(), false);

    delete process.env.GOODCUSTOM_MIGRATIONS_ON_STARTUP;
    assert.equal(startupMigrations.shouldRun(), true);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousOverride === undefined) delete process.env.GOODCUSTOM_MIGRATIONS_ON_STARTUP;
    else process.env.GOODCUSTOM_MIGRATIONS_ON_STARTUP = previousOverride;
  }
});
