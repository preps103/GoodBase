"use strict";

const crypto = require("node:crypto");
const { query } = require("../config/database");
const {
  getUserById,
  issueSessionForUser,
} = require("./auth.service");

const RP_ID = String(process.env.GOODOS_PASSKEY_RP_ID || "goodos.app").trim().toLowerCase();
const RP_NAME = "GoodOS";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const EXPECTED_ORIGINS = String(
  process.env.GOODOS_PASSKEY_ORIGINS || "https://goodos.app"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

let webAuthnModule;

async function webAuthn() {
  if (!webAuthnModule) webAuthnModule = import("@simplewebauthn/server");
  return webAuthnModule;
}

async function credentialsForUser(userId) {
  const result = await query(
    `SELECT * FROM goodbase_passkey_credentials WHERE user_id = $1::uuid ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function createChallenge({ userId = null, purpose, challenge }) {
  await query(
    `DELETE FROM goodbase_passkey_challenges WHERE expires_at < NOW() OR consumed_at < NOW() - INTERVAL '1 hour'`
  );
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO goodbase_passkey_challenges (id, user_id, purpose, challenge, expires_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, NOW() + ($5::bigint * INTERVAL '1 millisecond'))`,
    [id, userId, purpose, challenge, CHALLENGE_TTL_MS]
  );
  return id;
}

async function consumeChallenge({ id, purpose, userId = null }) {
  const result = await query(
    `UPDATE goodbase_passkey_challenges
     SET consumed_at = NOW()
     WHERE id = $1::uuid
       AND purpose = $2
       AND consumed_at IS NULL
       AND expires_at > NOW()
       AND ($3::uuid IS NULL OR user_id = $3::uuid)
     RETURNING *`,
    [id, purpose, userId]
  );
  if (!result.rows[0]) {
    const error = new Error("Passkey request expired. Please try again.");
    error.statusCode = 400;
    throw error;
  }
  return result.rows[0];
}

function publicCredential(row) {
  return {
    id: row.id,
    label: row.label,
    deviceType: row.device_type,
    backedUp: Boolean(row.backed_up),
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

async function listPasskeys(userId) {
  return (await credentialsForUser(userId)).map(publicCredential);
}

async function registrationOptions(user) {
  const { generateRegistrationOptions } = await webAuthn();
  const existing = await credentialsForUser(user.id);
  const options = await generateRegistrationOptions({
    rpID: RP_ID,
    rpName: RP_NAME,
    userID: Buffer.from(user.id, "utf8"),
    userName: user.email,
    userDisplayName: user.displayName || user.email,
    attestationType: "none",
    supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: existing.map((credential) => ({
      id: credential.credential_id,
      transports: credential.transports_json || [],
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  const challengeId = await createChallenge({
    userId: user.id,
    purpose: "registration",
    challenge: options.challenge,
  });
  return { challengeId, options };
}

async function verifyRegistration({ user, challengeId, response, label }) {
  const challenge = await consumeChallenge({
    id: challengeId,
    purpose: "registration",
    userId: user.id,
  });
  const { verifyRegistrationResponse } = await webAuthn();
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: EXPECTED_ORIGINS,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    const error = new Error("Passkey could not be verified.");
    error.statusCode = 400;
    throw error;
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const transports = response?.response?.transports || credential.transports || [];
  const result = await query(
    `INSERT INTO goodbase_passkey_credentials (
       user_id, credential_id, public_key, counter, transports_json, device_type, backed_up, label
     ) VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8)
     ON CONFLICT (credential_id) DO UPDATE SET
       public_key = EXCLUDED.public_key,
       counter = EXCLUDED.counter,
       transports_json = EXCLUDED.transports_json,
       device_type = EXCLUDED.device_type,
       backed_up = EXCLUDED.backed_up,
       label = EXCLUDED.label,
       updated_at = NOW()
     RETURNING *`,
    [
      user.id,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(transports),
      credentialDeviceType,
      credentialBackedUp,
      String(label || "Touch ID / fingerprint").trim().slice(0, 80),
    ]
  );
  return publicCredential(result.rows[0]);
}

async function authenticationOptions() {
  const { generateAuthenticationOptions } = await webAuthn();
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: [],
    userVerification: "required",
  });
  const challengeId = await createChallenge({
    purpose: "authentication",
    challenge: options.challenge,
  });
  return { challengeId, options };
}

async function verifyAuthentication({ challengeId, response, ipAddress, userAgent }) {
  const challenge = await consumeChallenge({
    id: challengeId,
    purpose: "authentication",
  });
  const credentialResult = await query(
    `SELECT * FROM goodbase_passkey_credentials WHERE credential_id = $1 LIMIT 1`,
    [response?.id || ""]
  );
  const stored = credentialResult.rows[0];
  if (!stored) {
    const error = new Error("Passkey was not recognized.");
    error.statusCode = 401;
    throw error;
  }
  const { verifyAuthenticationResponse } = await webAuthn();
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: EXPECTED_ORIGINS,
    expectedRPID: RP_ID,
    requireUserVerification: true,
    credential: {
      id: stored.credential_id,
      publicKey: new Uint8Array(stored.public_key),
      counter: Number(stored.counter),
      transports: stored.transports_json || [],
    },
  });
  if (!verification.verified) {
    const error = new Error("Passkey could not be verified.");
    error.statusCode = 401;
    throw error;
  }
  await query(
    `UPDATE goodbase_passkey_credentials
     SET counter = $2, last_used_at = NOW(), updated_at = NOW()
     WHERE id = $1::uuid`,
    [stored.id, verification.authenticationInfo.newCounter]
  );
  const user = await getUserById(stored.user_id);
  return issueSessionForUser({
    user,
    ipAddress,
    userAgent,
    authMethod: "passkey",
    mfaVerified: true,
  });
}

module.exports = {
  authenticationOptions,
  listPasskeys,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
};
