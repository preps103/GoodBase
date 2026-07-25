"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodBuilder stores native sites, pages, revisions, templates, and submissions", () => {
  const migration = read("migrations/20260725_goodbuilder_application.sql");
  for (const table of [
    "goodbuilder_sites",
    "goodbuilder_pages",
    "goodbuilder_revisions",
    "goodbuilder_templates",
    "goodbuilder_publications",
    "goodbuilder_form_submissions",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /published_snapshot_json JSONB/);
  assert.match(migration, /document_json JSONB NOT NULL/);
  assert.match(migration, /REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /'goodbuilder', 'GoodBuilder', 'builder\.goodos\.app'/);
});

test("GoodBuilder API is authenticated, origin-bound, and owner-scoped", () => {
  const routes = read("src/routes/goodbuilder.routes.js");
  const index = read("src/routes/index.js");
  assert.match(index, /router\.use\("\/api\/goodbuilder", goodbuilderRoutes\)/);
  assert.match(routes, /router\.use\(authRequired\)/);
  assert.match(routes, /GOODBUILDER_ORIGIN_DENIED/);
  assert.match(routes, /X-Requested-With/);
  assert.match(routes, /owner_user_id=\$2/);
  assert.doesNotMatch(routes, /req\.body\?\.userId/);
});

test("GoodBuilder publishes immutable snapshots and retains page revisions", () => {
  const routes = read("src/routes/goodbuilder.routes.js");
  assert.match(routes, /published_snapshot_json=\$3::jsonb/);
  assert.match(routes, /INSERT INTO goodbuilder_publications/);
  assert.match(routes, /Published site snapshot/);
  assert.match(routes, /REVISION_SOURCES = new Set\(\["autosave", "manual", "publish", "restore", "import"\]\)/);
  assert.match(routes, /Before revision restore/);
  assert.match(routes, /Cache-Control", "public, max-age=60, stale-while-revalidate=300/);
});

test("GoodBuilder limits documents and supports Elementor-class native template types", () => {
  const routes = read("src/routes/goodbuilder.routes.js");
  assert.match(routes, /Buffer\.byteLength\(encoded, "utf8"\) > 2_000_000/);
  for (const type of ["header", "footer", "popup", "loop", "product", "checkout"]) {
    assert.match(routes, new RegExp(`"${type}"`));
  }
});
