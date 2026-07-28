"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const database = require("../src/config/database");
const chat = require("../src/services/goodcustom-chat.service");

test("GoodCustom chat preserves intentional line breaks and bounds messages", () => {
  assert.equal(
    chat.cleanMessage("  First line  \r\nSecond line  "),
    "First line\nSecond line",
  );
  assert.equal(chat.cleanMessage("x".repeat(5000)).length, 4000);
  assert.equal(chat.cleanMessage("\u0000  "), "");
});

test("GoodCustom chat only bootstraps platform leadership automatically", () => {
  assert.equal(chat.isPlatformManager({ platformRole: "owner" }), true);
  assert.equal(chat.isPlatformManager({ platformRole: "ADMIN" }), true);
  assert.equal(chat.isPlatformManager({ platformRole: "member" }), false);
  assert.equal(chat.isPlatformManager({}), false);
});

test("GoodCustom customers are not treated as staff members", async () => {
  const originalQuery = database.query;
  database.query = async () => ({ rows: [] });
  try {
    await assert.rejects(
      () => chat.requireStaff({
        id: "89e0e5e1-ee43-4c9a-a41b-6b07bb920430",
        email: "customer@example.com",
        platformRole: "member",
      }),
      (error) => (
        error.statusCode === 403
        && error.code === "GOODCUSTOM_CHAT_STAFF_REQUIRED"
      ),
    );
  } finally {
    database.query = originalQuery;
  }
});

test("GoodCustom chat migration enforces membership, room, and message integrity", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "../migrations/20260728_goodcustom_internal_chat.sql"),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodcustom_staff/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodcustom_chat_room_members/);
  assert.match(migration, /CHECK \(char_length\(body\) BETWEEN 1 AND 4000\)/);
  assert.match(migration, /ON DELETE CASCADE/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON goodcustom_chat_messages/);
});
