"use strict";

const crypto = require("node:crypto");
const database = require("../config/database");
const notificationService = require("./notification.service");

const APP_ID = "goodcustom";
const APP_URL = "https://custom.goodos.app/admin";
const SERVICES = new Set([
  "wrap",
  "ppf",
  "ceramic-tint",
  "starlight",
  "mats",
  "smart-tint",
  "other",
]);
const MANAGEMENT_ROLES = new Set(["owner", "manager"]);

function serviceError(message, statusCode = 400, code = "GOODCUSTOM_QUOTE_REQUEST_FAILED") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanText(value, maximum) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
}

function cleanOptions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 24)
    .map((option) => cleanText(option, 160))
    .filter(Boolean);
}

function normalizeQuote(input = {}) {
  const quote = {
    name: cleanText(input.name, 100),
    email: cleanText(input.email, 254).toLowerCase(),
    phone: cleanText(input.phone, 30),
    carModel: cleanText(input.carModel, 100),
    service: cleanText(input.service, 40).toLowerCase(),
    message: cleanText(input.message, 1500),
    startingEstimate: Math.round(Number(input.startingEstimate) || 0),
    options: cleanOptions(input.options),
  };
  if (quote.name.length < 2) throw serviceError("A valid name is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(quote.email)) {
    throw serviceError("A valid email is required.");
  }
  if (!/^[+()\d\s.-]{7,30}$/.test(quote.phone)) {
    throw serviceError("A valid phone number is required.");
  }
  if (!quote.carModel) throw serviceError("A vehicle is required.");
  if (!SERVICES.has(quote.service)) throw serviceError("A valid service is required.");
  if (quote.startingEstimate < 1 || quote.startingEstimate > 100000) {
    throw serviceError("A valid starting estimate is required.");
  }
  return quote;
}

function platformRole(user) {
  return String(user?.platformRole || user?.role || "").toLowerCase();
}

async function requireManagement(user) {
  if (["owner", "admin"].includes(platformRole(user))) return true;
  const result = await database.query(
    `
      SELECT 1
      FROM goodcustom_staff
      WHERE user_id = $1::uuid
        AND status = 'active'
        AND role IN ('owner', 'manager')
      LIMIT 1
    `,
    [user?.id],
  );
  if (!result.rows[0]) {
    throw serviceError(
      "GoodCustom management access is required.",
      403,
      "GOODCUSTOM_QUOTE_MANAGEMENT_REQUIRED",
    );
  }
  return true;
}

const QUOTE_SELECT = `
  SELECT
    quote.id,
    quote.name,
    quote.email,
    quote.phone,
    quote.car_model AS "carModel",
    quote.service,
    quote.message,
    (quote.starting_estimate_cents / 100)::int AS "startingEstimate",
    quote.options_json AS options,
    quote.status,
    quote.created_at AS "createdAt",
    quote.updated_at AS "updatedAt"
  FROM goodcustom_quote_requests quote
`;

async function health() {
  const result = await database.query(`
    SELECT TO_REGCLASS('public.goodcustom_quote_requests') IS NOT NULL AS ready
  `);
  const schemaReady = result.rows[0]?.ready === true;
  return {
    service: "GoodCustom Quotes",
    status: schemaReady ? "ok" : "setup_required",
    schemaReady,
  };
}

async function managementRecipients() {
  const result = await database.query(`
    SELECT DISTINCT
      account.id AS "userId",
      account.email,
      COALESCE(
        NULLIF(account.display_name, ''),
        NULLIF(CONCAT_WS(' ', account.first_name, account.last_name), ''),
        SPLIT_PART(account.email, '@', 1)
      ) AS "displayName"
    FROM users account
    LEFT JOIN goodcustom_staff staff ON staff.user_id = account.id
    WHERE LOWER(COALESCE(account.platform_role, '')) IN ('owner', 'admin')
       OR (
         staff.status = 'active'
         AND staff.role IN ('owner', 'manager')
       )
    ORDER BY account.email
  `);
  return result.rows;
}

function quoteNotificationMessage(quote) {
  return [
    `${quote.name} requested a ${quote.service} build for ${quote.carModel}.`,
    `Starting estimate: $${quote.startingEstimate.toLocaleString("en-US")}.`,
    `Contact: ${quote.email} | ${quote.phone}.`,
    quote.message || "No additional project notes were provided.",
    "Final pricing must be confirmed after vehicle inspection and customization review.",
  ].join("\n");
}

async function notifyManagement(quote) {
  const recipients = await managementRecipients();
  const results = await Promise.allSettled(recipients.map((recipient) =>
    notificationService.createNotification({
      id: `gcquote_${quote.id.replace(/-/g, "")}_${String(recipient.userId).replace(/-/g, "")}`,
      appId: APP_ID,
      title: `New GoodCustom quote: ${quote.carModel}`,
      message: quoteNotificationMessage(quote),
      severity: "success",
      category: "quote",
      channel: "email",
      recipientUserId: recipient.userId,
      recipientEmail: recipient.email,
      toName: recipient.displayName,
      queueEmail: true,
      templateKey: "system.notice",
      source: "goodcustom-quote",
      sourceId: quote.id,
      actionUrl: APP_URL,
      payload: {
        quoteId: quote.id,
        appId: APP_ID,
        appDomain: "custom.goodos.app",
        ...quote,
      },
    }),
  ));
  const queued = results.filter((result) => result.status === "fulfilled").length;
  if (queued) {
    await notificationService.processEmailQueue(Math.min(queued, 20)).catch((error) => {
      console.error("GoodCustom quote email processing failed:", error.message);
    });
  }
  return { recipients: recipients.length, queued };
}

async function create({ user, input, requestKey }) {
  const quote = normalizeQuote(input);
  const key = cleanText(requestKey, 120) || null;
  if (!user?.id) {
    throw serviceError("GoodBase sign-in is required.", 401, "GOODCUSTOM_QUOTE_AUTH_REQUIRED");
  }

  if (key) {
    const existing = await database.query(
      `${QUOTE_SELECT}
       WHERE quote.requester_user_id = $1::uuid
         AND quote.request_key = $2
         AND quote.deleted_at IS NULL
       LIMIT 1`,
      [user.id, key],
    );
    if (existing.rows[0]) return { quote: existing.rows[0], created: false, alerts: null };
  }

  const id = crypto.randomUUID();
  const result = await database.query(
    `
      INSERT INTO goodcustom_quote_requests (
        id,
        request_key,
        requester_user_id,
        name,
        email,
        phone,
        car_model,
        service,
        message,
        starting_estimate_cents,
        options_json
      )
      VALUES (
        $1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
      )
      ON CONFLICT (requester_user_id, request_key)
      WHERE request_key IS NOT NULL
      DO NOTHING
      RETURNING
        id,
        name,
        email,
        phone,
        car_model AS "carModel",
        service,
        message,
        (starting_estimate_cents / 100)::int AS "startingEstimate",
        options_json AS options,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
    [
      id,
      key,
      user.id,
      quote.name,
      quote.email,
      quote.phone,
      quote.carModel,
      quote.service,
      quote.message,
      quote.startingEstimate * 100,
      JSON.stringify(quote.options),
    ],
  );
  const saved = result.rows[0] || (
    await database.query(
      `${QUOTE_SELECT}
       WHERE quote.requester_user_id = $1::uuid
         AND quote.request_key = $2
         AND quote.deleted_at IS NULL
       LIMIT 1`,
      [user.id, key],
    )
  ).rows[0];
  if (!result.rows[0]) {
    return { quote: saved, created: false, alerts: null };
  }
  const alerts = await notifyManagement(saved).catch((error) => {
    console.error("GoodCustom quote alerts failed:", error.message);
    return { recipients: 0, queued: 0 };
  });
  return { quote: saved, created: true, alerts };
}

async function list({ user, status, limit }) {
  await requireManagement(user);
  const normalizedStatus = cleanText(status, 20).toLowerCase();
  const statuses = new Set(["new", "contacted", "quoted", "scheduled", "closed"]);
  const selectedStatus = statuses.has(normalizedStatus) ? normalizedStatus : null;
  const selectedLimit = Math.min(Math.max(Number.parseInt(String(limit || "200"), 10) || 200, 1), 500);
  const result = await database.query(
    `
      ${QUOTE_SELECT}
      WHERE quote.deleted_at IS NULL
        AND ($1::text IS NULL OR quote.status = $1)
      ORDER BY quote.created_at DESC
      LIMIT $2
    `,
    [selectedStatus, selectedLimit],
  );
  return { quotes: result.rows, total: result.rows.length };
}

async function remove({ user, quoteId }) {
  await requireManagement(user);
  const result = await database.query(
    `
      UPDATE goodcustom_quote_requests
      SET deleted_at = NOW(),
          deleted_by = $2::uuid
      WHERE id = $1::uuid
        AND deleted_at IS NULL
      RETURNING id
    `,
    [quoteId, user.id],
  );
  if (!result.rows[0]) {
    throw serviceError("Quote request not found.", 404, "GOODCUSTOM_QUOTE_NOT_FOUND");
  }
  return result.rows[0];
}

module.exports = {
  SERVICES,
  create,
  health,
  list,
  normalizeQuote,
  remove,
  requireManagement,
};
