const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const consoleHtml = fs.readFileSync(
  path.join(__dirname, "..", "src", "public", "console.html"),
  "utf8"
);

test("GoodBase uses the shared GoodApps desktop top-bar sizing contract", () => {
  const expectedTokens = {
    "--suite-topbar-height": "77px",
    "--suite-edge-space": "36px",
    "--suite-identity-width": "360px",
    "--suite-brand-mark": "36px",
    "--suite-workspace-width": "246px",
    "--suite-workspace-height": "38px",
    "--suite-search-width": "544px",
    "--suite-search-height": "46px",
    "--suite-control-size": "34px",
    "--suite-controls-width": "166px",
  };

  for (const [token, value] of Object.entries(expectedTokens)) {
    assert.match(
      consoleHtml,
      new RegExp(`${token.replaceAll("-", "\\-")}\\s*:\\s*${value.replace(".", "\\.")}\\s*;`)
    );
  }

  assert.match(
    consoleHtml,
    /grid-template-columns:\s*var\(--suite-identity-width\)\s*var\(--suite-search-width\)\s*minmax\(0,\s*1fr\)\s*var\(--suite-controls-width\)\s*;/
  );
  assert.match(consoleHtml, /padding:\s*0\s+var\(--suite-edge-space\)\s*;/);
});

test("GoodBase implements the ordered shared top-bar zones", () => {
  const identity = consoleHtml.indexOf("data-goodos-topbar-identity");
  const search = consoleHtml.indexOf("data-goodos-topbar-search");
  const actions = consoleHtml.indexOf("data-goodos-topbar-actions");
  const controls = consoleHtml.indexOf("data-goodos-topbar-controls");

  assert.ok(identity >= 0);
  assert.ok(search > identity);
  assert.ok(actions > search);
  assert.ok(controls > actions);
  assert.match(consoleHtml, /href="\/backend-topbar\.css\?v=20260725-uniform-1"/);
});

test("GoodBase notifications remain explicitly application scoped", () => {
  assert.match(consoleHtml, /data-goodos-notification-mode="application"/);
  assert.match(consoleHtml, /data-goodos-notification-app-id="goodbase"/);
  assert.doesNotMatch(consoleHtml, /data-goodos-notification-mode="master"/);
  assert.doesNotMatch(consoleHtml, /data-goodos-notification-app-id="goodbackend"/);
});
