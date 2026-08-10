require("./telemetry/bootstrap");

const { runGoodCustomMigrations } = require("./runtime/goodcustom-migrations");
const { runGoodScanMigrations } = require("./runtime/goodscan-migrations");

runGoodCustomMigrations();
runGoodScanMigrations();

const app = require("./app");
const env = require("./config/env");
const database = require("./config/database");
const { attachRealtimeWebSocketServer } = require("./realtime/hub");
const { flushMetrics } = require("./enterprise/enterprise-foundation.service");
const { createShutdownController } = require("./runtime/graceful-shutdown");
const { shutdownTelemetry } = require("./telemetry/bootstrap");

const server = app.listen(env.port, "127.0.0.1", () => {
  console.log(`${env.serviceName} running on http://127.0.0.1:${env.port}`);
});

server.requestTimeout = env.requestTimeoutMs;
server.headersTimeout = env.headersTimeoutMs;
server.keepAliveTimeout = env.keepAliveTimeoutMs;
server.maxRequestsPerSocket = env.maxRequestsPerSocket;
server.maxHeadersCount = env.maxHeadersCount;

const realtimeServer = attachRealtimeWebSocketServer(server);
const shutdownController = createShutdownController({
  server,
  realtimeServer,
  pool: database.pool,
  flushMetrics,
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    void shutdownTelemetry();
    void shutdownController.shutdown(signal, 0);
  });
}

module.exports = server;
