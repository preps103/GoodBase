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

test("the registry discovers active products without a fixed application count", () => {
  assert.equal(Object.hasOwn(manifest, "applicationCount"), false);
  assert.ok(manifest.applications.length > 0);

  for (const key of ["id", "name", "domain", "status", "classification", "repositoryUrl", "localDirectory", "deploymentType"]) {
    for (const application of manifest.applications) {
      assert.ok(application[key], `${application.id || "unknown"} is missing ${key}`);
    }
  }

  for (const key of ["id", "domain", "repositoryUrl", "localDirectory"]) {
    const values = manifest.applications.map((application) => application[key]);
    assert.equal(new Set(values).size, values.length, `application ${key} values must be unique`);
  }

  for (const application of manifest.applications) {
    assert.equal(application.status, "active");
    assert.equal(application.classification, "product");
    assert.doesNotThrow(() => new URL(application.repositoryUrl));
  }
});

test("every active product declares the canonical login integration and theme tokens", () => {
  assert.equal(manifest.canonicalLogin.owner, "goodbase");
  assert.equal(manifest.canonicalLogin.package, "@goodos/topbar-widget");
  assert.equal(manifest.canonicalLogin.version, "4.3.0");
  assert.deepEqual(
    manifest.canonicalLogin.requiredComponents,
    ["GoodOSLoginShell", "GoodOSLoginWidget"]
  );

  for (const application of manifest.applications) {
    assert.equal(application.authEnabled, true, `${application.id} auth must be enabled`);
    assert.equal(application.canonicalLoginRequired, true, `${application.id} must use the canonical login`);
    assert.match(application.loginIntegration, /\.(?:jsx?|tsx?)$/);
    assert.match(application.theme.accent, /^#[0-9a-f]{6}$/i);
    assert.match(application.theme.accentInk, /^#[0-9a-f]{6}$/i);
  }
});

test("GoodBase deployment management excludes Sites-hosted applications", () => {
  const managed = manifest.applications.filter((application) => application.deploymentManaged);
  const hosted = manifest.applications.filter((application) => !application.deploymentManaged);

  assert.ok(managed.length > 0);
  assert.ok(hosted.length > 0);
  for (const application of managed) {
    assert.equal(application.deploymentType, "vps");
    assert.match(application.productionPath, /^\/home\/mgoodlo3\/Good[A-Za-z]+$/);
    assert.ok(application.service);
    assert.equal(application.productionPath.includes("-backup"), false);
    assert.equal(application.productionPath.includes("-release"), false);
  }
  for (const application of hosted) {
    assert.equal(application.deploymentType, "sites");
    assert.equal(Object.hasOwn(application, "productionPath"), false);
    assert.equal(Object.hasOwn(application, "service"), false);
  }
});

test("GoodBase, GoodID, and GoodMail Accounts have explicit authentication roles", () => {
  const platform = new Map(manifest.platformServices.map((service) => [service.id, service]));
  const shared = new Map(manifest.sharedServices.map((service) => [service.id, service]));

  assert.deepEqual([...platform.keys()], ["goodbase", "goodid"]);
  assert.equal(platform.get("goodbase").classification, "authentication-authority");
  assert.equal(platform.get("goodbase").canonicalLoginRequired, true);
  assert.equal(platform.get("goodid").classification, "oidc-identity-provider");
  assert.equal(platform.get("goodid").canonicalLoginRequired, false);
  assert.match(platform.get("goodid").canonicalLoginException, /upstream OIDC provider/i);
  assert.equal(shared.get("goodmail-accounts").domain, "mailaccounts.goodos.app");
  assert.equal(shared.get("goodmail-accounts").canonicalLoginRequired, false);
  assert.match(shared.get("goodmail-accounts").canonicalLoginException, /Mailbox credentials/i);
});

test("GoodCustoms, GoodTrusts, and GoodSure use canonical singular domains", () => {
  const applications = new Map(
    manifest.applications.map((application) => [application.id, application])
  );
  assert.equal(applications.get("goodcustoms").domain, "custom.goodos.app");
  assert.equal(applications.get("goodtrusts").domain, "trust.goodos.app");
  assert.equal(applications.get("goodsure").domain, "sure.goodos.app");
  assert.equal(applications.get("supplyguyz").domain, "supply.goodos.app");

  const domainMigration = fs.readFileSync(
    path.join(root, "migrations/20260725_canonical_product_domains.sql"),
    "utf8"
  );
  assert.match(domainMigration, /custom\.goodos\.app/);
  assert.match(domainMigration, /trust\.goodos\.app/);
});

test("retired applications and legacy repositories remain classified", () => {
  assert.deepEqual(
    manifest.retired.map(({ id }) => id),
    ["goodhub", "goodbackend"]
  );
  assert.ok(manifest.repositoryAliases.length > 0);
  assert.match(cleanupMigration, /DELETE FROM apps[\s\S]*'goodhub'/);
  assert.match(cleanupMigration, /DELETE FROM apps[\s\S]*'goodbackend'/);
  assert.match(cleanupMigration, /backend\.goodos\.app/);
  assert.match(cleanupMigration, /base\.goodos\.app/);
});
