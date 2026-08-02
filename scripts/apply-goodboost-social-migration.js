"use strict";
const fs = require("fs");
const path = require("path");
const database = require("../src/config/database");

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/20260801_goodboost_social_connectors.sql"), "utf8");
  await database.query(sql);
  console.log("GoodBoost social connector migration applied.");
  await database.pool.end();
})().catch((error) => {
  console.error("GoodBoost social connector migration failed:", error.message);
  process.exit(1);
});

