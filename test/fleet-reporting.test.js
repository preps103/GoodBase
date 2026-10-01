"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const reporting = require("../src/services/fleet-reporting.service");

test("performance reporting separates bookings, cash, refunds, balances, and recorded costs", () => {
  const report = reporting.buildPerformanceReport({
    from: new Date("2026-08-01T00:00:00.000Z"),
    toExclusive: new Date("2026-09-01T00:00:00.000Z"),
    vehicles: [
      { id: "car-1", make: "Honda", model: "Civic", model_year: 2024, status: "available", assigned_branch_id: "branch-1", payload: { category: "Economy" } },
      { id: "car-2", make: "Toyota", model: "Corolla", model_year: 2024, status: "available", assigned_branch_id: "branch-1", payload: { category: "Economy" } }
    ],
    bookings: [
      {
        id: "booking-1",
        reservation_number: "=CMD",
        customer_id: "customer-1",
        vehicle_id: "car-1",
        pickup_at: "2026-08-05T10:00:00.000Z",
        return_at: "2026-08-10T10:00:00.000Z",
        pickup_branch_id: "branch-1",
        return_branch_id: "branch-1",
        status: "completed",
        total_amount: 600,
        paid_amount: 500,
        payload: { sourceChannel: "online", pricing: { tax: 50, mandatoryFees: 20, locationSurcharge: 10 } }
      },
      {
        id: "booking-2",
        reservation_number: "GF-2",
        customer_id: "customer-2",
        vehicle_id: "car-2",
        pickup_at: "2026-08-15T10:00:00.000Z",
        return_at: "2026-08-17T10:00:00.000Z",
        pickup_branch_id: "branch-1",
        return_branch_id: "branch-1",
        status: "cancelled",
        total_amount: 300,
        paid_amount: 0,
        payload: { sourceChannel: "walk-in" }
      }
    ],
    payments: [
      { operation_type: "manual_payment", status: "succeeded", amount: 500, created_at: "2026-08-05T11:00:00.000Z", pickup_branch_id: "branch-1", return_branch_id: "branch-1", vehicle_id: "car-1" },
      { operation_type: "refund", status: "succeeded", amount: 50, created_at: "2026-08-20T11:00:00.000Z", pickup_branch_id: "branch-1", return_branch_id: "branch-1", vehicle_id: "car-1" },
      { operation_type: "authorization", status: "authorized", amount: 200, created_at: "2026-08-05T11:00:00.000Z", pickup_branch_id: "branch-1", return_branch_id: "branch-1", vehicle_id: "car-1" }
    ],
    state: {
      expenses: [
        { id: "expense-1", date: "2026-08-06", category: "insurance", amount: 100, vehicleId: "car-1" },
        { id: "expense-2", date: "2026-08-07", category: "maintenance", amount: 75, vehicleId: "car-1" }
      ],
      maintenance: [
        { id: "maint-duplicate", date: "2026-08-07", status: "completed", actualCost: 75, carId: "car-1" },
        { id: "maint-2", date: "2026-08-08", status: "completed", actualCost: 40, carId: "car-1" }
      ]
    }
  });

  assert.equal(report.summary.bookedRevenue, 600);
  assert.equal(report.summary.cashIn, 500);
  assert.equal(report.summary.refunds, 50);
  assert.equal(report.summary.collectedRevenue, 450);
  assert.equal(report.summary.outstandingBalance, 100);
  assert.equal(report.summary.quotedTaxes, 50);
  assert.equal(report.summary.quotedFees, 30);
  assert.equal(report.summary.recordedExpenses, 215);
  assert.equal(report.summary.cashLessRecordedCosts, 235);
  assert.equal(report.summary.reservations, 2);
  assert.equal(report.summary.cancellations, 1);
  assert.equal(report.summary.rentalDays, 5);
  assert.equal(report.summary.capacityDays, 62);
  assert.equal(report.summary.utilization, 8.1);
  assert.equal(report.summary.adr, 120);
  assert.equal(report.summary.revpar, 9.68);
  assert.equal(report.bookingSources[0].name, "Direct");
  assert.equal(report.topVehicles[0].id, "car-1");

  const csv = reporting.performanceCsv(report);
  assert.match(csv, /"'=CMD"/);
  assert.match(csv, /"Cash less recorded costs","235"/);
});

test("performance reporting honors branch and category filters", () => {
  const report = reporting.buildPerformanceReport({
    from: "2026-08-01T00:00:00.000Z",
    toExclusive: "2026-08-08T00:00:00.000Z",
    branchId: "branch-2",
    category: "SUV",
    vehicles: [
      { id: "car-1", status: "available", assigned_branch_id: "branch-1", payload: { category: "Economy" } },
      { id: "car-2", status: "available", assigned_branch_id: "branch-2", payload: { category: "SUV" } }
    ],
    bookings: [
      { id: "booking-1", vehicle_id: "car-1", pickup_at: "2026-08-02", return_at: "2026-08-04", pickup_branch_id: "branch-1", return_branch_id: "branch-1", status: "completed", total_amount: 100 },
      { id: "booking-2", vehicle_id: "car-2", pickup_at: "2026-08-02", return_at: "2026-08-04", pickup_branch_id: "branch-2", return_branch_id: "branch-2", status: "completed", total_amount: 300 }
    ]
  });

  assert.equal(report.summary.activeVehicles, 1);
  assert.equal(report.summary.reservations, 1);
  assert.equal(report.summary.bookedRevenue, 300);
  assert.equal(report.categories[0].category, "suv");
});

test("GoodFleet exposes authenticated server reports and guarded CSV export", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/fleet.routes.js"), "utf8");
  assert.match(routes, /router\.get\("\/reports\/performance"/);
  assert.match(routes, /router\.get\("\/reports\/performance\.csv"/);
  assert.match(routes, /restrictExportsToOwners/);
  assert.match(routes, /REPORT_EXPORT_ACCESS_REQUIRED/);
  assert.match(routes, /fleetReporting\.performanceCsv/);
  assert.match(routes, /Cache-Control", "private, no-store/);
});
