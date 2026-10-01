"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const programs = require("../src/services/fleet-customer-programs.service");
const pricing = require("../src/services/fleet-pricing.service");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("customer programs store tenant-scoped corporate, rate, membership, and loyalty ledgers", () => {
  const migration = read("migrations/20261001_goodfleet_customer_programs_v1.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_corporate_accounts/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_corporate_memberships/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_negotiated_rates/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_loyalty_accounts/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fleet_loyalty_events/);
  assert.match(migration, /fleet_corporate_memberships_active_customer_idx/);
  assert.match(migration, /UNIQUE \(organization_id, idempotency_key\)/);
  assert.match(migration, /CHECK \(points_balance >= 0\)/);
});

test("corporate and loyalty discounts choose the strongest eligible benefit without stacking", () => {
  assert.deepEqual(programs.programDiscount({
    adjustedBase: 1000,
    promotionalDiscount: 100,
    program: {
      corporateRate: { name: "Acme contracted rate", discountPercent: 15 },
      loyalty: { status: "active", tier: "gold", discountPercent: 5 },
    },
  }), {
    amount: 150,
    source: "corporate",
    label: "Acme contracted rate",
    percent: 15,
  });
  assert.equal(programs.loyaltyTier(1499), "member");
  assert.equal(programs.loyaltyTier(1500), "silver");
  assert.equal(programs.loyaltyTier(5000), "gold");
  assert.equal(programs.loyaltyTier(10000), "platinum");
  assert.equal(programs.loyaltyTierDiscount("member"), 0);
  assert.equal(programs.loyaltyTierDiscount("silver"), 3);
  assert.equal(programs.loyaltyTierDiscount("gold"), 5);
  assert.equal(programs.loyaltyTierDiscount("platinum"), 8);
  assert.equal(programs.rentalPoints(640.95), 640);
});

test("server pricing records the applied customer program in the immutable price snapshot", () => {
  const result = pricing.calculateBookingPrice({
    vehicle: { id: "vehicle-1", daily_rate: 100, payload: { category: "SUV" } },
    pickupAt: "2026-11-01T10:00:00.000Z",
    returnAt: "2026-11-03T10:00:00.000Z",
    input: {
      pickupLocationId: "branch-a",
      returnLocationId: "branch-a",
      customerProgram: {
        corporateAccountId: "account-1",
        corporateAccountName: "Acme",
        corporateRate: { id: "rate-1", name: "Acme SUV", discountPercent: 20 },
        loyalty: { id: "loyalty-1", status: "active", tier: "silver", discountPercent: 3 },
      },
    },
    state: { billingSettings: { currency: "USD", taxRate: 0 } },
  });
  assert.equal(result.base, 200);
  assert.equal(result.discount, 40);
  assert.equal(result.discountSource, "corporate");
  assert.equal(result.total, 160);
  assert.deepEqual(result.customerProgram, {
    corporateAccountId: "account-1",
    corporateAccountName: "Acme",
    corporateRateId: "rate-1",
    loyaltyAccountId: "loyalty-1",
    loyaltyTier: "silver",
  });
});

test("customer programs API is management-only, audited, and migration-gated", () => {
  const routes = read("src/routes/fleet-customer-programs.routes.js");
  const fleetRoutes = read("src/routes/fleet.routes.js");
  const marketplaceRoutes = read("src/routes/fleet-marketplace.routes.js");
  const packageJson = JSON.parse(read("package.json"));
  assert.match(routes, /router\.use\(authRequired, tenantContext, requireManagement\)/);
  assert.match(routes, /router\.get\("\/corporate-accounts"/);
  assert.match(routes, /router\.post\("\/corporate-accounts"/);
  assert.match(routes, /router\.post\("\/corporate-accounts\/:accountId\/members"/);
  assert.match(routes, /router\.post\("\/corporate-accounts\/:accountId\/rates"/);
  assert.match(routes, /router\.get\("\/loyalty-accounts"/);
  assert.match(routes, /router\.post\("\/loyalty-accounts\/:accountId\/adjustments"/);
  assert.match(routes, /corporate_account\.created/);
  assert.match(routes, /loyalty\.points_adjusted/);
  assert.match(fleetRoutes, /completed-rental:\$\{booking\.id\}/);
  assert.match(marketplaceRoutes, /loadCustomerProgram/);
  assert.match(marketplaceRoutes, /customerProgram: customerProgram/);
  assert.match(marketplaceRoutes, /customer\.rows\[0\]\?\.id \|\| null/);
  assert.match(packageJson.scripts.build, /apply-goodfleet-customer-programs-migration\.js/);
});
