const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "deploy/application-paths.json"), "utf8")
);
const cleanupMigration = fs.readFileSync(
  path.join(root, "migrations/20260725_remove_retired_goodhub.sql"),
  "utf8"
);

test("the deployment manifest defines exactly 15 uniquely routed applications", () => {
  assert.equal(manifest.applicationCount, 15);
  assert.equal(manifest.applications.length, 15);
  assert.equal(new Set(manifest.applications.map(({ id }) => id)).size, 15);
  assert.equal(new Set(manifest.applications.map(({ domain }) => domain)).size, 15);
  assert.equal(new Set(manifest.applications.map(({ service }) => service)).size, 15);
});

test("every product deployment uses the canonical production root and unversioned path", () => {
  for (const application of manifest.applications) {
    assert.match(application.productionPath, /^\/home\/mgoodlo3\/Good[A-Za-z]+$/);
    assert.equal(application.productionPath.includes("-backup"), false);
    assert.equal(application.productionPath.includes("-release"), false);
    assert.equal(application.productionPath.includes("-v1."), false);
  }
});

test("GoodBase and GoodID remain explicit platform services", () => {
  const platformIds = manifest.platformServices.map(({ id }) => id);
  assert.deepEqual(platformIds, ["goodbase", "goodid"]);
  assert.equal(manifest.platformServices[0].domain, "base.goodos.app");
  assert.equal(manifest.platformServices[0].productionPath, "/var/www/GoodBase");
});

test("GoodCustoms and GoodTrusts use their canonical singular domains", () => {
  const applications = new Map(
    manifest.applications.map((application) => [application.id, application])
  );
  assert.equal(applications.get("goodcustoms").domain, "custom.goodos.app");
  assert.equal(applications.get("goodtrusts").domain, "trust.goodos.app");

  const domainMigration = fs.readFileSync(
    path.join(root, "migrations/20260725_canonical_product_domains.sql"),
    "utf8"
  );
  assert.match(domainMigration, /custom\.goodos\.app/);
  assert.match(domainMigration, /trust\.goodos\.app/);

  const customNginx = fs.readFileSync(
    path.join(root, "deploy/nginx/custom.goodos.app.conf"),
    "utf8"
  );
  assert.match(customNginx, /server_name custom\.goodos\.app;/);
  assert.match(customNginx, /proxy_pass http:\/\/127\.0\.0\.1:3007;/);
  assert.match(customNginx, /return 308 https:\/\/custom\.goodos\.app\$request_uri;/);
});

test("retired GoodHub and GoodBackend identifiers cannot return", () => {
  assert.deepEqual(
    manifest.retired.map(({ id }) => id),
    ["goodhub", "goodbackend"]
  );
  assert.match(cleanupMigration, /DELETE FROM apps[\s\S]*'goodhub'/);
  assert.match(cleanupMigration, /DELETE FROM apps[\s\S]*'goodbackend'/);
  assert.match(cleanupMigration, /backend\.goodos\.app/);
  assert.match(cleanupMigration, /base\.goodos\.app/);
});
