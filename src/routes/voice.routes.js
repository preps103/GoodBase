const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const authRequired = process.env.NODE_ENV === "test"
  ? (req, res, next) => next()
  : require("../middleware/authRequired");

const router = express.Router();

const DB_PATH = path.resolve(
  process.env.GOODOS_VOICE_DB_PATH ||
  path.join(process.cwd(), "data", "goodos-voice-db.json")
);
const SECRETS_PATH = path.resolve(
  process.env.GOODVOICE_SECRETS_PATH ||
  path.join(path.dirname(DB_PATH), "goodvoice-provider-secrets.json")
);

const TABLES = {
  numbers: "voice_numbers",
  agents: "voice_agents",
  routes: "voice_routes",
  "business-hours": "voice_business_hours",
  queues: "voice_queues",
  "voicemail-profiles": "voice_voicemail_profiles",
  "call-logs": "voice_call_logs",
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
  call_recording_enabled: true,
  recording_consent_message: "This call is recorded for quality assurance.",
  webhook_url: "https://base.goodos.app/api/voice/call-event",
  auto_attendant_enabled: false,
  auto_attendant_number_ids: [],
  auto_attendant_greeting: "Thank you for calling. Please select an option.",
  auto_attendant_timeout_seconds: 8,
  auto_attendant_menu: [],
  missed_call_text_enabled: true,
  missed_call_text_template: "Sorry we missed your call. Reply here and our team will follow up.",
  spam_blocking_enabled: true,
  blocked_numbers: [],
  anonymous_call_action: "Voicemail",
  call_log_retention_days: 365,
  recording_retention_days: 90,
  sla_answer_seconds: 30,
  sla_abandon_rate_percent: 5,
  webhook_retry_count: 5,
  webhook_retry_delay_seconds: 30
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
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
  }

  let db = {};
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (err) {
    db = {};
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

  if (changed) saveDb(db);
  return db;
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
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

function readProviderSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8"));
  } catch (_) {
    return {};
  }
}

function saveProviderSecrets(secrets) {
  fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  fs.chmodSync(SECRETS_PATH, 0o600);
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

function getTelephonyHealth() {
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

  return {
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
}

function requireVoiceAdmin(req, res, next) {
  if (process.env.NODE_ENV === "test") return next();
  return authRequired(req, res, () => {
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
  });
}

function listTable(tableName) {
  return (req, res) => {
    const db = ensureDb();
    return res.json(db[tableName]);
  };
}

function createTableRecord(tableName, prefix) {
  return (req, res) => {
    const db = ensureDb();
    const record = {
      id: req.body && req.body.id ? req.body.id : makeId(prefix),
      ...(req.body || {}),
      created_at: (req.body && req.body.created_at) || nowIso(),
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
    const idx = db[tableName].findIndex((row) => recordMatchesId(row, req.params.id));

    if (idx < 0) {
      return res.status(404).json({
        success: false,
        message: `${tableName} record not found`
      });
    }

    db[tableName][idx] = {
      ...db[tableName][idx],
      ...(req.body || {}),
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

    db[tableName] = db[tableName].filter((row) => !recordMatchesId(row, req.params.id));

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
  router.post(pathName, createTableRecord(tableName, prefix));
  router.patch(`${pathName}/:id`, updateTableRecord(tableName));
  router.delete(`${pathName}/:id`, deleteTableRecord(tableName));
}

router.get("/health", (req, res) => {
  let databaseConnected = false;
  let tablesReady = false;
  let db = null;

  try {
    db = ensureDb();
    databaseConnected = true;
    tablesReady = Object.values(TABLES).every((table) => Array.isArray(db[table]));
  } catch (err) {
    databaseConnected = false;
    tablesReady = false;
  }

  const telephony = getTelephonyHealth();
  const providerSecrets = readProviderSecrets();
  const liveNumbers = databaseConnected
    ? db.voice_numbers.filter((number) => number.demo_data !== true)
    : [];
  const blockers = [];
  if (!databaseConnected) blockers.push("GoodBase voice database is unavailable.");
  if (liveNumbers.length === 0) blockers.push("Import at least one owned phone number.");
  if (!telephony.asterisk_connected) blockers.push("Asterisk is not reachable.");
  if (telephony.sip_endpoints === 0) blockers.push("No SIP endpoint is configured in Asterisk.");
  if (telephony.sip_endpoints > 0 && !telephony.sip_trunk_connected) {
    blockers.push("The configured SIP endpoint is not reachable.");
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
    provider_credentials_configured: Object.keys(providerSecrets).length > 0,
    setup_complete: blockers.length === 0,
    blockers,
    counts: databaseConnected ? {
      numbers: db.voice_numbers.length,
      live_numbers: liveNumbers.length,
      agents: db.voice_agents.length,
      routes: db.voice_routes.length,
      business_hours: db.voice_business_hours.length,
      queues: db.voice_queues.length,
      voicemails: db.voice_voicemail_profiles.length,
      call_logs: db.voice_call_logs.length,
      active_calls: db.voice_active_calls.length
    } : {},
    last_gateway_event_at: (() => {
      try {
        const db = ensureDb();
        const events = db.voice_call_events || [];
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
    version: "2.1.0"
  });
});

router.get("/tables", (req, res) => {
  const db = ensureDb();

  return res.json({
    success: true,
    database_path: DB_PATH,
    tables: Object.values(TABLES).map((table) => ({
      name: table,
      count: db[table].length
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

  if (req.body && req.body.replace_demo === true) {
    db.voice_numbers = db.voice_numbers.filter((number) => number.demo_data !== true);
  }

  let created = 0;
  let updated = 0;
  const imported = normalizedRows.map((row) => {
    const existing = db.voice_numbers.find(
      (number) => normalizeE164(number.phone_number || number.phoneNumber) === row.phone_number
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
    total_numbers: db.voice_numbers.length
  });
});

router.get("/settings", (req, res) => {
  const db = ensureDb();
  const telephony = getTelephonyHealth();
  return res.json({
    ...db.voice_settings,
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
  db.voice_settings = {
    ...db.voice_settings,
    ...updates,
    updated_at: nowIso()
  };
  saveDb(db);
  return res.json(db.voice_settings);
});

router.get("/providers/status", (req, res) => {
  const secrets = readProviderSecrets();
  const telephony = getTelephonyHealth();
  return res.json({
    bulkvs: {
      credentials_configured: Boolean(secrets.bulkvs && secrets.bulkvs.api_username && secrets.bulkvs.api_secret),
      sip_route_configured: telephony.sip_endpoints > 0,
      sip_registered: telephony.sip_trunk_connected
    },
    signalwire: {
      credentials_configured: Boolean(secrets.signalwire && secrets.signalwire.project_id && secrets.signalwire.api_token),
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
  secrets.bulkvs = {
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
  secrets.signalwire = {
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

router.patch("/agents/:id/status", (req, res) => {
  const db = ensureDb();
  const idx = db.voice_agents.findIndex((row) => recordMatchesId(row, req.params.id));

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
  return res.json(db.voice_active_calls);
});

router.get("/route-decisions", (req, res) => {
  const db = ensureDb();
  return res.json(db.voice_route_decisions);
});

router.get("/call-events", (req, res) => {
  const db = ensureDb();
  return res.json(db.voice_call_events);
});

router.get("/call-logs/export", (req, res) => {
  const db = ensureDb();
  const rows = db.voice_call_logs;

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

  const callId = req.body.call_id || req.body.callId || makeId("call");
  const fromNumber = normalizeNumber(req.body.from_number || req.body.fromNumber);
  const toNumber = normalizeNumber(req.body.to_number || req.body.toNumber);
  const classification = req.body.classification || req.body.department || "General";

  const voiceNumber = db.voice_numbers.find((number) => {
    const storedNumber = normalizeNumber(number.phone_number || number.phoneNumber);
    const status = String(number.status || "active").toLowerCase();
    return storedNumber === toNumber && status !== "disabled" && number.is_active !== false;
  });

  let response;

  if (!voiceNumber) {
    response = {
      action: "reject",
      reason: "No active voice number found"
    };
  } else {
    const route = db.voice_routes.find((item) => {
      const routeNumberId = item.incoming_number_id || item.incomingNumberId || item.voice_number_id || item.voiceNumberId;
      const routeToNumber = normalizeNumber(item.to_number || item.toNumber || item.phone_number || item.phoneNumber);
      const routeDept = item.department || item.classification;

      const numberMatches =
        String(routeNumberId || "") === String(voiceNumber.id) ||
        routeToNumber === toNumber;

      const deptMatches =
        !routeDept ||
        String(routeDept).toLowerCase() === String(classification).toLowerCase();

      const active = String(item.status || "active").toLowerCase() !== "disabled" && item.is_active !== false;

      return numberMatches && deptMatches && active;
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

        return assigned &&
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
      } else if (route.queue_id || route.queueId) {
        const queueId = route.queue_id || route.queueId;
        const queue = db.voice_queues.find((item) => String(item.id) === String(queueId));

        response = {
          action: "queue",
          queue_id: queueId,
          queue_name: queue ? queue.queue_name || queue.queueName : "GoodOS Voice Queue"
        };
      } else if (route.voicemail_profile_id || route.voicemailProfileId) {
        response = {
          action: "voicemail",
          voicemail_profile_id: route.voicemail_profile_id || route.voicemailProfileId
        };
      } else {
        response = {
          action: "reject",
          reason: "No available agent or fallback route"
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
    created_at: nowIso()
  });

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
      raw_payload: req.body
    });
  }

  saveDb(db);
  return res.json(response);
});

router.post("/call-event", (req, res) => {
  const db = ensureDb();

  const event = {
    id: makeId("event"),
    call_id: req.body.call_id || req.body.callId || null,
    event_type: req.body.event_type || req.body.eventType || "Unknown",
    event_source: req.body.event_source || req.body.eventSource || "goodos_voice",
    event_timestamp: req.body.event_timestamp || req.body.eventTimestamp || nowIso(),
    channel_id: req.body.channel_id || req.body.channelId || null,
    agent_id: req.body.agent_id || req.body.agentId || null,
    message: req.body.message || "",
    raw_event: req.body.raw_event || req.body.rawEvent || req.body,
    created_at: nowIso()
  };

  db.voice_call_events.push(event);

  const callId = event.call_id;
  if (callId) {
    const active = db.voice_active_calls.find((call) => String(call.call_id) === String(callId));
    if (active) {
      active.current_status = event.event_type;
      active.last_event_at = event.event_timestamp;
    }

    if (["Hangup", "BridgeLeave", "Voicemail", "RouteFailed"].includes(event.event_type)) {
      db.voice_active_calls = db.voice_active_calls.filter((call) => String(call.call_id) !== String(callId));

      db.voice_call_logs.push({
        id: makeId("cdr"),
        call_id: callId,
        from_number: active ? active.from_number : null,
        to_number: active ? active.to_number : null,
        selected_agent_id: active ? active.selected_agent_id : null,
        selected_agent_name: active ? active.selected_agent_name : null,
        action: active ? active.route_path : null,
        result: event.event_type,
        started_at: active ? active.started_at : null,
        ended_at: nowIso(),
        raw_payload: {
          active_call: active || null,
          final_event: event
        },
        created_at: nowIso(),
        updated_at: nowIso()
      });
    }
  }

  saveDb(db);
  return res.status(201).json({
    success: true,
    event
  });
});

router.post("/seed-demo", (req, res) => {
  const db = ensureDb();

  // Make demo seeding idempotent: remove previous demo rows first.
  for (const table of Object.values(TABLES)) {
    db[table] = db[table].filter((row) => row.demo_data !== true);
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

  saveDb(db);

  return res.json({
    success: true,
    message: "GoodOS Voice demo data seeded"
  });
});

router.delete("/demo-data", (req, res) => {
  const db = ensureDb();

  for (const table of Object.values(TABLES)) {
    db[table] = db[table].filter((row) => row.demo_data !== true);
  }

  saveDb(db);

  return res.json({
    success: true,
    message: "GoodOS Voice demo data cleared"
  });
});

module.exports = router;
