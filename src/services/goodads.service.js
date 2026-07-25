"use strict";

const { pool, query } = require("../config/database");

const RESOURCE_TYPES = new Set([
  "campaigns", "content", "approvals", "calendar", "connections",
  "publishing_jobs", "analytics", "media", "link_hubs", "automations",
  "notifications", "email_campaigns", "designs", "flyers",
  "business_cards", "qr_codes", "videos", "brand", "audit_events",
  "funnels", "lead_forms", "leads",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MUTATING_ROLES = new Set(["owner", "admin", "manager", "editor", "member"]);
const DESTRUCTIVE_ROLES = new Set(["owner", "admin", "manager"]);

function serviceError(message, statusCode = 400, code = "GOODADS_REQUEST_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function requireResourceType(type) {
  if (!RESOURCE_TYPES.has(type)) throw serviceError("Unsupported GoodAds resource.", 404, "GOODADS_RESOURCE_NOT_FOUND");
  return type;
}

function normalizePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError("A JSON object is required.");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 262144) {
    throw serviceError("Resource payload exceeds 256 KB.", 413, "GOODADS_PAYLOAD_TOO_LARGE");
  }
  return JSON.parse(encoded);
}

function requireUuid(value) {
  const id = String(value || "").trim();
  if (!UUID_PATTERN.test(id)) throw serviceError("A valid resource ID is required.");
  return id;
}

function requirePublicSlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  if (!PUBLIC_SLUG_PATTERN.test(slug)) {
    throw serviceError("A valid lead form address is required.", 400, "GOODADS_FORM_SLUG_INVALID");
  }
  return slug;
}

function boundedText(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function normalizeLeadSubmission(value) {
  const data = normalizePayload(value);
  if (boundedText(data.website, 200)) {
    throw serviceError("The lead submission was rejected.", 400, "GOODADS_LEAD_SPAM_REJECTED");
  }

  const email = boundedText(data.email, 320).toLowerCase();
  const phone = boundedText(data.phone, 40);
  if (!email && !phone) {
    throw serviceError("An email address or phone number is required.", 400, "GOODADS_LEAD_CONTACT_REQUIRED");
  }
  if (email && !EMAIL_PATTERN.test(email)) {
    throw serviceError("Enter a valid email address.", 400, "GOODADS_LEAD_EMAIL_INVALID");
  }

  return {
    firstName: boundedText(data.firstName, 100),
    lastName: boundedText(data.lastName, 100),
    email,
    phone,
    company: boundedText(data.company, 160),
    message: boundedText(data.message, 4000),
    consent: data.consent === true,
    source: boundedText(data.source || "lead-form", 120),
    pageUrl: boundedText(data.pageUrl, 2048),
    utm: {
      source: boundedText(data.utm?.source, 120),
      medium: boundedText(data.utm?.medium, 120),
      campaign: boundedText(data.utm?.campaign, 120),
      content: boundedText(data.utm?.content, 120),
      term: boundedText(data.utm?.term, 120),
    },
  };
}

function roleFromContext(context) {
  return String(context?.organization?.membershipRole || "").toLowerCase();
}

function requireMutationRole(context) {
  if (!MUTATING_ROLES.has(roleFromContext(context))) {
    throw serviceError("Your organization role cannot modify GoodAds resources.", 403, "GOODADS_WRITE_FORBIDDEN");
  }
}

function requireDestructiveRole(context) {
  if (!DESTRUCTIVE_ROLES.has(roleFromContext(context))) {
    throw serviceError("Owner, admin, or manager access is required.", 403, "GOODADS_DELETE_FORBIDDEN");
  }
}

function rowToResource(row) {
  return {
    id: row.id,
    resourceType: row.resource_type,
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...row.data,
  };
}

async function listResources({ type, context, limit = 50, offset = 0, status = null }) {
  requireResourceType(type);
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const boundedOffset = Math.max(Number(offset) || 0, 0);
  const result = await query(
    `SELECT * FROM goodads_resources
     WHERE organization_id = $1 AND resource_type = $2
       AND archived_at IS NULL
       AND ($3::text IS NULL OR status = $3)
     ORDER BY updated_at DESC
     LIMIT $4 OFFSET $5`,
    [context.organizationId, type, status || null, boundedLimit, boundedOffset]
  );
  const count = await query(
    `SELECT COUNT(*)::integer AS count FROM goodads_resources
     WHERE organization_id = $1 AND resource_type = $2
       AND archived_at IS NULL AND ($3::text IS NULL OR status = $3)`,
    [context.organizationId, type, status || null]
  );
  return { items: result.rows.map(rowToResource), total: count.rows[0]?.count || 0, limit: boundedLimit, offset: boundedOffset };
}

async function getResource({ type, id, context }) {
  requireResourceType(type);
  const result = await query(
    `SELECT * FROM goodads_resources
     WHERE id = $1::uuid AND organization_id = $2 AND resource_type = $3
       AND archived_at IS NULL`,
    [requireUuid(id), context.organizationId, type]
  );
  if (!result.rows[0]) throw serviceError("GoodAds resource not found.", 404, "GOODADS_RECORD_NOT_FOUND");
  return rowToResource(result.rows[0]);
}

async function upsertResource({ type, id, payload, context, userId }) {
  requireMutationRole(context);
  requireResourceType(type);
  const data = normalizePayload(payload);
  const resourceId = id ? requireUuid(id) : (data.id && UUID_PATTERN.test(String(data.id)) ? String(data.id) : null);
  const name = String(data.name || data.title || "").trim().slice(0, 240);
  const status = String(data.status || "draft").toLowerCase();
  const result = await query(
    `INSERT INTO goodads_resources (
       id, resource_type, organization_id, project_id, environment_id,
       owner_user_id, name, status, data
     ) VALUES (
       COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6::uuid, $7, $8, $9::jsonb
     )
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       data = EXCLUDED.data,
       version = goodads_resources.version + 1,
       updated_at = NOW()
     WHERE goodads_resources.organization_id = EXCLUDED.organization_id
       AND goodads_resources.resource_type = EXCLUDED.resource_type
     RETURNING *`,
    [resourceId, type, context.organizationId, context.projectId, context.environmentId, userId, name, status, JSON.stringify(data)]
  );
  if (!result.rows[0]) throw serviceError("The resource belongs to another tenant.", 409, "GOODADS_TENANT_CONFLICT");
  await recordEvent({
    resourceId: result.rows[0].id,
    context,
    userId,
    eventType: resourceId ? `${type}.updated` : `${type}.created`,
    nextStatus: result.rows[0].status,
  });
  return rowToResource(result.rows[0]);
}

async function archiveResource({ type, id, context, userId }) {
  requireDestructiveRole(context);
  requireResourceType(type);
  const result = await query(
    `UPDATE goodads_resources
     SET status = 'archived', archived_at = NOW(), updated_at = NOW(), version = version + 1
     WHERE id = $1::uuid AND organization_id = $2 AND resource_type = $3
       AND archived_at IS NULL RETURNING *`,
    [requireUuid(id), context.organizationId, type]
  );
  if (!result.rows[0]) throw serviceError("GoodAds resource not found.", 404, "GOODADS_RECORD_NOT_FOUND");
  await recordEvent({ resourceId: result.rows[0].id, context, userId, eventType: `${type}.archived`, previousStatus: result.rows[0].status, nextStatus: "archived" });
  return rowToResource(result.rows[0]);
}

async function transitionResource({ type, id, nextStatus, context, userId, eventType }) {
  requireMutationRole(context);
  requireResourceType(type);
  const current = await getResource({ type, id, context });
  const result = await query(
    `UPDATE goodads_resources
     SET status = $1, updated_at = NOW(), version = version + 1,
         data = data || jsonb_build_object('status', $1::text, 'updatedAt', NOW()::text)
     WHERE id = $2::uuid AND organization_id = $3 AND resource_type = $4
       AND archived_at IS NULL RETURNING *`,
    [nextStatus, requireUuid(id), context.organizationId, type]
  );
  await recordEvent({ resourceId: id, context, userId, eventType, previousStatus: current.status, nextStatus });
  return rowToResource(result.rows[0]);
}

async function recordEvent({ resourceId, context, userId, eventType, previousStatus = null, nextStatus = null, metadata = {} }) {
  await query(
    `INSERT INTO goodads_resource_events (
       resource_id, organization_id, actor_user_id, event_type,
       previous_status, next_status, metadata
     ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb)`,
    [resourceId, context.organizationId, userId, eventType, previousStatus, nextStatus, JSON.stringify(metadata)]
  );
}

async function dashboard(context) {
  const result = await query(
    `SELECT resource_type, status, COUNT(*)::integer AS count
     FROM goodads_resources
     WHERE organization_id = $1 AND archived_at IS NULL
     GROUP BY resource_type, status ORDER BY resource_type, status`,
    [context.organizationId]
  );
  const recent = await query(
    `SELECT * FROM goodads_resources
     WHERE organization_id = $1 AND archived_at IS NULL
     ORDER BY updated_at DESC LIMIT 12`,
    [context.organizationId]
  );
  const wonLeads = await query(
    `SELECT COUNT(*)::integer AS count FROM goodads_resources
     WHERE organization_id = $1 AND resource_type = 'leads'
       AND archived_at IS NULL AND data->>'stage' = 'won'`,
    [context.organizationId]
  );
  const count = (type, status = null) => result.rows
    .filter((row) => row.resource_type === type && (!status || row.status === status))
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  return {
    organization: context.organization,
    project: context.project,
    environment: context.environment,
    counts: result.rows,
    metrics: {
      campaigns: count("campaigns"),
      activeCampaigns: count("campaigns", "active"),
      content: count("content"),
      scheduled: count("calendar", "scheduled"),
      pendingApprovals: count("approvals", "pending"),
      connectedAccounts: count("connections", "connected"),
      publishingJobs: count("publishing_jobs"),
      publishingFailures: count("publishing_jobs", "failed"),
      funnels: count("funnels"),
      liveForms: count("lead_forms", "active"),
      leads: count("leads"),
      wonLeads: wonLeads.rows[0]?.count || 0,
    },
    recent: recent.rows.map(rowToResource),
    generatedAt: new Date().toISOString(),
  };
}

async function workspace(context) {
  const brand = await listResources({ type: "brand", context, limit: 1 });
  return {
    id: context.organization.id,
    name: context.organization.name,
    slug: context.organization.slug,
    plan: context.organization.plan,
    status: context.organization.status,
    role: context.organization.membershipRole,
    project: context.project,
    environment: context.environment,
    brand: brand.items[0] || null,
  };
}

function publicFormFromRow(row) {
  const data = row.data || {};
  const allowedFields = new Set(["firstName", "lastName", "email", "phone", "company", "message"]);
  const fields = Array.isArray(data.fields)
    ? data.fields
      .filter((field) => field && typeof field === "object" && allowedFields.has(String(field.id)))
      .slice(0, 12)
      .map((field) => ({
        id: String(field.id),
        label: boundedText(field.label, 80) || String(field.id),
        type: ["text", "email", "tel", "textarea"].includes(String(field.type)) ? String(field.type) : "text",
        required: field.required === true,
      }))
    : [];
  return {
    id: row.id,
    name: row.name,
    publicSlug: boundedText(data.publicSlug, 64),
    headline: boundedText(data.headline, 180),
    description: boundedText(data.description, 800),
    buttonLabel: boundedText(data.buttonLabel, 80) || "Get started",
    successMessage: boundedText(data.successMessage, 500) || "Thank you. We received your information.",
    fields,
    requireConsent: data.requireConsent === true,
    consentText: boundedText(data.consentText, 500),
    funnelId: UUID_PATTERN.test(String(data.funnelId || "")) ? String(data.funnelId) : null,
    theme: {
      backgroundColor: boundedText(data.theme?.backgroundColor, 20) || "#f8fafc",
      cardColor: boundedText(data.theme?.cardColor, 20) || "#ffffff",
      accentColor: boundedText(data.theme?.accentColor, 20) || "#4f46e5",
    },
  };
}

async function getPublicLeadForm(slug) {
  const result = await query(
    `SELECT * FROM goodads_resources
     WHERE resource_type = 'lead_forms' AND status = 'active'
       AND archived_at IS NULL AND data->>'publicSlug' = $1
     LIMIT 1`,
    [requirePublicSlug(slug)]
  );
  if (!result.rows[0]) {
    throw serviceError("This lead form is not available.", 404, "GOODADS_FORM_NOT_FOUND");
  }
  return publicFormFromRow(result.rows[0]);
}

async function recordLeadFormView(slug) {
  const result = await query(
    `UPDATE goodads_resources
     SET data = jsonb_set(
           data,
           '{viewCount}',
           to_jsonb(CASE WHEN COALESCE(data->>'viewCount', '') ~ '^[0-9]+$'
             THEN (data->>'viewCount')::integer + 1 ELSE 1 END),
           true
         ),
         version = version + 1,
         updated_at = NOW()
     WHERE resource_type = 'lead_forms' AND status = 'active'
       AND archived_at IS NULL AND data->>'publicSlug' = $1
     RETURNING id`,
    [requirePublicSlug(slug)]
  );
  if (!result.rows[0]) {
    throw serviceError("This lead form is not available.", 404, "GOODADS_FORM_NOT_FOUND");
  }
  return { recorded: true };
}

async function captureLead({ slug, payload, idempotencyKey, userAgent = "" }) {
  const normalizedSlug = requirePublicSlug(slug);
  const submission = normalizeLeadSubmission(payload);
  const requestKey = boundedText(idempotencyKey, 128);
  if (!requestKey) {
    throw serviceError("An idempotency key is required.", 400, "GOODADS_IDEMPOTENCY_REQUIRED");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const formResult = await client.query(
      `SELECT * FROM goodads_resources
       WHERE resource_type = 'lead_forms' AND status = 'active'
         AND archived_at IS NULL AND data->>'publicSlug' = $1
       LIMIT 1 FOR UPDATE`,
      [normalizedSlug]
    );
    const form = formResult.rows[0];
    if (!form) {
      throw serviceError("This lead form is not available.", 404, "GOODADS_FORM_NOT_FOUND");
    }
    if (form.data?.requireConsent === true && !submission.consent) {
      throw serviceError("Consent is required before submitting this form.", 400, "GOODADS_LEAD_CONSENT_REQUIRED");
    }

    const duplicateRequest = await client.query(
      `SELECT resource_id FROM goodads_resource_events
       WHERE organization_id = $1 AND event_type = 'leads.captured'
         AND metadata->>'idempotencyKey' = $2
       LIMIT 1`,
      [form.organization_id, requestKey]
    );
    if (duplicateRequest.rows[0]) {
      await client.query("COMMIT");
      return { leadId: duplicateRequest.rows[0].resource_id, status: "received", duplicate: true };
    }

    const identityClause = submission.email
      ? "LOWER(data->>'email') = $2"
      : "data->>'phone' = $2";
    const identityValue = submission.email || submission.phone;
    const existingResult = await client.query(
      `SELECT * FROM goodads_resources
       WHERE organization_id = $1 AND resource_type = 'leads'
         AND archived_at IS NULL AND ${identityClause}
       ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
      [form.organization_id, identityValue]
    );

    const now = new Date().toISOString();
    const funnelId = UUID_PATTERN.test(String(form.data?.funnelId || "")) ? String(form.data.funnelId) : null;
    const formId = String(form.id);
    const previous = existingResult.rows[0];
    const name = [submission.firstName, submission.lastName].filter(Boolean).join(" ")
      || submission.company || submission.email || submission.phone;
    let lead;

    if (previous) {
      const previousData = previous.data || {};
      const nextData = {
        ...previousData,
        ...submission,
        stage: previousData.stage || "new",
        score: Number(previousData.score) || 0,
        formId,
        funnelId,
        submissionCount: (Number(previousData.submissionCount) || 1) + 1,
        lastSubmittedAt: now,
        updatedAt: now,
      };
      const updated = await client.query(
        `UPDATE goodads_resources
         SET name = $1, data = $2::jsonb, version = version + 1, updated_at = NOW()
         WHERE id = $3::uuid RETURNING *`,
        [name, JSON.stringify(nextData), previous.id]
      );
      lead = updated.rows[0];
    } else {
      const leadData = {
        ...submission,
        stage: "new",
        score: 0,
        tags: [],
        notes: "",
        formId,
        funnelId,
        submissionCount: 1,
        firstSubmittedAt: now,
        lastSubmittedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const inserted = await client.query(
        `INSERT INTO goodads_resources (
           resource_type, organization_id, project_id, environment_id,
           owner_user_id, name, status, data
         ) VALUES ('leads', $1, $2, $3, $4::uuid, $5, 'active', $6::jsonb)
         RETURNING *`,
        [form.organization_id, form.project_id, form.environment_id, form.owner_user_id, name, JSON.stringify(leadData)]
      );
      lead = inserted.rows[0];
    }

    await client.query(
      `UPDATE goodads_resources
       SET data = jsonb_set(
             data,
             '{submissionCount}',
             to_jsonb(CASE WHEN COALESCE(data->>'submissionCount', '') ~ '^[0-9]+$'
               THEN (data->>'submissionCount')::integer + 1 ELSE 1 END),
             true
           ),
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1::uuid`,
      [form.id]
    );
    await client.query(
      `INSERT INTO goodads_resource_events (
         resource_id, organization_id, actor_user_id, event_type, next_status, metadata
       ) VALUES ($1::uuid, $2, NULL, 'leads.captured', 'active', $3::jsonb)`,
      [lead.id, form.organization_id, JSON.stringify({
        formId,
        funnelId,
        idempotencyKey: requestKey,
        userAgent: boundedText(userAgent, 400),
      })]
    );
    await client.query("COMMIT");
    return { leadId: lead.id, status: "received", duplicate: Boolean(previous) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  RESOURCE_TYPES,
  normalizePayload,
  requireUuid,
  requirePublicSlug,
  normalizeLeadSubmission,
  dashboard,
  workspace,
  listResources,
  getResource,
  upsertResource,
  archiveResource,
  transitionResource,
  getPublicLeadForm,
  recordLeadFormView,
  captureLead,
};
