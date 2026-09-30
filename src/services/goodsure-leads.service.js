"use strict";

const crypto = require("node:crypto");
const database = require("../config/database");

const STATUSES = new Set(["new", "dialing", "transferred", "warmed", "closed", "lost"]);
const LEAD_SELECT = `
  SELECT
    id,
    name,
    email,
    phone,
    age,
    coverage_amount AS "coverageAmount",
    status,
    NULLIF(ai_notes, '') AS "aiNotes",
    dial_attempts AS "dialAttempts",
    last_dial_time AS "lastDialTime",
    transfer_time AS "transferTime",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM goodsure_leads
`;

function leadError(message, statusCode = 400, code = "GOODSURE_LEAD_REQUEST_FAILED") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanText(value, maximum) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
}

function normalizeLead(input = {}) {
  const lead = {
    name: cleanText(input.name, 100),
    email: cleanText(input.email, 254).toLowerCase(),
    phone: cleanText(input.phone, 30),
    age: Number(input.age),
    coverageAmount: Number(input.coverageAmount),
  };
  if (lead.name.length < 2) throw leadError("A valid name is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
    throw leadError("A valid email is required.");
  }
  if (!/^[+()\d\s.-]{7,30}$/.test(lead.phone)) {
    throw leadError("A valid phone number is required.");
  }
  if (!Number.isInteger(lead.age) || lead.age < 18 || lead.age > 100) {
    throw leadError("Age must be between 18 and 100.");
  }
  if (!Number.isInteger(lead.coverageAmount)
      || lead.coverageAmount < 10_000
      || lead.coverageAmount > 10_000_000) {
    throw leadError("Coverage amount is outside the supported range.");
  }
  return lead;
}

function normalizeUpdates(input = {}) {
  const updates = {};
  if (input.status !== undefined) {
    const status = cleanText(input.status, 32).toLowerCase();
    if (!STATUSES.has(status)) throw leadError("Invalid lead status.");
    updates.status = status;
  }
  if (input.aiNotes !== undefined) updates.ai_notes = cleanText(input.aiNotes, 8_000);
  if (input.dialAttempts !== undefined) {
    const dialAttempts = Number(input.dialAttempts);
    if (!Number.isInteger(dialAttempts) || dialAttempts < 0 || dialAttempts > 10_000) {
      throw leadError("Invalid dial attempt count.");
    }
    updates.dial_attempts = dialAttempts;
  }
  for (const [clientKey, column] of [
    ["lastDialTime", "last_dial_time"],
    ["transferTime", "transfer_time"],
  ]) {
    if (input[clientKey] === undefined) continue;
    const value = cleanText(input[clientKey], 40);
    if (value && !Number.isFinite(Date.parse(value))) throw leadError(`Invalid ${clientKey}.`);
    updates[column] = value || null;
  }
  if (!Object.keys(updates).length) throw leadError("No supported lead updates were supplied.");
  return updates;
}

async function health() {
  const result = await database.query(`
    SELECT TO_REGCLASS('public.goodsure_leads') IS NOT NULL AS ready
  `);
  const schemaReady = result.rows[0]?.ready === true;
  return {
    service: "GoodSure Leads",
    status: schemaReady ? "ok" : "setup_required",
    schemaReady,
  };
}

async function create(input) {
  const lead = normalizeLead(input);
  const result = await database.query(
    `
      INSERT INTO goodsure_leads (
        id, name, email, phone, age, coverage_amount, status, dial_attempts
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, 'new', 0)
      RETURNING
        id,
        name,
        email,
        phone,
        age,
        coverage_amount AS "coverageAmount",
        status,
        NULLIF(ai_notes, '') AS "aiNotes",
        dial_attempts AS "dialAttempts",
        last_dial_time AS "lastDialTime",
        transfer_time AS "transferTime",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
    [crypto.randomUUID(), lead.name, lead.email, lead.phone, lead.age, lead.coverageAmount],
  );
  return result.rows[0];
}

async function list({ status, limit }) {
  const selectedStatus = STATUSES.has(cleanText(status, 32).toLowerCase())
    ? cleanText(status, 32).toLowerCase()
    : null;
  const selectedLimit = Math.min(
    Math.max(Number.parseInt(String(limit || "500"), 10) || 500, 1),
    500,
  );
  const result = await database.query(
    `
      ${LEAD_SELECT}
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [selectedStatus, selectedLimit],
  );
  return result.rows;
}

async function update({ leadId, input }) {
  const updates = normalizeUpdates(input);
  const columns = Object.keys(updates);
  const values = [leadId, ...columns.map((column) => updates[column])];
  const assignments = columns.map((column, index) => `${column} = $${index + 2}`);
  const result = await database.query(
    `
      UPDATE goodsure_leads
      SET ${assignments.join(", ")}
      WHERE id = $1::uuid
      RETURNING
        id,
        name,
        email,
        phone,
        age,
        coverage_amount AS "coverageAmount",
        status,
        NULLIF(ai_notes, '') AS "aiNotes",
        dial_attempts AS "dialAttempts",
        last_dial_time AS "lastDialTime",
        transfer_time AS "transferTime",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
    values,
  );
  if (!result.rows[0]) {
    throw leadError("Lead not found.", 404, "GOODSURE_LEAD_NOT_FOUND");
  }
  return result.rows[0];
}

module.exports = {
  STATUSES,
  create,
  health,
  list,
  normalizeLead,
  normalizeUpdates,
  update,
};
