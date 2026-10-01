"use strict";

const { normalizedCategory, vehicleCategory } = require("./fleet-pricing.service");

const REVENUE_STATUSES = new Set([
  "pending_payment", "confirmed", "assigned", "checked_in", "checked_out",
  "extended", "overdue", "needs_attention", "completed"
]);
const CASH_IN_OPERATION_TYPES = new Set(["checkout", "capture", "manual_payment"]);
const CASH_IN_STATUSES = new Set(["succeeded", "captured"]);
const REFUND_STATUSES = new Set(["succeeded", "refunded"]);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rounded(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

function date(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function value(row, snake, camel) {
  return row?.[snake] ?? row?.[camel];
}

function rangeDays(from, toExclusive) {
  return Math.max(1, Math.ceil((toExclusive.getTime() - from.getTime()) / 86_400_000));
}

function overlapDays(startAt, endAt, from, toExclusive) {
  const start = date(startAt);
  const end = date(endAt);
  if (!start || !end || end <= start) return 0;
  const overlapStart = Math.max(start.getTime(), from.getTime());
  const overlapEnd = Math.min(end.getTime(), toExclusive.getTime());
  if (overlapEnd <= overlapStart) return 0;
  return Math.max(1, Math.ceil((overlapEnd - overlapStart) / 86_400_000));
}

function branchMatches(row, branchId) {
  if (!branchId) return true;
  return String(value(row, "pickup_branch_id", "pickupBranchId") || "") === branchId ||
    String(value(row, "return_branch_id", "returnBranchId") || "") === branchId;
}

function sourceName(booking) {
  const payload = booking?.payload || booking?.booking_payload || {};
  const source = String(payload.sourceChannel || payload.source_channel || "direct").toLowerCase();
  if (["online", "app", "direct", "our_application"].includes(source)) return "Direct";
  if (source === "walk-in" || source === "walk_in") return "Walk-in";
  if (source === "partner") return "Partner";
  return source.replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()) || "Direct";
}

function vehicleName(vehicle) {
  return [vehicle?.model_year ?? vehicle?.year, vehicle?.make, vehicle?.model]
    .filter(Boolean)
    .join(" ") || "Unassigned vehicle";
}

function bucketKey(value, daily) {
  const parsed = date(value);
  if (!parsed) return null;
  return daily
    ? parsed.toISOString().slice(0, 10)
    : parsed.toISOString().slice(0, 7);
}

function bucketLabel(key, daily) {
  const parsed = new Date(`${key}${daily ? "T00:00:00.000Z" : "-01T00:00:00.000Z"}`);
  return parsed.toLocaleDateString("en-US", daily
    ? { month: "short", day: "numeric", timeZone: "UTC" }
    : { month: "short", year: "2-digit", timeZone: "UTC" });
}

function buildBuckets(from, toExclusive) {
  const daily = rangeDays(from, toExclusive) <= 45;
  const buckets = new Map();
  const cursor = new Date(from);
  while (cursor < toExclusive) {
    const key = bucketKey(cursor, daily);
    if (!buckets.has(key)) {
      buckets.set(key, { key, label: bucketLabel(key, daily), booked: 0, collected: 0, expenses: 0 });
    }
    if (daily) cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
  }
  return { daily, buckets };
}

function expenseDate(expense) {
  return expense?.date || expense?.createdAt || expense?.created_at;
}

function maintenanceCost(record) {
  if (String(record?.status || "").toLowerCase() !== "completed") return 0;
  return Math.max(0, number(record.actualCost ?? record.actual_cost ?? record.estimatedCost ?? record.estimated_cost));
}

function expenseMatchKey({ amount, occurredAt, vehicleId }) {
  const parsed = date(occurredAt);
  return `${rounded(amount)}:${parsed ? parsed.toISOString().slice(0, 10) : ""}:${String(vehicleId || "")}`;
}

function buildPerformanceReport({
  vehicles = [],
  bookings = [],
  payments = [],
  state = {},
  from,
  toExclusive,
  branchId = "",
  category = ""
}) {
  const reportFrom = date(from);
  const reportTo = date(toExclusive);
  if (!reportFrom || !reportTo || reportTo <= reportFrom) {
    const error = new Error("Use a valid reporting period.");
    error.statusCode = 400;
    error.code = "INVALID_REPORT_RANGE";
    throw error;
  }

  const normalizedFilterCategory = category ? normalizedCategory(category) : "";
  const selectedVehicles = vehicles.filter(vehicle => {
    if (branchId && String(value(vehicle, "assigned_branch_id", "assignedBranchId") || "") !== branchId) return false;
    if (normalizedFilterCategory && vehicleCategory(vehicle) !== normalizedFilterCategory) return false;
    return !["retired", "blocked", "recalled"].includes(String(vehicle?.status || "").toLowerCase());
  });
  const allVehiclesById = new Map(vehicles.map(vehicle => [String(vehicle.id), vehicle]));
  const selectedVehicleIds = new Set(selectedVehicles.map(vehicle => String(vehicle.id)));

  const scopedBookings = bookings.filter(booking => {
    if (!branchMatches(booking, branchId)) return false;
    const vehicleId = String(value(booking, "vehicle_id", "vehicleId") || "");
    if (normalizedFilterCategory) {
      const vehicle = allVehiclesById.get(vehicleId);
      if (!vehicle || vehicleCategory(vehicle) !== normalizedFilterCategory) return false;
    }
    return true;
  });
  const reportBookings = scopedBookings.filter(booking => {
    const pickup = date(value(booking, "pickup_at", "pickupAt") || booking.startDate);
    return pickup && pickup >= reportFrom && pickup < reportTo;
  });
  const revenueBookings = reportBookings.filter(booking =>
    REVENUE_STATUSES.has(String(booking.status || "").toLowerCase())
  );
  const utilizationBookings = scopedBookings.filter(booking => {
    const status = String(booking.status || "").toLowerCase();
    const vehicleId = String(value(booking, "vehicle_id", "vehicleId") || "");
    return REVENUE_STATUSES.has(status) && selectedVehicleIds.has(vehicleId) && overlapDays(
      value(booking, "pickup_at", "pickupAt") || booking.startDate,
      value(booking, "return_at", "returnAt") || booking.endDate,
      reportFrom,
      reportTo
    ) > 0;
  });

  const reportBookingIds = new Set(reportBookings.map(booking => String(booking.id)));
  const scopedPayments = payments.filter(payment => {
    const createdAt = date(value(payment, "created_at", "createdAt"));
    if (!createdAt || createdAt < reportFrom || createdAt >= reportTo) return false;
    if (!branchMatches(payment, branchId)) return false;
    if (normalizedFilterCategory) {
      const vehicle = allVehiclesById.get(String(value(payment, "vehicle_id", "vehicleId") || ""));
      if (!vehicle || vehicleCategory(vehicle) !== normalizedFilterCategory) return false;
    }
    return true;
  });

  let cashIn = 0;
  let refunds = 0;
  for (const payment of scopedPayments) {
    const operationType = String(value(payment, "operation_type", "operationType") || "").toLowerCase();
    const status = String(payment.status || "").toLowerCase();
    const amount = Math.max(0, number(payment.amount));
    if (CASH_IN_OPERATION_TYPES.has(operationType) && CASH_IN_STATUSES.has(status)) cashIn += amount;
    if (operationType === "refund" && REFUND_STATUSES.has(status)) refunds += amount;
  }
  cashIn = rounded(cashIn);
  refunds = rounded(refunds);
  const collectedRevenue = rounded(cashIn - refunds);
  const bookedRevenue = rounded(revenueBookings.reduce((sum, booking) =>
    sum + Math.max(0, number(value(booking, "total_amount", "totalAmount"))), 0));
  const outstandingBalance = rounded(revenueBookings.reduce((sum, booking) =>
    sum + Math.max(0, number(value(booking, "total_amount", "totalAmount")) - number(value(booking, "paid_amount", "paidAmount"))), 0));
  const quotedTaxes = rounded(revenueBookings.reduce((sum, booking) =>
    sum + Math.max(0, number(booking?.payload?.pricing?.tax)), 0));
  const quotedFees = rounded(revenueBookings.reduce((sum, booking) => {
    const pricing = booking?.payload?.pricing || {};
    return sum + Math.max(0,
      number(pricing.mandatoryFees) + number(pricing.locationSurcharge) + number(pricing.oneWayFee)
    );
  }, 0));

  const expenses = (Array.isArray(state.expenses) ? state.expenses : []).filter(expense => {
    const occurredAt = date(expenseDate(expense));
    if (!occurredAt || occurredAt < reportFrom || occurredAt >= reportTo) return false;
    if (branchId && expense.branchId && String(expense.branchId) !== branchId) return false;
    if (normalizedFilterCategory && expense.vehicleId) {
      const vehicle = allVehiclesById.get(String(expense.vehicleId));
      if (!vehicle || vehicleCategory(vehicle) !== normalizedFilterCategory) return false;
    }
    return true;
  });
  const explicitExpenseKeys = new Set(expenses.map(expense => expenseMatchKey({
    amount: expense.amount,
    occurredAt: expenseDate(expense),
    vehicleId: expense.vehicleId
  })));
  const maintenance = (Array.isArray(state.maintenance) ? state.maintenance : []).filter(record => {
    const occurredAt = date(record.date);
    const cost = maintenanceCost(record);
    if (!occurredAt || occurredAt < reportFrom || occurredAt >= reportTo || !cost) return false;
    const vehicle = allVehiclesById.get(String(record.carId || record.vehicleId || ""));
    if (branchId && (!vehicle || String(value(vehicle, "assigned_branch_id", "assignedBranchId") || "") !== branchId)) return false;
    if (normalizedFilterCategory && (!vehicle || vehicleCategory(vehicle) !== normalizedFilterCategory)) return false;
    return !explicitExpenseKeys.has(expenseMatchKey({
      amount: cost,
      occurredAt: record.date,
      vehicleId: record.carId || record.vehicleId
    }));
  });
  const explicitExpenses = rounded(expenses.reduce((sum, expense) => sum + Math.max(0, number(expense.amount)), 0));
  const maintenanceExpenses = rounded(maintenance.reduce((sum, record) => sum + maintenanceCost(record), 0));
  const recordedExpenses = rounded(explicitExpenses + maintenanceExpenses);
  const cashLessRecordedCosts = rounded(collectedRevenue - recordedExpenses);

  const days = rangeDays(reportFrom, reportTo);
  const capacityDays = selectedVehicles.length * days;
  const rentalDays = utilizationBookings.reduce((sum, booking) => sum + overlapDays(
    value(booking, "pickup_at", "pickupAt") || booking.startDate,
    value(booking, "return_at", "returnAt") || booking.endDate,
    reportFrom,
    reportTo
  ), 0);
  const utilization = capacityDays ? Math.min(100, rentalDays / capacityDays * 100) : 0;
  const adr = rentalDays ? bookedRevenue / rentalDays : 0;
  const revpar = capacityDays ? bookedRevenue / capacityDays : 0;

  const categoryGroups = new Map();
  for (const vehicle of selectedVehicles) {
    const key = vehicleCategory(vehicle);
    if (!categoryGroups.has(key)) categoryGroups.set(key, { category: key, vehicles: 0, rentalDays: 0, bookedRevenue: 0 });
    categoryGroups.get(key).vehicles += 1;
  }
  for (const booking of utilizationBookings) {
    const vehicle = allVehiclesById.get(String(value(booking, "vehicle_id", "vehicleId") || ""));
    if (!vehicle) continue;
    const group = categoryGroups.get(vehicleCategory(vehicle));
    group.rentalDays += overlapDays(
      value(booking, "pickup_at", "pickupAt") || booking.startDate,
      value(booking, "return_at", "returnAt") || booking.endDate,
      reportFrom,
      reportTo
    );
  }
  for (const booking of revenueBookings) {
    const vehicle = allVehiclesById.get(String(value(booking, "vehicle_id", "vehicleId") || ""));
    const group = vehicle && categoryGroups.get(vehicleCategory(vehicle));
    if (group) group.bookedRevenue += Math.max(0, number(value(booking, "total_amount", "totalAmount")));
  }
  const categories = [...categoryGroups.values()].map(group => ({
    ...group,
    bookedRevenue: rounded(group.bookedRevenue),
    utilization: group.vehicles * days ? rounded(group.rentalDays / (group.vehicles * days) * 100, 1) : 0
  })).sort((left, right) => right.bookedRevenue - left.bookedRevenue || left.category.localeCompare(right.category));

  const sources = new Map();
  for (const booking of revenueBookings) {
    const source = sourceName(booking);
    const current = sources.get(source) || { name: source, bookings: 0, bookedRevenue: 0 };
    current.bookings += 1;
    current.bookedRevenue += Math.max(0, number(value(booking, "total_amount", "totalAmount")));
    sources.set(source, current);
  }
  const bookingSources = [...sources.values()].map(source => ({
    ...source,
    bookedRevenue: rounded(source.bookedRevenue),
    share: bookedRevenue ? rounded(source.bookedRevenue / bookedRevenue * 100, 1) : 0
  })).sort((left, right) => right.bookedRevenue - left.bookedRevenue || left.name.localeCompare(right.name));

  const vehicleGroups = new Map(selectedVehicles.map(vehicle => [String(vehicle.id), {
    id: String(vehicle.id),
    name: vehicleName(vehicle),
    category: vehicleCategory(vehicle),
    rentalDays: 0,
    bookedRevenue: 0
  }]));
  for (const booking of utilizationBookings) {
    const group = vehicleGroups.get(String(value(booking, "vehicle_id", "vehicleId") || ""));
    if (group) group.rentalDays += overlapDays(
      value(booking, "pickup_at", "pickupAt") || booking.startDate,
      value(booking, "return_at", "returnAt") || booking.endDate,
      reportFrom,
      reportTo
    );
  }
  for (const booking of revenueBookings) {
    const group = vehicleGroups.get(String(value(booking, "vehicle_id", "vehicleId") || ""));
    if (group) group.bookedRevenue += Math.max(0, number(value(booking, "total_amount", "totalAmount")));
  }
  const topVehicles = [...vehicleGroups.values()].map(vehicle => ({
    ...vehicle,
    bookedRevenue: rounded(vehicle.bookedRevenue),
    utilization: rounded(Math.min(100, vehicle.rentalDays / days * 100), 1)
  })).sort((left, right) => right.bookedRevenue - left.bookedRevenue || right.rentalDays - left.rentalDays).slice(0, 10);

  const { daily, buckets } = buildBuckets(reportFrom, reportTo);
  for (const booking of revenueBookings) {
    const key = bucketKey(value(booking, "pickup_at", "pickupAt") || booking.startDate, daily);
    if (buckets.has(key)) buckets.get(key).booked += Math.max(0, number(value(booking, "total_amount", "totalAmount")));
  }
  for (const payment of scopedPayments) {
    const key = bucketKey(value(payment, "created_at", "createdAt"), daily);
    if (!buckets.has(key)) continue;
    const operationType = String(value(payment, "operation_type", "operationType") || "").toLowerCase();
    const status = String(payment.status || "").toLowerCase();
    const amount = Math.max(0, number(payment.amount));
    if (CASH_IN_OPERATION_TYPES.has(operationType) && CASH_IN_STATUSES.has(status)) buckets.get(key).collected += amount;
    if (operationType === "refund" && REFUND_STATUSES.has(status)) buckets.get(key).collected -= amount;
  }
  for (const expense of expenses) {
    const key = bucketKey(expenseDate(expense), daily);
    if (buckets.has(key)) buckets.get(key).expenses += Math.max(0, number(expense.amount));
  }
  for (const record of maintenance) {
    const key = bucketKey(record.date, daily);
    if (buckets.has(key)) buckets.get(key).expenses += maintenanceCost(record);
  }
  const series = [...buckets.values()].map(bucket => ({
    ...bucket,
    booked: rounded(bucket.booked),
    collected: rounded(bucket.collected),
    expenses: rounded(bucket.expenses)
  }));

  return {
    generatedAt: new Date().toISOString(),
    period: {
      from: reportFrom.toISOString(),
      toExclusive: reportTo.toISOString(),
      days,
      branchId: branchId || null,
      category: normalizedFilterCategory || null
    },
    summary: {
      bookedRevenue,
      cashIn,
      refunds,
      collectedRevenue,
      outstandingBalance,
      quotedTaxes,
      quotedFees,
      recordedExpenses,
      explicitExpenses,
      maintenanceExpenses,
      cashLessRecordedCosts,
      reservations: reportBookings.length,
      cancellations: reportBookings.filter(booking => String(booking.status).toLowerCase() === "cancelled").length,
      noShows: reportBookings.filter(booking => String(booking.status).toLowerCase() === "no_show").length,
      overdue: scopedBookings.filter(booking => String(booking.status).toLowerCase() === "overdue").length,
      activeVehicles: selectedVehicles.length,
      rentalDays,
      capacityDays,
      utilization: rounded(utilization, 1),
      adr: rounded(adr),
      revpar: rounded(revpar),
      uniqueCustomers: new Set(reportBookings.map(booking => String(value(booking, "customer_id", "customerId") || "")).filter(Boolean)).size
    },
    categories,
    bookingSources,
    topVehicles,
    series,
    reservations: reportBookings.map(booking => ({
      id: String(booking.id),
      reservationNumber: String(value(booking, "reservation_number", "reservationNumber") || ""),
      vehicleId: value(booking, "vehicle_id", "vehicleId") || null,
      vehicleName: vehicleName(allVehiclesById.get(String(value(booking, "vehicle_id", "vehicleId") || ""))),
      pickupAt: value(booking, "pickup_at", "pickupAt") || booking.startDate,
      returnAt: value(booking, "return_at", "returnAt") || booking.endDate,
      status: String(booking.status || ""),
      total: rounded(value(booking, "total_amount", "totalAmount")),
      paid: rounded(value(booking, "paid_amount", "paidAmount")),
      balance: rounded(Math.max(0, number(value(booking, "total_amount", "totalAmount")) - number(value(booking, "paid_amount", "paidAmount")))),
      source: sourceName(booking)
    }))
  };
}

function safeCsvCell(value) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function performanceCsv(report) {
  const rows = [
    ["GoodFleet performance report"],
    ["Generated", report.generatedAt],
    ["Period start", report.period.from],
    ["Period end (exclusive)", report.period.toExclusive],
    ["Branch", report.period.branchId || "All branches"],
    ["Vehicle category", report.period.category || "All categories"],
    [],
    ["Booked revenue", report.summary.bookedRevenue],
    ["Cash collected", report.summary.cashIn],
    ["Refunds", report.summary.refunds],
    ["Net collected cash", report.summary.collectedRevenue],
    ["Outstanding balance", report.summary.outstandingBalance],
    ["Recorded expenses", report.summary.recordedExpenses],
    ["Cash less recorded costs", report.summary.cashLessRecordedCosts],
    ["Utilization percent", report.summary.utilization],
    ["ADR", report.summary.adr],
    ["RevPAR", report.summary.revpar],
    [],
    ["Reservation", "Vehicle", "Pickup", "Return", "Status", "Source", "Total", "Paid", "Balance"],
    ...report.reservations.map(booking => [
      booking.reservationNumber,
      booking.vehicleName,
      booking.pickupAt,
      booking.returnAt,
      booking.status,
      booking.source,
      booking.total,
      booking.paid,
      booking.balance
    ])
  ];
  return rows.map(row => row.map(safeCsvCell).join(",")).join("\n");
}

module.exports = {
  buildPerformanceReport,
  overlapDays,
  performanceCsv,
  safeCsvCell
};
