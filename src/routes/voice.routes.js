const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const authRequired = process.env.NODE_ENV === "test"
  ? (req, res, next) => next()
  : require("../middleware/authRequired");
const tenantContext = process.env.NODE_ENV === "test"
  ? (req, res, next) => next()
  : require("../middleware/tenantContext");

const router = express.Router();

const DB_PATH = path.resolve(
  process.env.GOODOS_VOICE_DB_PATH ||
  path.join(process.cwd(), "data", "goodos-voice-db.json")
);
const SECRETS_PATH = path.resolve(
  process.env.GOODVOICE_SECRETS_PATH ||
  path.join(path.dirname(DB_PATH), "goodvoice-provider-secrets.json")
);
const DB_BACKUP_PATH = `${DB_PATH}.backup`;
const STATE_BACKUP_STAMP = path.resolve(
  process.env.GOODVOICE_STATE_BACKUP_STAMP ||
  path.join(path.dirname(DB_PATH), "goodvoice-state-backup.timestamp")
);

const TABLES = {
  numbers: "voice_numbers",
  agents: "voice_agents",
  routes: "voice_routes",
  "business-hours": "voice_business_hours",
  queues: "voice_queues",
  "voicemail-profiles": "voice_voicemail_profiles",
  "call-logs": "voice_call_logs",
  "emergency-locations": "voice_emergency_locations",
  "port-requests": "voice_port_requests",
  "active-calls": "voice_active_calls",
  "call-events": "voice_call_events",
  "route-decisions": "voice_route_decisions"
};

const DEFAULT_SETTINGS = {
  module_status: "Online",
  asterisk_connection_status: "Disconnected",
  sip_trunk_status: "Offline",
  default_fallback_action: "Voicemail",
  default_routing_mode: "Round Robin",
  call_recording_enabled: false,
  recording_consent_message: "This call is recorded for quality assurance.",
  webhook_url: "https://base.goodos.app/api/voice/call-event",
  auto_attendant_enabled: false,
  auto_attendant_number_ids: [],
  auto_attendant_greeting: "Thank you for calling. Please select an option.",
  auto_attendant_timeout_seconds: 8,
  auto_attendant_menu: [],
  missed_call_text_enabled: false,
  missed_call_text_template: "Sorry we missed your call. Reply here and our team will follow up.",
  spam_blocking_enabled: true,
  blocked_numbers: [],
  anonymous_call_action: "Voicemail",
  call_log_retention_days: 365,
  recording_retention_days: 90,
  sla_answer_seconds: 30,
  sla_abandon_rate_percent: 5,
  webhook_retry_count: 5,
  webhook_retry_delay_seconds: 30,
  supervisor_monitoring_enabled: false,
  supervisor_whisper_enabled: false,
  supervisor_barge_enabled: false,
  supervisor_takeover_enabled: false,
  monitoring_announcement_enabled: true,
  post_call_wrap_up_seconds: 30,
  disposition_required: false,
  disposition_codes: [],
  conversation_intelligence_enabled: false,
  ai_summary_enabled: false,
  sentiment_analysis_enabled: false,
  action_item_detection_enabled: false,
  transcript_redaction_enabled: true,
  quality_monitoring_enabled: false,
  quality_min_mos: 3.5,
  quality_max_jitter_ms: 30,
  quality_max_packet_loss_percent: 1,
  emergency_notifications_enabled: false,
  emergency_notification_recipients: [],
  stir_shaken_visibility_enabled: false
};

const GOODVOICE_APP_IDS = new Set(["goodvoice", "good-voice", "voice"]);
const TABLE_WRITE_FIELDS = {
  voice_numbers: new Set([
    "phone_number", "label", "partner_name", "department", "routing_mode",
    "business_hours_id", "fallback_action", "fallback_target", "provider",
    "status", "is_active"
  ]),
  voice_agents: new Set([
    "name", "extension", "phone_number", "email", "assigned_partner", "skills",
    "priority", "max_concurrent_calls", "status", "current_status", "is_active",
    "user_id"
  ]),
  voice_routes: new Set([
    "phone_number_id", "incoming_number_id", "partner_name", "department",
    "routing_strategy", "assigned_agents", "assigned_agent_ids", "fallback_queue_id",
    "fallback_voicemail_id", "business_hours_id", "after_hours_fallback",
    "after_hours_target", "status", "is_active"
  ]),
  voice_business_hours: new Set([
    "name", "days_of_week", "open_time", "close_time", "timezone", "holiday_closed",
    "after_hours_fallback", "after_hours_target", "status", "is_active"
  ]),
  voice_queues: new Set([
    "name", "partner_name", "department", "assigned_agents", "assigned_agent_ids",
    "max_wait_time_seconds", "hold_music_label", "overflow_action", "overflow_target",
    "status", "is_active"
  ]),
  voice_voicemail_profiles: new Set([
    "name", "partner_name", "greeting_text", "delivery_email", "save_transcription",
    "status", "is_active"
  ]),
  voice_call_logs: new Set([
    "call_id", "from_number", "to_number", "partner_name", "selected_agent_id",
    "selected_agent_name", "call_status", "result", "started_at", "ended_at",
    "duration_seconds", "notes", "disposition_status", "disposition_code",
    "disposition_notes", "callback_required", "callback_due_at", "consent_confirmed"
  ]),
  voice_emergency_locations: new Set([
    "label", "address_line_1", "address_line_2", "city", "region", "postal_code",
    "country", "callback_number", "notification_recipients", "assigned_number_ids",
    "status", "provider_reference", "notes"
  ]),
  voice_port_requests: new Set([
    "numbers", "losing_carrier", "account_number_last4", "account_name",
    "requested_completion_date", "status", "external_reference", "notes"
  ])
};

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(DB_PATH)) {
    const fresh = {};
    for (const table of Object.values(TABLES)) fresh[table] = [];
    fresh.voice_settings = { ...DEFAULT_SETTINGS };
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2), {
      encoding: "utf8",
      mode: 0o640
    });
    fs.chmodSync(DB_PATH, 0o640);
  }

  let db = {};
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (err) {
    try {
      const backup = JSON.parse(fs.readFileSync(DB_BACKUP_PATH, "utf8"));
      fs.copyFileSync(DB_BACKUP_PATH, DB_PATH);
      fs.chmodSync(DB_PATH, 0o640);
      db = backup;
    } catch (backupError) {
      const databaseError = new Error("GoodVoice database and recovery copy could not be parsed safely.");
      databaseError.code = "GOODVOICE_DATABASE_INVALID";
      databaseError.cause = backupError || err;
      throw databaseError;
    }
  }

  let changed = false;
  for (const table of Object.values(TABLES)) {
    if (!Array.isArray(db[table])) {
      db[table] = [];
      changed = true;
    }
  }
  if (!db.voice_settings || Array.isArray(db.voice_settings)) {
    db.voice_settings = { ...DEFAULT_SETTINGS };
    changed = true;
  } else {
    const mergedSettings = { ...DEFAULT_SETTINGS, ...db.voice_settings };
    if (JSON.stringify(mergedSettings) !== JSON.stringify(db.voice_settings)) {
      db.voice_settings = mergedSettings;
      changed = true;
    }
  }
  if (!db.voice_settings_by_tenant || Array.isArray(db.voice_settings_by_tenant)) {
    db.voice_settings_by_tenant = {};
    changed = true;
  }

  if (changed) saveDb(db);
  return db;
}

function saveDb(db) {
  const temporaryPath = `${DB_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  if (fs.existsSync(DB_PATH)) {
    fs.copyFileSync(DB_PATH, DB_BACKUP_PATH);
    fs.chmodSync(DB_BACKUP_PATH, 0o640);
  }
  fs.writeFileSync(temporaryPath, JSON.stringify(db, null, 2), {
    encoding: "utf8",
    mode: 0o640
  });
  fs.renameSync(temporaryPath, DB_PATH);
  fs.chmodSync(DB_PATH, 0o640);
}

function stateBackupStatus() {
  try {
    const completedAt = fs.readFileSync(STATE_BACKUP_STAMP, "utf8").trim();
    const ageMs = Date.now() - Date.parse(completedAt);
    return {
      configured: true,
      completed_at: completedAt,
      fresh: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 26 * 60 * 60 * 1000
    };
  } catch (_) {
    return { configured: false, completed_at: null, fresh: false };
  }
}

function normalizeNumber(value) {
  return String(value || "").trim();
}

function normalizeE164(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  const normalized = raw.startsWith("+")
    ? `+${digits}`
    : digits.length === 10
      ? `+1${digits}`
      : `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : "";
}

function canonicalPhone(value) {
  return normalizeE164(value) || normalizeNumber(value);
}

function normalizeEmailList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[,\n]/);
  return [...new Set(
    values
      .map((item) => String(item || "").trim().toLowerCase())
      .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))
  )];
}

function normalizePhoneNumberList(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(normalizeE164).filter(Boolean))];
}

function normalizeEmergencyLocation(updates) {
  return {
    ...updates,
    label: String(updates.label || "").trim().slice(0, 120),
    address_line_1: String(updates.address_line_1 || "").trim().slice(0, 160),
    address_line_2: String(updates.address_line_2 || "").trim().slice(0, 160),
    city: String(updates.city || "").trim().slice(0, 100),
    region: String(updates.region || "").trim().slice(0, 80),
    postal_code: String(updates.postal_code || "").trim().slice(0, 24),
    country: String(updates.country || "US").trim().toUpperCase().slice(0, 2),
    callback_number: normalizeE164(updates.callback_number),
    notification_recipients: normalizeEmailList(updates.notification_recipients),
    assigned_number_ids: Array.isArray(updates.assigned_number_ids)
      ? [...new Set(updates.assigned_number_ids.map(String))]
      : [],
    notes: String(updates.notes || "").trim().slice(0, 1000)
  };
}

function normalizePortRequest(updates) {
  return {
    ...updates,
    numbers: normalizePhoneNumberList(updates.numbers),
    losing_carrier: String(updates.losing_carrier || "").trim().slice(0, 120),
    account_number_last4: String(updates.account_number_last4 || "")
      .replace(/\D/g, "")
      .slice(-4),
    account_name: String(updates.account_name || "").trim().slice(0, 160),
    requested_completion_date: String(updates.requested_completion_date || "").trim().slice(0, 10),
    external_reference: String(updates.external_reference || "").trim().slice(0, 160),
    notes: String(updates.notes || "").trim().slice(0, 2000)
  };
}

function missingEmergencyFields(updates) {
  return [
    ["label", updates.label],
    ["address_line_1", updates.address_line_1],
    ["city", updates.city],
    ["region", updates.region],
    ["postal_code", updates.postal_code],
    ["callback_number", updates.callback_number]
  ].filter(([, value]) => !value).map(([key]) => key);
}

function missingPortFields(updates) {
  const missing = [];
  if (!updates.numbers.length) missing.push("numbers");
  if (!updates.losing_carrier) missing.push("losing_carrier");
  if (!updates.account_name) missing.push("account_name");
  return missing;
}

function assessCallQuality(settings, metrics = {}) {
  const mos = Number(metrics.mos);
  const jitter = Number(metrics.jitter_ms);
  const packetLoss = Number(metrics.packet_loss_percent);
  const available = [mos, jitter, packetLoss].some(Number.isFinite);
  if (!settings.quality_monitoring_enabled || !available) {
    return {
      status: settings.quality_monitoring_enabled ? "not_measured" : "disabled",
      alerts: []
    };
  }

  const alerts = [];
  if (Number.isFinite(mos) && mos < Number(settings.quality_min_mos)) {
    alerts.push(`MOS ${mos} is below ${settings.quality_min_mos}.`);
  }
  if (Number.isFinite(jitter) && jitter > Number(settings.quality_max_jitter_ms)) {
    alerts.push(`Jitter ${jitter}ms exceeds ${settings.quality_max_jitter_ms}ms.`);
  }
  if (
    Number.isFinite(packetLoss) &&
    packetLoss > Number(settings.quality_max_packet_loss_percent)
  ) {
    alerts.push(
      `Packet loss ${packetLoss}% exceeds ${settings.quality_max_packet_loss_percent}%.`
    );
  }

  return {
    status: alerts.length > 0 ? "degraded" : "good",
    alerts,
    metrics: {
      mos: Number.isFinite(mos) ? mos : null,
      jitter_ms: Number.isFinite(jitter) ? jitter : null,
      packet_loss_percent: Number.isFinite(packetLoss) ? packetLoss : null,
      latency_ms: Number.isFinite(Number(metrics.latency_ms))
        ? Number(metrics.latency_ms)
        : null
    }
  };
}

function stableStringHash(value) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) || 1;
}

function recordMatchesId(row, id) {
  return (
    String(row.id) === String(id) ||
    String(stableStringHash(row.id)) === String(id)
  );
}

function normalizeAppId(app) {
  return String(app && (app.id || app.slug || app.name) || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function hasGoodVoiceAccess(req) {
  const role = String(
    req.user && (req.user.platformRole || req.user.platform_role || req.user.role) || ""
  ).toLowerCase();
  if (["owner", "admin"].includes(role)) return true;
  return Array.isArray(req.apps) && req.apps.some((app) => {
    const appId = normalizeAppId(app);
    return GOODVOICE_APP_IDS.has(appId) || GOODVOICE_APP_IDS.has(appId.replace(/-/g, ""));
  });
}

function requireVoiceAccess(req, res, next) {
  if (process.env.NODE_ENV === "test" && !req.user) {
    req.voiceTenantId = "";
    return next();
  }
  return authRequired(req, res, () => {
    if (!hasGoodVoiceAccess(req)) {
      return res.status(403).json({
        success: false,
        code: "GOODVOICE_ACCESS_REQUIRED",
        message: "This account does not have access to GoodVoice."
      });
    }
    return tenantContext(req, res, () => {
      req.voiceTenantId = String(req.tenantContext?.organizationId || "").trim().toLowerCase();
      if (!req.voiceTenantId) {
        return res.status(403).json({
          success: false,
          code: "GOODVOICE_WORKSPACE_REQUIRED",
          message: "A GoodVoice workspace could not be resolved for this account."
        });
      }
      return next();
    });
  });
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function requireVoiceWebhook(req, res, next) {
  const secret = String(process.env.GOODOS_VOICE_SECRET || "");
  if (!secret) {
    return res.status(503).json({
      success: false,
      code: "VOICE_GATEWAY_SECRET_UNAVAILABLE",
      message: "GoodVoice gateway authentication is not configured."
    });
  }

  const timestamp = String(req.headers["x-goodvoice-timestamp"] || "");
  const signature = String(req.headers["x-goodvoice-signature"] || "")
    .replace(/^sha256=/i, "");
  const timestampMs = Number(timestamp) * 1000;
  const withinReplayWindow = Number.isFinite(timestampMs) &&
    Math.abs(Date.now() - timestampMs) <= 5 * 60 * 1000;
  const body = JSON.stringify(req.body || {});
  const expectedSignature = timestamp
    ? crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
    : "";

  if (!withinReplayWindow || !signature || !safeEqual(signature, expectedSignature)) {
    return res.status(401).json({
      success: false,
      code: "INVALID_VOICE_GATEWAY_SIGNATURE",
      message: "GoodVoice gateway authentication failed."
    });
  }
  return next();
}

function sanitizeTableWrite(tableName, body) {
  const allowed = TABLE_WRITE_FIELDS[tableName] || new Set();
  return Object.fromEntries(
    Object.entries(body && typeof body === "object" ? body : {})
      .filter(([key]) => allowed.has(key))
  );
}

function tenantRows(req, rows) {
  return rows.filter((row) => String(row.tenant_id || "") === String(req.voiceTenantId || ""));
}

function tenantSettings(req, db) {
  return {
    ...DEFAULT_SETTINGS,
    ...(db.voice_settings_by_tenant[req.voiceTenantId] || {})
  };
}

function reconcileStaleCalls(db, maximumAgeMs = 4 * 60 * 60 * 1000) {
  const now = Date.now();
  const stale = db.voice_active_calls.filter((call) => {
    const lastActivity = Date.parse(call.last_event_at || call.started_at || "");
    return !Number.isFinite(lastActivity) || now - lastActivity > maximumAgeMs;
  });
  if (!stale.length) return 0;

  const existingCallIds = new Set(db.voice_call_logs.map((row) => String(row.call_id || "")));
  stale.forEach((call) => {
    if (existingCallIds.has(String(call.call_id || ""))) return;
    db.voice_call_logs.push({
      id: makeId("cdr"),
      call_id: call.call_id,
      from_number: call.from_number || null,
      to_number: call.to_number || null,
      selected_agent_id: call.selected_agent_id || null,
      selected_agent_name: call.selected_agent_name || null,
      action: call.route_path || null,
      result: "StaleTimeout",
      started_at: call.started_at || null,
      ended_at: nowIso(),
      tenant_id: call.tenant_id || "",
      created_at: nowIso(),
      updated_at: nowIso()
    });
  });
  const staleIds = new Set(stale.map((call) => String(call.id)));
  db.voice_active_calls = db.voice_active_calls.filter((call) => !staleIds.has(String(call.id)));
  saveDb(db);
  return stale.length;
}

function readProviderSecrets() {
  if (!fs.existsSync(SECRETS_PATH)) return {};
  const payload = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8"));
  if (payload && payload.version === 1 && payload.algorithm === "aes-256-gcm") {
    const key = providerVaultKey();
    if (!key) {
      const error = new Error("GoodVoice provider vault key is not configured.");
      error.code = "GOODVOICE_PROVIDER_VAULT_KEY_REQUIRED";
      throw error;
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(payload.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
    return JSON.parse(plaintext);
  }
  if (payload && typeof payload === "object") {
    if (providerVaultKey()) {
      saveProviderSecrets(payload);
    }
    return payload;
  }
  return {};
}

function saveProviderSecrets(secrets) {
  const key = providerVaultKey();
  if (!key) {
    const error = new Error("GoodVoice provider vault key is not configured.");
    error.code = "GOODVOICE_PROVIDER_VAULT_KEY_REQUIRED";
    throw error;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secrets), "utf8"),
    cipher.final()
  ]);
  const envelope = {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
  fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
  const temporaryPath = `${SECRETS_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(envelope, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(temporaryPath, SECRETS_PATH);
  fs.chmodSync(SECRETS_PATH, 0o600);
}

function providerVaultKey() {
  const raw = String(process.env.GOODVOICE_PROVIDER_VAULT_KEY || "").trim();
  if (!raw) return null;
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  } catch (_) {
    // Fall through to a stable digest for deployment systems that provide text keys.
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function providerVaultEncrypted() {
  if (!fs.existsSync(SECRETS_PATH)) return true;
  try {
    const payload = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8"));
    return payload?.version === 1 && payload?.algorithm === "aes-256-gcm";
  } catch (_) {
    return false;
  }
}

function runAsteriskCommand(command) {
  try {
    return execFileSync("asterisk", ["-rx", command], {
      encoding: "utf8",
      timeout: 2500,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch (_) {
    return "";
  }
}

function runSystemCommand(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch (_) {
    return "";
  }
}

async function getTelephonyHealth(tenantId = "") {
  const versionOutput = runAsteriskCommand("core show version");
  const registrationsOutput = runAsteriskCommand("pjsip show registrations");
  const endpointsOutput = runAsteriskCommand("pjsip show endpoints");
  const chanSipRegistriesOutput = runAsteriskCommand("sip show registry");
  const chanSipPeersOutput = runAsteriskCommand("sip show peers");
  const managerOutput = runAsteriskCommand("manager show settings");
  const channelOutput = runAsteriskCommand("core show channels count");
  const asteriskProcessOutput = runSystemCommand("pgrep", ["-x", "asterisk"]);
  const listeningSockets = runSystemCommand("ss", ["-ltn"]);

  const asteriskConnected =
    /Asterisk\s+\d/i.test(versionOutput) ||
    /^\s*\d+\s*$/m.test(asteriskProcessOutput);
  const registeredMatches = [
    ...(registrationsOutput.match(/\bRegistered\b/gi) || []),
    ...(chanSipRegistriesOutput.match(/\bRegistered\b/gi) || [])
  ];
  const rejectedMatches = registrationsOutput.match(/\bRejected\b/gi) || [];
  const endpointMatches = endpointsOutput.match(/Endpoint:\s+\S+/gi) || [];
  const chanSipPeerLines = chanSipPeersOutput
    .split(/\r?\n/)
    .filter((line) => /bulkvs/i.test(line));
  const reachableChanSipPeers = chanSipPeerLines.filter((line) => /\bOK\b/i.test(line));
  const activeChannelsMatch = channelOutput.match(/(\d+)\s+active channels/i);
  const sipEndpoints = endpointMatches.length + chanSipPeerLines.length;
  const sipTrunkConnected =
    registeredMatches.length > 0 ||
    reachableChanSipPeers.length > 0;

  const localHealth = {
    asterisk_connected: asteriskConnected,
    sip_trunk_connected: sipTrunkConnected,
    ami_connected:
      asteriskConnected &&
      (
        /Manager\s+\(AMI\):\s+Yes/i.test(managerOutput) ||
        /127\.0\.0\.1:5038\b/.test(listeningSockets)
      ),
    sip_registrations: registeredMatches.length,
    sip_rejected_registrations: rejectedMatches.length,
    sip_endpoints: sipEndpoints,
    sip_reachable_endpoints: reachableChanSipPeers.length,
    sip_auth_mode: chanSipPeerLines.length > 0 ? "ip" : "unconfigured",
    active_channels: activeChannelsMatch ? Number(activeChannelsMatch[1]) : 0
  };
  if (process.env.NODE_ENV === "test") return localHealth;

  try {
    const response = await fetch(
      process.env.GOODVOICE_PBX_HEALTH_URL ||
      "http://127.0.0.1:3015/api/voice/pbx-health/internal",
      {
        headers: {
          accept: "application/json",
          "x-goodbase-webhook-secret": String(process.env.GOODOS_VOICE_SECRET || ""),
          ...(tenantId ? { "x-goodvoice-tenant-id": String(tenantId) } : {})
        },
        signal: AbortSignal.timeout(1500)
      }
    );
    if (!response.ok) return localHealth;
    const remoteHealth = await response.json();
    return {
      ...localHealth,
      ...Object.fromEntries(
        [
          "asterisk_connected",
          "sip_trunk_connected",
          "ami_connected",
          "sip_registrations",
          "sip_endpoints",
          "sip_reachable_endpoints",
          "sip_auth_mode",
          "active_channels",
          "provider_credentials_configured"
        ].map((key) => [key, remoteHealth[key] ?? localHealth[key]])
      )
    };
  } catch (_) {
    return localHealth;
  }
}

function requireVoiceAdmin(req, res, next) {
  if (process.env.NODE_ENV === "test" && !req.user) return next();
  const role = String(
    req.user && (req.user.platformRole || req.user.platform_role || req.user.role) || ""
  ).toLowerCase();
  if (!["owner", "admin"].includes(role)) {
    return res.status(403).json({
      success: false,
      code: "ADMIN_REQUIRED",
      message: "GoodVoice administration requires an owner or admin role."
    });
  }
  return next();
}

function listTable(tableName) {
  return (req, res) => {
    const db = ensureDb();
    return res.json(tenantRows(req, db[tableName]));
  };
}

function createTableRecord(tableName, prefix) {
  return (req, res) => {
    const db = ensureDb();
    let updates = sanitizeTableWrite(tableName, req.body);
    if (tableName === TABLES.numbers) {
      const phoneNumber = normalizeE164(updates.phone_number);
      if (!phoneNumber) {
        return res.status(400).json({
          success: false,
          code: "INVALID_E164_NUMBER",
          message: "A valid E.164 phone number is required."
        });
      }
      const conflict = db.voice_numbers.find((number) =>
        normalizeE164(number.phone_number || number.phoneNumber) === phoneNumber
      );
      if (conflict) {
        return res.status(409).json({
          success: false,
          code: "PHONE_NUMBER_ALREADY_ASSIGNED",
          message: "This phone number is already assigned to a GoodVoice workspace."
        });
      }
      updates.phone_number = phoneNumber;
    }
    if (tableName === TABLES["emergency-locations"]) {
      updates = normalizeEmergencyLocation(updates);
      const missing = missingEmergencyFields(updates);
      if (missing.length) {
        return res.status(400).json({
          success: false,
          code: "INVALID_EMERGENCY_LOCATION",
          message: `Complete the required emergency location fields: ${missing.join(", ")}.`,
          missing
        });
      }
      if (updates.status === "validated" && !updates.provider_reference) {
        updates.status = "pending_provider";
      }
    }
    if (tableName === TABLES["port-requests"]) {
      updates = normalizePortRequest(updates);
      const missing = missingPortFields(updates);
      if (missing.length) {
        return res.status(400).json({
          success: false,
          code: "INVALID_PORT_REQUEST",
          message: `Complete the required port request fields: ${missing.join(", ")}.`,
          missing
        });
      }
      if (
        ["submitted", "carrier_review", "confirmed", "completed"].includes(updates.status) &&
        !updates.external_reference
      ) {
        return res.status(400).json({
          success: false,
          code: "PORT_PROVIDER_REFERENCE_REQUIRED",
          message: "A carrier reference is required before a port request can advance beyond draft."
        });
      }
      const duplicate = db.voice_port_requests.find((request) =>
        String(request.tenant_id || "") === String(req.voiceTenantId || "") &&
        !["completed", "rejected"].includes(String(request.status || "draft")) &&
        Array.isArray(request.numbers) &&
        request.numbers.some((number) => updates.numbers.includes(canonicalPhone(number)))
      );
      if (duplicate) {
        return res.status(409).json({
          success: false,
          code: "DUPLICATE_PORT_REQUEST",
          message: "One or more numbers already belong to an active port request."
        });
      }
    }
    const record = {
      id: makeId(prefix),
      ...updates,
      tenant_id: req.voiceTenantId,
      created_at: nowIso(),
      updated_at: nowIso()
    };

    db[tableName].push(record);
    saveDb(db);
    return res.status(201).json(record);
  };
}

function updateTableRecord(tableName) {
  return (req, res) => {
    const db = ensureDb();
    const idx = db[tableName].findIndex((row) =>
      recordMatchesId(row, req.params.id) &&
      String(row.tenant_id || "") === String(req.voiceTenantId || "")
    );

    if (idx < 0) {
      return res.status(404).json({
        success: false,
        message: `${tableName} record not found`
      });
    }

    let updates = sanitizeTableWrite(tableName, req.body);
    if (tableName === TABLES["emergency-locations"]) {
      updates = normalizeEmergencyLocation({ ...db[tableName][idx], ...updates });
      const missing = missingEmergencyFields(updates);
      if (missing.length) {
        return res.status(400).json({
          success: false,
          code: "INVALID_EMERGENCY_LOCATION",
          message: `Complete the required emergency location fields: ${missing.join(", ")}.`,
          missing
        });
      }
      if (updates.status === "validated" && !updates.provider_reference) {
        updates.status = "pending_provider";
      }
    }
    if (tableName === TABLES["port-requests"]) {
      updates = normalizePortRequest({ ...db[tableName][idx], ...updates });
      const missing = missingPortFields(updates);
      if (missing.length) {
        return res.status(400).json({
          success: false,
          code: "INVALID_PORT_REQUEST",
          message: `Complete the required port request fields: ${missing.join(", ")}.`,
          missing
        });
      }
      if (
        ["submitted", "carrier_review", "confirmed", "completed"].includes(updates.status) &&
        !updates.external_reference
      ) {
        return res.status(400).json({
          success: false,
          code: "PORT_PROVIDER_REFERENCE_REQUIRED",
          message: "A carrier reference is required before a port request can advance beyond draft."
        });
      }
    }
    db[tableName][idx] = {
      ...db[tableName][idx],
      ...updates,
      updated_at: nowIso()
    };

    saveDb(db);
    return res.json(db[tableName][idx]);
  };
}

function deleteTableRecord(tableName) {
  return (req, res) => {
    const db = ensureDb();
    const before = db[tableName].length;

    db[tableName] = db[tableName].filter((row) =>
      !recordMatchesId(row, req.params.id) ||
      String(row.tenant_id || "") !== String(req.voiceTenantId || "")
    );

    if (db[tableName].length === before) {
      return res.status(404).json({
        success: false,
        message: `${tableName} record not found`
      });
    }

    saveDb(db);
    return res.json({
      success: true,
      deleted: true,
      id: req.params.id
    });
  };
}

function crud(pathName, tableName, prefix) {
  router.get(pathName, listTable(tableName));
  router.post(pathName, requireVoiceAdmin, createTableRecord(tableName, prefix));
  router.patch(`${pathName}/:id`, requireVoiceAdmin, updateTableRecord(tableName));
  router.delete(`${pathName}/:id`, requireVoiceAdmin, deleteTableRecord(tableName));
}

router.get("/health", (_req, res) => {
  return res.json({
    status: "ok",
    module: "GoodVoice",
    version: "2.2.0",
    timestamp: nowIso()
  });
});

router.get("/health/details", requireVoiceAccess, async (req, res) => {
  let databaseConnected = false;
  let tablesReady = false;
  let db = null;

  try {
    db = ensureDb();
    reconcileStaleCalls(db);
    databaseConnected = true;
    tablesReady = Object.values(TABLES).every((table) => Array.isArray(db[table]));
  } catch (err) {
    databaseConnected = false;
    tablesReady = false;
  }

  const telephony = await getTelephonyHealth(req.voiceTenantId);
  const providerSecrets = readProviderSecrets();
  const tenantProviderSecrets = providerSecrets.tenants?.[req.voiceTenantId] || {};
  const backup = stateBackupStatus();
  const scoped = databaseConnected
    ? Object.fromEntries(
        Object.values(TABLES).map((table) => [table, tenantRows(req, db[table])])
      )
    : {};
  const liveNumbers = databaseConnected
    ? scoped.voice_numbers.filter((number) => number.demo_data !== true)
    : [];
  const blockers = [];
  if (!databaseConnected) blockers.push("GoodBase voice database is unavailable.");
  if (liveNumbers.length === 0) blockers.push("Import at least one owned phone number.");
  if (databaseConnected && scoped.voice_agents.length === 0) blockers.push("Add at least one active call agent.");
  if (databaseConnected && scoped.voice_routes.length === 0) blockers.push("Create at least one active DID route.");
  if (!telephony.provider_credentials_configured && Object.keys(tenantProviderSecrets).length === 0) {
    blockers.push("Configure a supported messaging carrier.");
  }
  if (!backup.fresh) blockers.push("GoodVoice state backup has not completed successfully in the last 26 hours.");
  if (!telephony.asterisk_connected) blockers.push("Asterisk is not reachable.");
  if (telephony.sip_endpoints === 0) blockers.push("No SIP endpoint is configured in Asterisk.");
  if (telephony.sip_endpoints > 0 && !telephony.sip_trunk_connected) {
    blockers.push("The configured SIP endpoint is not reachable.");
  }
  const legacyUnscopedRecords = databaseConnected
    ? Object.values(TABLES).reduce(
        (total, table) => total + db[table].filter((row) => !String(row.tenant_id || "").trim()).length,
        0
      )
    : 0;
  if (legacyUnscopedRecords > 0) {
    blockers.push("Legacy unscoped voice records must be archived before production use.");
  }

  return res.json({
    status: "ok",
    module: "GoodVoice",
    database_connected: databaseConnected,
    database_persistent: true,
    voice_tables_ready: tablesReady,
    backend_api_ready: true,
    ...telephony,
    gateway_secret_configured: Boolean(process.env.GOODOS_VOICE_SECRET),
    provider_credentials_configured:
      telephony.provider_credentials_configured === true || Object.keys(tenantProviderSecrets).length > 0,
    state_backup: backup,
    provider_vault_encrypted: providerVaultEncrypted(),
    legacy_unscoped_records: legacyUnscopedRecords,
    setup_complete: blockers.length === 0,
    blockers,
    counts: databaseConnected ? {
      numbers: scoped.voice_numbers.length,
      live_numbers: liveNumbers.length,
      agents: scoped.voice_agents.length,
      routes: scoped.voice_routes.length,
      business_hours: scoped.voice_business_hours.length,
      queues: scoped.voice_queues.length,
      voicemails: scoped.voice_voicemail_profiles.length,
      call_logs: scoped.voice_call_logs.length,
      active_calls: scoped.voice_active_calls.length
    } : {},
    last_gateway_event_at: (() => {
      try {
        const db = ensureDb();
        const events = tenantRows(req, db.voice_call_events || []);
        if (!events.length) return null;
        return events
          .map((event) => event.event_timestamp || event.created_at)
          .filter(Boolean)
          .sort()
          .slice(-1)[0] || null;
      } catch (_) {
        return null;
      }
    })(),
    version: "2.2.0"
  });
});

// Secure the complete voice surface by default. The only public route is the
// redacted health check above. PBX event routes use signed, replay-resistant
// gateway requests; every other route requires a GoodVoice-entitled session.
router.use((req, res, next) => {
  if (req.method === "POST" && ["/route-call", "/call-event"].includes(req.path)) {
    return requireVoiceWebhook(req, res, next);
  }
  return requireVoiceAccess(req, res, next);
});

router.get("/tables", requireVoiceAdmin, (req, res) => {
  const db = ensureDb();

  return res.json({
    success: true,
    database_path: DB_PATH,
    tables: Object.values(TABLES).map((table) => ({
      name: table,
      count: tenantRows(req, db[table]).length
    }))
  });
});

crud("/numbers", TABLES.numbers, "num");
crud("/agents", TABLES.agents, "agent");
crud("/routes", TABLES.routes, "route");
crud("/business-hours", TABLES["business-hours"], "hours");
crud("/queues", TABLES.queues, "queue");
crud("/voicemail-profiles", TABLES["voicemail-profiles"], "vm");
crud("/call-logs", TABLES["call-logs"], "cdr");
crud("/emergency-locations", TABLES["emergency-locations"], "e911");
crud("/port-requests", TABLES["port-requests"], "port");

router.patch("/call-logs/:id/disposition", requireVoiceAdmin, (req, res) => {
  const db = ensureDb();
  const index = db.voice_call_logs.findIndex((row) =>
    recordMatchesId(row, req.params.id) &&
    String(row.tenant_id || "") === String(req.voiceTenantId || "")
  );
  if (index < 0) {
    return res.status(404).json({ success: false, message: "Call log not found." });
  }
  const code = String(req.body.disposition_code || "").trim().slice(0, 80);
  const notes = String(req.body.disposition_notes || "").trim().slice(0, 2000);
  db.voice_call_logs[index] = {
    ...db.voice_call_logs[index],
    disposition_status: code ? "completed" : "pending",
    disposition_code: code,
    disposition_notes: notes,
    updated_at: nowIso()
  };
  saveDb(db);
  return res.json(db.voice_call_logs[index]);
});

router.post("/numbers/import", requireVoiceAdmin, (req, res) => {
  const input = Array.isArray(req.body)
    ? req.body
    : Array.isArray(req.body && req.body.numbers)
      ? req.body.numbers
      : [];

  if (input.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Provide a non-empty numbers array."
    });
  }
  if (input.length > 1000) {
    return res.status(400).json({
      success: false,
      message: "A maximum of 1,000 phone numbers can be imported at once."
    });
  }

  const db = ensureDb();
  const normalizedRows = [];
  const invalid = [];
  const seen = new Set();

  input.forEach((item, index) => {
    const source = typeof item === "string" ? { phone_number: item } : (item || {});
    const phoneNumber = normalizeE164(
      source.phone_number || source.phoneNumber || source.did || source.number
    );
    if (!phoneNumber) {
      invalid.push({
        index,
        value: source.phone_number || source.phoneNumber || source.did || source.number || ""
      });
      return;
    }
    if (seen.has(phoneNumber)) return;
    seen.add(phoneNumber);
    normalizedRows.push({
      phone_number: phoneNumber,
      label: String(source.label || source.name || `Imported DID ${phoneNumber}`).trim().slice(0, 120),
      partner_name: String(source.partner_name || source.partnerName || "GoodVoice").trim().slice(0, 120),
      department: ["Sales", "Support", "Billing", "General"].includes(source.department)
        ? source.department
        : "General",
      routing_mode: ["Round Robin", "Priority", "Least Recent", "Broadcast"].includes(source.routing_mode || source.routingMode)
        ? (source.routing_mode || source.routingMode)
        : "Round Robin",
      business_hours_id: Number(source.business_hours_id || source.businessHoursId || 1),
      fallback_action: ["Queue", "Voicemail", "Overflow Number", "Reject"].includes(source.fallback_action || source.fallbackAction)
        ? (source.fallback_action || source.fallbackAction)
        : "Voicemail",
      fallback_target: String(source.fallback_target || source.fallbackTarget || ""),
      provider: String(source.provider || (req.body && req.body.provider) || "bulkvs").toLowerCase(),
      status: "active",
      is_active: source.is_active !== false
    });
  });

  if (invalid.length > 0) {
    return res.status(400).json({
      success: false,
      message: "One or more phone numbers are not valid E.164 numbers.",
      invalid
    });
  }

  const crossTenantConflicts = normalizedRows
    .map((row) => row.phone_number)
    .filter((phoneNumber) => db.voice_numbers.some((number) =>
      normalizeE164(number.phone_number || number.phoneNumber) === phoneNumber &&
      String(number.tenant_id || "") !== String(req.voiceTenantId || "")
    ));
  if (crossTenantConflicts.length > 0) {
    return res.status(409).json({
      success: false,
      code: "PHONE_NUMBER_ALREADY_ASSIGNED",
      message: "One or more phone numbers are already assigned to another GoodVoice workspace.",
      conflicts: crossTenantConflicts
    });
  }

  if (req.body && req.body.replace_demo === true) {
    db.voice_numbers = db.voice_numbers.filter((number) =>
      number.demo_data !== true ||
      String(number.tenant_id || "") !== String(req.voiceTenantId || "")
    );
  }

  let created = 0;
  let updated = 0;
  const imported = normalizedRows.map((row) => {
    const existing = db.voice_numbers.find(
      (number) =>
        normalizeE164(number.phone_number || number.phoneNumber) === row.phone_number &&
        String(number.tenant_id || "") === String(req.voiceTenantId || "")
    );
    if (existing) {
      Object.assign(existing, row, {
        updated_at: nowIso(),
        demo_data: false
      });
      updated += 1;
      return existing;
    }

    const numericIds = db.voice_numbers
      .map((number) => Number(number.id))
      .filter(Number.isFinite);
    const record = {
      id: numericIds.length ? Math.max(...numericIds) + created + 1 : created + 1,
      ...row,
      tenant_id: req.voiceTenantId,
      demo_data: false,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    db.voice_numbers.push(record);
    created += 1;
    return record;
  });

  saveDb(db);
  return res.status(201).json({
    success: true,
    created,
    updated,
    imported,
    total_numbers: tenantRows(req, db.voice_numbers).length
  });
});

router.get("/settings", async (req, res) => {
  const db = ensureDb();
  const telephony = await getTelephonyHealth(req.voiceTenantId);
  return res.json({
    ...tenantSettings(req, db),
    asterisk_connection_status: telephony.asterisk_connected ? "Connected" : "Disconnected",
    sip_trunk_status: telephony.sip_trunk_connected ? "Online" : "Offline"
  });
});

router.patch("/settings", requireVoiceAdmin, (req, res) => {
  const db = ensureDb();
  const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
  const updates = Object.fromEntries(
    Object.entries(req.body || {}).filter(([key]) => allowed.has(key))
  );
  db.voice_settings_by_tenant[req.voiceTenantId] = {
    ...tenantSettings(req, db),
    ...updates,
    updated_at: nowIso()
  };
  saveDb(db);
  return res.json(db.voice_settings_by_tenant[req.voiceTenantId]);
});

router.get("/operations/readiness", async (req, res) => {
  const db = ensureDb();
  const settings = tenantSettings(req, db);
  const telephony = await getTelephonyHealth(req.voiceTenantId);
  const backup = stateBackupStatus();
  const providerSecrets = readProviderSecrets();
  const tenantProviderSecrets = providerSecrets.tenants?.[req.voiceTenantId] || {};
  const numbers = tenantRows(req, db.voice_numbers).filter((number) => number.demo_data !== true);
  const agents = tenantRows(req, db.voice_agents).filter((agent) => agent.is_active !== false);
  const routes = tenantRows(req, db.voice_routes).filter((route) => route.is_active !== false);
  const emergencyLocations = tenantRows(req, db.voice_emergency_locations);
  const portRequests = tenantRows(req, db.voice_port_requests);
  const validatedLocations = emergencyLocations.filter((item) => item.status === "validated");
  const pendingLocations = emergencyLocations.filter((item) => item.status === "pending_provider");
  const activePorts = portRequests.filter((item) =>
    !["completed", "rejected"].includes(String(item.status || "draft"))
  );
  const blockers = [];
  if (!numbers.length) blockers.push("Import at least one carrier-owned phone number.");
  if (!agents.length) blockers.push("Add at least one active call agent.");
  if (!routes.length) blockers.push("Create at least one active DID route.");
  if (numbers.length && !validatedLocations.length) {
    blockers.push("Validate at least one carrier-backed emergency location for live numbers.");
  }
  if (!telephony.provider_credentials_configured && !Object.keys(tenantProviderSecrets).length) {
    blockers.push("Configure BulkVS or SignalWire messaging credentials.");
  }
  if (!telephony.asterisk_connected) blockers.push("Asterisk is not reachable.");
  if (!telephony.sip_trunk_connected) blockers.push("The SIP trunk is not reachable.");
  if (!backup.fresh) blockers.push("GoodVoice state backup has not completed successfully in the last 26 hours.");
  if (settings.call_recording_enabled) {
    blockers.push("Call recording must remain disabled until consent prompts, retention, access controls, and a live recording test are completed.");
  }
  if (settings.missed_call_text_enabled) {
    blockers.push("Missed-call automatic SMS requires a production delivery worker and must remain disabled until tested.");
  }
  if (settings.supervisor_monitoring_enabled || settings.supervisor_whisper_enabled ||
      settings.supervisor_barge_enabled || settings.supervisor_takeover_enabled) {
    blockers.push("Supervisor PBX actions are configured as policy only and are not enabled in this release.");
  }
  if (settings.conversation_intelligence_enabled) {
    blockers.push("Conversation intelligence processing is not connected in this release.");
  }
  return res.json({
    status: blockers.length ? "attention_required" : "ready",
    blockers,
    emergency_locations: {
      total: emergencyLocations.length,
      validated: validatedLocations.length,
      pending_provider: pendingLocations.length
    },
    porting: {
      active_requests: activePorts.length,
      numbers_in_progress: activePorts.reduce(
        (total, item) => total + (Array.isArray(item.numbers) ? item.numbers.length : 0),
        0
      )
    },
    supervisor_controls: {
      monitor: false,
      whisper: false,
      barge: false,
      takeover: false
    },
    telephony: {
      asterisk_connected: telephony.asterisk_connected,
      sip_trunk_connected: telephony.sip_trunk_connected,
      ami_connected: telephony.ami_connected,
      sip_endpoints: telephony.sip_endpoints
    },
    messaging: {
      provider_credentials_configured:
        telephony.provider_credentials_configured === true || Object.keys(tenantProviderSecrets).length > 0,
      inbound_webhook_verified: false,
      delivery_callbacks_verified: false
    },
    backup,
    quality_policy: {
      enabled: settings.quality_monitoring_enabled === true,
      minimum_mos: Number(settings.quality_min_mos || 3.5),
      maximum_jitter_ms: Number(settings.quality_max_jitter_ms || 30),
      maximum_packet_loss_percent: Number(settings.quality_max_packet_loss_percent || 1)
    }
  });
});

router.get("/providers/status", async (req, res) => {
  const secrets = readProviderSecrets();
  const tenantSecrets = secrets.tenants?.[req.voiceTenantId] || {};
  const telephony = await getTelephonyHealth(req.voiceTenantId);
  return res.json({
    bulkvs: {
      credentials_configured: Boolean(tenantSecrets.bulkvs && tenantSecrets.bulkvs.api_username && tenantSecrets.bulkvs.api_secret),
      sip_route_configured: telephony.sip_endpoints > 0,
      sip_registered: telephony.sip_trunk_connected
    },
    signalwire: {
      credentials_configured: Boolean(tenantSecrets.signalwire && tenantSecrets.signalwire.project_id && tenantSecrets.signalwire.api_token),
      sip_route_configured: telephony.sip_endpoints > 0,
      sip_registered: telephony.sip_trunk_connected
    }
  });
});

router.post("/providers/bulkvs/configure", requireVoiceAdmin, (req, res) => {
  const apiUsername = String(req.body.username || req.body.api_username || "").trim();
  const apiSecret = String(req.body.api_key || req.body.api_secret || "").trim();
  if (!apiUsername || !apiSecret) {
    return res.status(400).json({
      success: false,
      message: "BulkVS API username and API secret are required."
    });
  }
  const secrets = readProviderSecrets();
  secrets.tenants = secrets.tenants || {};
  secrets.tenants[req.voiceTenantId] = secrets.tenants[req.voiceTenantId] || {};
  secrets.tenants[req.voiceTenantId].bulkvs = {
    api_username: apiUsername,
    api_secret: apiSecret,
    updated_at: nowIso()
  };
  saveProviderSecrets(secrets);
  return res.json({
    success: true,
    provider: "bulkvs",
    credentials_configured: true,
    message: "BulkVS credentials were stored in the GoodVoice backend vault."
  });
});

router.post("/providers/signalwire/configure", requireVoiceAdmin, (req, res) => {
  const projectId = String(req.body.project_id || "").trim();
  const apiToken = String(req.body.api_token || "").trim();
  const spaceUrl = String(req.body.space_url || "").trim();
  if (!projectId || !apiToken || !spaceUrl) {
    return res.status(400).json({
      success: false,
      message: "SignalWire Space URL, project ID, and API token are required."
    });
  }
  const secrets = readProviderSecrets();
  secrets.tenants = secrets.tenants || {};
  secrets.tenants[req.voiceTenantId] = secrets.tenants[req.voiceTenantId] || {};
  secrets.tenants[req.voiceTenantId].signalwire = {
    space_url: spaceUrl,
    project_id: projectId,
    api_token: apiToken,
    updated_at: nowIso()
  };
  saveProviderSecrets(secrets);
  return res.json({
    success: true,
    provider: "signalwire",
    credentials_configured: true,
    message: "SignalWire credentials were stored in the GoodVoice backend vault."
  });
});

router.patch("/agents/:id/status", requireVoiceAdmin, (req, res) => {
  const db = ensureDb();
  const idx = db.voice_agents.findIndex((row) =>
    recordMatchesId(row, req.params.id) &&
    String(row.tenant_id || "") === String(req.voiceTenantId || "")
  );

  if (idx < 0) {
    return res.status(404).json({
      success: false,
      message: "voice agent not found"
    });
  }

  db.voice_agents[idx] = {
    ...db.voice_agents[idx],
    current_status: req.body.current_status || req.body.currentStatus || req.body.status || "available",
    updated_at: nowIso()
  };

  saveDb(db);
  return res.json(db.voice_agents[idx]);
});

router.get("/active-calls", (req, res) => {
  const db = ensureDb();
  reconcileStaleCalls(db);
  return res.json(tenantRows(req, db.voice_active_calls));
});

router.get("/route-decisions", (req, res) => {
  const db = ensureDb();
  return res.json(tenantRows(req, db.voice_route_decisions));
});

router.get("/call-events", (req, res) => {
  const db = ensureDb();
  return res.json(tenantRows(req, db.voice_call_events));
});

router.get("/call-logs/export", (req, res) => {
  const db = ensureDb();
  const rows = tenantRows(req, db.voice_call_logs);

  const headers = [
    "call_id",
    "from_number",
    "to_number",
    "partner_name",
    "department",
    "selected_agent_name",
    "action",
    "result",
    "duration_seconds",
    "wait_seconds",
    "started_at",
    "answered_at",
    "ended_at"
  ];

  const csv = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((key) => {
        const value = row[key] === undefined || row[key] === null ? "" : String(row[key]);
        return `"${value.replace(/"/g, '""')}"`;
      }).join(",")
    )
  ].join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=goodos-voice-call-logs.csv");
  return res.send(csv);
});

router.post("/route-call", (req, res) => {
  const started = Date.now();
  const db = ensureDb();
  reconcileStaleCalls(db);

  const callId = req.body.call_id || req.body.callId || makeId("call");
  const fromNumber = canonicalPhone(req.body.from_number || req.body.fromNumber);
  const toNumber = canonicalPhone(req.body.to_number || req.body.toNumber);
  const classification = req.body.classification || req.body.department || "General";

  const voiceNumber = db.voice_numbers.find((number) => {
    const storedNumber = canonicalPhone(number.phone_number || number.phoneNumber);
    const status = String(number.status || "active").toLowerCase();
    return storedNumber === toNumber && status !== "disabled" && number.is_active !== false;
  });

  let response;
  let tenantId = "";

  if (!voiceNumber) {
    response = {
      action: "reject",
      reason: "No active voice number found"
    };
  } else {
    tenantId = String(voiceNumber.tenant_id || "");
    const route = db.voice_routes.find((item) => {
      const routeNumberId = item.incoming_number_id || item.incomingNumberId || item.voice_number_id || item.voiceNumberId;
      const routeToNumber = canonicalPhone(item.to_number || item.toNumber || item.phone_number || item.phoneNumber);
      const routeDept = item.department || item.classification;

      const numberMatches =
        String(routeNumberId || "") === String(voiceNumber.id) ||
        routeToNumber === toNumber;

      const deptMatches =
        !routeDept ||
        String(routeDept).toLowerCase() === String(classification).toLowerCase();

      const active = String(item.status || "active").toLowerCase() !== "disabled" && item.is_active !== false;

      const tenantMatches = String(item.tenant_id || "") === tenantId;
      return numberMatches && deptMatches && active && tenantMatches;
    });

    if (!route) {
      response = {
        action: "reject",
        reason: "No active route found"
      };
    } else {
      const assignedIds = Array.isArray(route.assigned_agent_ids)
        ? route.assigned_agent_ids
        : Array.isArray(route.assignedAgentIds)
          ? route.assignedAgentIds
          : [];

      const availableAgents = db.voice_agents.filter((agent) => {
        const agentStatus = String(agent.current_status || agent.currentStatus || "available").toLowerCase();
        const accountStatus = String(agent.status || "active").toLowerCase();
        const assigned = assignedIds.length === 0 || assignedIds.map(String).includes(String(agent.id));

        return String(agent.tenant_id || "") === tenantId &&
          assigned &&
          agentStatus === "available" &&
          accountStatus !== "disabled" &&
          agent.is_active !== false;
      });

      if (availableAgents.length > 0) {
        const selected = availableAgents.sort((a, b) => Number(a.priority || 999) - Number(b.priority || 999))[0];

        response = {
          action: "dial_agent",
          agent_id: selected.id,
          agent_name: selected.name,
          agent_phone: selected.direct_phone_number || selected.directPhoneNumber || selected.phone_number || selected.phoneNumber,
          extension: selected.extension,
          timeout_seconds: Number(route.timeout_seconds || route.timeoutSeconds || 25)
        };
      } else if (
        String(process.env.GOODVOICE_ENABLE_PBX_QUEUES || "").toLowerCase() === "true" &&
        (route.queue_id || route.queueId)
      ) {
        const queueId = route.queue_id || route.queueId;
        const queue = db.voice_queues.find((item) =>
          String(item.id) === String(queueId) && String(item.tenant_id || "") === tenantId
        );

        response = {
          action: "queue",
          queue_id: queueId,
          queue_name: queue ? queue.queue_name || queue.queueName : "GoodOS Voice Queue"
        };
      } else if (
        String(process.env.GOODVOICE_ENABLE_PBX_VOICEMAIL || "").toLowerCase() === "true" &&
        (route.voicemail_profile_id || route.voicemailProfileId)
      ) {
        response = {
          action: "voicemail",
          voicemail_profile_id: route.voicemail_profile_id || route.voicemailProfileId
        };
      } else {
        response = {
          action: "reject",
          reason: "No available agent or production-ready fallback route"
        };
      }
    }
  }

  db.voice_route_decisions.push({
    id: makeId("decision"),
    call_id: callId,
    from_number: fromNumber,
    to_number: toNumber,
    classification,
    decision_action: response.action,
    selected_agent_id: response.agent_id || null,
    selected_queue_id: response.queue_id || null,
    selected_voicemail_profile_id: response.voicemail_profile_id || null,
    reject_reason: response.reason || null,
    decision_time_ms: Date.now() - started,
    raw_request: req.body,
    raw_response: response,
    tenant_id: tenantId,
    created_at: nowIso()
  });

  if (tenantId) {
    db.voice_call_events
      .filter((event) => String(event.call_id || "") === String(callId) && !event.tenant_id)
      .forEach((event) => { event.tenant_id = tenantId; });
  }

  if (["dial_agent", "queue", "voicemail"].includes(response.action)) {
    db.voice_active_calls.push({
      id: makeId("active"),
      call_id: callId,
      from_number: fromNumber,
      to_number: toNumber,
      selected_agent_id: response.agent_id || null,
      selected_agent_name: response.agent_name || null,
      current_status: response.action,
      route_path: response.action,
      started_at: nowIso(),
      last_event_at: nowIso(),
      raw_payload: req.body,
      tenant_id: tenantId
    });
  }

  saveDb(db);
  return res.json(response);
});

router.post("/call-event", (req, res) => {
  const db = ensureDb();
  reconcileStaleCalls(db);
  const callId = req.body.call_id || req.body.callId || null;
  const activeCall = callId
    ? db.voice_active_calls.find((call) => String(call.call_id) === String(callId))
    : null;
  const routeDecision = !activeCall && callId
    ? [...db.voice_route_decisions].reverse().find((item) => String(item.call_id) === String(callId))
    : null;
  const eventToNumber = canonicalPhone(req.body.to_number || req.body.toNumber);
  const voiceNumber = eventToNumber
    ? db.voice_numbers.find((number) =>
        canonicalPhone(number.phone_number || number.phoneNumber) === eventToNumber &&
        number.is_active !== false
      )
    : null;
  const eventTenantId = String(
    activeCall?.tenant_id || routeDecision?.tenant_id || voiceNumber?.tenant_id || ""
  );
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(db.voice_settings_by_tenant[eventTenantId] || {})
  };
  let workflowDispositionRequired = false;
  let workflowIntelligenceStatus = settings.conversation_intelligence_enabled
    ? "awaiting_recording"
    : "disabled";
  const quality = assessCallQuality(
    settings,
    req.body.rtp_metrics || req.body.rtpMetrics || {}
  );

  const event = {
    id: makeId("event"),
    call_id: callId,
    event_type: req.body.event_type || req.body.eventType || req.body.event || "Unknown",
    event_source: req.body.event_source || req.body.eventSource || "goodos_voice",
    event_timestamp: req.body.event_timestamp || req.body.eventTimestamp || nowIso(),
    channel_id: req.body.channel_id || req.body.channelId || null,
    agent_id: req.body.agent_id || req.body.agentId || null,
    message: req.body.message || "",
    quality,
    raw_event: req.body.raw_event || req.body.rawEvent || req.body,
    tenant_id: eventTenantId,
    created_at: nowIso()
  };

  db.voice_call_events.push(event);

  if (callId) {
    const active = activeCall || db.voice_active_calls.find((call) => String(call.call_id) === String(callId));
    if (active) {
      active.current_status = event.event_type;
      active.last_event_at = event.event_timestamp;
    }

    if (["Hangup", "BridgeLeave", "Voicemail", "RouteFailed"].includes(event.event_type)) {
      db.voice_active_calls = db.voice_active_calls.filter((call) => String(call.call_id) !== String(callId));
      const wrapUpRequired =
        Boolean(settings.disposition_required) &&
        Boolean(active && active.selected_agent_id);
      const wrapUpSeconds = Number(settings.post_call_wrap_up_seconds || 0);
      const wrapUpDueAt = new Date(Date.now() + wrapUpSeconds * 1000).toISOString();
      const intelligenceRequested =
        Boolean(settings.conversation_intelligence_enabled) &&
        Boolean(req.body.recording_url || req.body.recordingUrl);
      workflowDispositionRequired = wrapUpRequired;
      workflowIntelligenceStatus = intelligenceRequested
        ? "queued"
        : workflowIntelligenceStatus;

      db.voice_call_logs.push({
        id: makeId("cdr"),
        call_id: callId,
        from_number: active ? active.from_number : null,
        to_number: active ? active.to_number : null,
        selected_agent_id: active ? active.selected_agent_id : null,
        selected_agent_name: active ? active.selected_agent_name : null,
        action: active ? active.route_path : null,
        result: event.event_type,
        disposition_status: wrapUpRequired ? "pending" : "not_required",
        disposition_code: null,
        wrap_up_due_at: wrapUpRequired ? wrapUpDueAt : null,
        quality,
        intelligence_status: intelligenceRequested ? "queued" : "not_requested",
        intelligence_features: intelligenceRequested ? {
          summary: Boolean(settings.ai_summary_enabled),
          sentiment: Boolean(settings.sentiment_analysis_enabled),
          action_items: Boolean(settings.action_item_detection_enabled),
          redaction: Boolean(settings.transcript_redaction_enabled)
        } : null,
        recording_url: req.body.recording_url || req.body.recordingUrl || null,
        started_at: active ? active.started_at : null,
        ended_at: nowIso(),
        raw_payload: {
          active_call: active || null,
          final_event: event
        },
        tenant_id: active?.tenant_id || event.tenant_id || "",
        created_at: nowIso(),
        updated_at: nowIso()
      });
    }
  }

  saveDb(db);
  return res.status(201).json({
    success: true,
    event,
    workflow: {
      disposition_required: workflowDispositionRequired,
      wrap_up_seconds: Number(settings.post_call_wrap_up_seconds || 0),
      quality,
      conversation_intelligence: workflowIntelligenceStatus
    }
  });
});

router.post("/seed-demo", requireVoiceAdmin, (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({
      success: false,
      code: "DEMO_SEEDING_DISABLED",
      message: "Demo seeding is disabled in production."
    });
  }
  const db = ensureDb();

  // Make demo seeding idempotent: remove previous demo rows first.
  for (const table of Object.values(TABLES)) {
    db[table] = db[table].filter((row) =>
      row.demo_data !== true ||
      String(row.tenant_id || "") !== String(req.voiceTenantId || "")
    );
  }

  db.voice_numbers.push(
    {
      id: "num_demo_001",
      phone_number: "+17145550101",
      label: "Transparency Sales Line",
      partner_name: "Transparency Partner",
      department: "Sales",
      routing_mode: "priority",
      status: "active",
      demo_data: true,
      created_at: nowIso(),
      updated_at: nowIso()
    },
    {
      id: "num_demo_002",
      phone_number: "+17145550102",
      label: "Support Line",
      partner_name: "GoodOS Support",
      department: "Support",
      routing_mode: "round_robin",
      status: "active",
      demo_data: true,
      created_at: nowIso(),
      updated_at: nowIso()
    }
  );

  db.voice_agents.push(
    {
      id: "agent_demo_001",
      name: "Demo Agent One",
      extension: "101",
      direct_phone_number: "+17145559876",
      email: "agent1@example.com",
      partner_name: "Transparency Partner",
      skills: ["Sales", "General"],
      priority: 1,
      max_concurrent_calls: 1,
      current_status: "available",
      status: "active",
      demo_data: true,
      created_at: nowIso(),
      updated_at: nowIso()
    },
    {
      id: "agent_demo_002",
      name: "Demo Agent Two",
      extension: "102",
      direct_phone_number: "+17145559877",
      email: "agent2@example.com",
      partner_name: "GoodOS Support",
      skills: ["Support", "General"],
      priority: 2,
      max_concurrent_calls: 1,
      current_status: "available",
      status: "active",
      demo_data: true,
      created_at: nowIso(),
      updated_at: nowIso()
    }
  );

  db.voice_routes.push(
    {
      id: "route_demo_001",
      incoming_number_id: "num_demo_001",
      partner_name: "Transparency Partner",
      department: "Sales",
      routing_strategy: "priority",
      assigned_agent_ids: ["agent_demo_001"],
      status: "active",
      demo_data: true,
      created_at: nowIso(),
      updated_at: nowIso()
    },
    {
      id: "route_demo_002",
      incoming_number_id: "num_demo_002",
      partner_name: "GoodOS Support",
      department: "Support",
      routing_strategy: "round_robin",
      assigned_agent_ids: ["agent_demo_002"],
      status: "active",
      demo_data: true,
      created_at: nowIso(),
      updated_at: nowIso()
    }
  );

  for (const table of Object.values(TABLES)) {
    db[table]
      .filter((row) => row.demo_data === true && !row.tenant_id)
      .forEach((row) => { row.tenant_id = req.voiceTenantId; });
  }

  saveDb(db);

  return res.json({
    success: true,
    message: "GoodOS Voice demo data seeded"
  });
});

router.delete("/demo-data", requireVoiceAdmin, (req, res) => {
  const db = ensureDb();

  for (const table of Object.values(TABLES)) {
    db[table] = db[table].filter((row) =>
      row.demo_data !== true ||
      String(row.tenant_id || "") !== String(req.voiceTenantId || "")
    );
  }

  saveDb(db);

  return res.json({
    success: true,
    message: "GoodOS Voice demo data cleared"
  });
});

module.exports = router;
