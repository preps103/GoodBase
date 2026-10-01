"use strict";

const { execFile } = require("child_process");
const http = require("http");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const CONTROL_COMMAND = "/usr/local/sbin/goodos-pm2-control";
const STARTUP_SETTLE_MS = 750;
const READINESS_INTERVAL_MS = 500;
const READINESS_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 3_000;
const READY_ENDPOINTS = Object.freeze({
  "goodbase-api": "http://127.0.0.1:8001/api/health/ready",
  "goodbase-api-ha": "http://127.0.0.1:8002/api/health/ready",
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runControl(...args) {
  return execFileAsync("sudo", ["-n", CONTROL_COMMAND, ...args], {
    timeout: 2 * 60 * 1000,
    windowsHide: true,
  });
}

function probeReadiness(url, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: requestTimeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });

    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

async function waitForReadiness(processName, url, options = {}) {
  const probe = options.probe || probeReadiness;
  const sleep = options.sleep || delay;
  const timeoutMs = options.timeoutMs ?? READINESS_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? READINESS_INTERVAL_MS;
  const startedAt = Date.now();

  do {
    if (await probe(url)) return;
    if (Date.now() - startedAt >= timeoutMs) break;
    await sleep(intervalMs);
  } while (true);

  throw new Error(`${processName} did not become ready within ${timeoutMs}ms.`);
}

async function restartGoodBaseServices(options = {}) {
  const control = options.control || runControl;
  const wait = options.wait || waitForReadiness;
  const sleep = options.sleep || delay;

  await sleep(STARTUP_SETTLE_MS);
  await control("restart", "goodbase-worker");
  await sleep(STARTUP_SETTLE_MS);

  // Keep the primary serving traffic until the secondary is confirmed ready.
  await wait("goodbase-api", READY_ENDPOINTS["goodbase-api"]);
  await control("restart", "goodbase-api-ha");
  await wait("goodbase-api-ha", READY_ENDPOINTS["goodbase-api-ha"]);

  // Only restart the primary after the secondary can accept traffic.
  await control("restart", "goodbase-api");
  await wait("goodbase-api", READY_ENDPOINTS["goodbase-api"]);
  await control("save");
}

if (require.main === module) {
  restartGoodBaseServices().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  READY_ENDPOINTS,
  probeReadiness,
  restartGoodBaseServices,
  waitForReadiness,
};
