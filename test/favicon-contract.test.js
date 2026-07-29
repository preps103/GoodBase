"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const version = "20260728-1";
const safariFaviconPath = "/goodbase-favicon-20260728.ico";

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
    for (const requiredTag of [
      `<link rel="icon" type="image/x-icon" sizes="16x16 32x32 48x48 64x64" href="${safariFaviconPath}">`,
      `<link rel="shortcut icon" type="image/x-icon" href="${safariFaviconPath}">`,
      `<link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg?v=${version}">`,
      `<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?v=${version}">`,
      `<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png?v=${version}">`,
      `<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=${version}">`,
      `<link rel="manifest" href="/site.webmanifest?v=${version}">`,
    ]) {
      assert.ok(html.includes(requiredTag), `${surface} must include ${requiredTag}`);
    }
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
    /function sendGoodBaseBrandAsset[\s\S]*?max-age=300, must-revalidate/,
  );
  assert.match(
    routes,
    /router\.get\("\/favicon\.svg"[\s\S]*?image\/svg\+xml[\s\S]*?favicon\.svg/,
  );
  assert.match(
    routes,
    /router\.get\("\/favicon\.ico"[\s\S]*?image\/x-icon[\s\S]*?favicon\.ico/,
  );
  assert.match(
    routes,
    /router\.get\("\/goodbase-favicon-20260728\.ico"[\s\S]*?image\/x-icon[\s\S]*?favicon\.ico/,
  );
  for (const endpoint of [
    "/favicon-16x16.png",
    "/favicon-32x32.png",
    "/apple-touch-icon.png",
    "/icons/goodbase-192.png",
    "/icons/goodbase-512.png",
  ]) {
    assert.ok(routes.includes(`router.get("${endpoint}"`), `${endpoint} must be served`);
  }
  assert.match(
    routes,
    /router\.get\("\/favicon-16x16\.png"[\s\S]*?image\/png[\s\S]*?favicon-16x16\.png/,
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
      src: `/icons/goodbase-192.png?v=${version}`,
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: `/icons/goodbase-512.png?v=${version}`,
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    },
  ]);
});

test("favicon raster assets use real PNG and ICO formats at their declared sizes", () => {
  const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
  const pngAssets = [
    ["src/public/favicon-16x16.png", 16],
    ["src/public/favicon-32x32.png", 32],
    ["src/public/apple-touch-icon.png", 180],
    ["src/public/icons/goodbase-192.png", 192],
    ["src/public/icons/goodbase-512.png", 512],
  ];

  for (const [relativePath, expectedSize] of pngAssets) {
    const buffer = fs.readFileSync(path.join(root, relativePath));
    assert.ok(buffer.subarray(0, 8).equals(pngSignature), `${relativePath} must be PNG`);
    assert.equal(buffer.readUInt32BE(16), expectedSize, `${relativePath} width`);
    assert.equal(buffer.readUInt32BE(20), expectedSize, `${relativePath} height`);
  }

  const ico = fs.readFileSync(path.join(root, "src/public/favicon.ico"));
  assert.equal(ico.readUInt16LE(0), 0, "ICO reserved header");
  assert.equal(ico.readUInt16LE(2), 1, "ICO image type");
  assert.ok(ico.readUInt16LE(4) >= 4, "ICO must contain multiple browser sizes");
});
