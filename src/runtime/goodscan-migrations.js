"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

function shouldRun() {
  if (process.env.GOODSCAN_MIGRATIONS_ON_STARTUP === "0") return false;
  return process.env.NODE_ENV === "production" || process.env.GOODSCAN_MIGRATIONS_ON_STARTUP === "1";
}

function runGoodScanMigrations() {
  if (!shouldRun()) return { skipped: true };
  const script = path.join(__dirname, "..", "..", "scripts", "apply-goodscan-migration.js");
  const result = spawnSync(process.execPath, [script], { env: process.env, stdio: "inherit", timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`GoodScan migration exited with status ${result.status ?? "unknown"}.`);
  return { skipped: false };
}

module.exports = { runGoodScanMigrations, shouldRun };
