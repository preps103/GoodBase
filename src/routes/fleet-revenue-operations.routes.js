"use strict";

const crypto = require("node:crypto");
const express = require("express");
const authRequired = require("../middleware/authRequired");
const { pool, query } = require("../config/database");
const {
  CHARGE_TYPES,
  chooseBookingMatch,
  evidenceItems,
  canTransition,
  approvalBlockers,
  accountingCsv,
} = require("../services/fleet-revenue-operations.service");
const {
  CASE_TYPES,
  CASE_PRIORITIES,
  CASE_STATUSES,
  FINAL_STATUSES,
  evidenceItems: financialCaseEvidence,
  canTransition: canTransitionFinancialCase,
  allowedTransitions,
  transitionBlockers,
} = require("../services/fleet-financial-cases.service");

const router = express.Router();
const ORGANIZATION_ID = process.env.GOODFLEET_PUBLIC_ORGANIZATION_ID || "org_goodos";
const MANAGEMENT_ROLES = new Set(["owner", "admin", "manager"]);
const WORKFLOW_STATUSES = new Set([
  "imported",
  "review_required",
  "approved",
  "disputed",
  "collection_pending",
  "collected",
  "waived",
  "failed",
]);

router.use(authRequired);

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function fail(response, status, code, message, details) {
  return response.status(status).json({
    success: false,
    code,
    message,
    ...(details ? { details } : {}),
  });
}

function fleetRole(request) {
  const membership = (request.apps || []).find(
    app =>
      clean(app?.membershipStatus, 40).toLowerCase() === "active" &&
      (clean(app?.id, 80).toLowerCase() === "goodfleet" ||
        clean(app?.domain, 160).toLowerCase() === "fleet.goodos.app"),
  );
  return clean(membership?.role, 40).toLowerCase();
}

function requireManagement(request, response, next) {
  if (!MANAGEMENT_ROLES.has(fleetRole(request))) {
    return fail(
      response,
      403,
      "MANAGEMENT_ACCESS_REQUIRED",
      "GoodFleet management access is required.",
    );
  }
  next();
}

router.use(requireManagement);

function numberOrNull(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function validDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value, 80));
}

function incidentalPayload(row) {
  return {
    id: row.id,
    sourceProvider: row.source_provider,
    sourceReference: row.source_reference || null,
    chargeType: row.charge_type,
    description: row.description,
    occurredAt: row.occurred_at,
    amount: Number(row.amount),
    currency: row.currency,
    licensePlate: row.license_plate || null,
    vin: row.vin || null,
    transponderReference: row.transponder_reference || null,
    vehicleId: row.vehicle_id || null,
    vehicleName: row.vehicle_name || null,
    bookingId: row.booking_id || null,
    reservationNumber: row.reservation_number || null,
    customerId: row.customer_id || null,
    customerName: row.customer_name || null,
    matchStatus: row.match_status,
    matchConfidence: Number(row.match_confidence || 0),
    matchReasons: Array.isArray(row.match_reasons_json) ? row.match_reasons_json : [],
    matchCandidates: Array.isArray(row.source_payload?.matchCandidates)
      ? row.source_payload.matchCandidates
      : [],
    workflowStatus: row.workflow_status,
    evidence: Array.isArray(row.evidence_json) ? row.evidence_json : [],
    notes: row.notes || null,
    disputeDeadline: row.dispute_deadline || null,
    events: Array.isArray(row.events) ? row.events : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const INCIDENTAL_SELECT = `
  SELECT charge.*,
         booking.reservation_number,
         customer.full_name AS customer_name,
         concat_ws(' ',vehicle.model_year,vehicle.make,vehicle.model) AS vehicle_name,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'id',event.id,
             'eventType',event.event_type,
             'fromStatus',event.from_status,
             'toStatus',event.to_status,
             'details',event.details_json,
             'createdAt',event.created_at
           ) ORDER BY event.created_at)
             FROM fleet_incidental_events event
            WHERE event.organization_id=charge.organization_id
              AND event.incidental_id=charge.id
         ),'[]'::jsonb) AS events
    FROM fleet_incidental_charges charge
    LEFT JOIN fleet_bookings booking
      ON booking.organization_id=charge.organization_id
     AND booking.id=charge.booking_id
    LEFT JOIN fleet_customers customer
      ON customer.organization_id=charge.organization_id
     AND customer.id=charge.customer_id
    LEFT JOIN fleet_vehicles vehicle
      ON vehicle.organization_id=charge.organization_id
     AND vehicle.id=charge.vehicle_id`;

async function loadIncidental(client, id, lock = false) {
  const result = await client.query(
    `${INCIDENTAL_SELECT}
      WHERE charge.organization_id=$1 AND charge.id=$2
      ${lock ? "FOR UPDATE OF charge" : ""}`,
    [ORGANIZATION_ID, id],
  );
  return result.rows[0] || null;
}

async function recordEvent(client, request, incidentalId, eventType, fromStatus, toStatus, details) {
  await client.query(
    `INSERT INTO fleet_incidental_events
      (organization_id,incidental_id,event_type,from_status,to_status,details_json,actor_id)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [
      ORGANIZATION_ID,
      incidentalId,
      eventType,
      fromStatus || null,
      toStatus || null,
      JSON.stringify(details || {}),
      request.user.id,
    ],
  );
}

async function audit(client, request, action, entityId, before, after) {
  await client.query(
    `INSERT INTO fleet_audit_events
      (organization_id,actor_id,action,entity_type,entity_id,before_json,after_json,request_id,ip_address)
     VALUES ($1,$2,$3,'incidental_charge',$4,$5::jsonb,$6::jsonb,$7,$8)`,
    [
      ORGANIZATION_ID,
      request.user.id,
      action,
      entityId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      request.id || request.get("X-Request-ID") || null,
      request.ip || null,
    ],
  );
}

async function matchingCandidates(input) {
  const vehicleId = clean(input.vehicleId, 80) || null;
  const reservationNumber = clean(input.reservationNumber, 80) || null;
  const licensePlate = clean(input.licensePlate, 32).toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
  const vin = clean(input.vin, 32).toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "") || null;
  if (!vehicleId && !reservationNumber && !licensePlate && !vin) return [];
  const occurredAt = validDate(input.occurredAt);
  const result = await query(
    `SELECT booking.id AS booking_id,
            booking.reservation_number,
            booking.pickup_at,
            booking.return_at,
            booking.customer_id,
            customer.full_name AS customer_name,
            vehicle.id AS vehicle_id,
            vehicle.vin,
            vehicle.license_plate,
            concat_ws(' ',vehicle.model_year,vehicle.make,vehicle.model) AS vehicle_name
       FROM fleet_bookings booking
       JOIN fleet_vehicles vehicle
         ON vehicle.organization_id=booking.organization_id
        AND vehicle.id=booking.vehicle_id
       JOIN fleet_customers customer
         ON customer.organization_id=booking.organization_id
        AND customer.id=booking.customer_id
      WHERE booking.organization_id=$1
        AND booking.archived_at IS NULL
        AND booking.status NOT IN ('cancelled','refunded','no_show')
        AND (
          ($2::text IS NOT NULL AND vehicle.id::text=$2::text) OR
          ($3::text IS NOT NULL AND upper(booking.reservation_number)=$3::text) OR
          ($4::text IS NOT NULL AND regexp_replace(upper(vehicle.license_plate),'[^A-Z0-9]','','g')=$4::text) OR
          ($5::text IS NOT NULL AND regexp_replace(upper(vehicle.vin),'[^A-HJ-NPR-Z0-9]','','g')=$5::text)
        )
        AND ($6::timestamptz IS NULL OR (
          booking.pickup_at <= $6::timestamptz + INTERVAL '48 hours'
          AND booking.return_at >= $6::timestamptz - INTERVAL '12 hours'
        ))
      ORDER BY booking.pickup_at DESC
      LIMIT 12`,
    [
      ORGANIZATION_ID,
      vehicleId,
      reservationNumber ? reservationNumber.toUpperCase() : null,
      licensePlate,
      vin,
      occurredAt,
    ],
  );
  return result.rows.map(row => ({
    bookingId: row.booking_id,
    reservationNumber: row.reservation_number,
    pickupAt: row.pickup_at,
    returnAt: row.return_at,
    customerId: row.customer_id,
    customerName: row.customer_name,
    vehicleId: row.vehicle_id,
    vehicleName: row.vehicle_name,
    vin: row.vin,
    licensePlate: row.license_plate,
  }));
}

router.get("/incidentals", async (request, response, next) => {
  try {
    const workflowStatus = clean(request.query.status, 40).toLowerCase();
    const limit = numberOrNull(request.query.limit, 1, 250) || 100;
    if (workflowStatus && !WORKFLOW_STATUSES.has(workflowStatus)) {
      return fail(response, 400, "INVALID_WORKFLOW_STATUS", "The incidental status is invalid.");
    }
    const result = await query(
      `${INCIDENTAL_SELECT}
        WHERE charge.organization_id=$1
          AND ($2::text='' OR charge.workflow_status=$2)
        ORDER BY
          CASE charge.workflow_status
            WHEN 'review_required' THEN 0
            WHEN 'disputed' THEN 1
            WHEN 'failed' THEN 2
            ELSE 3
          END,
          charge.occurred_at DESC
        LIMIT $3`,
      [ORGANIZATION_ID, workflowStatus, limit],
    );
    return response.json({ success: true, data: result.rows.map(incidentalPayload) });
  } catch (error) {
    return next(error);
  }
});

router.get("/incidentals/summary", async (_request, response, next) => {
  try {
    const result = await query(
      `SELECT COUNT(*)::integer AS total,
              COUNT(*) FILTER (WHERE workflow_status='review_required')::integer AS needs_review,
              COUNT(*) FILTER (WHERE workflow_status='disputed')::integer AS disputed,
              COUNT(*) FILTER (WHERE workflow_status='collection_pending')::integer AS collection_pending,
              COALESCE(SUM(amount) FILTER (
                WHERE workflow_status IN ('approved','collection_pending','collected')
              ),0)::numeric(12,2) AS approved_amount,
              COALESCE(SUM(amount) FILTER (WHERE workflow_status='collected'),0)::numeric(12,2) AS collected_amount
         FROM fleet_incidental_charges
        WHERE organization_id=$1`,
      [ORGANIZATION_ID],
    );
    const row = result.rows[0] || {};
    return response.json({
      success: true,
      data: {
        total: Number(row.total || 0),
        needsReview: Number(row.needs_review || 0),
        disputed: Number(row.disputed || 0),
        collectionPending: Number(row.collection_pending || 0),
        approvedAmount: Number(row.approved_amount || 0),
        collectedAmount: Number(row.collected_amount || 0),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/incidentals", async (request, response, next) => {
  const chargeType = clean(request.body?.chargeType, 40).toLowerCase();
  const description = clean(request.body?.description, 500);
  const occurredAt = validDate(request.body?.occurredAt);
  const amount = numberOrNull(request.body?.amount, 0.01, 1_000_000);
  const currency = clean(request.body?.currency || "USD", 3).toUpperCase();
  const idempotencyKey = clean(
    request.body?.idempotencyKey || request.get("Idempotency-Key"),
    200,
  );
  if (!CHARGE_TYPES.has(chargeType)) {
    return fail(response, 400, "INVALID_CHARGE_TYPE", "Select a supported incidental type.");
  }
  if (!description || !occurredAt || !amount || !/^[A-Z]{3}$/.test(currency) || !idempotencyKey) {
    return fail(
      response,
      400,
      "INCIDENTAL_INPUT_REQUIRED",
      "Description, occurrence time, positive amount, currency, and idempotency key are required.",
    );
  }
  try {
    const existing = await query(
      `${INCIDENTAL_SELECT}
        WHERE charge.organization_id=$1 AND charge.idempotency_key=$2`,
      [ORGANIZATION_ID, idempotencyKey],
    );
    if (existing.rowCount) {
      return response.json({ success: true, data: incidentalPayload(existing.rows[0]), replayed: true });
    }

    const input = {
      vehicleId: request.body?.vehicleId,
      reservationNumber: request.body?.reservationNumber,
      licensePlate: request.body?.licensePlate,
      vin: request.body?.vin,
      occurredAt,
    };
    const candidates = await matchingCandidates(input);
    const matching = chooseBookingMatch(input, candidates);
    const selected = matching.match;
    const suggested = matching.suggestedMatch;
    const evidence = evidenceItems(request.body?.evidence);
    const sourceProvider = clean(request.body?.sourceProvider || "manual", 80).toLowerCase();
    const sourceReference = clean(request.body?.sourceReference, 200) || null;
    const matchStatus = selected ? "auto_matched" : suggested ? "suggested" : "unmatched";
    const workflowStatus = "review_required";
    const matchCandidates = matching.ranked.slice(0, 5).map(candidate => ({
      bookingId: candidate.bookingId,
      reservationNumber: candidate.reservationNumber,
      vehicleId: candidate.vehicleId,
      vehicleName: candidate.vehicleName,
      customerName: candidate.customerName,
      pickupAt: candidate.pickupAt,
      returnAt: candidate.returnAt,
      confidence: candidate.confidence,
      reasons: candidate.reasons,
    }));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO fleet_incidental_charges
          (organization_id,idempotency_key,source_provider,source_reference,charge_type,
           description,occurred_at,amount,currency,license_plate,vin,transponder_reference,
           vehicle_id,booking_id,customer_id,match_status,match_confidence,match_reasons_json,
           workflow_status,evidence_json,source_payload,notes,dispute_deadline,created_by,updated_by)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,
           $19,$20::jsonb,$21::jsonb,$22,$23,$24,$24)
         RETURNING id`,
        [
          ORGANIZATION_ID,
          idempotencyKey,
          sourceProvider,
          sourceReference,
          chargeType,
          description,
          occurredAt,
          amount,
          currency,
          clean(request.body?.licensePlate, 32) || suggested?.licensePlate || null,
          clean(request.body?.vin, 32) || suggested?.vin || null,
          clean(request.body?.transponderReference, 120) || null,
          selected?.vehicleId || clean(request.body?.vehicleId, 80) || suggested?.vehicleId || null,
          selected?.bookingId || null,
          selected?.customerId || null,
          matchStatus,
          selected?.confidence || suggested?.confidence || 0,
          JSON.stringify(selected?.reasons || suggested?.reasons || []),
          workflowStatus,
          JSON.stringify(evidence),
          JSON.stringify({
            matchCandidates,
            importedFields: Object.keys(request.body || {}).filter(key => key !== "evidence"),
          }),
          clean(request.body?.notes, 2000) || null,
          new Date(Date.now() + 7 * 86_400_000).toISOString(),
          request.user.id,
        ],
      );
      const id = inserted.rows[0].id;
      await recordEvent(client, request, id, "imported", null, workflowStatus, {
        sourceProvider,
        matchStatus,
        matchConfidence: selected?.confidence || suggested?.confidence || 0,
      });
      await audit(client, request, "incidental.created", id, null, {
        chargeType,
        amount,
        currency,
        workflowStatus,
        matchStatus,
      });
      const row = await loadIncidental(client, id);
      await client.query("COMMIT");
      return response.status(201).json({ success: true, data: incidentalPayload(row) });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        return fail(
          response,
          409,
          "INCIDENTAL_DUPLICATE",
          "That provider record has already been imported.",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return next(error);
  }
});

router.patch("/incidentals/:incidentalId/match", async (request, response, next) => {
  const bookingId = clean(request.body?.bookingId, 80);
  if (!bookingId) {
    return fail(response, 400, "BOOKING_REQUIRED", "Select the reservation for this charge.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await loadIncidental(client, request.params.incidentalId, true);
    if (!before) {
      await client.query("ROLLBACK");
      return fail(response, 404, "INCIDENTAL_NOT_FOUND", "The incidental charge was not found.");
    }
    if (["collected", "waived"].includes(before.workflow_status)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "INCIDENTAL_FINALIZED", "A finalized charge cannot be rematched.");
    }
    const bookingResult = await client.query(
      `SELECT booking.id,booking.customer_id,booking.vehicle_id,booking.reservation_number
         FROM fleet_bookings booking
        WHERE booking.organization_id=$1 AND booking.id=$2 AND booking.archived_at IS NULL`,
      [ORGANIZATION_ID, bookingId],
    );
    const booking = bookingResult.rows[0];
    if (!booking) {
      await client.query("ROLLBACK");
      return fail(response, 404, "BOOKING_NOT_FOUND", "The selected reservation was not found.");
    }
    await client.query(
      `UPDATE fleet_incidental_charges
          SET booking_id=$3,customer_id=$4,vehicle_id=$5,match_status='confirmed',
              match_confidence=1,match_reasons_json='["staff_confirmed"]'::jsonb,
              updated_by=$6,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [ORGANIZATION_ID, before.id, booking.id, booking.customer_id, booking.vehicle_id, request.user.id],
    );
    await recordEvent(client, request, before.id, "match_confirmed", null, null, {
      bookingId: booking.id,
      reservationNumber: booking.reservation_number,
    });
    await audit(client, request, "incidental.match_confirmed", before.id, {
      bookingId: before.booking_id,
      matchStatus: before.match_status,
    }, {
      bookingId: booking.id,
      matchStatus: "confirmed",
    });
    const after = await loadIncidental(client, before.id);
    await client.query("COMMIT");
    return response.json({ success: true, data: incidentalPayload(after) });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.patch("/incidentals/:incidentalId/evidence", async (request, response, next) => {
  const evidence = evidenceItems(request.body?.evidence);
  if (!evidence.length) {
    return fail(response, 400, "EVIDENCE_REQUIRED", "Add at least one evidence item.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await loadIncidental(client, request.params.incidentalId, true);
    if (!before) {
      await client.query("ROLLBACK");
      return fail(response, 404, "INCIDENTAL_NOT_FOUND", "The incidental charge was not found.");
    }
    if (["collected", "waived"].includes(before.workflow_status)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "INCIDENTAL_FINALIZED", "A finalized charge cannot be changed.");
    }
    await client.query(
      `UPDATE fleet_incidental_charges
          SET evidence_json=$3::jsonb,updated_by=$4,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [ORGANIZATION_ID, before.id, JSON.stringify(evidence), request.user.id],
    );
    await recordEvent(client, request, before.id, "evidence_updated", null, null, {
      evidenceCount: evidence.length,
    });
    await audit(client, request, "incidental.evidence_updated", before.id, {
      evidenceCount: Array.isArray(before.evidence_json) ? before.evidence_json.length : 0,
    }, { evidenceCount: evidence.length });
    const after = await loadIncidental(client, before.id);
    await client.query("COMMIT");
    return response.json({ success: true, data: incidentalPayload(after) });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.patch("/incidentals/:incidentalId/status", async (request, response, next) => {
  const nextStatus = clean(request.body?.status, 40).toLowerCase();
  const notes = clean(request.body?.notes, 2000);
  if (!WORKFLOW_STATUSES.has(nextStatus)) {
    return fail(response, 400, "INVALID_WORKFLOW_STATUS", "The requested status is invalid.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await loadIncidental(client, request.params.incidentalId, true);
    if (!before) {
      await client.query("ROLLBACK");
      return fail(response, 404, "INCIDENTAL_NOT_FOUND", "The incidental charge was not found.");
    }
    if (!canTransition(before.workflow_status, nextStatus)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "WORKFLOW_TRANSITION_BLOCKED", "That workflow transition is not allowed.", {
        from: before.workflow_status,
        to: nextStatus,
      });
    }
    if (["disputed", "waived", "failed"].includes(nextStatus) && notes.length < 5) {
      await client.query("ROLLBACK");
      return fail(response, 400, "WORKFLOW_REASON_REQUIRED", "Add a reason before changing this status.");
    }
    if (nextStatus === "approved") {
      const blockers = approvalBlockers({
        matchStatus: before.match_status,
        evidence: before.evidence_json,
        amount: before.amount,
      });
      if (blockers.length) {
        await client.query("ROLLBACK");
        return fail(
          response,
          409,
          "INCIDENTAL_APPROVAL_BLOCKED",
          "The charge cannot be approved until its match and evidence are complete.",
          { blockers },
        );
      }
    }
    await client.query(
      `UPDATE fleet_incidental_charges
          SET workflow_status=$3,notes=COALESCE(NULLIF($4,''),notes),updated_by=$5,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [ORGANIZATION_ID, before.id, nextStatus, notes, request.user.id],
    );
    await recordEvent(
      client,
      request,
      before.id,
      "status_changed",
      before.workflow_status,
      nextStatus,
      notes ? { notes } : {},
    );
    await audit(client, request, "incidental.status_changed", before.id, {
      workflowStatus: before.workflow_status,
    }, { workflowStatus: nextStatus, notes: notes || undefined });
    const after = await loadIncidental(client, before.id);
    await client.query("COMMIT");
    return response.json({ success: true, data: incidentalPayload(after) });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

const FINANCIAL_CASE_SELECT = `
  SELECT financial_case.*,
         booking.reservation_number,
         customer.full_name AS customer_name,
         payment.provider AS payment_provider,
         payment.provider_reference AS payment_provider_reference,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'id',event.id,
             'eventType',event.event_type,
             'fromStatus',event.from_status,
             'toStatus',event.to_status,
             'details',event.details_json,
             'createdAt',event.created_at
           ) ORDER BY event.created_at)
             FROM fleet_financial_case_events event
            WHERE event.organization_id=financial_case.organization_id
              AND event.case_id=financial_case.id
         ),'[]'::jsonb) AS events
    FROM fleet_financial_cases financial_case
    LEFT JOIN fleet_bookings booking
      ON booking.organization_id=financial_case.organization_id
     AND booking.id=financial_case.booking_id
    LEFT JOIN fleet_customers customer
      ON customer.organization_id=financial_case.organization_id
     AND customer.id=financial_case.customer_id
    LEFT JOIN fleet_payment_operations payment
      ON payment.id=financial_case.payment_operation_id`;

function financialCasePayload(row) {
  return {
    id: row.id,
    caseNumber: row.case_number,
    caseType: row.case_type,
    title: row.title,
    description: row.description || null,
    amount: Number(row.amount || 0),
    currency: row.currency,
    status: row.status,
    priority: row.priority,
    bookingId: row.booking_id || null,
    reservationNumber: row.reservation_number || null,
    customerId: row.customer_id || null,
    customerName: row.customer_name || null,
    paymentOperationId: row.payment_operation_id || null,
    paymentProvider: row.payment_provider || null,
    paymentProviderReference: row.payment_provider_reference || null,
    externalReference: row.external_reference || null,
    externalDeadline: row.external_deadline || null,
    evidence: Array.isArray(row.evidence_json) ? row.evidence_json : [],
    notes: row.notes || null,
    assignedTo: row.assigned_to || null,
    resolvedAt: row.resolved_at || null,
    allowedTransitions: allowedTransitions(row.case_type, row.status),
    events: Array.isArray(row.events) ? row.events : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadFinancialCase(client, id, lock = false) {
  const result = await client.query(
    `${FINANCIAL_CASE_SELECT}
      WHERE financial_case.organization_id=$1 AND financial_case.id=$2
      ${lock ? "FOR UPDATE OF financial_case" : ""}`,
    [ORGANIZATION_ID, id],
  );
  return result.rows[0] || null;
}

async function recordFinancialCaseEvent(client, request, caseId, eventType, fromStatus, toStatus, details) {
  await client.query(
    `INSERT INTO fleet_financial_case_events
      (organization_id,case_id,event_type,from_status,to_status,details_json,actor_id)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [ORGANIZATION_ID, caseId, eventType, fromStatus || null, toStatus || null, JSON.stringify(details || {}), request.user.id],
  );
}

async function auditFinancialCase(client, request, action, entityId, before, after) {
  await client.query(
    `INSERT INTO fleet_audit_events
      (organization_id,actor_id,action,entity_type,entity_id,before_json,after_json,request_id,ip_address)
     VALUES ($1,$2,$3,'financial_case',$4,$5::jsonb,$6::jsonb,$7,$8)`,
    [
      ORGANIZATION_ID,
      request.user.id,
      action,
      entityId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      request.id || request.get("X-Request-ID") || null,
      request.ip || null,
    ],
  );
}

router.get("/financial-cases", async (request, response, next) => {
  const caseType = clean(request.query.type, 40).toLowerCase();
  const status = clean(request.query.status, 40).toLowerCase();
  const limit = numberOrNull(request.query.limit, 1, 250) || 100;
  if (caseType && !CASE_TYPES.has(caseType)) {
    return fail(response, 400, "INVALID_CASE_TYPE", "The financial case type is invalid.");
  }
  if (status && !CASE_STATUSES.has(status)) {
    return fail(response, 400, "INVALID_CASE_STATUS", "The financial case status is invalid.");
  }
  try {
    const result = await query(
      `${FINANCIAL_CASE_SELECT}
        WHERE financial_case.organization_id=$1
          AND ($2::text='' OR financial_case.case_type=$2)
          AND ($3::text='' OR financial_case.status=$3)
        ORDER BY
          CASE financial_case.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
          financial_case.external_deadline ASC NULLS LAST,
          financial_case.created_at DESC
        LIMIT $4`,
      [ORGANIZATION_ID, caseType, status, limit],
    );
    return response.json({ success: true, data: result.rows.map(financialCasePayload) });
  } catch (error) {
    return next(error);
  }
});

router.get("/financial-cases/summary", async (_request, response, next) => {
  try {
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status NOT IN ('resolved_won','resolved_lost','collected','written_off'))::integer AS open_count,
         COUNT(*) FILTER (WHERE priority='urgent' AND status NOT IN ('resolved_won','resolved_lost','collected','written_off'))::integer AS urgent_count,
         COUNT(*) FILTER (WHERE external_deadline < NOW() AND status NOT IN ('resolved_won','resolved_lost','collected','written_off'))::integer AS overdue_count,
         COUNT(*) FILTER (WHERE case_type='chargeback' AND status NOT IN ('resolved_won','resolved_lost','written_off'))::integer AS open_chargebacks,
         COALESCE(SUM(amount) FILTER (WHERE status NOT IN ('resolved_won','resolved_lost','collected','written_off')),0)::numeric(12,2) AS at_risk_amount,
         COALESCE(SUM(amount) FILTER (WHERE case_type='collection' AND status NOT IN ('collected','written_off')),0)::numeric(12,2) AS collection_amount
       FROM fleet_financial_cases
       WHERE organization_id=$1`,
      [ORGANIZATION_ID],
    );
    const row = result.rows[0] || {};
    return response.json({
      success: true,
      data: {
        openCount: Number(row.open_count || 0),
        urgentCount: Number(row.urgent_count || 0),
        overdueCount: Number(row.overdue_count || 0),
        openChargebacks: Number(row.open_chargebacks || 0),
        atRiskAmount: Number(row.at_risk_amount || 0),
        collectionAmount: Number(row.collection_amount || 0),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/financial-cases/readiness", async (_request, response) => response.json({
  success: true,
  data: {
    internalWorkflow: "ready",
    automatedProviderActions: "external_activation_required",
    message: "Case intake, evidence, deadlines, assignments, transitions, and audit history are live. Processor submissions and automated collections remain disabled until the payment gateway is activated.",
  },
}));

router.post("/financial-cases", async (request, response, next) => {
  const caseType = clean(request.body?.caseType, 40).toLowerCase();
  const priority = clean(request.body?.priority || "normal", 40).toLowerCase();
  const title = clean(request.body?.title, 200);
  const description = clean(request.body?.description, 4000) || null;
  const amount = numberOrNull(request.body?.amount ?? 0, 0, 10_000_000);
  const currency = clean(request.body?.currency || "USD", 3).toUpperCase();
  const idempotencyKey = clean(request.body?.idempotencyKey || request.get("Idempotency-Key"), 200);
  const externalDeadline = request.body?.externalDeadline ? validDate(request.body.externalDeadline) : null;
  const bookingId = clean(request.body?.bookingId, 80) || null;
  const paymentOperationId = clean(request.body?.paymentOperationId, 80) || null;
  if (!CASE_TYPES.has(caseType) || !CASE_PRIORITIES.has(priority)) {
    return fail(response, 400, "INVALID_FINANCIAL_CASE", "Select a supported case type and priority.");
  }
  if (!title || amount === null || !/^[A-Z]{3}$/.test(currency) || !idempotencyKey) {
    return fail(response, 400, "FINANCIAL_CASE_INPUT_REQUIRED", "Title, non-negative amount, currency, and idempotency key are required.");
  }
  if (request.body?.externalDeadline && !externalDeadline) {
    return fail(response, 400, "INVALID_CASE_DEADLINE", "Use a valid external deadline.");
  }
  if ((bookingId && !validUuid(bookingId)) || (paymentOperationId && !validUuid(paymentOperationId))) {
    return fail(response, 400, "INVALID_CASE_LINK", "The linked reservation or payment is invalid.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `${FINANCIAL_CASE_SELECT}
        WHERE financial_case.organization_id=$1 AND financial_case.idempotency_key=$2`,
      [ORGANIZATION_ID, idempotencyKey],
    );
    if (existing.rowCount) {
      await client.query("COMMIT");
      return response.json({ success: true, data: financialCasePayload(existing.rows[0]), replayed: true });
    }

    let customerId = clean(request.body?.customerId, 80) || null;
    let resolvedBookingId = bookingId;
    let resolvedPaymentOperationId = paymentOperationId;
    let inferredExternalReference = null;
    if (resolvedBookingId) {
      const bookingResult = await client.query(
        `SELECT id,customer_id FROM fleet_bookings WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL`,
        [ORGANIZATION_ID, resolvedBookingId],
      );
      if (!bookingResult.rowCount) {
        await client.query("ROLLBACK");
        return fail(response, 404, "BOOKING_NOT_FOUND", "The linked reservation was not found.");
      }
      customerId ||= bookingResult.rows[0].customer_id;
    }
    if (resolvedPaymentOperationId) {
      const paymentResult = await client.query(
        `SELECT id,booking_id,customer_id,provider_reference
           FROM fleet_payment_operations WHERE organization_id=$1 AND id=$2`,
        [ORGANIZATION_ID, resolvedPaymentOperationId],
      );
      if (!paymentResult.rowCount) {
        await client.query("ROLLBACK");
        return fail(response, 404, "PAYMENT_OPERATION_NOT_FOUND", "The linked payment operation was not found.");
      }
      resolvedBookingId ||= paymentResult.rows[0].booking_id;
      customerId ||= paymentResult.rows[0].customer_id;
      inferredExternalReference = paymentResult.rows[0].provider_reference;
    }
    if (customerId && !validUuid(customerId)) {
      await client.query("ROLLBACK");
      return fail(response, 400, "INVALID_CUSTOMER_LINK", "The linked customer is invalid.");
    }
    if (customerId) {
      const customerResult = await client.query(
        `SELECT id FROM fleet_customers WHERE organization_id=$1 AND id=$2`,
        [ORGANIZATION_ID, customerId],
      );
      if (!customerResult.rowCount) {
        await client.query("ROLLBACK");
        return fail(response, 404, "CUSTOMER_NOT_FOUND", "The linked customer was not found.");
      }
    }

    const caseNumber = `GFC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const evidence = financialCaseEvidence(request.body?.evidence);
    const inserted = await client.query(
      `INSERT INTO fleet_financial_cases
        (organization_id,idempotency_key,case_number,case_type,title,description,amount,currency,
         status,priority,booking_id,customer_id,payment_operation_id,external_reference,
         external_deadline,evidence_json,notes,assigned_to,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$18)
       RETURNING id`,
      [
        ORGANIZATION_ID, idempotencyKey, caseNumber, caseType, title, description, amount, currency,
        priority, resolvedBookingId, customerId, resolvedPaymentOperationId,
        clean(request.body?.externalReference, 300) || inferredExternalReference || null,
        externalDeadline, JSON.stringify(evidence), clean(request.body?.notes, 2000) || null,
        request.body?.assignedTo && validUuid(request.body.assignedTo) ? request.body.assignedTo : null,
        request.user.id,
      ],
    );
    const id = inserted.rows[0].id;
    await recordFinancialCaseEvent(client, request, id, "created", null, "open", {
      caseType, priority, amount, currency, evidenceCount: evidence.length,
    });
    await auditFinancialCase(client, request, "financial_case.created", id, null, {
      caseNumber, caseType, status: "open", priority, amount, currency,
    });
    const row = await loadFinancialCase(client, id);
    await client.query("COMMIT");
    return response.status(201).json({ success: true, data: financialCasePayload(row) });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return fail(response, 409, "FINANCIAL_CASE_DUPLICATE", "That provider case or request has already been recorded.");
    }
    return next(error);
  } finally {
    client.release();
  }
});

router.patch("/financial-cases/:caseId/evidence", async (request, response, next) => {
  if (!validUuid(request.params.caseId)) {
    return fail(response, 400, "INVALID_CASE_ID", "The financial case identifier is invalid.");
  }
  const evidence = financialCaseEvidence(request.body?.evidence);
  if (!evidence.length) {
    return fail(response, 400, "CASE_EVIDENCE_REQUIRED", "Add at least one evidence reference.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await loadFinancialCase(client, request.params.caseId, true);
    if (!before) {
      await client.query("ROLLBACK");
      return fail(response, 404, "FINANCIAL_CASE_NOT_FOUND", "The financial case was not found.");
    }
    if (FINAL_STATUSES.has(before.status)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "FINANCIAL_CASE_FINAL", "A resolved financial case cannot be changed.");
    }
    await client.query(
      `UPDATE fleet_financial_cases SET evidence_json=$3::jsonb,updated_by=$4,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [ORGANIZATION_ID, before.id, JSON.stringify(evidence), request.user.id],
    );
    await recordFinancialCaseEvent(client, request, before.id, "evidence_updated", null, null, { evidenceCount: evidence.length });
    await auditFinancialCase(client, request, "financial_case.evidence_updated", before.id, {
      evidenceCount: Array.isArray(before.evidence_json) ? before.evidence_json.length : 0,
    }, { evidenceCount: evidence.length });
    const after = await loadFinancialCase(client, before.id);
    await client.query("COMMIT");
    return response.json({ success: true, data: financialCasePayload(after) });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.patch("/financial-cases/:caseId/status", async (request, response, next) => {
  if (!validUuid(request.params.caseId)) {
    return fail(response, 400, "INVALID_CASE_ID", "The financial case identifier is invalid.");
  }
  const nextStatus = clean(request.body?.status, 40).toLowerCase();
  const notes = clean(request.body?.notes, 2000);
  const externalReference = clean(request.body?.externalReference, 300) || null;
  if (!CASE_STATUSES.has(nextStatus)) {
    return fail(response, 400, "INVALID_CASE_STATUS", "The requested financial case status is invalid.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await loadFinancialCase(client, request.params.caseId, true);
    if (!before) {
      await client.query("ROLLBACK");
      return fail(response, 404, "FINANCIAL_CASE_NOT_FOUND", "The financial case was not found.");
    }
    if (!canTransitionFinancialCase(before.case_type, before.status, nextStatus)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "CASE_TRANSITION_BLOCKED", "That financial case transition is not allowed.", {
        from: before.status,
        to: nextStatus,
        allowed: allowedTransitions(before.case_type, before.status),
      });
    }
    const blockers = transitionBlockers({
      evidence: before.evidence_json,
      externalReference: externalReference || before.external_reference,
    }, nextStatus, notes);
    if (blockers.length) {
      await client.query("ROLLBACK");
      return fail(response, 409, "CASE_TRANSITION_REQUIREMENTS", "Complete the case requirements before changing its status.", { blockers });
    }
    await client.query(
      `UPDATE fleet_financial_cases
          SET status=$3,notes=COALESCE(NULLIF($4,''),notes),
              external_reference=COALESCE($5,external_reference),
              resolved_at=CASE WHEN $6 THEN NOW() ELSE NULL END,
              updated_by=$7,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [ORGANIZATION_ID, before.id, nextStatus, notes, externalReference, FINAL_STATUSES.has(nextStatus), request.user.id],
    );
    await recordFinancialCaseEvent(client, request, before.id, "status_changed", before.status, nextStatus, {
      notes: notes || undefined,
      externalReference: externalReference || undefined,
    });
    await auditFinancialCase(client, request, "financial_case.status_changed", before.id, {
      status: before.status,
    }, { status: nextStatus, notes: notes || undefined });
    const after = await loadFinancialCase(client, before.id);
    await client.query("COMMIT");
    return response.json({ success: true, data: financialCasePayload(after) });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/accounting/readiness", async (_request, response) => response.json({
  success: true,
  data: {
    csv: {
      state: "ready",
      mode: "live",
      message: "Accountant-ready CSV export is available now.",
    },
    quickbooks: {
      state: "external_activation_required",
      mode: "disabled",
      message: "QuickBooks OAuth credentials and company authorization are required.",
    },
    xero: {
      state: "external_activation_required",
      mode: "disabled",
      message: "Xero OAuth credentials and tenant authorization are required.",
    },
  },
}));

router.get("/accounting/export.csv", async (request, response, next) => {
  const from = request.query.from ? validDate(request.query.from) : null;
  const to = request.query.to ? validDate(request.query.to) : null;
  if ((request.query.from && !from) || (request.query.to && !to)) {
    return fail(response, 400, "INVALID_EXPORT_RANGE", "Use valid dates for the accounting export.");
  }
  try {
    const result = await query(
      `SELECT charge.occurred_at AS "occurredAt",
              charge.charge_type AS "chargeType",
              charge.description,
              charge.amount,
              charge.currency,
              booking.reservation_number AS "reservationNumber",
              concat_ws(' ',vehicle.model_year,vehicle.make,vehicle.model) AS "vehicleName",
              vehicle.license_plate AS "licensePlate",
              customer.full_name AS "customerName",
              charge.workflow_status AS "workflowStatus",
              charge.source_provider AS "sourceProvider",
              charge.source_reference AS "sourceReference"
         FROM fleet_incidental_charges charge
         LEFT JOIN fleet_bookings booking
           ON booking.organization_id=charge.organization_id AND booking.id=charge.booking_id
         LEFT JOIN fleet_vehicles vehicle
           ON vehicle.organization_id=charge.organization_id AND vehicle.id=charge.vehicle_id
         LEFT JOIN fleet_customers customer
           ON customer.organization_id=charge.organization_id AND customer.id=charge.customer_id
        WHERE charge.organization_id=$1
          AND charge.workflow_status IN ('approved','collection_pending','collected')
          AND ($2::timestamptz IS NULL OR charge.occurred_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR charge.occurred_at <= $3::timestamptz)
        ORDER BY charge.occurred_at,charge.id`,
      [ORGANIZATION_ID, from, to],
    );
    const csv = accountingCsv(result.rows);
    const date = new Date().toISOString().slice(0, 10);
    response.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="goodfleet-incidentals-${date}.csv"`,
      "Cache-Control": "private, no-store",
    });
    return response.send(csv);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
