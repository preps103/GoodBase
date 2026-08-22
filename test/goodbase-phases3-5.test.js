const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Phase 3 validates JWT tenant context and forces RLS", () => {
  const migration = read("migrations/20260721_goodbase_rls_phase3.sql");
  const gateway = read("src/routes/data-plane.routes.js");
  const token = read("src/services/data-plane-token.service.js");

  assert.match(migration, /goodos_auth\.claim_text/);
  assert.match(migration, /backend_project_memberships/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /backend_rls_policy_registry/);
  assert.match(gateway, /resolveTenantContext/);
  assert.match(token, /organizationId/);
  assert.match(token, /projectId/);
  assert.match(token, /environmentId/);
});

test("Phase 3 management API audits exposure and applies bounded templates", () => {
  const routes = read("src/routes/goodbase-platform.routes.js");
  assert.match(routes, /security\/rls\/audit/);
  assert.match(routes, /security\/rls\/policies/);
  assert.match(routes, /POLICY_TEMPLATES/);
  assert.match(routes, /ALTER TABLE.*FORCE ROW LEVEL SECURITY/);
  assert.match(routes, /dataPlaneAdminRequired/);
});

test("Phase 4 provides current, TLS-only transaction and session pools", () => {
  const compose = read("deploy/data-platform/compose.yaml");
  const migration = read("migrations/20260721_goodbase_pooling_phase4.sql");
  assert.match(compose, /edoburu\/pgbouncer:v1\.25\.2-p0/);
  assert.match(compose, /POOL_MODE: transaction/);
  assert.match(compose, /POOL_MODE: session/);
  assert.match(compose, /CLIENT_TLS_SSLMODE: require/);
  assert.match(compose, /MAX_PREPARED_STATEMENTS/);
  assert.match(migration, /backend_connection_budgets/);
});

test("Phase 5 provisions logical-replication CDC with WAL protection", () => {
  const compose = read("deploy/data-platform/compose.yaml");
  const migration = read("migrations/20260721_goodbase_realtime_phase5.sql");
  const provision = read("scripts/provision-data-platform.sh");
  const nginx = read("deploy/nginx/base.goodos.app.conf.example");

  assert.match(compose, /supabase\/realtime:v2\.112\.9/);
  assert.match(migration, /CREATE PUBLICATION goodbase_goodos_production/);
  assert.match(migration, /backend_realtime_replication_health/);
  assert.match(provision, /wal_level = 'logical'/);
  assert.match(provision, /max_slot_wal_keep_size = '2GB'/);
  assert.match(provision, /pre-phase5-/);
  assert.match(nginx, /rewrite \^\/realtime\/v1/);
});

test("canonical Goodbase assets no longer depend on the retired backend hostname", () => {
  const roots = ["src", "docs", "migrations", "scripts", "deploy", "test"];
  const files = [];
  const walk = (entry) => {
    for (const child of fs.readdirSync(path.join(root, entry), { withFileTypes: true })) {
      const relative = path.join(entry, child.name);
      if (child.isDirectory()) walk(relative);
      else files.push(relative);
    }
  };
  roots.forEach(walk);
  const retiredHost = ["backend", "goodos", "app"].join(".");
  const allowedRetirementAssets = new Set([
    "migrations/20260724_goodbackend_to_goodbase.sql",
    "migrations/20260725_remove_retired_goodbackend.sql",
    "deploy/application-paths.json",
    "test/goodbase-phases3-5.test.js"
  ]);
  const offenders = files.filter((file) => read(file).includes(retiredHost) && !allowedRetirementAssets.has(file));
  assert.deepEqual(offenders, []);
});
