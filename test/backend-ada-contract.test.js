"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("backend console loads the themed ADA control", () => {
  const consoleHtml = read("src/public/console.html");
  const routes = read("src/routes/index.js");
  assert.match(consoleHtml, /href="\/backend-ada\.css"/);
  assert.match(consoleHtml, /src="\/backend-ada\.js"/);
  assert.match(routes, /router\.get\("\/backend-ada\.css"/);
  assert.match(routes, /router\.get\("\/backend-ada\.js"/);
  assert.match(
    routes,
    /router\.get\("\/backend-ada\.js"[\s\S]*?Cross-Origin-Resource-Policy", "cross-origin"[\s\S]*?\n}\);/,
  );
  assert.match(
    routes,
    /router\.get\("\/backend-ada\.css"[\s\S]*?Cross-Origin-Resource-Policy", "cross-origin"[\s\S]*?\n}\);/,
  );
});

test("Update Sites keeps a dedicated slot beside the ADA launcher", () => {
  const consoleHtml = read("src/public/console.html");

  assert.match(
    consoleHtml,
    /right:\s*calc\(var\(--backend-ada-trigger-right,\s*24px\)\s*\+\s*90px\s*\+\s*12px\)/,
  );
  assert.match(
    consoleHtml,
    /bottom:\s*var\(--backend-ada-trigger-bottom,\s*24px\)/,
  );
});

test("ADA control preserves the GoodOS accessibility contract", () => {
  const client = read("src/public/backend-ada.js");
  const styles = read("src/public/backend-ada.css");

  assert.match(client, /goodos-accessibility-settings-v1/);
  for (const setting of [
    "textScale",
    "highContrast",
    "grayscale",
    "reduceAnimations",
    "highlightLinks",
    "focusIndicators",
  ]) {
    assert.ok(client.includes(setting), `${setting} must remain available`);
  }
  assert.match(client, /aria-haspopup="dialog"/);
  assert.match(client, /setOpen\(panel\.hidden, false\)/);
  assert.match(client, /event\.key === "Escape"/);
  assert.match(client, /data-goodos-app-name/);
  assert.match(client, /data-goodos-ada-widget-version/);
  assert.match(client, /goodos:accessibility:open/);
  assert.match(client, /goodos:accessibility:close/);
  assert.match(client, /goodos:accessibility:toggle/);
  assert.match(client, /goodos:accessibility:ready/);
  assert.match(client, /window\.GoodOSAdaWidget/);
  assert.match(client, /unmount: unmount/);
  assert.match(client, /configure: configure/);
  assert.match(client, /goodosAdaPlacement/);
  assert.match(styles, /html\.ada-reduce-motion/);
  assert.match(styles, /html\.ada-focus-indicators/);
  assert.match(styles, /button\[aria-label="Accessibility Options"\]:not\(\.backend-ada-trigger\)/);
  assert.match(styles, /button\[aria-label="Open accessibility menu"\]:not\(\.backend-ada-trigger\)/);
  assert.match(styles, /data-goodos-ada-placement="bottom-left"/);
  assert.match(styles, /data-goodos-ada-placement="top-right"/);
});

test("ADA launcher and panel use the universal GoodOS dimensions", () => {
  const styles = read("src/public/backend-ada.css");
  const triggerRule = styles.match(/\.backend-ada-trigger\s*\{([\s\S]*?)\}/)?.[1] || "";
  const triggerIconRule =
    styles.match(/\.backend-ada-trigger svg,[\s\S]*?\{([\s\S]*?)\}/)?.[1] || "";
  const panelRule = styles.match(/\.backend-ada-panel\s*\{([\s\S]*?)\}/)?.[1] || "";

  for (const requiredRule of [
    "--backend-ada-trigger-right: 24px",
    "--backend-ada-trigger-bottom: 24px",
    "--backend-ada-panel-right: 24px",
    "--backend-ada-panel-bottom: 96px",
    "z-index: 50",
    "width: 90px",
    "min-width: 90px",
    "max-width: 90px",
    "height: 46px",
    "min-height: 46px",
    "max-height: 46px",
    "padding: 12px 16px",
    "gap: 8px",
    "font-size: 12px",
    "font-weight: 700",
    "line-height: 16px",
    "letter-spacing: 0.05em",
    "border-radius: 9999px",
    "z-index: 100",
    "box-sizing: border-box",
    "width: 400px",
    "height: 750px",
    "max-height: 85vh",
    "border-radius: 24px",
  ]) {
    assert.ok(styles.includes(requiredRule), `${requiredRule} must remain standardized`);
  }

  for (const requiredTriggerRule of [
    "right: var(--backend-ada-trigger-right)",
    "bottom: var(--backend-ada-trigger-bottom)",
    "z-index: 50",
    "width: 90px",
    "height: 46px",
    "padding: 12px 16px",
    "gap: 8px",
    "border: 1px",
    "border-radius: 9999px",
    "font-size: 12px",
    "font-weight: 700",
    "line-height: 16px",
    "letter-spacing: 0.05em",
    "text-transform: uppercase",
  ]) {
    assert.ok(
      triggerRule.includes(requiredTriggerRule),
      `${requiredTriggerRule} must remain on the universal launcher`,
    );
  }

  assert.match(triggerIconRule, /width:\s*20px/);
  assert.match(triggerIconRule, /height:\s*20px/);

  for (const requiredPanelRule of [
    "right: var(--backend-ada-panel-right)",
    "bottom: var(--backend-ada-panel-bottom)",
    "z-index: 100",
    "box-sizing: border-box",
    "width: 400px",
    "height: 750px",
    "max-height: 85vh",
    "border-radius: 24px",
  ]) {
    assert.ok(
      panelRule.includes(requiredPanelRule),
      `${requiredPanelRule} must remain on the universal panel`,
    );
  }
});

test("ADA panel adapts safely to tablet and mobile viewports", () => {
  const styles = read("src/public/backend-ada.css");
  const tabletRule =
    styles.match(/@media \(max-width: 1024px\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  const mobileRule =
    styles.match(/@media \(max-width: 640px\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  const compactRule =
    styles.match(/@media \(max-width: 360px\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(tabletRule, /max-height:\s*min\(85vh,\s*calc\(100dvh - 120px\)\)/);
  assert.match(mobileRule, /left:\s*24px/);
  assert.match(mobileRule, /right:\s*24px/);
  assert.match(mobileRule, /width:\s*auto/);
  assert.match(mobileRule, /max-width:\s*none/);
  assert.match(mobileRule, /\.backend-ada-close[\s\S]*?width:\s*44px[\s\S]*?height:\s*44px/);
  assert.match(mobileRule, /\.backend-ada-text-sizes button[\s\S]*?min-height:\s*44px/);
  assert.match(mobileRule, /\.backend-ada-reset[\s\S]*?min-height:\s*44px/);
  assert.match(compactRule, /\.backend-ada-subtitle[\s\S]*?display:\s*none/);
  assert.match(styles, /overscroll-behavior:\s*contain/);
  assert.match(styles, /-webkit-overflow-scrolling:\s*touch/);
  assert.match(styles, /@media \(hover: none\), \(pointer: coarse\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("PostgREST exposes its local-only admin readiness endpoint", () => {
  const compose = read("deploy/data-platform/compose.yaml");
  assert.match(compose, /PGRST_ADMIN_SERVER_PORT: "8301"/);
  assert.match(compose, /network_mode: host/);
});
