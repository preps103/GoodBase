const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "goodvoice-routes-"));
process.env.NODE_ENV = "test";
process.env.GOODOS_VOICE_DB_PATH = path.join(testDirectory, "voice-db.json");
process.env.GOODVOICE_SECRETS_PATH = path.join(testDirectory, "voice-secrets.json");

const voiceRoutes = require("../src/routes/voice.routes");

async function withServer(callback) {
  const app = express();
  app.use(express.json());
  app.use("/api/voice", voiceRoutes);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}/api/voice`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("reports measured GoodVoice backend and telephony readiness", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.module, "GoodVoice");
    assert.equal(health.database_connected, true);
    assert.equal(health.backend_api_ready, true);
    assert.equal(typeof health.asterisk_connected, "boolean");
    assert.equal(typeof health.sip_trunk_connected, "boolean");
    assert.ok(Array.isArray(health.blockers));
  });
});

test("imports, normalizes, and updates owned phone numbers", async () => {
  await withServer(async (baseUrl) => {
    const firstResponse = await fetch(`${baseUrl}/numbers/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        numbers: [
          {
            phone_number: "(714) 555-0101",
            label: "Main Line",
            department: "General"
          }
        ],
        replace_demo: true
      })
    });
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json();
    assert.equal(first.created, 1);
    assert.equal(first.imported[0].phone_number, "+17145550101");

    const secondResponse = await fetch(`${baseUrl}/numbers/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        numbers: [
          {
            phone_number: "+17145550101",
            label: "Updated Main Line"
          }
        ]
      })
    });
    const second = await secondResponse.json();
    assert.equal(second.created, 0);
    assert.equal(second.updated, 1);

    const numbers = await (await fetch(`${baseUrl}/numbers`)).json();
    assert.equal(numbers.length, 1);
    assert.equal(numbers[0].label, "Updated Main Line");
  });
});

test("persists settings and provider credentials server-side", async () => {
  await withServer(async (baseUrl) => {
    const settingsResponse = await fetch(`${baseUrl}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        missed_call_text_enabled: false,
        ignored_setting: "not stored"
      })
    });
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json();
    assert.equal(settings.missed_call_text_enabled, false);
    assert.equal(settings.ignored_setting, undefined);

    const providerResponse = await fetch(`${baseUrl}/providers/bulkvs/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "test-user",
        api_key: "test-secret"
      })
    });
    assert.equal(providerResponse.status, 200);
    const secretStat = fs.statSync(process.env.GOODVOICE_SECRETS_PATH);
    assert.equal(secretStat.mode & 0o777, 0o600);

    const providerStatus = await (await fetch(`${baseUrl}/providers/status`)).json();
    assert.equal(providerStatus.bulkvs.credentials_configured, true);
  });
});

test.after(() => {
  fs.rmSync(testDirectory, { recursive: true, force: true });
});
