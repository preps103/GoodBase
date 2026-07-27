"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const CONTROL_COMMAND = "/usr/local/sbin/goodos-pm2-control";
const PROCESSES = ["goodbase-worker", "goodbase-api-ha", "goodbase-api"];

async function runControl(...args) {
  await execFileAsync("sudo", ["-n", CONTROL_COMMAND, ...args], {
    timeout: 2 * 60 * 1000,
    windowsHide: true,
  });
}

async function main() {
  await new Promise((resolve) => setTimeout(resolve, 750));
  for (const processName of PROCESSES) {
    await runControl("restart", processName);
  }
  await runControl("save");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
