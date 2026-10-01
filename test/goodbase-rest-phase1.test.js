const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("Goodbase Phase 1 adds production REST registries and a request ledger", () => {
  const migration = read("migrations/20260720_goodbase_rest_phase1.sql");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS backend_data_plane_publications/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS backend_data_plane_request_logs/);
  assert.match(migration, /backend_data_plane_publications_name_unique/);
  assert.match(migration, /NOTIFY pgrst, 'reload schema'/);
  assert.match(migration, /https:\/\/base\.goodos\.app\/rest\/v1/);
});

test("Goodbase REST gateway is bounded, audited, and publication-controlled", () => {
  const gateway = read("src/routes/data-plane.routes.js");

  assert.match(gateway, /GOODBASE_REST_MAX_QUERY_BYTES/);
  assert.match(gateway, /GOODBASE_REST_MAX_BODY_BYTES/);
  assert.match(gateway, /GOODBASE_REST_MAX_RESPONSE_BYTES/);
  assert.match(gateway, /backend_data_plane_request_logs/);
  assert.match(gateway, /controlRouter\.get\(\s*"\/readiness"/);
  assert.match(gateway, /controlRouter\.get\(\s*"\/publications"/);
  assert.match(gateway, /controlRouter\.post\(\s*"\/publications"/);
  assert.match(gateway, /controlRouter\.post\(\s*"\/schema-cache\/reload"/);
  assert.match(gateway, /Row Level Security must be enabled before publishing a table/);
  assert.match(gateway, /security_invoker = true/);
  assert.match(gateway, /X-Goodbase-Data-Plane/);
  assert.match(gateway, /https:\/\/base\.goodos\.app/);
});

test("PostgREST uses the Goodbase public URL and validates token audience", () => {
  const compose = read("deploy/data-platform/compose.yaml");
  const tokenService = read("src/services/data-plane-token.service.js");

  assert.match(compose, /name: goodbase-data-platform/);
  assert.match(compose, /container_name: goodbase-postgrest/);
  assert.match(compose, /PGRST_JWT_AUD: goodbase-rest/);
  assert.match(compose, /PGRST_DB_CHANNEL_ENABLED: "true"/);
  assert.match(compose, /PGRST_OPENAPI_SERVER_PROXY_URI: https:\/\/base\.goodos\.app\/rest\/v1/);
  assert.match(compose, /max-size: 10m/);
  assert.match(tokenService, /DATA_TOKEN_AUDIENCE = "goodbase-rest"/);
  assert.match(tokenService, /issuer: PUBLIC_BASE_URL/);
  assert.match(tokenService, /audience: DATA_TOKEN_AUDIENCE/);
  assert.match(tokenService, /jti: crypto\.randomUUID\(\)/);
});

test("Phase 1 provisioning validates migrations, PostgREST, and backend health", () => {
  const script = read("scripts/provision-data-platform.sh");

  assert.match(script, /20260720_postgrest_data_plane\.sql/);
  assert.match(script, /20260720_goodbase_rest_phase1\.sql/);
  assert.match(script, /docker compose --env-file "\$ENV_FILE" config --quiet/);
  assert.match(script, /127\.0\.0\.1:8301\/ready/);
  assert.match(script, /127\.0\.0\.1:8001\/api\/data-platform\/health/);
  assert.match(script, /pm2 restart "\$PM2_PROCESS" --update-env/);
});

test("Goodbase Nginx template serves the canonical hostname through HA and Realtime", () => {
  const nginx = read("deploy/nginx/base.goodos.app.conf.example");

  assert.match(nginx, /server_name base\.goodos\.app/);
  assert.match(nginx, /upstream goodbase_api/);
  assert.match(nginx, /server 127\.0\.0\.1:8001 max_fails=1 fail_timeout=5s/);
  assert.match(nginx, /server 127\.0\.0\.1:8002 backup/);
  assert.match(nginx, /proxy_pass http:\/\/goodbase_api/);
  assert.match(nginx, /proxy_next_upstream error timeout http_502 http_503 http_504/);
  assert.match(nginx, /proxy_next_upstream_tries 2/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8400/);
  assert.match(nginx, /return 308 https:\/\/base\.goodos\.app\$request_uri/);
  assert.doesNotMatch(nginx, /backend\.goodos\.app/);
});
