"use strict";

const { programDiscount } = require("./fleet-customer-programs.service");

const ACTIVE_BOOKING_STATUSES = new Set([
  "quote", "pending_payment", "confirmed", "assigned", "checked_in",
  "checked_out", "extended", "overdue"
]);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rounded(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

function normalizedCategory(value) {
  return String(value || "uncategorized")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "uncategorized";
}

function vehicleCategory(vehicle) {
  return normalizedCategory(
    vehicle?.payload?.category ||
    vehicle?.payload?.carClass ||
    vehicle?.category ||
    vehicle?.car_class
  );
}

function rentalDays(pickupAt, returnAt) {
  const pickup = new Date(pickupAt);
  const dropoff = new Date(returnAt);
  if (Number.isNaN(pickup.getTime()) || Number.isNaN(dropoff.getTime()) || dropoff <= pickup) {
    const error = new Error("Return must be after pickup.");
    error.statusCode = 400;
    error.code = "INVALID_RENTAL_PERIOD";
    throw error;
  }
  return Math.max(1, Math.ceil((dropoff.getTime() - pickup.getTime()) / 86_400_000));
}

function matchesBranch(record, branchId) {
  const configured = String(record?.branchId || record?.branch_id || "").trim();
  return !configured || configured === String(branchId || "");
}

function selectRatePlan(rates, vehicle, branchId) {
  const category = vehicleCategory(vehicle);
  return (Array.isArray(rates) ? rates : [])
    .filter(rate =>
      String(rate?.status || "active").toLowerCase() === "active" &&
      normalizedCategory(rate?.carClass || rate?.car_class) === category &&
      matchesBranch(rate, branchId)
    )
    .sort((left, right) => {
      const leftExact = String(left?.branchId || left?.branch_id || "") === String(branchId || "") ? 1 : 0;
      const rightExact = String(right?.branchId || right?.branch_id || "") === String(branchId || "") ? 1 : 0;
      return rightExact - leftExact;
    })[0] || null;
}

function durationCharge(days, plan, vehicleDailyRate) {
  const fallbackDaily = Math.max(0, number(vehicleDailyRate));
  const dailyRate = Math.max(0, number(plan?.dailyRate ?? plan?.daily_rate, fallbackDaily)) || fallbackDaily;
  const weeklyRate = Math.max(0, number(plan?.weeklyRate ?? plan?.weekly_rate, dailyRate * 7)) || dailyRate * 7;
  const monthlyRate = Math.max(0, number(plan?.monthlyRate ?? plan?.monthly_rate, weeklyRate * 4)) || dailyRate * 30;
  const months = Math.floor(days / 30);
  const afterMonths = days % 30;
  const weeks = Math.floor(afterMonths / 7);
  const remainingDays = afterMonths % 7;
  const amount = months * monthlyRate + weeks * weeklyRate + remainingDays * dailyRate;
  return {
    amount: rounded(amount),
    dailyRate: rounded(dailyRate),
    effectiveDailyRate: rounded(amount / days),
    duration: { months, weeks, days: remainingDays }
  };
}

function parseAdjustment(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return 0;
  return Math.max(-80, Math.min(300, number(match[0])));
}

function overlaps(startA, endA, startB, endB) {
  return startA <= endB && endA >= startB;
}

function applicableSeasonalAdjustments(adjustments, pickupAt, returnAt, branchId) {
  const pickup = new Date(pickupAt);
  const dropoff = new Date(returnAt);
  return (Array.isArray(adjustments) ? adjustments : [])
    .filter(adjustment => {
      const start = new Date(`${String(adjustment?.startDate || "").slice(0, 10)}T00:00:00.000Z`);
      const end = new Date(`${String(adjustment?.endDate || "").slice(0, 10)}T23:59:59.999Z`);
      return !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) &&
        matchesBranch(adjustment, branchId) && overlaps(pickup, dropoff, start, end);
    })
    .map(adjustment => ({
      id: String(adjustment.id || ""),
      name: String(adjustment.name || "Seasonal adjustment"),
      percent: parseAdjustment(adjustment.adjustment)
    }))
    .filter(adjustment => adjustment.percent !== 0);
}

function eligibleDiscount(discounts, suppliedCode, days, pickupAt, branchId) {
  const code = String(suppliedCode || "").trim().toLowerCase();
  if (!code) return null;
  const pickup = new Date(pickupAt);
  return (Array.isArray(discounts) ? discounts : []).find(discount => {
    if (String(discount?.status || "").toLowerCase() !== "active") return false;
    if (String(discount?.code || "").trim().toLowerCase() !== code) return false;
    if (!matchesBranch(discount, branchId)) return false;
    const minimum = Math.max(0, number(discount?.minDays));
    const maximum = Math.max(0, number(discount?.maxDays));
    if (minimum && days < minimum) return false;
    if (maximum && days > maximum) return false;
    if (discount?.startDate && pickup < new Date(`${String(discount.startDate).slice(0, 10)}T00:00:00.000Z`)) return false;
    if (discount?.endDate && pickup > new Date(`${String(discount.endDate).slice(0, 10)}T23:59:59.999Z`)) return false;
    return true;
  }) || null;
}

function branchById(state, branchId) {
  return (Array.isArray(state?.branches) ? state.branches : [])
    .find(branch => String(branch?.id || "") === String(branchId || "")) || null;
}

function calculateBookingPrice({ vehicle, state = {}, input = {}, pickupAt, returnAt }) {
  const days = rentalDays(pickupAt, returnAt);
  const pickupBranchId = String(input.pickupLocationId || input.pickupBranchId || "");
  const returnBranchId = String(input.returnLocationId || input.returnBranchId || pickupBranchId);
  const pickupBranch = branchById(state, pickupBranchId);
  const isOneWay = Boolean(pickupBranchId && returnBranchId && pickupBranchId !== returnBranchId);
  if (isOneWay && pickupBranch?.locationRules?.allowOneWayRentals === false) {
    const error = new Error("One-way rentals are not enabled for the selected pickup branch.");
    error.statusCode = 409;
    error.code = "ONE_WAY_NOT_ALLOWED";
    throw error;
  }

  const plan = selectRatePlan(state.rates, vehicle, pickupBranchId);
  const duration = durationCharge(days, plan, vehicle?.daily_rate ?? vehicle?.dailyRate);
  const seasonalRules = applicableSeasonalAdjustments(
    state.seasonalAdjustments,
    pickupAt,
    returnAt,
    pickupBranchId
  );
  const seasonalPercent = Math.max(
    -80,
    Math.min(300, seasonalRules.reduce((sum, adjustment) => sum + adjustment.percent, 0))
  );
  const seasonalAdjustment = rounded(duration.amount * seasonalPercent / 100);
  const adjustedBase = Math.max(0, rounded(duration.amount + seasonalAdjustment));

  const discountRecord = eligibleDiscount(
    state.discounts,
    input.discountCode || input.promoCode,
    days,
    pickupAt,
    pickupBranchId
  );
  let promotionalDiscount = 0;
  if (discountRecord) {
    const value = Math.max(0, number(discountRecord.value));
    promotionalDiscount = discountRecord.type === "percentage"
      ? adjustedBase * Math.min(value, 100) / 100
      : Math.min(value, adjustedBase);
  }
  promotionalDiscount = rounded(promotionalDiscount);
  const selectedDiscount = programDiscount({
    adjustedBase,
    promotionalDiscount,
    program: input.customerProgram,
  });
  const discount = selectedDiscount.amount;
  const discountedBase = Math.max(0, rounded(adjustedBase - discount));

  const feeLines = (Array.isArray(state.fees) ? state.fees : [])
    .filter(fee =>
      String(fee?.status || "").toLowerCase() === "active" &&
      String(fee?.type || "").toLowerCase() === "mandatory" &&
      matchesBranch(fee, pickupBranchId)
    )
    .map(fee => {
      const value = Math.max(0, number(fee.value));
      const amount = fee.calculationType === "per_day"
        ? value * days
        : fee.calculationType === "percentage"
          ? discountedBase * value / 100
          : value;
      return { id: String(fee.id || ""), name: String(fee.name || "Mandatory fee"), amount: rounded(amount) };
    });

  const locationSurcharge = rounded(
    Math.max(0, number(pickupBranch?.financialConfig?.locationSurcharge)) * days
  );
  const oneWayFee = isOneWay
    ? rounded(Math.max(0, number(pickupBranch?.financialConfig?.oneWayFee)))
    : 0;
  const mandatoryFees = rounded(feeLines.reduce((sum, fee) => sum + fee.amount, 0));
  const additionalCharges = rounded((Array.isArray(input.additionalCharges) ? input.additionalCharges : [])
    .reduce((sum, charge) => sum + Math.max(0, number(charge?.amount)), 0));
  const configuredTax = number(pickupBranch?.financialConfig?.taxRate ?? state.billingSettings?.taxRate);
  const taxRate = Math.min(Math.max(configuredTax, 0), 100);
  const taxableSubtotal = discountedBase + mandatoryFees + locationSurcharge + oneWayFee + additionalCharges;
  const tax = rounded(taxableSubtotal * taxRate / 100);
  const total = rounded(taxableSubtotal + tax);

  return {
    days,
    currency: String(state.billingSettings?.currency || "USD"),
    vehicleCategory: vehicleCategory(vehicle),
    ratePlanId: plan?.id || null,
    rateSource: plan ? (plan.branchId || plan.branch_id ? "branch_rate_plan" : "rate_plan") : "vehicle_daily_rate",
    dailyRate: duration.dailyRate,
    effectiveDailyRate: duration.effectiveDailyRate,
    duration: duration.duration,
    base: duration.amount,
    seasonalAdjustment,
    seasonalPercent: rounded(seasonalPercent, 3),
    seasonalRules,
    discount,
    discountCode: selectedDiscount.source === "promotion" ? discountRecord?.code || null : null,
    discountSource: selectedDiscount.source,
    discountLabel: selectedDiscount.label,
    discountPercent: selectedDiscount.percent,
    customerProgram: input.customerProgram ? {
      corporateAccountId: input.customerProgram.corporateAccountId || null,
      corporateAccountName: input.customerProgram.corporateAccountName || null,
      corporateRateId: input.customerProgram.corporateRate?.id || null,
      loyaltyAccountId: input.customerProgram.loyalty?.id || null,
      loyaltyTier: input.customerProgram.loyalty?.tier || null,
    } : null,
    mandatoryFees,
    feeLines,
    locationSurcharge,
    oneWayFee,
    additionalCharges,
    subtotal: rounded(taxableSubtotal),
    taxRate: rounded(taxRate, 4),
    tax,
    total
  };
}

function overlapDays(startAt, endAt, windowStart, windowEnd) {
  const start = Math.max(new Date(startAt).getTime(), windowStart.getTime());
  const end = Math.min(new Date(endAt).getTime(), windowEnd.getTime());
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.max(1, Math.ceil((end - start) / 86_400_000));
}

function recommendationFor(utilization) {
  if (utilization >= 85) return 20;
  if (utilization >= 70) return 12;
  if (utilization >= 55) return 5;
  if (utilization < 20) return -10;
  if (utilization < 35) return -5;
  return 0;
}

function buildPricingInsights({ vehicles = [], bookings = [], state = {}, asOf = new Date(), horizonDays = 30 }) {
  const boundedHorizon = Math.min(90, Math.max(7, Math.trunc(number(horizonDays, 30))));
  const windowStart = new Date(asOf);
  const windowEnd = new Date(windowStart.getTime() + boundedHorizon * 86_400_000);
  const activeVehicles = vehicles.filter(vehicle =>
    !["retired", "blocked", "recalled"].includes(String(vehicle?.status || "").toLowerCase())
  );
  const groups = new Map();
  for (const vehicle of activeVehicles) {
    const category = vehicleCategory(vehicle);
    if (!groups.has(category)) groups.set(category, { category, vehicles: [], bookedDays: 0, revenue: 0 });
    groups.get(category).vehicles.push(vehicle);
  }
  const byId = new Map(activeVehicles.map(vehicle => [String(vehicle.id), vehicle]));
  for (const booking of bookings) {
    if (!ACTIVE_BOOKING_STATUSES.has(String(booking?.status || "").toLowerCase())) continue;
    const vehicle = byId.get(String(booking?.vehicle_id || booking?.vehicleId || booking?.carId || ""));
    if (!vehicle) continue;
    const days = overlapDays(
      booking?.pickup_at || booking?.pickupAt || booking?.startDate,
      booking?.return_at || booking?.returnAt || booking?.endDate,
      windowStart,
      windowEnd
    );
    if (!days) continue;
    const group = groups.get(vehicleCategory(vehicle));
    group.bookedDays += days;
    group.revenue += Math.max(0, number(booking?.total_amount ?? booking?.totalAmount));
  }

  const insights = [...groups.values()].map(group => {
    const capacityDays = group.vehicles.length * boundedHorizon;
    const utilization = capacityDays ? Math.min(100, group.bookedDays / capacityDays * 100) : 0;
    const availableDays = Math.max(0, capacityDays - group.bookedDays);
    const recommendedAdjustment = recommendationFor(utilization);
    return {
      id: `yield_${group.category}`,
      category: group.category,
      vehicleCount: group.vehicles.length,
      bookedDays: group.bookedDays,
      availableDays,
      utilization: rounded(utilization, 1),
      recommendedAdjustment,
      reason: recommendedAdjustment > 0
        ? `${rounded(utilization, 1)}% of available vehicle-days are already committed.`
        : recommendedAdjustment < 0
          ? `Only ${rounded(utilization, 1)}% of available vehicle-days are committed.`
          : `Utilization is balanced at ${rounded(utilization, 1)}%.`
    };
  }).sort((left, right) => right.utilization - left.utilization || left.category.localeCompare(right.category));

  const totalCapacityDays = activeVehicles.length * boundedHorizon;
  const totalBookedDays = insights.reduce((sum, item) => sum + item.bookedDays, 0);
  const utilization = totalCapacityDays ? totalBookedDays / totalCapacityDays * 100 : 0;
  const planRates = (Array.isArray(state.rates) ? state.rates : [])
    .filter(rate => String(rate?.status || "active").toLowerCase() === "active")
    .map(rate => Math.max(0, number(rate?.dailyRate ?? rate?.daily_rate)))
    .filter(rate => rate > 0);
  const vehicleRates = activeVehicles
    .map(vehicle => Math.max(0, number(vehicle?.daily_rate ?? vehicle?.dailyRate)))
    .filter(rate => rate > 0);
  const sourceRates = planRates.length ? planRates : vehicleRates;
  const averageDailyRate = sourceRates.length
    ? sourceRates.reduce((sum, rate) => sum + rate, 0) / sourceRates.length
    : 0;
  return {
    generatedAt: new Date().toISOString(),
    horizonDays: boundedHorizon,
    metrics: {
      activeVehicles: activeVehicles.length,
      bookedDays: totalBookedDays,
      availableDays: Math.max(0, totalCapacityDays - totalBookedDays),
      utilization: rounded(utilization, 1),
      averageDailyRate: rounded(averageDailyRate),
      revpar: rounded(averageDailyRate * utilization / 100)
    },
    insights
  };
}

module.exports = {
  buildPricingInsights,
  calculateBookingPrice,
  durationCharge,
  normalizedCategory,
  selectRatePlan,
  vehicleCategory
};
