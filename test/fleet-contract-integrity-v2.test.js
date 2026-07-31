"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  sha256,
  contractEventHash,
  completedContractRecordHash,
  verifyContractEventChain,
} = require("../src/services/fleet-contract-integrity.service");

test("contract event hashing is deterministic when event-data key order changes", () => {
  const base = {
    envelopeId: "envelope-1",
    recipientId: "recipient-1",
    actorUserId: "user-1",
    eventType: "recipient.signed",
    sequence: 1,
    previousHash: null,
    createdAt: "2026-07-31T12:00:00.000Z",
  };
  const left = contractEventHash({ ...base, data: { signatureHash: "a", documentHash: "b" } });
  const right = contractEventHash({ ...base, data: { documentHash: "b", signatureHash: "a" } });
  assert.equal(left, right);
});

test("contract completion records bind the document, ordered signatures, and completion time", () => {
  const hash = completedContractRecordHash("document", ["signature-1", "signature-2"], "2026-07-31T12:00:00.000Z");
  assert.equal(hash, sha256("document|signature-1|signature-2|2026-07-31T12:00:00.000Z"));
  assert.notEqual(hash, completedContractRecordHash("document", ["signature-2", "signature-1"], "2026-07-31T12:00:00.000Z"));
});

test("contract audit verification detects broken links and altered event evidence", () => {
  const first = {
    id: "event-1",
    envelopeId: "envelope-1",
    recipientId: null,
    actorUserId: "user-1",
    sequence: 1,
    type: "envelope.created",
    data: { bookingId: "booking-1" },
    previousHash: null,
    createdAt: "2026-07-31T12:00:00.000Z",
  };
  first.hash = contractEventHash({ ...first, eventType: first.type });
  const second = {
    id: "event-2",
    envelopeId: "envelope-1",
    recipientId: "recipient-1",
    actorUserId: "user-1",
    sequence: 2,
    type: "recipient.viewed",
    data: { accessMethod: "secure_signing_link" },
    previousHash: first.hash,
    createdAt: "2026-07-31T12:01:00.000Z",
  };
  second.hash = contractEventHash({ ...second, eventType: second.type });
  assert.deepEqual(verifyContractEventChain([first, second]), {
    valid: true,
    failures: [],
    head: second.hash,
  });

  const changed = { ...second, data: { accessMethod: "altered" } };
  const result = verifyContractEventChain([first, changed]);
  assert.equal(result.valid, false);
  assert.match(result.failures.join(" "), /integrity check/);
});

test("contract integrity migration freezes published terms, snapshots, and signed evidence", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "..", "migrations", "20260731_goodfleet_contract_integrity_v2.sql"),
    "utf8"
  );
  assert.match(migration, /published fleet contract template versions are immutable/);
  assert.match(migration, /fleet contract envelope snapshots are immutable/);
  assert.match(migration, /signed fleet contract evidence is immutable/);
  assert.match(migration, /completed fleet contracts require a completion record/);
});

test("contract routes restrict governance actions and reject duplicate or closed-booking agreements", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "fleet-contracts.routes.js"), "utf8");
  assert.match(routes, /router\.post\("\/templates", requireContractManager/);
  assert.match(routes, /router\.post\("\/:envelopeId\/void", requireContractManager/);
  assert.match(routes, /CONTRACT_BOOKING_CLOSED/);
  assert.match(routes, /CONTRACT_ALREADY_EXISTS/);
  assert.match(routes, /documentHashValid/);
  assert.match(routes, /completedRecordHashValid/);
  assert.match(routes, /auditChainValid/);
  assert.match(routes, /expireDueContracts\(client, request, row\.organization_id, row\.id\)/);
  assert.match(routes, /CONTRACT_EXPIRED/);
});
