const express = require("express");
const env = require("../config/env");
const { success } = require("../utils/response");
const { runtimeLifecycle } = require("../runtime/lifecycle");
const { runReadinessChecks } = require("../services/readiness.service");

const router = express.Router();

router.get("/", (req, res) => {
  return success(res, {
    service: env.serviceName,
    status: "ok",
    environment: env.nodeEnv,
    version: env.version,
    releaseCommit: env.releaseCommit,
    ...runtimeLifecycle.snapshot(),
  });
});

router.get("/live", (req, res) => {
  return success(res, {
    service: env.serviceName,
    status: "alive",
    environment: env.nodeEnv,
    version: env.version,
    releaseCommit: env.releaseCommit,
    ...runtimeLifecycle.snapshot(),
    timestamp: new Date().toISOString(),
  });
});

router.get("/ready", async (req, res, next) => {
  try {
    const readiness = await runReadinessChecks();
    return res.status(readiness.trafficReady ? 200 : 503).json({
      success: readiness.trafficReady,
      service: env.serviceName,
      version: env.version,
      releaseCommit: env.releaseCommit,
      ...readiness,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
