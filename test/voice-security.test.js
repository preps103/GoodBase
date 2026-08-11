const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "routes", "voice.routes.js"),
  "utf8"
);

test("GoodVoice canonical API is default-deny with a redacted public health route", () => {
  assert.match(source, /router\.get\("\/health", \(_req, res\)/);
  assert.match(source, /router\.get\("\/health\/details", requireVoiceAccess/);
  assert.match(source, /router\.use\(\(req, res, next\) =>/);
  assert.match(source, /return requireVoiceAccess\(req, res, next\)/);
  assert.match(source, /GOODVOICE_ACCESS_REQUIRED/);
  assert.match(source, /GOODVOICE_WORKSPACE_REQUIRED/);
  assert.match(source, /require\("\.\.\/middleware\/tenantContext"\)/);
  assert.match(source, /req\.tenantContext\?\.organizationId/);
});

test("PBX routes require signed timestamps and replay protection", () => {
  assert.match(source, /function requireVoiceWebhook/);
  assert.match(source, /x-goodvoice-timestamp/);
  assert.match(source, /x-goodvoice-signature/);
  assert.match(source, /createHmac\("sha256", secret\)/);
  assert.match(source, /5 \* 60 \* 1000/);
  assert.match(source, /\["\/route-call", "\/call-event"\]/);
});

test("voice writes are scoped, allowlisted, and atomic", () => {
  assert.match(source, /TABLE_WRITE_FIELDS/);
  assert.match(source, /sanitizeTableWrite/);
  assert.match(source, /tenant_id: req\.voiceTenantId/);
  assert.match(source, /tenantRows\(req, db\[tableName\]\)/);
  assert.match(source, /fs\.renameSync\(temporaryPath, DB_PATH\)/);
  assert.match(source, /fs\.renameSync\(temporaryPath, SECRETS_PATH\)/);
  assert.match(source, /createCipheriv\("aes-256-gcm"/);
  assert.match(source, /saveProviderSecrets\(payload\)/);
  assert.match(source, /GOODVOICE_PROVIDER_VAULT_KEY/);
  assert.match(source, /GOODVOICE_DATABASE_INVALID/);
  assert.doesNotMatch(
    source.match(/function createTableRecord[\s\S]*?function updateTableRecord/)?.[0] || "",
    /db\[tableName\]\[idx\]/
  );
});

test("phone numbers are globally unique across GoodVoice workspaces", () => {
  assert.match(source, /PHONE_NUMBER_ALREADY_ASSIGNED/);
  assert.match(source, /crossTenantConflicts/);
});

test("readiness detects stale calls, legacy records, and missing state backups", () => {
  assert.match(source, /reconcileStaleCalls\(db\)/);
  assert.match(source, /legacy_unscoped_records/);
  assert.match(source, /stateBackupStatus\(\)/);
});

test("production demo seeding and unready PBX fallbacks fail closed", () => {
  assert.match(source, /DEMO_SEEDING_DISABLED/);
  assert.match(source, /GOODVOICE_ENABLE_PBX_QUEUES/);
  assert.match(source, /GOODVOICE_ENABLE_PBX_VOICEMAIL/);
  assert.match(source, /No available agent or production-ready fallback route/);
});
