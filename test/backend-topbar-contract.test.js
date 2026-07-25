"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("master top bar exposes the four ordered integration zones", () => {
  const styles = read("src/public/backend-topbar.css");
  const contract = read("docs/goodos-topbar-integration.md");

  const identity = contract.indexOf("data-goodos-topbar-identity");
  const search = contract.indexOf("data-goodos-topbar-search");
  const actions = contract.indexOf("data-goodos-topbar-actions");
  const controls = contract.indexOf("data-goodos-topbar-controls");

  assert.ok(identity >= 0, "identity/workspace zone is required");
  assert.ok(search > identity, "search must follow identity in integration markup");
  assert.ok(actions > search, "application actions must follow search in integration markup");
  assert.ok(controls > actions, "universal controls must follow application actions in integration markup");
  assert.match(styles, /--goodos-topbar-identity-width:\s*360px\s*;/);
  assert.match(styles, /--goodos-topbar-controls-width:\s*166px\s*;/);
  assert.match(styles, /\[data-goodos-topbar\][\s\S]*width:\s*100vw\s*!important\s*;/);
  assert.match(styles, /\[data-goodos-topbar\][\s\S]*max-width:\s*100vw\s*!important\s*;/);
  assert.match(styles, /grid-template-columns:[\s\S]*var\(--goodos-topbar-identity-width\)[\s\S]*var\(--goodos-topbar-search-width\)[\s\S]*minmax\(0,\s*1fr\)[\s\S]*var\(--goodos-topbar-controls-width\)\s*!important\s*;/);
  assert.match(styles, /\[data-goodos-topbar-identity\][\s\S]*grid-column:\s*1\s*;/);
  assert.match(styles, /\[data-goodos-topbar-search\][\s\S]*grid-column:\s*2\s*;/);
  assert.match(styles, /\[data-goodos-topbar-actions\][\s\S]*grid-column:\s*3\s*;/);
  assert.match(styles, /\[data-goodos-topbar-controls\][\s\S]*grid-column:\s*4\s*;/);
});

test("master top bar preserves the GoodBase desktop dimensions", () => {
  const styles = read("src/public/backend-topbar.css");
  const expectedTokens = {
    "--goodos-topbar-height": "77px",
    "--goodos-topbar-workspace-width": "246px",
    "--goodos-topbar-workspace-height": "38px",
    "--goodos-topbar-search-width": "544px",
    "--goodos-topbar-search-height": "46px",
    "--goodos-topbar-control-size": "34px",
  };

  for (const [token, value] of Object.entries(expectedTokens)) {
    assert.match(styles, new RegExp(`${token}:\\s*${value}\\s*;`));
  }
  assert.match(styles, /\[data-goodos-topbar-control="theme"\][\s\S]*grid-column:\s*1\s*!important\s*;/);
  assert.match(styles, /\[data-goodos-notifications\][\s\S]*grid-column:\s*2\s*!important\s*;/);
  assert.match(styles, /\[data-goodos-topbar-control="help"\][\s\S]*grid-column:\s*3\s*!important\s*;/);
  assert.match(styles, /\[data-goodos-topbar-control="account"\][\s\S]*grid-column:\s*4\s*!important\s*;/);
});

test("master top bar is responsive and themeable without changing structure", () => {
  const styles = read("src/public/backend-topbar.css");

  for (const token of [
    "--goodos-topbar-surface",
    "--goodos-topbar-raised",
    "--goodos-topbar-border",
    "--goodos-topbar-text",
    "--goodos-topbar-muted",
    "--goodos-topbar-accent",
    "--goodos-topbar-focus",
  ]) {
    assert.ok(styles.includes(token), `${token} must remain available for application theming`);
  }

  assert.match(styles, /@media \(max-width:\s*1480px\)/);
  assert.match(styles, /@media \(max-width:\s*1120px\)/);
  assert.match(styles, /@media \(max-width:\s*760px\)/);
});

test("master top bar stylesheet is delivered as a cross-origin shared asset", () => {
  const routes = read("src/routes/index.js");

  assert.match(routes, /router\.get\("\/backend-topbar\.css"/);
  assert.match(routes, /Cross-Origin-Resource-Policy/);
  assert.match(routes, /res\.type\("text\/css"\)/);
  assert.match(routes, /public\/backend-topbar\.css/);
});

test("notification integration keeps product state scoped and reserves master mode for GoodOS", () => {
  const contract = read("docs/goodos-topbar-integration.md");

  assert.match(contract, /data-goodos-notification-mode="application"/);
  assert.match(contract, /data-goodos-notification-app-id="<stable-product-app-id>"/);
  assert.match(contract, /does not create, fetch, merge, cache, or mutate notification state/);
  assert.match(contract, /must remain application-scoped/);
  assert.match(contract, /GoodOS is the only application allowed to declare master mode/);
  assert.match(contract, /data-goodos-notification-mode="master"/);
  assert.match(contract, /data-goodos-notification-entitlement-scope="accessible-apps"/);
  assert.match(contract, /server, not the browser, must enforce that entitlement boundary/);

  for (const hook of [
    "data-goodos-notification-badge",
    "data-goodos-notification-preview",
    'data-goodos-notification-action="open-center"',
    'data-goodos-notification-action="search"',
    'data-goodos-notification-action="filter"',
    'data-goodos-notification-action="mark-read"',
    'data-goodos-notification-action="mark-all-read"',
    'data-goodos-notification-action="archive"',
    'data-goodos-notification-action="preferences"',
    "data-goodos-notification-deep-link",
  ]) {
    assert.ok(contract.includes(hook), `${hook} must remain in the integration contract`);
  }
});
