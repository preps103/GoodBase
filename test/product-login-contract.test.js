const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const css = fs.readFileSync(path.join(__dirname, "..", "src/public/backend-login.css"), "utf8");
const routes = fs.readFileSync(path.join(__dirname, "..", "src/routes/index.js"), "utf8");
const docs = fs.readFileSync(path.join(__dirname, "..", "docs/product-login-contract.md"), "utf8");
const authUi = fs.readFileSync(path.join(__dirname, "..", "src/public/goodbase-auth.html"), "utf8");
const authClient = fs.readFileSync(path.join(__dirname, "..", "src/public/goodbase-auth.js"), "utf8");

test("shared product login stylesheet exposes the required structure", () => {
  for (const hook of ["data-goodbase-login", "data-goodbase-login-brand", "data-goodbase-login-auth", "data-goodbase-login-provider", "data-goodbase-login-fields", "data-goodbase-login-submit"]) assert.match(css, new RegExp(hook));
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /prefers-reduced-motion/);
});
test("product login stylesheet is cross-origin reusable", () => {
  assert.match(routes, /router\.get\("\/backend-login\.css"/);
  assert.match(routes, /Cross-Origin-Resource-Policy/);
  assert.match(routes, /no-store, no-cache, must-revalidate, proxy-revalidate/);
});
test("contract requires the same four-tile panel in GoodOS and every application", () => {
  for (const name of ["Google", "Apple", "Microsoft", "GoodOS", "forgot-password", "create-account"]) assert.match(docs, new RegExp(name, "i"));
  assert.match(docs, /GoodOS and every product application use the shared GoodBase authentication contract/);
  assert.match(docs, /two-by-two provider grid/);
  assert.match(css, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
});
test("GoodBase auth UI implements the complete shared product panel", () => {
  for (const hook of [
    "data-goodbase-login",
    "data-goodbase-login-brand",
    "data-goodbase-login-auth",
    "data-goodbase-login-panel",
    "data-goodbase-login-providers",
    "data-goodbase-login-provider",
    "data-goodbase-login-divider",
    "data-goodbase-login-fields",
    "data-goodbase-login-field",
    "data-goodbase-login-password",
    "data-goodbase-login-password-toggle",
    "data-goodbase-login-recovery",
    "data-goodbase-login-submit",
    "data-goodbase-login-error"
  ]) assert.match(authUi, new RegExp(hook));
  for (const endpoint of [
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/password-reset/request",
    "/api/auth/password-reset/complete",
    "/api/goodbase/v1/growth/auth/providers",
    "/api/oidc/start/"
  ]) assert.match(authClient, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const provider of ["google", "apple", "microsoft"]) assert.match(authClient, new RegExp(`"${provider}"`));
  assert.match(routes, /router\.get\("\/register"/);
  assert.match(authClient, /setPasswordVisibility/);
  assert.match(authClient, /aria-pressed/);
});
