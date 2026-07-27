"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const htmlSurfaces = [
  "src/public/console.html",
  "src/public/goodbase-auth.html",
  "src/public/landing.html",
  "src/public/mfa-enroll.html",
  "src/public/oidc-admin.html",
  "src/public/studio.html",
  "src/public/update-sites.html",
  "src/public/voice.html",
  "src/public/developer/api-docs.html",
  "src/public/developer/docs.html",
];

test("every GoodBase HTML surface declares the canonical favicon and manifest", () => {
  for (const surface of htmlSurfaces) {
    const html = read(surface);
    assert.match(
      html,
      /<link rel="icon" type="image\/svg\+xml" sizes="any" href="\/favicon\.svg\?v=20260726">/,
      `${surface} must load the canonical GoodBase favicon`,
    );
    assert.match(
      html,
      /<link rel="manifest" href="\/site\.webmanifest\?v=20260726">/,
      `${surface} must load the GoodBase web manifest`,
    );
  }
});

test("favicon endpoints return the branded asset instead of an empty response", () => {
  const routes = read("src/routes/index.js");

  assert.doesNotMatch(
    routes,
    /router\.get\("\/favicon\.ico"[\s\S]*?status\(204\)/,
  );
  assert.match(
    routes,
    /function sendGoodBaseFavicon[\s\S]*?max-age=300, must-revalidate[\s\S]*?image\/svg\+xml[\s\S]*?favicon\.svg/,
  );
  assert.match(
    routes,
    /router\.get\("\/favicon\.svg"[\s\S]*?sendGoodBaseFavicon\(res\)/,
  );
  assert.match(
    routes,
    /router\.get\("\/favicon\.ico"[\s\S]*?sendGoodBaseFavicon\(res\)/,
  );
  assert.match(
    routes,
    /router\.get\("\/site\.webmanifest"[\s\S]*?application\/manifest\+json[\s\S]*?site\.webmanifest/,
  );
});

test("GoodBase favicon and manifest preserve the database brand", () => {
  const favicon = read("src/public/favicon.svg");
  const manifest = JSON.parse(read("src/public/site.webmanifest"));

  assert.match(favicon, /<title id="title">GoodBase favicon<\/title>/);
  assert.match(favicon, /<ellipse cx="32" cy="17" rx="16" ry="6"\/>/);
  assert.equal(manifest.name, "GoodBase");
  assert.equal(manifest.short_name, "GoodBase");
  assert.deepEqual(manifest.icons, [
    {
      src: "/favicon.svg?v=20260726",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    },
  ]);
});
