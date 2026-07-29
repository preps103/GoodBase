"use strict";

const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { pool, query } = require("../config/database");
const { encryptValue } = require("../services/secret.service");

const router = express.Router();
const EMPLOYEE_ROLES = new Set(["owner", "admin", "manager", "staff"]);
const TEMPLATE_STATUSES = new Set(["draft", "active", "archived"]);
const SIGNABLE_ENVELOPE_STATUSES = new Set(["sent", "viewed", "partially_signed"]);
const PUBLIC_APP_URL = String(process.env.GOODFLEET_PUBLIC_URL || "https://fleet.goodos.app").replace(/\/$/, "");
const MAX_SIGNATURE_BYTES = 350_000;

const signingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "SIGNING_RATE_LIMITED", message: "Too many signing attempts. Try again shortly." },
});

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function fail(response, status, code, message, details) {
  return response.status(status).json({ success: false, code, message, ...(details ? { details } : {}) });
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function normalizePhone(value) {
  const raw = clean(value, 30);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function organization(request) {
  return request.tenantContext.organizationId;
}

function membershipRole(request) {
  const organizationRole = clean(request.tenantContext?.organization?.membershipRole, 40).toLowerCase();
  if (["owner", "admin", "manager"].includes(organizationRole)) return organizationRole;
  const membership = (request.apps || []).find(app =>
    clean(app?.membershipStatus, 40).toLowerCase() === "active" &&
    (clean(app?.id, 80).toLowerCase() === "goodfleet" ||
      clean(app?.domain, 160).toLowerCase() === "fleet.goodos.app")
  );
  return clean(membership?.role, 40).toLowerCase() || organizationRole;
}

function requireEmployee(request, response, next) {
  if (!EMPLOYEE_ROLES.has(membershipRole(request))) {
    return fail(response, 403, "CONTRACT_ACCESS_REQUIRED", "GoodFleet contract access is required.");
  }
  return next();
}

function employeeScope(request, response, next) {
  return tenantContext(request, response, error => {
    if (error) return next(error);
    return requireEmployee(request, response, next);
  });
}

function templatePayload(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    version: row.version,
    status: row.status,
    content: row.content_text,
    consumerDisclosure: row.consumer_disclosure_text,
    contentHash: row.content_hash,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recipientPayload(row, includeEvidence = false) {
  return {
    id: row.id,
    role: row.recipient_role,
    name: row.full_name,
    email: row.email,
    signingOrder: row.signing_order,
    status: row.status,
    viewedAt: row.viewed_at,
    consentedAt: row.consented_at,
    signedAt: row.signed_at,
    declinedAt: row.declined_at,
    declineReason: row.decline_reason,
    signatureType: row.signature_type,
    signatureText: row.signature_text,
    signatureData: includeEvidence ? row.signature_data : undefined,
    signatureHash: row.signature_hash,
    consentRecord: row.consent_record,
    signedIp: includeEvidence && row.signed_ip ? String(row.signed_ip) : undefined,
    signedUserAgent: includeEvidence ? row.signed_user_agent : undefined,
  };
}

function eventPayload(row, includeNetworkEvidence = true) {
  return {
    id: row.id,
    sequence: row.sequence_number,
    type: row.event_type,
    data: row.event_data || {},
    previousHash: row.previous_event_hash,
    hash: row.event_hash,
    ipAddress: includeNetworkEvidence && row.ip_address ? String(row.ip_address) : undefined,
    userAgent: includeNetworkEvidence ? row.user_agent : undefined,
    createdAt: row.created_at,
  };
}

async function loadEnvelope(client, envelopeId, org = null, includeEvidence = true) {
  const envelopeResult = await client.query(
    `SELECT envelope.*,
            template.name AS template_name,
            booking.reservation_number,booking.customer_id,booking.vehicle_id,
            booking.pickup_at,booking.return_at,booking.pickup_branch_id,booking.return_branch_id,
            booking.total_amount,booking.deposit_amount,
            customer.full_name AS customer_name,customer.email AS customer_email,
            vehicle.make AS vehicle_make,vehicle.model AS vehicle_model,
            vehicle.model_year AS vehicle_year,vehicle.license_plate
       FROM fleet_contract_envelopes envelope
       JOIN fleet_contract_templates template
         ON template.organization_id=envelope.organization_id AND template.id=envelope.template_id
       JOIN fleet_bookings booking
         ON booking.organization_id=envelope.organization_id AND booking.id=envelope.booking_id
       JOIN fleet_customers customer
         ON customer.organization_id=booking.organization_id AND customer.id=booking.customer_id
       LEFT JOIN fleet_vehicles vehicle
         ON vehicle.organization_id=booking.organization_id AND vehicle.id=booking.vehicle_id
      WHERE envelope.id=$1
        AND ($2::text IS NULL OR envelope.organization_id=$2)
      LIMIT 1`,
    [envelopeId, org]
  );
  if (!envelopeResult.rowCount) return null;
  const envelope = envelopeResult.rows[0];
  const [recipients, events] = await Promise.all([
    client.query(
      `SELECT * FROM fleet_contract_recipients
        WHERE organization_id=$1 AND envelope_id=$2
        ORDER BY signing_order,created_at`,
      [envelope.organization_id, envelope.id]
    ),
    client.query(
      `SELECT * FROM fleet_contract_events
        WHERE organization_id=$1 AND envelope_id=$2
        ORDER BY sequence_number`,
      [envelope.organization_id, envelope.id]
    ),
  ]);
  return {
    id: envelope.id,
    organizationId: envelope.organization_id,
    contractNumber: envelope.contract_number,
    bookingId: envelope.booking_id,
    templateId: envelope.template_id,
    templateName: envelope.template_name,
    templateVersion: envelope.template_version,
    status: envelope.status,
    subject: envelope.subject,
    message: envelope.message || "",
    content: envelope.content_snapshot,
    consumerDisclosure: envelope.disclosure_snapshot,
    documentHash: envelope.document_hash,
    completedRecordHash: envelope.completed_record_hash,
    expiresAt: envelope.expires_at,
    sentAt: envelope.sent_at,
    completedAt: envelope.completed_at,
    declinedAt: envelope.declined_at,
    voidedAt: envelope.voided_at,
    voidReason: envelope.void_reason,
    lastRemindedAt: envelope.last_reminded_at,
    createdAt: envelope.created_at,
    updatedAt: envelope.updated_at,
    booking: {
      id: envelope.booking_id,
      reservationNumber: envelope.reservation_number,
      customerId: envelope.customer_id,
      vehicleId: envelope.vehicle_id,
      pickupAt: envelope.pickup_at,
      returnAt: envelope.return_at,
      pickupLocationId: envelope.pickup_branch_id,
      returnLocationId: envelope.return_branch_id,
      totalAmount: Number(envelope.total_amount),
      depositAmount: Number(envelope.deposit_amount),
    },
    customer: {
      name: envelope.customer_name,
      email: envelope.customer_email,
    },
    vehicle: envelope.vehicle_make ? {
      make: envelope.vehicle_make,
      model: envelope.vehicle_model,
      year: envelope.vehicle_year,
      licensePlate: envelope.license_plate,
    } : null,
    recipients: recipients.rows.map(row => recipientPayload(row, includeEvidence)),
    events: events.rows.map(row => eventPayload(row, includeEvidence)),
  };
}

async function recordEvent(client, {
  request,
  organizationId,
  envelopeId,
  recipientId = null,
  actorUserId = null,
  eventType,
  data = {},
}) {
  const previous = await client.query(
    `SELECT sequence_number,event_hash
       FROM fleet_contract_events
      WHERE organization_id=$1 AND envelope_id=$2
      ORDER BY sequence_number DESC
      LIMIT 1`,
    [organizationId, envelopeId]
  );
  const sequence = Number(previous.rows[0]?.sequence_number || 0) + 1;
  const previousHash = previous.rows[0]?.event_hash || null;
  const createdAt = new Date().toISOString();
  const eventData = {
    envelopeId,
    recipientId,
    actorUserId,
    eventType,
    data,
    sequence,
    previousHash,
    createdAt,
  };
  const eventHash = sha256(JSON.stringify(eventData));
  await client.query(
    `INSERT INTO fleet_contract_events (
       organization_id,envelope_id,recipient_id,actor_user_id,sequence_number,
       event_type,event_data,previous_event_hash,event_hash,ip_address,user_agent,created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
    [
      organizationId,
      envelopeId,
      recipientId,
      actorUserId,
      sequence,
      eventType,
      JSON.stringify(data),
      previousHash,
      eventHash,
      request.ip || null,
      clean(request.get("user-agent"), 1000) || null,
      createdAt,
    ]
  );
  return { sequence, eventHash, createdAt };
}

function renderTemplate(content, values) {
  return content.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => String(values[key] ?? "Not assigned"));
}

async function publicEnvelopeForToken(client, rawToken, { lock = false } = {}) {
  const tokenHash = sha256(rawToken);
  const result = await client.query(
    `SELECT envelope.*,
            envelope.status AS envelope_status,
            recipient.id AS recipient_id,recipient.envelope_id,
            recipient.recipient_user_id,recipient.recipient_role,recipient.full_name,
            recipient.email,recipient.signing_order,recipient.status AS recipient_status,
            recipient.access_token_hash,recipient.access_token_expires_at,
            recipient.viewed_at,recipient.consented_at,recipient.signed_at,
            recipient.declined_at,recipient.decline_reason,recipient.signature_type,
            recipient.signature_text,recipient.signature_data,recipient.signature_hash,
            recipient.consent_record,recipient.signed_ip,recipient.signed_user_agent
       FROM fleet_contract_recipients recipient
       JOIN fleet_contract_envelopes envelope
         ON envelope.organization_id=recipient.organization_id
        AND envelope.id=recipient.envelope_id
      WHERE recipient.access_token_hash=$1
      ${lock ? "FOR UPDATE OF recipient,envelope" : ""}
      LIMIT 1`,
    [tokenHash]
  );
  if (!result.rowCount) return null;
  const row = {
    ...result.rows[0],
    id: result.rows[0].recipient_id,
    status: result.rows[0].recipient_status,
  };
  if (row.access_token_expires_at && new Date(row.access_token_expires_at) <= new Date()) return null;
  if (row.expires_at && new Date(row.expires_at) <= new Date() && row.status !== "signed") return null;
  return row;
}

function signingPayload(row) {
  return {
    envelopeId: row.envelope_id,
    contractNumber: row.contract_number,
    status: row.envelope_status,
    subject: row.subject,
    message: row.message || "",
    content: row.content_snapshot,
    consumerDisclosure: row.disclosure_snapshot,
    documentHash: row.document_hash,
    completedRecordHash: row.completed_record_hash,
    sentAt: row.sent_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
    recipient: recipientPayload(row),
  };
}

function validateSignatureInput(body, expectedName) {
  if (body?.consent !== true) {
    const error = new Error("Electronic records and signature consent is required.");
    error.statusCode = 400;
    error.code = "ELECTRONIC_CONSENT_REQUIRED";
    throw error;
  }
  const signerName = clean(body?.signerName, 200);
  if (!signerName || signerName.toLowerCase() !== clean(expectedName, 200).toLowerCase()) {
    const error = new Error("Enter the recipient name exactly as shown to confirm signer identity.");
    error.statusCode = 400;
    error.code = "SIGNER_NAME_MISMATCH";
    throw error;
  }
  const signatureType = clean(body?.signatureType, 20).toLowerCase();
  if (!["typed", "drawn"].includes(signatureType)) {
    const error = new Error("Choose a typed or drawn signature.");
    error.statusCode = 400;
    error.code = "INVALID_SIGNATURE_TYPE";
    throw error;
  }
  const signatureText = signatureType === "typed" ? clean(body?.signatureText, 200) : null;
  const signatureData = signatureType === "drawn" ? clean(body?.signatureData, MAX_SIGNATURE_BYTES) : null;
  if (signatureType === "typed" && !signatureText) {
    const error = new Error("Type your signature.");
    error.statusCode = 400;
    error.code = "SIGNATURE_REQUIRED";
    throw error;
  }
  if (signatureType === "drawn" &&
      (!signatureData || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signatureData))) {
    const error = new Error("Draw a valid signature.");
    error.statusCode = 400;
    error.code = "SIGNATURE_REQUIRED";
    throw error;
  }
  return { signerName, signatureType, signatureText, signatureData };
}

async function notifyManagementOfCompletion(client, recipient, completedRecordHash) {
  const bookingResult = await client.query(
    `SELECT reservation_number
       FROM fleet_bookings
      WHERE organization_id=$1 AND id=$2
      LIMIT 1`,
    [recipient.organization_id, recipient.booking_id]
  );
  const reservationNumber = bookingResult.rows[0]?.reservation_number || recipient.booking_id;
  const managers = await client.query(
    `SELECT DISTINCT users.id,users.email,users.display_name,
            COALESCE(membership.project_id,'proj_goodos_platform') AS project_id,
            COALESCE(membership.environment_id,'env_goodos_production') AS environment_id
       FROM app_memberships membership
       JOIN users ON users.id=membership.user_id
      WHERE membership.app_id='goodfleet'
        AND membership.status='active'
        AND membership.role IN ('owner','admin','manager')
        AND (membership.organization_id=$1 OR membership.organization_id IS NULL)
        AND users.status='active'`,
    [recipient.organization_id]
  );
  const title = `Rental agreement signed: ${recipient.contract_number}`;
  const message = `${recipient.full_name} completed rental agreement ${recipient.contract_number} for reservation ${reservationNumber}. Review the signed agreement and completion record.`;
  const actionUrl = `/bookings?tab=contracts&contract=${encodeURIComponent(recipient.envelope_id)}`;
  let created = 0;

  for (const manager of managers.rows) {
    const key = sha256(`${recipient.envelope_id}|${manager.id}|completed`).slice(0, 32);
    const notificationId = `ntf_gf_contract_signed_${key}`;
    const messageId = `msg_gf_contract_signed_${key}`;
    const queueId = `ntq_gf_contract_signed_${key}`;
    const payload = {
      appId: "goodfleet",
      envelopeId: recipient.envelope_id,
      contractNumber: recipient.contract_number,
      bookingId: recipient.booking_id,
      reservationNumber,
      signerName: recipient.full_name,
      completedRecordHash,
    };
    const inserted = await client.query(
      `INSERT INTO backend_notifications (
         id,notification_key,category,channel,title,message,severity,status,
         recipient_user_id,recipient_email,source,source_id,action_url,
         payload_json,metadata_json,organization_id,project_id,environment_id
       ) VALUES (
         $1,'fleet.contract.completed','reservation','in_app',$2,$3,'success','unread',
         $4,$5,'goodfleet-contracts',$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        notificationId,
        title,
        message,
        manager.id,
        manager.email,
        recipient.envelope_id,
        actionUrl,
        JSON.stringify(payload),
        JSON.stringify({ appId: "goodfleet", eventType: "fleet.contract.completed" }),
        recipient.organization_id,
        manager.project_id,
        manager.environment_id,
      ]
    );
    if (!inserted.rowCount) continue;

    await client.query(
      `INSERT INTO backend_message_center (
         id,notification_id,user_id,email,title,body,severity,status,action_url,
         metadata_json,organization_id,project_id,environment_id
       ) VALUES ($1,$2,$3,$4,$5,$6,'success','unread',$7,$8::jsonb,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [
        messageId,
        notificationId,
        manager.id,
        manager.email,
        title,
        message,
        actionUrl,
        JSON.stringify({ appId: "goodfleet", source: "goodfleet-contracts" }),
        recipient.organization_id,
        manager.project_id,
        manager.environment_id,
      ]
    );
    await client.query(
      `INSERT INTO backend_notification_queue (
         id,notification_id,queue_type,channel,status,priority,scheduled_at,
         payload_json,metadata_json,organization_id,project_id,environment_id
       ) VALUES ($1,$2,'notification','in_app','completed',20,NOW(),$3::jsonb,$4::jsonb,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [
        queueId,
        notificationId,
        JSON.stringify({ title, message, severity: "success", actionUrl }),
        JSON.stringify({ appId: "goodfleet", messageId }),
        recipient.organization_id,
        manager.project_id,
        manager.environment_id,
      ]
    );
    created += 1;
  }

  return created;
}

async function completeSignature(client, request, recipient, body, actorUserId = null) {
  if (!SIGNABLE_ENVELOPE_STATUSES.has(recipient.envelope_status)) {
    const error = new Error("This agreement is not available for signature.");
    error.statusCode = 409;
    error.code = "CONTRACT_NOT_SIGNABLE";
    throw error;
  }
  if (!["sent", "viewed"].includes(recipient.status)) {
    const error = new Error("This recipient has already completed the agreement.");
    error.statusCode = 409;
    error.code = "RECIPIENT_NOT_SIGNABLE";
    throw error;
  }
  const signature = validateSignatureInput(body, recipient.full_name);
  const signedAt = new Date().toISOString();
  const signatureMaterial = signature.signatureType === "typed"
    ? signature.signatureText
    : signature.signatureData;
  const signatureHash = sha256(
    `${recipient.document_hash}|${recipient.id}|${signature.signerName}|${signature.signatureType}|${signatureMaterial}|${signedAt}`
  );
  const consentRecord = {
    affirmativeConsent: true,
    intentToSign: true,
    disclosureHash: sha256(recipient.disclosure_snapshot),
    documentHash: recipient.document_hash,
    signerName: signature.signerName,
    consentedAt: signedAt,
    accessMethod: actorUserId ? "goodos_authenticated_customer" : "secure_signing_link",
  };
  await client.query(
    `UPDATE fleet_contract_recipients
        SET status='signed',consented_at=$3,signed_at=$3,signature_type=$4,
            signature_text=$5,signature_data=$6,signature_hash=$7,consent_record=$8::jsonb,
            signed_ip=$9,signed_user_agent=$10,access_token_hash=NULL,
            access_token_expires_at=NULL,updated_at=NOW()
      WHERE organization_id=$1 AND id=$2`,
    [
      recipient.organization_id,
      recipient.id,
      signedAt,
      signature.signatureType,
      signature.signatureText,
      signature.signatureData,
      signatureHash,
      JSON.stringify(consentRecord),
      request.ip || null,
      clean(request.get("user-agent"), 1000) || null,
    ]
  );
  await recordEvent(client, {
    request,
    organizationId: recipient.organization_id,
    envelopeId: recipient.envelope_id,
    recipientId: recipient.id,
    actorUserId,
    eventType: "recipient.signed",
    data: {
      signatureType: signature.signatureType,
      signatureHash,
      documentHash: recipient.document_hash,
      consentDisclosureHash: consentRecord.disclosureHash,
      accessMethod: consentRecord.accessMethod,
    },
  });
  const pending = await client.query(
    `SELECT COUNT(*)::integer AS remaining,
            COALESCE(jsonb_agg(signature_hash ORDER BY signing_order)
              FILTER (WHERE signature_hash IS NOT NULL),'[]'::jsonb) AS signature_hashes
       FROM fleet_contract_recipients
      WHERE organization_id=$1 AND envelope_id=$2 AND status<>'signed'`,
    [recipient.organization_id, recipient.envelope_id]
  );
  if (Number(pending.rows[0].remaining) === 0) {
    const completedAt = new Date().toISOString();
    const allSignatures = await client.query(
      `SELECT signature_hash FROM fleet_contract_recipients
        WHERE organization_id=$1 AND envelope_id=$2
        ORDER BY signing_order`,
      [recipient.organization_id, recipient.envelope_id]
    );
    const completedRecordHash = sha256(
      `${recipient.document_hash}|${allSignatures.rows.map(row => row.signature_hash).join("|")}|${completedAt}`
    );
    await client.query(
      `UPDATE fleet_contract_envelopes
          SET status='completed',completed_at=$3,completed_record_hash=$4,
              updated_by=$5,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [recipient.organization_id, recipient.envelope_id, completedAt, completedRecordHash, actorUserId]
    );
    const managementNotificationCount = await notifyManagementOfCompletion(
      client,
      recipient,
      completedRecordHash
    );
    await recordEvent(client, {
      request,
      organizationId: recipient.organization_id,
      envelopeId: recipient.envelope_id,
      actorUserId,
      eventType: "envelope.completed",
      data: {
        documentHash: recipient.document_hash,
        completedRecordHash,
        managementNotificationCount,
      },
    });
  } else {
    await client.query(
      `UPDATE fleet_contract_envelopes
          SET status='partially_signed',updated_by=$3,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [recipient.organization_id, recipient.envelope_id, actorUserId]
    );
  }
}

async function notifyRecipient(
  client,
  request,
  envelope,
  recipient,
  eventType,
  signingUrl,
  signingUrlExpiresAt
) {
  const contactResult = await client.query(
    `SELECT booking.customer_id,customer.phone,users.id AS recipient_user_id
       FROM fleet_bookings booking
       JOIN fleet_customers customer
         ON customer.organization_id=booking.organization_id AND customer.id=booking.customer_id
       LEFT JOIN users ON lower(users.email)=lower($3)
      WHERE booking.organization_id=$1 AND booking.id=$2
      LIMIT 1`,
    [envelope.organization_id, envelope.booking_id, recipient.email]
  );
  const contact = contactResult.rows[0] || {};
  const phone = normalizePhone(contact.phone);
  const smsProvider = phone
    ? await client.query(
      `SELECT id,organization_id,project_id,environment_id
         FROM goodbase_consumer_auth_providers
        WHERE organization_id=$1
          AND provider_type IN ('phone_otp','sms_mfa')
          AND status='enabled'
          AND controller_url IS NOT NULL
          AND secret_ref IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
      [envelope.organization_id]
    )
    : { rows: [] };
  const provider = smsProvider.rows[0] || null;
  const title = eventType === "reminder"
    ? `Signature reminder: ${envelope.contract_number}`
    : `Rental agreement ready: ${envelope.contract_number}`;
  const body = eventType === "reminder"
    ? "Your GoodFleet rental agreement is still waiting for your review and electronic signature."
    : "Review and electronically sign your GoodFleet rental agreement before vehicle pickup.";
  const emailBody = `${body}

Open your secure agreement:
${signingUrl}

This link is personal, expires automatically, and can be used only to complete this agreement. If you did not expect this request, contact GoodFleet support.`;
  const smsBody = `${title}. ${body} Secure link: ${signingUrl} This personal link expires automatically. Do not forward it.`;
  const channels = ["in_app", "email", ...(phone ? ["sms"] : [])];
  const inserted = await client.query(
    `INSERT INTO fleet_customer_notifications (
       organization_id,customer_id,recipient_user_id,recipient_email,recipient_phone,title,body,
       category,channels,status,action_url,client_request_id,created_by
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,'reservation',$8::text[],
             'partially_delivered','/account/contracts',$9,$10)
     RETURNING id`,
    [
      envelope.organization_id,
      contact.customer_id,
      contact.recipient_user_id || null,
      recipient.email,
      phone,
      title,
      body,
      channels,
      `contract:${eventType}:${envelope.id}:${crypto.randomUUID()}`,
      request.user.id,
    ]
  );
  if (inserted.rowCount) {
    await client.query(
      `INSERT INTO fleet_customer_notification_deliveries
        (notification_id,channel,status,attempted_at,delivered_at)
       VALUES
         ($1,'in_app','delivered',NOW(),NOW()),
         ($1,'email','pending',NULL,NULL)`,
      [inserted.rows[0].id]
    );
    if (phone) {
      await client.query(
        `INSERT INTO fleet_customer_notification_deliveries
          (notification_id,channel,status,error_code)
         VALUES ($1,'sms',$2,$3)`,
        [
          inserted.rows[0].id,
          provider ? "pending" : "failed",
          provider ? null : "SMS_PROVIDER_UNAVAILABLE",
        ]
      );
    }
    await client.query(
      `INSERT INTO backend_email_queue
        (id,notification_id,to_email,to_name,subject,body_text,provider,status,organization_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'internal','pending',$7,NOW(),NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        `gfemail_${inserted.rows[0].id}`,
        String(inserted.rows[0].id),
        recipient.email,
        recipient.full_name,
        title,
        emailBody,
        envelope.organization_id,
      ]
    );
    if (phone && provider) {
      await client.query(
        `INSERT INTO goodbase_sms_deliveries (
           organization_id,project_id,environment_id,user_id,destination_hash,
           encrypted_payload,provider_id,purpose,expires_at,fleet_notification_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'contract_signing',$8,$9)`,
        [
          provider.organization_id,
          provider.project_id,
          provider.environment_id,
          contact.recipient_user_id || null,
          sha256(phone),
          encryptValue(JSON.stringify({
            phone,
            message: smsBody,
            signingUrl,
            notificationId: inserted.rows[0].id,
          })),
          provider.id,
          signingUrlExpiresAt,
          inserted.rows[0].id,
        ]
      );
    }
  }
  return {
    channels,
    inApp: "delivered",
    email: "queued",
    sms: !phone ? "phone_missing_or_invalid" : provider ? "queued" : "provider_unavailable",
  };
}

router.get("/sign/:token", signingLimiter, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const recipient = await publicEnvelopeForToken(client, request.params.token);
    if (!recipient) return fail(response, 404, "SIGNING_LINK_INVALID", "This signing link is invalid or expired.");
    response.set("Cache-Control", "no-store");
    response.json({ success: true, data: signingPayload(recipient) });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.post("/sign/:token/view", signingLimiter, async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recipient = await publicEnvelopeForToken(client, request.params.token, { lock: true });
    if (!recipient) {
      await client.query("ROLLBACK");
      return fail(response, 404, "SIGNING_LINK_INVALID", "This signing link is invalid or expired.");
    }
    if (recipient.status === "sent") {
      await client.query(
        `UPDATE fleet_contract_recipients
            SET status='viewed',viewed_at=NOW(),updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [recipient.organization_id, recipient.id]
      );
      await client.query(
        `UPDATE fleet_contract_envelopes
            SET status=CASE WHEN status='sent' THEN 'viewed' ELSE status END,updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [recipient.organization_id, recipient.envelope_id]
      );
      await recordEvent(client, {
        request,
        organizationId: recipient.organization_id,
        envelopeId: recipient.envelope_id,
        recipientId: recipient.id,
        eventType: "recipient.viewed",
        data: { accessMethod: "secure_signing_link" },
      });
    }
    await client.query("COMMIT");
    response.json({ success: true, data: { viewed: true } });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/sign/:token/complete", signingLimiter, async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recipient = await publicEnvelopeForToken(client, request.params.token, { lock: true });
    if (!recipient) {
      await client.query("ROLLBACK");
      return fail(response, 404, "SIGNING_LINK_INVALID", "This signing link is invalid or expired.");
    }
    await completeSignature(client, request, recipient, request.body || {});
    await client.query("COMMIT");
    const completed = await loadEnvelope(client, recipient.envelope_id, recipient.organization_id, false);
    response.set("Cache-Control", "no-store");
    response.json({ success: true, data: completed });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.statusCode) return fail(response, error.statusCode, error.code, error.message);
    next(error);
  } finally {
    client.release();
  }
});

router.post("/sign/:token/decline", signingLimiter, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const reason = clean(request.body?.reason, 1000);
    if (!reason) return fail(response, 400, "DECLINE_REASON_REQUIRED", "Enter a reason for declining.");
    await client.query("BEGIN");
    const recipient = await publicEnvelopeForToken(client, request.params.token, { lock: true });
    if (!recipient) {
      await client.query("ROLLBACK");
      return fail(response, 404, "SIGNING_LINK_INVALID", "This signing link is invalid or expired.");
    }
    if (!["sent", "viewed"].includes(recipient.status)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "CONTRACT_NOT_SIGNABLE", "This agreement can no longer be declined.");
    }
    await client.query(
      `UPDATE fleet_contract_recipients
          SET status='declined',declined_at=NOW(),decline_reason=$3,
              access_token_hash=NULL,access_token_expires_at=NULL,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [recipient.organization_id, recipient.id, reason]
    );
    await client.query(
      `UPDATE fleet_contract_envelopes
          SET status='declined',declined_at=NOW(),updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [recipient.organization_id, recipient.envelope_id]
    );
    await recordEvent(client, {
      request,
      organizationId: recipient.organization_id,
      envelopeId: recipient.envelope_id,
      recipientId: recipient.id,
      eventType: "recipient.declined",
      data: { reason },
    });
    await client.query("COMMIT");
    response.json({ success: true, data: { declined: true } });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.use(authRequired);

router.get("/mine", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const email = clean(request.user?.email, 320).toLowerCase();
    const result = await client.query(
      `SELECT envelope.id
         FROM fleet_contract_envelopes envelope
         JOIN fleet_contract_recipients recipient
           ON recipient.organization_id=envelope.organization_id
          AND recipient.envelope_id=envelope.id
        WHERE lower(recipient.email)=lower($1)
        ORDER BY envelope.updated_at DESC
        LIMIT 100`,
      [email]
    );
    const records = [];
    for (const row of result.rows) {
      const envelope = await loadEnvelope(client, row.id, null, false);
      if (envelope) records.push(envelope);
    }
    response.set("Cache-Control", "no-store");
    response.json({ success: true, data: records });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.post("/mine/:envelopeId/view", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const email = clean(request.user?.email, 320).toLowerCase();
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT envelope.*,
              envelope.status AS envelope_status,
              recipient.id AS recipient_id,recipient.envelope_id,
              recipient.recipient_user_id,recipient.recipient_role,recipient.full_name,
              recipient.email,recipient.signing_order,recipient.status AS recipient_status,
              recipient.access_token_hash,recipient.access_token_expires_at,
              recipient.viewed_at,recipient.consented_at,recipient.signed_at,
              recipient.declined_at,recipient.decline_reason,recipient.signature_type,
              recipient.signature_text,recipient.signature_data,recipient.signature_hash,
              recipient.consent_record,recipient.signed_ip,recipient.signed_user_agent
         FROM fleet_contract_recipients recipient
         JOIN fleet_contract_envelopes envelope
           ON envelope.organization_id=recipient.organization_id
          AND envelope.id=recipient.envelope_id
        WHERE recipient.envelope_id=$1 AND lower(recipient.email)=lower($2)
        FOR UPDATE OF recipient,envelope`,
      [request.params.envelopeId, email]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "CONTRACT_NOT_FOUND", "Agreement not found.");
    }
    const recipient = {
      ...result.rows[0],
      id: result.rows[0].recipient_id,
      status: result.rows[0].recipient_status,
    };
    if (recipient.status === "sent") {
      await client.query(
        `UPDATE fleet_contract_recipients SET status='viewed',viewed_at=NOW(),updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [recipient.organization_id, recipient.id]
      );
      await client.query(
        `UPDATE fleet_contract_envelopes
            SET status=CASE WHEN status='sent' THEN 'viewed' ELSE status END,updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [recipient.organization_id, recipient.envelope_id]
      );
      await recordEvent(client, {
        request,
        organizationId: recipient.organization_id,
        envelopeId: recipient.envelope_id,
        recipientId: recipient.id,
        actorUserId: request.user.id,
        eventType: "recipient.viewed",
        data: { accessMethod: "goodos_authenticated_customer" },
      });
    }
    await client.query("COMMIT");
    response.json({ success: true, data: { viewed: true } });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/mine/:envelopeId/complete", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const email = clean(request.user?.email, 320).toLowerCase();
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT envelope.*,
              envelope.status AS envelope_status,
              recipient.id AS recipient_id,recipient.envelope_id,
              recipient.recipient_user_id,recipient.recipient_role,recipient.full_name,
              recipient.email,recipient.signing_order,recipient.status AS recipient_status,
              recipient.access_token_hash,recipient.access_token_expires_at,
              recipient.viewed_at,recipient.consented_at,recipient.signed_at,
              recipient.declined_at,recipient.decline_reason,recipient.signature_type,
              recipient.signature_text,recipient.signature_data,recipient.signature_hash,
              recipient.consent_record,recipient.signed_ip,recipient.signed_user_agent
         FROM fleet_contract_recipients recipient
         JOIN fleet_contract_envelopes envelope
           ON envelope.organization_id=recipient.organization_id
          AND envelope.id=recipient.envelope_id
        WHERE recipient.envelope_id=$1 AND lower(recipient.email)=lower($2)
        FOR UPDATE OF recipient,envelope`,
      [request.params.envelopeId, email]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "CONTRACT_NOT_FOUND", "Agreement not found.");
    }
    const recipient = {
      ...result.rows[0],
      id: result.rows[0].recipient_id,
      status: result.rows[0].recipient_status,
    };
    await completeSignature(client, request, recipient, request.body || {}, request.user.id);
    await client.query("COMMIT");
    const envelope = await loadEnvelope(client, request.params.envelopeId, recipient.organization_id, false);
    response.set("Cache-Control", "no-store");
    response.json({ success: true, data: envelope });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.statusCode) return fail(response, error.statusCode, error.code, error.message);
    next(error);
  } finally {
    client.release();
  }
});

router.use(employeeScope);

router.get("/templates", async (request, response, next) => {
  try {
    const result = await query(
      `SELECT * FROM fleet_contract_templates
        WHERE organization_id=$1
        ORDER BY status='active' DESC,name,version DESC`,
      [organization(request)]
    );
    response.json({ success: true, data: result.rows.map(templatePayload) });
  } catch (error) {
    next(error);
  }
});

router.post("/templates", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const name = clean(request.body?.name, 160);
    const description = clean(request.body?.description, 1000);
    const content = clean(request.body?.content, 100000);
    const consumerDisclosure = clean(request.body?.consumerDisclosure, 10000);
    const status = clean(request.body?.status || "draft", 20).toLowerCase();
    if (!name || content.length < 50 || consumerDisclosure.length < 50) {
      return fail(response, 400, "TEMPLATE_DETAILS_REQUIRED", "Name, agreement content, and electronic consent disclosure are required.");
    }
    if (!TEMPLATE_STATUSES.has(status)) {
      return fail(response, 400, "INVALID_TEMPLATE_STATUS", "Choose a valid template status.");
    }
    await client.query("BEGIN");
    const versionResult = await client.query(
      `SELECT COALESCE(MAX(version),0)+1 AS version
         FROM fleet_contract_templates
        WHERE organization_id=$1 AND lower(name)=lower($2)`,
      [organization(request), name]
    );
    const result = await client.query(
      `INSERT INTO fleet_contract_templates (
         organization_id,name,description,version,status,content_text,
         consumer_disclosure_text,content_hash,created_by,updated_by,published_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)
       RETURNING *`,
      [
        organization(request),
        name,
        description || null,
        Number(versionResult.rows[0].version),
        status,
        content,
        consumerDisclosure,
        sha256(`${content}|${consumerDisclosure}`),
        request.user.id,
        status === "active" ? new Date().toISOString() : null,
      ]
    );
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: templatePayload(result.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return fail(response, 409, "TEMPLATE_VERSION_EXISTS", "This template version already exists.");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT id FROM fleet_contract_envelopes
        WHERE organization_id=$1
        ORDER BY updated_at DESC
        LIMIT 250`,
      [organization(request)]
    );
    const records = [];
    for (const row of result.rows) {
      const envelope = await loadEnvelope(client, row.id, organization(request), false);
      if (envelope) records.push(envelope);
    }
    response.json({ success: true, data: records });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.post("/", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const bookingId = clean(request.body?.bookingId, 80);
    const templateId = clean(request.body?.templateId, 80);
    const subject = clean(request.body?.subject || "GoodFleet rental agreement", 200);
    const message = clean(request.body?.message, 2000);
    const expiresInDays = Math.min(30, Math.max(1, Number(request.body?.expiresInDays) || 7));
    if (!bookingId || !templateId) {
      return fail(response, 400, "CONTRACT_DETAILS_REQUIRED", "Choose a booking and active template.");
    }
    await client.query("BEGIN");
    const source = await client.query(
      `SELECT booking.*,customer.full_name AS customer_name,customer.email AS customer_email,
              vehicle.make AS vehicle_make,vehicle.model AS vehicle_model,
              vehicle.model_year AS vehicle_year,
              template.name AS template_name,template.version AS template_version,
              template.content_text,template.consumer_disclosure_text
         FROM fleet_bookings booking
         JOIN fleet_customers customer
           ON customer.organization_id=booking.organization_id AND customer.id=booking.customer_id
         LEFT JOIN fleet_vehicles vehicle
           ON vehicle.organization_id=booking.organization_id AND vehicle.id=booking.vehicle_id
         JOIN fleet_contract_templates template
           ON template.organization_id=booking.organization_id AND template.id=$3
          AND template.status='active'
        WHERE booking.organization_id=$1 AND booking.id=$2 AND booking.archived_at IS NULL
        FOR UPDATE OF booking`,
      [organization(request), bookingId, templateId]
    );
    if (!source.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "CONTRACT_SOURCE_NOT_FOUND", "Booking or active template not found.");
    }
    const row = source.rows[0];
    const contractNumber = `GF-AGR-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const values = {
      contract_number: contractNumber,
      reservation_number: row.reservation_number,
      customer_name: row.customer_name,
      customer_email: row.customer_email,
      vehicle_year: row.vehicle_year || "Unassigned",
      vehicle_make: row.vehicle_make || "vehicle",
      vehicle_model: row.vehicle_model || "",
      pickup_at: new Date(row.pickup_at).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" }),
      return_at: new Date(row.return_at).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" }),
      pickup_location: row.pickup_branch_id,
      total_amount: `$${Number(row.total_amount).toFixed(2)}`,
      deposit_amount: `$${Number(row.deposit_amount).toFixed(2)}`,
    };
    const content = renderTemplate(row.content_text, values);
    const disclosure = renderTemplate(row.consumer_disclosure_text, values);
    const documentHash = sha256(`${content}|${disclosure}`);
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
    const envelope = await client.query(
      `INSERT INTO fleet_contract_envelopes (
         organization_id,contract_number,booking_id,template_id,template_version,status,
         subject,message,content_snapshot,disclosure_snapshot,document_hash,expires_at,
         created_by,updated_by
       ) VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$12)
       RETURNING *`,
      [
        organization(request),
        contractNumber,
        bookingId,
        templateId,
        row.template_version,
        subject,
        message || null,
        content,
        disclosure,
        documentHash,
        expiresAt,
        request.user.id,
      ]
    );
    const recipientUser = await client.query(
      `SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1`,
      [row.customer_email]
    );
    await client.query(
      `INSERT INTO fleet_contract_recipients (
         organization_id,envelope_id,recipient_user_id,recipient_role,full_name,email,signing_order
       ) VALUES ($1,$2,$3,'customer',$4,lower($5),1)`,
      [
        organization(request),
        envelope.rows[0].id,
        recipientUser.rows[0]?.id || null,
        row.customer_name,
        row.customer_email,
      ]
    );
    await recordEvent(client, {
      request,
      organizationId: organization(request),
      envelopeId: envelope.rows[0].id,
      actorUserId: request.user.id,
      eventType: "envelope.created",
      data: {
        bookingId,
        templateId,
        templateVersion: row.template_version,
        documentHash,
      },
    });
    await client.query("COMMIT");
    const created = await loadEnvelope(client, envelope.rows[0].id, organization(request), false);
    response.status(201).json({ success: true, data: created });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/:envelopeId", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const envelope = await loadEnvelope(client, request.params.envelopeId, organization(request), true);
    if (!envelope) return fail(response, 404, "CONTRACT_NOT_FOUND", "Agreement not found.");
    response.set("Cache-Control", "no-store");
    response.json({ success: true, data: envelope });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

async function sendOrRemind(request, response, next, eventType) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const envelopeResult = await client.query(
      `SELECT * FROM fleet_contract_envelopes
        WHERE organization_id=$1 AND id=$2
        FOR UPDATE`,
      [organization(request), request.params.envelopeId]
    );
    if (!envelopeResult.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "CONTRACT_NOT_FOUND", "Agreement not found.");
    }
    const envelope = envelopeResult.rows[0];
    const allowed = eventType === "send"
      ? envelope.status === "draft"
      : ["sent", "viewed", "partially_signed"].includes(envelope.status);
    if (!allowed) {
      await client.query("ROLLBACK");
      return fail(response, 409, "CONTRACT_STATUS_INVALID", "This agreement cannot be sent in its current status.");
    }
    if (envelope.expires_at && new Date(envelope.expires_at) <= new Date()) {
      await client.query("ROLLBACK");
      return fail(response, 409, "CONTRACT_EXPIRED", "Create a new agreement because this one has expired.");
    }
    const recipientResult = await client.query(
      `SELECT * FROM fleet_contract_recipients
        WHERE organization_id=$1 AND envelope_id=$2 AND status<>'signed'
        ORDER BY signing_order
        FOR UPDATE`,
      [organization(request), envelope.id]
    );
    if (!recipientResult.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 409, "NO_PENDING_RECIPIENT", "No recipient is waiting for a signature.");
    }
    const rawToken = randomToken();
    const tokenHash = sha256(rawToken);
    const signingUrl = `${PUBLIC_APP_URL}/sign/${rawToken}`;
    const tokenExpiresAt = new Date(Math.min(
      new Date(envelope.expires_at).getTime(),
      Date.now() + 7 * 86_400_000
    )).toISOString();
    const recipient = recipientResult.rows[0];
    await client.query(
      `UPDATE fleet_contract_recipients
          SET status=CASE WHEN status='pending' THEN 'sent' ELSE status END,
              access_token_hash=$3,access_token_expires_at=$4,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [organization(request), recipient.id, tokenHash, tokenExpiresAt]
    );
    await client.query(
      `UPDATE fleet_contract_envelopes
          SET status=CASE WHEN status='draft' THEN 'sent' ELSE status END,
              sent_at=COALESCE(sent_at,NOW()),
              last_reminded_at=CASE WHEN $3='reminder' THEN NOW() ELSE last_reminded_at END,
              updated_by=$4,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [organization(request), envelope.id, eventType, request.user.id]
    );
    const delivery = await notifyRecipient(
      client,
      request,
      envelope,
      recipient,
      eventType,
      signingUrl,
      tokenExpiresAt
    );
    await recordEvent(client, {
      request,
      organizationId: organization(request),
      envelopeId: envelope.id,
      recipientId: recipient.id,
      actorUserId: request.user.id,
      eventType: eventType === "send" ? "envelope.sent" : "envelope.reminded",
      data: {
        recipientEmail: recipient.email,
        tokenExpiresAt,
        deliveryChannels: delivery.channels,
        smsStatus: delivery.sms,
      },
    });
    await client.query("COMMIT");
    const saved = await loadEnvelope(client, envelope.id, organization(request), false);
    response.set("Cache-Control", "no-store");
    response.json({
      success: true,
      data: {
        envelope: saved,
        signingUrl,
        signingUrlExpiresAt: tokenExpiresAt,
        delivery,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
}

router.post("/:envelopeId/send", (request, response, next) =>
  sendOrRemind(request, response, next, "send"));
router.post("/:envelopeId/remind", (request, response, next) =>
  sendOrRemind(request, response, next, "reminder"));

router.post("/:envelopeId/void", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const reason = clean(request.body?.reason, 1000);
    if (!reason) return fail(response, 400, "VOID_REASON_REQUIRED", "Enter a reason for voiding the agreement.");
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE fleet_contract_envelopes
          SET status='voided',voided_at=NOW(),void_reason=$3,updated_by=$4,updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
          AND status IN ('draft','sent','viewed','partially_signed')
        RETURNING *`,
      [organization(request), request.params.envelopeId, reason, request.user.id]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 409, "CONTRACT_NOT_VOIDABLE", "This agreement cannot be voided.");
    }
    await client.query(
      `UPDATE fleet_contract_recipients
          SET access_token_hash=NULL,access_token_expires_at=NULL,updated_at=NOW()
        WHERE organization_id=$1 AND envelope_id=$2`,
      [organization(request), request.params.envelopeId]
    );
    await recordEvent(client, {
      request,
      organizationId: organization(request),
      envelopeId: request.params.envelopeId,
      actorUserId: request.user.id,
      eventType: "envelope.voided",
      data: { reason },
    });
    await client.query("COMMIT");
    const envelope = await loadEnvelope(client, request.params.envelopeId, organization(request), false);
    response.json({ success: true, data: envelope });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/:envelopeId/certificate", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const envelope = await loadEnvelope(client, request.params.envelopeId, organization(request), true);
    if (!envelope) return fail(response, 404, "CONTRACT_NOT_FOUND", "Agreement not found.");
    if (envelope.status !== "completed") {
      return fail(response, 409, "CONTRACT_NOT_COMPLETED", "A completion record is available after every recipient signs.");
    }
    response.set("Cache-Control", "no-store");
    response.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        contract: envelope,
        verification: {
          algorithm: "SHA-256",
          documentHash: envelope.documentHash,
          completedRecordHash: envelope.completedRecordHash,
          auditEventCount: envelope.events.length,
          auditChainHead: envelope.events.at(-1)?.hash || null,
        },
      },
    });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
