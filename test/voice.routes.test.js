const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "goodvoice-routes-"));
process.env.NODE_ENV = "test";
process.env.GOODOS_VOICE_DB_PATH = path.join(testDirectory, "voice-db.json");
process.env.GOODVOICE_SECRETS_PATH = path.join(testDirectory, "voice-secrets.json");
process.env.GOODVOICE_STATE_BACKUP_STAMP = path.join(testDirectory, "voice-state-backup.timestamp");
process.env.GOODVOICE_PROVIDER_VAULT_KEY = crypto.randomBytes(32).toString("hex");
process.env.GOODOS_VOICE_SECRET = crypto.randomBytes(32).toString("hex");
fs.writeFileSync(process.env.GOODVOICE_STATE_BACKUP_STAMP, new Date().toISOString());

const voiceRoutes = require("../src/routes/voice.routes");

function signedVoiceRequest(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac("sha256", process.env.GOODOS_VOICE_SECRET)
    .update(`${timestamp}.${JSON.stringify(body)}`)
    .digest("hex");

  return {
    "content-type": "application/json",
    "x-goodvoice-timestamp": timestamp,
    "x-goodvoice-signature": signature
  };
}

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
    const response = await fetch(`${baseUrl}/health/details`);
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

test("persists enterprise voice policies and reports readiness", async () => {
  await withServer(async (baseUrl) => {
    const settingsResponse = await fetch(`${baseUrl}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        supervisor_monitoring_enabled: true,
        supervisor_whisper_enabled: true,
        quality_min_mos: 3.8,
        disposition_codes: ["Resolved", "Escalated"]
      })
    });
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json();
    assert.equal(settings.supervisor_monitoring_enabled, true);
    assert.equal(settings.supervisor_whisper_enabled, true);
    assert.equal(settings.quality_min_mos, 3.8);
    assert.deepEqual(settings.disposition_codes, ["Resolved", "Escalated"]);

    const readiness = await (await fetch(`${baseUrl}/operations/readiness`)).json();
    assert.equal(readiness.supervisor_controls.monitor, false);
    assert.equal(readiness.quality_policy.minimum_mos, 3.8);
    assert.ok(readiness.blockers.includes(
      "Supervisor PBX actions are configured as policy only and are not enabled in this release."
    ));
  });
});

test("tracks emergency locations without claiming carrier validation", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/emergency-locations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Headquarters",
        address_line_1: "123 Main Street",
        city: "Anaheim",
        region: "CA",
        postal_code: "92805",
        callback_number: "(714) 555-0100",
        status: "pending_provider"
      })
    });
    assert.equal(response.status, 201);
    const location = await response.json();
    assert.equal(location.callback_number, "+17145550100");
    assert.equal(location.status, "pending_provider");

    const locations = await (await fetch(`${baseUrl}/emergency-locations`)).json();
    assert.equal(locations.length, 1);
    assert.equal(locations[0].label, "Headquarters");
  });
});

test("tracks number-porting requests and prevents duplicate active numbers", async () => {
  await withServer(async (baseUrl) => {
    const payload = {
      numbers: ["(714) 555-0199"],
      losing_carrier: "Current Carrier",
      account_name: "GoodVoice",
      status: "submitted",
      external_reference: "carrier-port-test-001"
    };
    const firstResponse = await fetch(`${baseUrl}/port-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    assert.equal(firstResponse.status, 201);
    const request = await firstResponse.json();
    assert.deepEqual(request.numbers, ["+17145550199"]);

    const duplicateResponse = await fetch(`${baseUrl}/port-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    assert.equal(duplicateResponse.status, 409);
  });
});

test("creates post-call wrap-up, quality, and intelligence workflow records", async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/seed-demo`, { method: "POST" });
    await fetch(`${baseUrl}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        disposition_required: true,
        disposition_codes: ["Resolved", "Escalated"],
        conversation_intelligence_enabled: true,
        ai_summary_enabled: true,
        quality_monitoring_enabled: true,
        quality_min_mos: 3.5
      })
    });

    const routeBody = {
      call_id: "call_enterprise_test",
      from_number: "+17145550199",
      to_number: "+17145550102",
      classification: "Support"
    };
    const routeResponse = await fetch(`${baseUrl}/route-call`, {
      method: "POST",
      headers: signedVoiceRequest(routeBody),
      body: JSON.stringify(routeBody)
    });
    const route = await routeResponse.json();
    assert.equal(route.action, "dial_agent");

    const eventBody = {
      call_id: "call_enterprise_test",
      event: "Hangup",
      recording_url: "https://recordings.example.test/call.wav",
      rtp_metrics: {
        mos: 3.1,
        jitter_ms: 45,
        packet_loss_percent: 1.5
      }
    };
    const eventResponse = await fetch(`${baseUrl}/call-event`, {
      method: "POST",
      headers: signedVoiceRequest(eventBody),
      body: JSON.stringify(eventBody)
    });
    assert.equal(eventResponse.status, 201);
    const event = await eventResponse.json();
    assert.equal(event.event.event_type, "Hangup");
    assert.equal(event.workflow.disposition_required, true);
    assert.equal(event.workflow.conversation_intelligence, "queued");
    assert.equal(event.workflow.quality.status, "degraded");

    const logs = await (await fetch(`${baseUrl}/call-logs`)).json();
    const log = logs.find((item) => item.call_id === "call_enterprise_test");
    assert.equal(log.disposition_status, "pending");
    assert.equal(log.intelligence_status, "queued");

    const dispositionResponse = await fetch(`${baseUrl}/call-logs/${log.id}/disposition`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        disposition_code: "Resolved",
        notes: "Customer request completed."
      })
    });
    assert.equal(dispositionResponse.status, 200);
    const disposed = await dispositionResponse.json();
    assert.equal(disposed.disposition_status, "completed");
    assert.equal(disposed.disposition_code, "Resolved");
  });
});

test.after(() => {
  fs.rmSync(testDirectory, { recursive: true, force: true });
});
