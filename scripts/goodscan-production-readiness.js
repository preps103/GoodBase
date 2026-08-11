"use strict";

const { Pool } = require("pg");

const requiredTables = [
  "goodscan_assets",
  "goodscan_credit_products",
  "goodscan_credit_accounts",
  "goodscan_credit_ledger",
  "goodscan_credit_checkout_sessions",
  "goodscan_credit_webhook_events",
  "goodscan_generation_jobs",
];

function configured(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

async function main() {
  const checks = {
    databaseUrl: Boolean(process.env.DATABASE_URL),
    stripeSecret: configured(process.env.STRIPE_SECRET_KEY, /^sk_(test|live)_/),
    stripeWebhookSecret: configured(
      process.env.GOODSCAN_STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET,
      /^whsec_/,
    ),
    tables: {},
    activeCreditProducts: 0,
  };

  if (!checks.databaseUrl) {
    console.log(JSON.stringify({ ready: false, checks }, null, 2));
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: "goodscan-readiness" });
  try {
    for (const table of requiredTables) {
      const result = await pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${table}`]);
      checks.tables[table] = result.rows[0]?.present === true;
    }
    if (checks.tables.goodscan_credit_products) {
      const products = await pool.query("SELECT COUNT(*)::int AS count FROM goodscan_credit_products WHERE active=TRUE");
      checks.activeCreditProducts = Number(products.rows[0]?.count || 0);
    }
  } finally {
    await pool.end();
  }

  const ready = checks.databaseUrl && checks.stripeSecret && checks.stripeWebhookSecret &&
    Object.values(checks.tables).every(Boolean) && checks.activeCreditProducts > 0;
  console.log(JSON.stringify({ ready, checks }, null, 2));
  if (!ready) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ready: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
