"use strict";

const crypto = require("crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function orderedLegacyData(eventType, data) {
  const orders = {
    "envelope.created": ["bookingId", "templateId", "templateVersion", "documentHash"],
    "envelope.sent": ["recipientEmail", "tokenExpiresAt", "deliveryChannels", "smsStatus"],
    "envelope.reminded": ["recipientEmail", "tokenExpiresAt", "deliveryChannels", "smsStatus"],
    "recipient.viewed": ["accessMethod"],
    "recipient.signed": ["signatureType", "signatureHash", "documentHash", "consentDisclosureHash", "accessMethod"],
    "recipient.declined": ["reason"],
    "envelope.completed": ["documentHash", "completedRecordHash", "managementNotificationCount"],
    "envelope.voided": ["reason"],
  };
  const order = orders[eventType];
  if (!order) return data;
  return order.reduce((result, key) => {
    if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = data[key];
    return result;
  }, {});
}

function contractEventHash({
  envelopeId,
  recipientId = null,
  actorUserId = null,
  eventType,
  data = {},
  sequence,
  previousHash = null,
  createdAt,
}) {
  return sha256(JSON.stringify(canonicalize({
    envelopeId,
    recipientId,
    actorUserId,
    eventType,
    data,
    sequence,
    previousHash,
    createdAt,
  })));
}

function legacyContractEventHash(input) {
  return sha256(JSON.stringify({
    envelopeId: input.envelopeId,
    recipientId: input.recipientId || null,
    actorUserId: input.actorUserId || null,
    eventType: input.eventType,
    data: orderedLegacyData(input.eventType, input.data || {}),
    sequence: Number(input.sequence),
    previousHash: input.previousHash || null,
    createdAt: new Date(input.createdAt).toISOString(),
  }));
}

function completedContractRecordHash(documentHash, signatureHashes, completedAt) {
  return sha256(`${documentHash}|${signatureHashes.join("|")}|${completedAt}`);
}

function verifyContractEventChain(events) {
  const ordered = [...events].sort((left, right) => Number(left.sequence) - Number(right.sequence));
  const failures = [];
  let previousHash = null;

  ordered.forEach((event, index) => {
    const expectedSequence = index + 1;
    if (Number(event.sequence) !== expectedSequence) {
      failures.push(`Event sequence ${event.sequence} is out of order; expected ${expectedSequence}.`);
    }
    if ((event.previousHash || null) !== previousHash) {
      failures.push(`Event ${event.sequence} does not reference the previous audit hash.`);
    }
    const hashInput = {
      envelopeId: event.envelopeId,
      recipientId: event.recipientId || null,
      actorUserId: event.actorUserId || null,
      eventType: event.type,
      data: event.data || {},
      sequence: Number(event.sequence),
      previousHash: event.previousHash || null,
      createdAt: new Date(event.createdAt).toISOString(),
    };
    const expectedHash = contractEventHash(hashInput);
    const legacyHash = legacyContractEventHash(hashInput);
    if (event.hash !== expectedHash && event.hash !== legacyHash) {
      failures.push(`Event ${event.sequence} failed its SHA-256 integrity check.`);
    }
    previousHash = event.hash;
  });

  return {
    valid: failures.length === 0,
    failures,
    head: ordered.at(-1)?.hash || null,
  };
}

module.exports = {
  sha256,
  contractEventHash,
  completedContractRecordHash,
  verifyContractEventChain,
};
