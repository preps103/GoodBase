"use strict";

const CASE_TYPES = new Set(["fraud_review", "chargeback", "collection"]);
const CASE_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const CASE_STATUSES = new Set([
  "open", "investigating", "evidence_due", "response_ready", "submitted",
  "payment_plan", "resolved_won", "resolved_lost", "collected", "written_off",
]);
const FINAL_STATUSES = new Set(["resolved_won", "resolved_lost", "collected", "written_off"]);

const TRANSITIONS = Object.freeze({
  open: new Set(["investigating", "evidence_due", "payment_plan", "resolved_won", "resolved_lost", "collected", "written_off"]),
  investigating: new Set(["evidence_due", "response_ready", "payment_plan", "resolved_won", "resolved_lost", "collected", "written_off"]),
  evidence_due: new Set(["investigating", "response_ready", "payment_plan", "written_off"]),
  response_ready: new Set(["submitted", "investigating"]),
  submitted: new Set(["resolved_won", "resolved_lost", "investigating"]),
  payment_plan: new Set(["collected", "investigating", "written_off"]),
  resolved_won: new Set([]),
  resolved_lost: new Set([]),
  collected: new Set([]),
  written_off: new Set([]),
});

const TYPE_STATUSES = Object.freeze({
  fraud_review: new Set(["open", "investigating", "evidence_due", "resolved_won", "resolved_lost"]),
  chargeback: new Set(["open", "investigating", "evidence_due", "response_ready", "submitted", "resolved_won", "resolved_lost", "written_off"]),
  collection: new Set(["open", "investigating", "payment_plan", "collected", "written_off"]),
});

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function evidenceItems(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === "string") {
      const reference = clean(item, 2000);
      return reference ? { type: "reference", reference, description: "" } : null;
    }
    if (!item || typeof item !== "object") return null;
    const type = clean(item.type || "reference", 40).toLowerCase();
    const reference = clean(item.reference || item.value || item.url, 2000);
    const description = clean(item.description, 500);
    return reference ? { type, reference, description } : null;
  }).filter(Boolean).slice(0, 30);
}

function canTransition(caseType, from, to) {
  return Boolean(
    CASE_TYPES.has(caseType) &&
    TYPE_STATUSES[caseType]?.has(to) &&
    TRANSITIONS[from]?.has(to),
  );
}

function allowedTransitions(caseType, status) {
  return [...(TRANSITIONS[status] || [])].filter(next => TYPE_STATUSES[caseType]?.has(next));
}

function transitionBlockers(record, nextStatus, notes) {
  const blockers = [];
  const evidence = evidenceItems(record.evidence || record.evidence_json);
  if (["response_ready", "submitted"].includes(nextStatus) && !evidence.length) {
    blockers.push("evidence_required");
  }
  if (nextStatus === "submitted" && !clean(record.externalReference || record.external_reference, 300)) {
    blockers.push("external_reference_required");
  }
  if (["resolved_won", "resolved_lost", "collected", "written_off", "payment_plan"].includes(nextStatus) && clean(notes, 2000).length < 5) {
    blockers.push("resolution_note_required");
  }
  return blockers;
}

module.exports = {
  CASE_TYPES,
  CASE_PRIORITIES,
  CASE_STATUSES,
  FINAL_STATUSES,
  TRANSITIONS,
  TYPE_STATUSES,
  evidenceItems,
  canTransition,
  allowedTransitions,
  transitionBlockers,
};
