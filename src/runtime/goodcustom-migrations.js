"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MIGRATIONS = [
  "apply-goodcustom-chat-migration.js",
  "apply-goodcustom-quotes-migration.js",
];

function shouldRun() {
  if (process.env.GOODCUSTOM_MIGRATIONS_ON_STARTUP === "0") return false;
  return process.env.NODE_ENV === "production"
    || process.env.GOODCUSTOM_MIGRATIONS_ON_STARTUP === "1";
}

function runGoodCustomMigrations() {
  if (!shouldRun()) return { skipped: true, migrations: [] };

  const completed = [];
  for (const migration of MIGRATIONS) {
    const script = path.join(__dirname, "..", "..", "scripts", migration);
    const result = spawnSync(process.execPath, [script], {
      env: process.env,
      stdio: "inherit",
      timeout: 120_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${migration} exited with status ${result.status ?? "unknown"}.`);
    }
    completed.push(migration);
  }

  return { skipped: false, migrations: completed };
}

module.exports = {
  MIGRATIONS,
  runGoodCustomMigrations,
  shouldRun,
};
