"use strict";

const CHARGE_TYPES = new Set([
  "toll",
  "citation",
  "fuel",
  "ev_charging",
  "mileage",
  "cleaning",
  "smoking",
  "late_return",
  "damage",
  "other",
]);

const WORKFLOW_TRANSITIONS = Object.freeze({
  imported: new Set(["review_required", "waived"]),
  review_required: new Set(["approved", "disputed", "waived"]),
  approved: new Set(["collection_pending", "disputed", "waived"]),
  disputed: new Set(["approved", "waived"]),
  collection_pending: new Set(["collected", "failed", "disputed", "waived"]),
  failed: new Set(["collection_pending", "waived"]),
  collected: new Set([]),
  waived: new Set([]),
});

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizePlate(value) {
  return clean(value, 32).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeVin(value) {
  return clean(value, 32).toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "");
}

function finiteDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function roundConfidence(value) {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function scoreBookingCandidate(incident, candidate) {
  let score = 0;
  const reasons = [];
  const incidentVehicleId = clean(incident.vehicleId, 80);
  const candidateVehicleId = clean(candidate.vehicleId, 80);
  const incidentPlate = normalizePlate(incident.licensePlate);
  const candidatePlate = normalizePlate(candidate.licensePlate);
  const incidentVin = normalizeVin(incident.vin);
  const candidateVin = normalizeVin(candidate.vin);
  const incidentReservation = clean(incident.reservationNumber, 80).toUpperCase();
  const candidateReservation = clean(candidate.reservationNumber, 80).toUpperCase();

  if (incidentReservation && incidentReservation === candidateReservation) {
    score += 0.6;
    reasons.push("reservation_number_exact");
  }
  if (incidentVehicleId && incidentVehicleId === candidateVehicleId) {
    score += 0.5;
    reasons.push("vehicle_id_exact");
  }
  if (incidentVin && incidentVin === candidateVin) {
    score += 0.45;
    reasons.push("vin_exact");
  }
  if (incidentPlate && incidentPlate === candidatePlate) {
    score += 0.4;
    reasons.push("license_plate_exact");
  }

  const occurredAt = finiteDate(incident.occurredAt);
  const pickupAt = finiteDate(candidate.pickupAt);
  const returnAt = finiteDate(candidate.returnAt);
  if (occurredAt && pickupAt && returnAt) {
    if (occurredAt >= pickupAt && occurredAt <= returnAt) {
      score += 0.35;
      reasons.push("inside_reservation_window");
    } else {
      const beforeHours = (pickupAt.getTime() - occurredAt.getTime()) / 3_600_000;
      const afterHours = (occurredAt.getTime() - returnAt.getTime()) / 3_600_000;
      if ((beforeHours >= 0 && beforeHours <= 12) || (afterHours >= 0 && afterHours <= 48)) {
        score += 0.18;
        reasons.push("near_reservation_window");
      }
    }
  }

  return {
    ...candidate,
    confidence: roundConfidence(score),
    reasons,
  };
}

function chooseBookingMatch(incident, candidates) {
  const ranked = (Array.isArray(candidates) ? candidates : [])
    .map(candidate => scoreBookingCandidate(incident, candidate))
    .sort((left, right) => right.confidence - left.confidence);
  const best = ranked[0] || null;
  const runnerUp = ranked[1] || null;
  const decisive = best && (!runnerUp || best.confidence - runnerUp.confidence >= 0.1);
  const automatic = Boolean(best && best.confidence >= 0.75 && decisive);
  return {
    match: automatic ? best : null,
    suggestedMatch: best,
    automatic,
    ranked,
  };
}

function evidenceItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (typeof item === "string") return { type: "note", value: clean(item, 2000) };
      if (!item || typeof item !== "object") return null;
      const type = clean(item.type, 40).toLowerCase() || "note";
      const itemValue = clean(item.value || item.url || item.reference, 2000);
      return itemValue ? { type, value: itemValue } : null;
    })
    .filter(Boolean)
    .slice(0, 20);
}

function canTransition(from, to) {
  return Boolean(WORKFLOW_TRANSITIONS[from]?.has(to));
}

function approvalBlockers(record) {
  const blockers = [];
  if (!["auto_matched", "confirmed"].includes(record.matchStatus)) {
    blockers.push("confirmed_reservation_match_required");
  }
  if (!evidenceItems(record.evidence).length) blockers.push("evidence_required");
  if (!(Number(record.amount) > 0)) blockers.push("positive_amount_required");
  return blockers;
}

function csvCell(value) {
  const text = String(value ?? "");
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function accountingCsv(rows) {
  const headers = [
    "Date",
    "Type",
    "Description",
    "Amount",
    "Currency",
    "Reservation",
    "Vehicle",
    "License Plate",
    "Customer",
    "Workflow Status",
    "Source Provider",
    "Source Reference",
  ];
  return [
    headers.map(csvCell).join(","),
    ...(Array.isArray(rows) ? rows : []).map(row => [
      row.occurredAt,
      row.chargeType,
      row.description,
      Number(row.amount).toFixed(2),
      row.currency,
      row.reservationNumber,
      row.vehicleName,
      row.licensePlate,
      row.customerName,
      row.workflowStatus,
      row.sourceProvider,
      row.sourceReference,
    ].map(csvCell).join(",")),
  ].join("\n");
}

module.exports = {
  CHARGE_TYPES,
  WORKFLOW_TRANSITIONS,
  normalizePlate,
  normalizeVin,
  scoreBookingCandidate,
  chooseBookingMatch,
  evidenceItems,
  canTransition,
  approvalBlockers,
  accountingCsv,
};
