"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const database = require("../src/security/phase2-db");
const security = require("../src/middleware/phase2-security");

function responseDouble() {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.status = code => {
    response.statusCode = code;
    return response;
  };
  response.json = body => {
    response.body = body;
    return response;
  };
  return response;
}

test("a stale owner lock is cleared before mobile or desktop password verification", async t => {
  const originalQuery = database.query;
  t.after(() => {
    database.query = originalQuery;
  });

  const queries = [];
  database.query = async (sql, parameters) => {
    queries.push({ sql, parameters });
    if (/SELECT\s+id,/i.test(sql)) {
      return {
        rows: [{
          id: "owner-user-id",
          platform_role: "owner",
          failed_login_count: 5,
          locked_until: new Date(Date.now() + 15 * 60 * 1000),
        }],
      };
    }
    return { rows: [] };
  };

  const request = {
    body: { email: "owner@goodos.app" },
    originalUrl: "/api/auth/login",
  };
  const response = responseDouble();
  let nextCalls = 0;

  await security.loginGuard(request, response, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, undefined);
  assert.ok(
    queries.some(({ sql }) => (
      /failed_login_count = 0/i.test(sql) &&
      /locked_until = NULL/i.test(sql)
    )),
    "the owner lock state must be cleared before authentication continues"
  );

  const beforeFailure = queries.length;
  response.statusCode = 401;
  response.emit("finish");
  assert.equal(
    queries.length,
    beforeFailure,
    "a failed owner password must not recreate the persistent account lock"
  );
});

test("ordinary accounts retain persistent lockout protection", async t => {
  const originalQuery = database.query;
  t.after(() => {
    database.query = originalQuery;
  });

  database.query = async sql => {
    if (/SELECT\s+id,/i.test(sql)) {
      return {
        rows: [{
          id: "member-user-id",
          platform_role: "member",
          failed_login_count: 5,
          locked_until: new Date(Date.now() + 15 * 60 * 1000),
        }],
      };
    }
    return { rows: [] };
  };

  const response = responseDouble();
  let nextCalls = 0;
  await security.loginGuard(
    {
      body: { email: "member@example.com" },
      originalUrl: "/api/auth/login",
    },
    response,
    () => {
      nextCalls += 1;
    }
  );

  assert.equal(nextCalls, 0);
  assert.equal(response.statusCode, 423);
  assert.equal(response.body.code, "ACCOUNT_TEMPORARILY_LOCKED");
});
