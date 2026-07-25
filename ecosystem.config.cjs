const { execFileSync } = require("child_process");

const cwd = "/var/www/GoodBase";
const runtimeUser = "goodapp";
function releaseCommit() {
  try {
    return execFileSync("git", ["-C", __dirname, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "0000000";
  }
}
const runtimeEnv = {
  NODE_ENV: "production",
  GOODBASE_RELEASE_COMMIT: releaseCommit(),
  GOODOS_VOICE_DB_PATH: "/var/lib/goodapp-backend/goodos-voice-db.json",
  GOODBASE_SYMBOL_STORAGE_ROOT: "/var/lib/goodapp-backend/symbols",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
  OTEL_METRIC_EXPORT_INTERVAL: "15000"
};

const serviceDefaults = {
  cwd,
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  min_uptime: "10s",
  max_restarts: 10,
  max_memory_restart: "512M",
  kill_timeout: 10000,
  uid: runtimeUser,
  gid: runtimeUser
};

module.exports = {
  apps: [
    {
      ...serviceDefaults,
      name: "goodbase-api",
      script: "src/server.js",
      env: {
        ...runtimeEnv,
        OTEL_SERVICE_NAME: "goodbase-api",
        GOODBASE_RUNTIME_ROLE: "api",
        PORT: 8001
      }
    },
    {
      ...serviceDefaults,
      name: "goodbase-api-ha",
      script: "src/server.js",
      env: {
        ...runtimeEnv,
        OTEL_SERVICE_NAME: "goodbase-api-ha",
        GOODBASE_RUNTIME_ROLE: "api",
        PORT: 8002
      }
    },
    {
      ...serviceDefaults,
      name: "goodbase-worker",
      script: "src/workers/goodapp-worker-v3.js",
      env: {
        ...runtimeEnv,
        OTEL_SERVICE_NAME: "goodbase-worker",
        GOODBASE_RUNTIME_ROLE: "worker"
      }
    }
  ]
};
