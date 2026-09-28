"use strict";

function clean(value, maximum = 1000) {
  return String(value ?? "")
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, maximum);
}

function invalid(message) {
  return Object.assign(new Error(message), {
    statusCode: 400,
    code: "GOODESCROW_ASSISTANT_INVALID_INPUT",
  });
}

const GUIDANCE = [
  {
    terms: ["release", "milestone", "delivery", "deliverable", "approve"],
    text: "Use an objective release milestone: name the deliverable, who verifies it, the evidence required, the review window, and what happens if the buyer does not respond.",
  },
  {
    terms: ["dispute", "refund", "cancel", "chargeback"],
    text: "Keep the funds held while the parties preserve messages and delivery evidence. Follow the transaction's written dispute steps, deadlines, and neutral-review process before any release or refund.",
  },
  {
    terms: ["fraud", "identity", "scam", "suspicious", "verify"],
    text: "Pause the transaction and independently verify both parties through trusted contact details. Do not release funds or accept changed payment instructions until identity and account ownership are confirmed.",
  },
  {
    terms: ["fee", "cost", "payment", "currency", "amount"],
    text: "Record the exact amount, currency, fee payer, payment deadline, and refund treatment before funding. Both parties should confirm the same terms in the transaction record.",
  },
];

function advice(input = {}) {
  const query = clean(input.query, 4000);
  if (!query) throw invalid("A question is required.");
  const normalized = query.toLowerCase();
  const selected = GUIDANCE.find((item) => item.terms.some((term) => normalized.includes(term)));
  const text = selected?.text
    || "Define the transaction parties, amount, deliverables, verification evidence, release conditions, deadlines, fees, and dispute process in clear objective terms before funding.";
  return {
    text: `${text} This is general operational information, not legal advice.`,
    mode: "guided",
    legalAdvice: false,
  };
}

function draftTerms(input = {}) {
  const title = clean(input.title, 200);
  const buyerName = clean(input.buyerName, 120);
  const sellerName = clean(input.sellerName, 120);
  const currency = clean(input.currency, 3).toUpperCase();
  const amount = Number(input.amount);
  if (!title || !buyerName || !sellerName) {
    throw invalid("A title, buyer, and seller are required.");
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    throw invalid("A valid transaction amount is required.");
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw invalid("A three-letter currency code is required.");
  }
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return {
    text: `For ${title}, release ${formatted} ${currency} to ${sellerName} after ${buyerName} confirms the agreed deliverable and required evidence. Keep funds held during any timely documented dispute until the parties complete the stated resolution process.`,
    mode: "guided",
    legalAdvice: false,
  };
}

function health() {
  return {
    service: "GoodEscrow Assistant",
    status: "ok",
    mode: "guided",
    externalProviderRequired: false,
  };
}

module.exports = { advice, clean, draftTerms, health };
