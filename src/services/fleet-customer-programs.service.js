"use strict";

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rounded(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100;
}

function normalizedCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function loyaltyTier(lifetimePoints) {
  const points = Math.max(0, Math.trunc(number(lifetimePoints)));
  if (points >= 10_000) return "platinum";
  if (points >= 5_000) return "gold";
  if (points >= 1_500) return "silver";
  return "member";
}

function loyaltyTierDiscount(tier) {
  if (tier === "platinum") return 8;
  if (tier === "gold") return 5;
  if (tier === "silver") return 3;
  return 0;
}

function programDiscount({ adjustedBase, promotionalDiscount = 0, program = null }) {
  const base = Math.max(0, number(adjustedBase));
  const candidates = [];
  const promotion = Math.min(base, Math.max(0, number(promotionalDiscount)));
  if (promotion > 0) {
    candidates.push({
      amount: rounded(promotion),
      source: "promotion",
      label: "Promotional discount",
      percent: rounded(promotion / Math.max(base, 1) * 100),
    });
  }

  const corporatePercent = Math.min(80, Math.max(0, number(program?.corporateRate?.discountPercent)));
  if (corporatePercent > 0) {
    candidates.push({
      amount: rounded(base * corporatePercent / 100),
      source: "corporate",
      label: String(program?.corporateRate?.name || program?.corporateAccountName || "Negotiated corporate rate"),
      percent: rounded(corporatePercent),
    });
  }

  const loyaltyPercent = Math.min(25, Math.max(0, number(program?.loyalty?.discountPercent)));
  if (loyaltyPercent > 0 && String(program?.loyalty?.status || "").toLowerCase() === "active") {
    candidates.push({
      amount: rounded(base * loyaltyPercent / 100),
      source: "loyalty",
      label: `${String(program?.loyalty?.tier || "member")} loyalty benefit`,
      percent: rounded(loyaltyPercent),
    });
  }

  const selected = candidates.sort((left, right) =>
    right.amount - left.amount || left.source.localeCompare(right.source)
  )[0] || null;
  return selected || { amount: 0, source: null, label: null, percent: 0 };
}

function rentalPoints(paidAmount) {
  return Math.max(0, Math.min(100_000, Math.floor(number(paidAmount))));
}

async function loadCustomerProgram(client, {
  organizationId,
  customerId,
  vehicleCategory,
  branchId,
  pickupAt,
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(customerId || ""))) {
    return null;
  }
  const accountResult = await client.query(
    `SELECT account.id AS corporate_account_id,account.name AS corporate_account_name,
            loyalty.id AS loyalty_account_id,loyalty.status AS loyalty_status,
            loyalty.tier AS loyalty_tier,loyalty.points_balance,
            loyalty.discount_percent AS loyalty_discount_percent
       FROM fleet_customers customer
       LEFT JOIN fleet_corporate_memberships membership
         ON membership.organization_id=customer.organization_id
        AND membership.customer_id=customer.id
        AND membership.status='active'
       LEFT JOIN fleet_corporate_accounts account
         ON account.organization_id=membership.organization_id
        AND account.id=membership.corporate_account_id
        AND account.status='active'
       LEFT JOIN fleet_loyalty_accounts loyalty
         ON loyalty.organization_id=customer.organization_id
        AND loyalty.customer_id=customer.id
      WHERE customer.organization_id=$1 AND customer.id=$2 AND customer.archived_at IS NULL`,
    [organizationId, customerId]
  );
  const record = accountResult.rows[0];
  if (!record) return null;

  let corporateRate = null;
  if (record.corporate_account_id) {
    const category = String(vehicleCategory || "uncategorized");
    const branch = String(branchId || "").slice(0, 200);
    const rateResult = await client.query(
      `SELECT id,name,discount_percent
         FROM fleet_negotiated_rates
        WHERE organization_id=$1
          AND corporate_account_id=$2
          AND status='active'
          AND vehicle_category=ANY($3::text[])
          AND (branch_id IS NULL OR branch_id=$4)
          AND (starts_on IS NULL OR starts_on<=$5::date)
          AND (ends_on IS NULL OR ends_on>=$5::date)
        ORDER BY (vehicle_category=$6) DESC,(branch_id=$4) DESC,discount_percent DESC,created_at ASC
        LIMIT 1`,
      [organizationId, record.corporate_account_id, ["*", category], branch || null, pickupAt, category]
    );
    if (rateResult.rowCount) {
      corporateRate = {
        id: rateResult.rows[0].id,
        name: rateResult.rows[0].name,
        discountPercent: Number(rateResult.rows[0].discount_percent),
      };
    }
  }
  const loyalty = record.loyalty_account_id ? {
    id: record.loyalty_account_id,
    status: record.loyalty_status,
    tier: record.loyalty_tier,
    pointsBalance: Number(record.points_balance || 0),
    discountPercent: Number(record.loyalty_discount_percent || 0),
  } : null;
  if (!record.corporate_account_id && !loyalty) return null;
  return {
    corporateAccountId: record.corporate_account_id || null,
    corporateAccountName: record.corporate_account_name || null,
    corporateRate,
    loyalty,
  };
}

module.exports = {
  loyaltyTier,
  loyaltyTierDiscount,
  loadCustomerProgram,
  normalizedCode,
  programDiscount,
  rentalPoints,
};
