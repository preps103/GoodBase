"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const pricing = require("../src/services/fleet-pricing.service");

test("server pricing applies branch duration rates, seasonal rules, eligible discounts, fees, and tax", () => {
  const result = pricing.calculateBookingPrice({
    vehicle: { id: "vehicle-1", daily_rate: 100, payload: { category: "SUV" } },
    pickupAt: "2026-11-01T10:00:00.000Z",
    returnAt: "2026-11-11T10:00:00.000Z",
    input: {
      pickupLocationId: "branch-a",
      returnLocationId: "branch-b",
      discountCode: "SAVE10",
      additionalCharges: [{ amount: 10 }]
    },
    state: {
      billingSettings: { currency: "USD", taxRate: 8 },
      branches: [{
        id: "branch-a",
        financialConfig: { taxRate: 10, locationSurcharge: 5, oneWayFee: 50 },
        locationRules: { allowOneWayRentals: true }
      }],
      rates: [
        { id: "global", carClass: "suv", dailyRate: 100, weeklyRate: 600, monthlyRate: 2000, status: "active" },
        { id: "branch", carClass: "suv", dailyRate: 120, weeklyRate: 700, monthlyRate: 2200, branchId: "branch-a", status: "active" }
      ],
      seasonalAdjustments: [{
        id: "season-1",
        name: "Holiday demand",
        startDate: "2026-11-01",
        endDate: "2026-11-30",
        adjustment: "+10%",
        branchId: "branch-a"
      }],
      discounts: [{
        id: "discount-1",
        code: "SAVE10",
        type: "percentage",
        value: 10,
        minDays: 7,
        status: "active",
        branchId: "branch-a"
      }],
      fees: [{
        id: "fee-1",
        name: "Facility fee",
        type: "mandatory",
        calculationType: "per_day",
        value: 2,
        status: "active",
        branchId: "branch-a"
      }]
    }
  });

  assert.equal(result.ratePlanId, "branch");
  assert.equal(result.rateSource, "branch_rate_plan");
  assert.deepEqual(result.duration, { months: 0, weeks: 1, days: 3 });
  assert.equal(result.base, 1060);
  assert.equal(result.seasonalAdjustment, 106);
  assert.equal(result.discount, 116.6);
  assert.equal(result.mandatoryFees, 20);
  assert.equal(result.locationSurcharge, 50);
  assert.equal(result.oneWayFee, 50);
  assert.equal(result.subtotal, 1179.4);
  assert.equal(result.tax, 117.94);
  assert.equal(result.total, 1297.34);
});

test("pricing rejects one-way rentals when the pickup branch disables them", () => {
  assert.throws(() => pricing.calculateBookingPrice({
    vehicle: { daily_rate: 100, payload: { category: "economy" } },
    pickupAt: "2026-11-01T10:00:00.000Z",
    returnAt: "2026-11-02T10:00:00.000Z",
    input: { pickupLocationId: "a", returnLocationId: "b" },
    state: { branches: [{ id: "a", locationRules: { allowOneWayRentals: false } }] }
  }), error => error.code === "ONE_WAY_NOT_ALLOWED");
});

test("demand insights are derived from real vehicle-day capacity and upcoming bookings", () => {
  const result = pricing.buildPricingInsights({
    asOf: new Date("2026-11-01T00:00:00.000Z"),
    horizonDays: 30,
    vehicles: [
      { id: "suv-1", status: "available", daily_rate: 110, payload: { category: "SUV" } },
      { id: "suv-2", status: "available", daily_rate: 110, payload: { category: "SUV" } },
      { id: "eco-1", status: "available", daily_rate: 80, payload: { category: "Economy" } }
    ],
    bookings: [{
      vehicle_id: "suv-1",
      pickup_at: "2026-11-01T00:00:00.000Z",
      return_at: "2026-11-16T00:00:00.000Z",
      status: "confirmed",
      total_amount: 1500
    }],
    state: {
      rates: [
        { carClass: "SUV", dailyRate: 120, status: "active" },
        { carClass: "Economy", dailyRate: 80, status: "active" }
      ]
    }
  });

  const suv = result.insights.find(item => item.category === "suv");
  const economy = result.insights.find(item => item.category === "economy");
  assert.equal(suv.utilization, 25);
  assert.equal(suv.recommendedAdjustment, -5);
  assert.equal(economy.recommendedAdjustment, -10);
  assert.equal(result.metrics.utilization, 16.7);
  assert.equal(result.metrics.averageDailyRate, 100);
  assert.equal(result.metrics.revpar, 16.67);
});

test("GoodFleet exposes authenticated pricing insight and preview endpoints", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/fleet.routes.js"), "utf8");
  assert.match(routes, /router\.get\("\/pricing\/insights"/);
  assert.match(routes, /router\.post\("\/pricing\/preview"/);
  assert.match(routes, /GOODFLEET_TESTING_MODE \|\| "false"/);
});
