"use strict";

const DEFAULT_POLICY = Object.freeze({
  cancellationWindowHours: 24,
  lateCancellationFee: 0,
  noShowGracePeriodMinutes: 120,
  noShowFee: 0,
});

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function currency(value) {
  return Number(Math.max(0, Number(value) || 0).toFixed(2));
}

function bookingPolicy(state = {}) {
  const reservations = state?.ownerSettings?.reservations || {};
  return {
    cancellationWindowHours: boundedNumber(
      reservations.cancellationWindowHours,
      DEFAULT_POLICY.cancellationWindowHours,
      0,
      720,
    ),
    lateCancellationFee: boundedNumber(
      reservations.lateCancellationFee,
      DEFAULT_POLICY.lateCancellationFee,
      0,
      10000,
    ),
    noShowGracePeriodMinutes: boundedNumber(
      reservations.noShowGracePeriodMinutes,
      DEFAULT_POLICY.noShowGracePeriodMinutes,
      0,
      1440,
    ),
    noShowFee: boundedNumber(
      reservations.noShowFee,
      DEFAULT_POLICY.noShowFee,
      0,
      10000,
    ),
  };
}

function financialOutcome({ feeAmount, paidAmount, totalAmount }) {
  const fee = Math.min(currency(feeAmount), currency(totalAmount));
  const paid = currency(paidAmount);
  const refundDue = currency(Math.max(0, paid - fee));
  const balanceDue = currency(Math.max(0, fee - paid));
  const disposition = refundDue > 0
    ? "refund_review"
    : balanceDue > 0
      ? "collection_review"
      : "no_action";
  return { feeAmount: fee, refundDue, balanceDue, disposition };
}

function cancellationOutcome({ pickupAt, totalAmount, paidAmount, state, now = new Date(), waiveFee = false }) {
  const policy = bookingPolicy(state);
  const pickup = new Date(pickupAt);
  const current = new Date(now);
  if (Number.isNaN(pickup.getTime()) || Number.isNaN(current.getTime())) {
    const error = new Error("Pickup time is invalid.");
    error.statusCode = 400;
    error.code = "INVALID_PICKUP_TIME";
    throw error;
  }
  const hoursBeforePickup = Number(((pickup.getTime() - current.getTime()) / 3_600_000).toFixed(2));
  const insideFeeWindow = hoursBeforePickup < policy.cancellationWindowHours;
  const financial = financialOutcome({
    feeAmount: waiveFee || !insideFeeWindow ? 0 : policy.lateCancellationFee,
    paidAmount,
    totalAmount,
  });
  return {
    actionType: "cancellation",
    policy,
    hoursBeforePickup,
    insideFeeWindow,
    feeWaived: Boolean(waiveFee),
    ...financial,
  };
}

function noShowOutcome({ pickupAt, totalAmount, paidAmount, state, now = new Date(), waiveFee = false }) {
  const policy = bookingPolicy(state);
  const pickup = new Date(pickupAt);
  const current = new Date(now);
  if (Number.isNaN(pickup.getTime()) || Number.isNaN(current.getTime())) {
    const error = new Error("Pickup time is invalid.");
    error.statusCode = 400;
    error.code = "INVALID_PICKUP_TIME";
    throw error;
  }
  const eligibleAt = new Date(pickup.getTime() + policy.noShowGracePeriodMinutes * 60_000);
  if (current < eligibleAt) {
    const error = new Error(`This reservation can be marked as a no-show after ${eligibleAt.toISOString()}.`);
    error.statusCode = 409;
    error.code = "NO_SHOW_GRACE_PERIOD_ACTIVE";
    error.details = { eligibleAt: eligibleAt.toISOString() };
    throw error;
  }
  return {
    actionType: "no_show",
    policy,
    eligibleAt: eligibleAt.toISOString(),
    minutesAfterPickup: Number(((current.getTime() - pickup.getTime()) / 60_000).toFixed(2)),
    feeWaived: Boolean(waiveFee),
    ...financialOutcome({
      feeAmount: waiveFee ? 0 : policy.noShowFee,
      paidAmount,
      totalAmount,
    }),
  };
}

function policyActionPayload(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookingId: row.booking_id,
    actionType: row.action_type,
    source: row.source,
    reason: row.reason,
    status: row.status,
    feeAmount: Number(row.fee_amount || 0),
    refundDue: Number(row.refund_due || 0),
    balanceDue: Number(row.balance_due || 0),
    policy: row.policy_json || {},
    outcome: row.outcome_json || {},
    createdAt: row.created_at,
  };
}

async function recordPolicyAction(client, {
  organizationId,
  bookingId,
  actionType,
  source,
  reason,
  outcome,
  idempotencyKey,
  actorId,
}) {
  const status = outcome.feeWaived
    ? "waived"
    : outcome.disposition === "no_action" ? "recorded" : "review_required";
  const result = await client.query(
    `INSERT INTO fleet_booking_policy_actions
      (organization_id,booking_id,action_type,source,reason,status,fee_amount,
       refund_due,balance_due,policy_json,outcome_json,idempotency_key,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)
     ON CONFLICT (organization_id,idempotency_key) DO UPDATE
       SET idempotency_key=EXCLUDED.idempotency_key
     RETURNING *`,
    [organizationId, bookingId, actionType, source, reason, status,
      outcome.feeAmount, outcome.refundDue, outcome.balanceDue,
      JSON.stringify(outcome.policy || {}), JSON.stringify(outcome), idempotencyKey, actorId],
  );
  return policyActionPayload(result.rows[0]);
}

async function syncInventoryTransfer(client, {
  organizationId,
  bookingId,
  vehicleId,
  pickupBranchId,
  returnBranchId,
  expectedAt,
  bookingStatus,
  actorId,
}) {
  const oneWay = pickupBranchId && returnBranchId && pickupBranchId !== returnBranchId;
  const terminalCancellation = ["cancelled", "refunded", "no_show"].includes(bookingStatus);
  if (!oneWay || terminalCancellation) {
    const cancelled = await client.query(
      `UPDATE fleet_inventory_transfer_plans
          SET status='cancelled',cancelled_at=COALESCE(cancelled_at,NOW()),
              updated_by=$3,updated_at=NOW()
        WHERE organization_id=$1 AND booking_id=$2 AND status='planned'
        RETURNING *`,
      [organizationId, bookingId, actorId],
    );
    return cancelled.rows[0] || null;
  }
  const status = bookingStatus === "completed" ? "completed" : "planned";
  const result = await client.query(
    `INSERT INTO fleet_inventory_transfer_plans
      (organization_id,booking_id,vehicle_id,origin_branch_id,destination_branch_id,
       expected_at,status,completed_at,created_by,updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7='completed' THEN NOW() ELSE NULL END,$8,$8)
     ON CONFLICT (organization_id,booking_id) DO UPDATE SET
       vehicle_id=EXCLUDED.vehicle_id,
       origin_branch_id=EXCLUDED.origin_branch_id,
       destination_branch_id=EXCLUDED.destination_branch_id,
       expected_at=EXCLUDED.expected_at,
       status=EXCLUDED.status,
       completed_at=CASE WHEN EXCLUDED.status='completed' THEN COALESCE(fleet_inventory_transfer_plans.completed_at,NOW()) ELSE NULL END,
       cancelled_at=NULL,
       updated_by=EXCLUDED.updated_by,
       updated_at=NOW()
     RETURNING *`,
    [organizationId, bookingId, vehicleId || null, pickupBranchId, returnBranchId,
      expectedAt, status, actorId],
  );
  return result.rows[0];
}

module.exports = {
  DEFAULT_POLICY,
  bookingPolicy,
  cancellationOutcome,
  noShowOutcome,
  policyActionPayload,
  recordPolicyAction,
  syncInventoryTransfer,
};
