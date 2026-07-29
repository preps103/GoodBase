"use strict";

const crypto = require("node:crypto");
const database = require("../config/database");
const resources = require("./goodads.service");

const { pool, query } = database;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set([
  "google", "facebook", "instagram", "threads", "linkedin",
  "x", "tiktok", "pinterest", "reddit",
]);
const ENGAGEMENT_TYPES = new Set(["comment", "direct_message", "mention", "review"]);
const ENGAGEMENT_STATUSES = new Set(["new", "open", "pending", "resolved", "archived"]);
const ENGAGEMENT_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const MODERATION_STATUSES = new Set(["visible", "hidden", "spam", "escalated"]);
const SENTIMENTS = new Set(["positive", "neutral", "negative", "unknown"]);
const MANAGEMENT_ROLES = new Set(["owner", "admin", "manager"]);
const MUTATING_ROLES = new Set(["owner", "admin", "manager", "editor", "member"]);
const AUTOMATION_TRIGGERS = new Set(["manual", "schedule"]);
const AUTOMATION_ACTIONS = new Set([
  "create_draft",
  "request_approval",
  "notify_team",
  "create_task",
  "pause_campaign",
]);

function workflowError(message, statusCode = 400, code = "GOODADS_WORKFLOW_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function boundedText(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function requireUuid(value, label = "ID") {
  const id = boundedText(value, 80).toLowerCase();
  if (!UUID_PATTERN.test(id)) throw workflowError(`A valid ${label} is required.`);
  return id;
}

function role(context) {
  return boundedText(context?.organization?.membershipRole, 40).toLowerCase();
}

function requireWrite(context) {
  if (!MUTATING_ROLES.has(role(context))) {
    throw workflowError(
      "Your organization role cannot update GoodAds workflows.",
      403,
      "GOODADS_WORKFLOW_WRITE_FORBIDDEN"
    );
  }
}

function requireManagement(context) {
  if (!MANAGEMENT_ROLES.has(role(context))) {
    throw workflowError(
      "Owner, admin, or manager access is required for this decision.",
      403,
      "GOODADS_WORKFLOW_DECISION_FORBIDDEN"
    );
  }
}

function optionalHttpsUrl(value) {
  const text = boundedText(value, 2048);
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw workflowError("Engagement permalink must be a complete HTTPS address.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw workflowError("Engagement permalink must use HTTPS without embedded credentials.");
  }
  return url.toString();
}

function timingSafeHex(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "hex");
  const rightBuffer = Buffer.from(String(right || ""), "hex");
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length > 0
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyEngagementSignature(rawBody, headers, nowSeconds = Math.floor(Date.now() / 1000)) {
  const secret = boundedText(process.env.GOODADS_ENGAGEMENT_WEBHOOK_SECRET, 500);
  if (secret.length < 32) {
    throw workflowError(
      "GoodAds engagement ingestion is not configured.",
      503,
      "GOODADS_ENGAGEMENT_NOT_CONFIGURED"
    );
  }
  if (!Buffer.isBuffer(rawBody) || !rawBody.length) {
    throw workflowError("The signed engagement payload is missing.", 400, "GOODADS_ENGAGEMENT_BODY_MISSING");
  }
  const timestamp = Number(headers["x-goodads-timestamp"]);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > 300) {
    throw workflowError("The engagement signature timestamp is invalid.", 401, "GOODADS_ENGAGEMENT_SIGNATURE_INVALID");
  }
  const supplied = boundedText(headers["x-goodads-signature"], 200).replace(/^sha256=/i, "");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");
  if (!timingSafeHex(supplied, expected)) {
    throw workflowError("The engagement signature is invalid.", 401, "GOODADS_ENGAGEMENT_SIGNATURE_INVALID");
  }
  return true;
}

function normalizeEngagementEvent(value, providerValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw workflowError("Each engagement event must be a JSON object.");
  }
  const provider = boundedText(providerValue || value.provider, 40).toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw workflowError("Unsupported engagement provider.", 404, "GOODADS_ENGAGEMENT_PROVIDER_INVALID");
  }
  const providerItemId = boundedText(value.providerItemId || value.id, 500);
  if (!providerItemId) throw workflowError("Provider engagement ID is required.");
  const itemType = boundedText(value.itemType || value.type, 40).toLowerCase();
  if (!ENGAGEMENT_TYPES.has(itemType)) throw workflowError("Unsupported engagement type.");
  const body = boundedText(value.body || value.message || value.text, 10000);
  if (!body) throw workflowError("Engagement text is required.");
  const sentiment = boundedText(value.sentiment || "unknown", 20).toLowerCase();
  return {
    provider,
    providerItemId,
    itemType,
    body,
    connectionId: value.connectionId ? requireUuid(value.connectionId, "connection ID") : null,
    authorName: boundedText(value.authorName || value.author?.name, 240),
    authorHandle: boundedText(value.authorHandle || value.author?.handle, 240),
    permalink: optionalHttpsUrl(value.permalink || value.url),
    sentiment: SENTIMENTS.has(sentiment) ? sentiment : "unknown",
    providerCreatedAt: (() => {
      if (!value.createdAt) return null;
      const date = new Date(value.createdAt);
      if (Number.isNaN(date.getTime())) throw workflowError("Provider engagement date is invalid.");
      return date.toISOString();
    })(),
  };
}

function rowToEngagement(row) {
  return {
    id: row.id,
    provider: row.provider,
    providerItemId: row.provider_item_id,
    connectionId: row.connection_id,
    itemType: row.item_type,
    authorName: row.author_name,
    authorHandle: row.author_handle,
    body: row.body,
    permalink: row.permalink,
    status: row.status,
    priority: row.priority,
    moderationStatus: row.moderation_status,
    sentiment: row.sentiment,
    assignedUserId: row.assigned_user_id,
    responseDraft: row.response_draft,
    providerCreatedAt: row.provider_created_at,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
}

async function ingestEngagement({ provider, payload, rawBody, headers }) {
  verifyEngagementSignature(rawBody, headers);
  const organizationId = boundedText(payload?.organizationId, 120);
  if (!organizationId) throw workflowError("Organization ID is required.");
  const inputEvents = Array.isArray(payload?.events) ? payload.events : [payload?.event || payload];
  if (!inputEvents.length || inputEvents.length > 100) {
    throw workflowError("Submit between 1 and 100 engagement events.");
  }
  const events = inputEvents.map((event) => normalizeEngagementEvent(event, provider));
  const client = await pool.connect();
  const inserted = [];
  try {
    await client.query("BEGIN");
    for (const event of events) {
      const result = await client.query(
        `INSERT INTO goodads_engagement_items (
           organization_id, connection_id, provider, provider_item_id,
           item_type, author_name, author_handle, body, permalink,
           sentiment, provider_created_at
         )
         SELECT $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11
         WHERE $2::uuid IS NULL OR EXISTS (
           SELECT 1 FROM goodads_social_connections connection
           WHERE connection.id = $2::uuid
             AND connection.organization_id = $1
             AND connection.provider = $3
         )
         ON CONFLICT (organization_id, provider, provider_item_id)
         DO UPDATE SET
           body = EXCLUDED.body,
           author_name = EXCLUDED.author_name,
           author_handle = EXCLUDED.author_handle,
           permalink = EXCLUDED.permalink,
           sentiment = EXCLUDED.sentiment,
           provider_created_at = EXCLUDED.provider_created_at,
           updated_at = NOW()
         RETURNING *`,
        [
          organizationId,
          event.connectionId,
          event.provider,
          event.providerItemId,
          event.itemType,
          event.authorName,
          event.authorHandle,
          event.body,
          event.permalink,
          event.sentiment,
          event.providerCreatedAt,
        ]
      );
      if (!result.rows[0]) {
        throw workflowError(
          "The engagement connection does not belong to this organization.",
          409,
          "GOODADS_ENGAGEMENT_CONNECTION_INVALID"
        );
      }
      inserted.push(rowToEngagement(result.rows[0]));
    }
    await client.query("COMMIT");
    return { accepted: inserted.length, items: inserted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listEngagement({
  context,
  status = null,
  itemType = null,
  provider = null,
  assignedTo = null,
  search = "",
  limit = 50,
  offset = 0,
}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const safeStatus = status ? boundedText(status, 20).toLowerCase() : null;
  const safeType = itemType ? boundedText(itemType, 40).toLowerCase() : null;
  const safeProvider = provider ? boundedText(provider, 40).toLowerCase() : null;
  const safeAssignee = assignedTo ? requireUuid(assignedTo, "assignee ID") : null;
  if (safeStatus && !ENGAGEMENT_STATUSES.has(safeStatus)) throw workflowError("Unsupported engagement status.");
  if (safeType && !ENGAGEMENT_TYPES.has(safeType)) throw workflowError("Unsupported engagement type.");
  if (safeProvider && !PROVIDERS.has(safeProvider)) throw workflowError("Unsupported engagement provider.");
  const needle = boundedText(search, 200);
  const values = [
    context.organizationId,
    safeStatus,
    safeType,
    safeProvider,
    safeAssignee,
    needle ? `%${needle}%` : null,
    safeLimit,
    safeOffset,
  ];
  const [result, count] = await Promise.all([
    query(
      `SELECT *
       FROM goodads_engagement_items
       WHERE organization_id = $1
         AND ($2::text IS NULL OR status = $2)
         AND ($3::text IS NULL OR item_type = $3)
         AND ($4::text IS NULL OR provider = $4)
         AND ($5::uuid IS NULL OR assigned_user_id = $5)
         AND (
           $6::text IS NULL
           OR body ILIKE $6
           OR author_name ILIKE $6
           OR author_handle ILIKE $6
         )
       ORDER BY
         CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
         received_at DESC
       LIMIT $7 OFFSET $8`,
      values
    ),
    query(
      `SELECT COUNT(*)::integer AS count
       FROM goodads_engagement_items
       WHERE organization_id = $1
         AND ($2::text IS NULL OR status = $2)
         AND ($3::text IS NULL OR item_type = $3)
         AND ($4::text IS NULL OR provider = $4)
         AND ($5::uuid IS NULL OR assigned_user_id = $5)
         AND (
           $6::text IS NULL
           OR body ILIKE $6
           OR author_name ILIKE $6
           OR author_handle ILIKE $6
         )`,
      values.slice(0, 6)
    ),
  ]);
  return {
    items: result.rows.map(rowToEngagement),
    total: Number(count.rows[0]?.count || 0),
    limit: safeLimit,
    offset: safeOffset,
  };
}

async function updateEngagement({ id, payload, context }) {
  requireWrite(context);
  const status = payload?.status ? boundedText(payload.status, 20).toLowerCase() : null;
  const priority = payload?.priority ? boundedText(payload.priority, 20).toLowerCase() : null;
  const moderation = payload?.moderationStatus
    ? boundedText(payload.moderationStatus, 20).toLowerCase()
    : null;
  if (status && !ENGAGEMENT_STATUSES.has(status)) throw workflowError("Unsupported engagement status.");
  if (priority && !ENGAGEMENT_PRIORITIES.has(priority)) throw workflowError("Unsupported engagement priority.");
  if (moderation && !MODERATION_STATUSES.has(moderation)) throw workflowError("Unsupported moderation status.");
  const assignedUserId = payload?.assignedUserId === null
    ? null
    : payload?.assignedUserId ? requireUuid(payload.assignedUserId, "assignee ID") : undefined;
  if (assignedUserId) {
    const membership = await query(
      `SELECT 1 FROM backend_organization_memberships
       WHERE organization_id = $1 AND user_id = $2::uuid AND status = 'active'`,
      [context.organizationId, assignedUserId]
    );
    if (!membership.rows[0]) throw workflowError("The assignee is not an active workspace member.");
  }
  const responseDraft = payload?.responseDraft === undefined
    ? undefined
    : boundedText(payload.responseDraft, 10000);
  const result = await query(
    `UPDATE goodads_engagement_items SET
       status = COALESCE($1, status),
       priority = COALESCE($2, priority),
       moderation_status = COALESCE($3, moderation_status),
       assigned_user_id = CASE WHEN $4::boolean THEN $5::uuid ELSE assigned_user_id END,
       response_draft = CASE WHEN $6::boolean THEN $7 ELSE response_draft END,
       updated_at = NOW()
     WHERE id = $8::uuid AND organization_id = $9
     RETURNING *`,
    [
      status,
      priority,
      moderation,
      assignedUserId !== undefined,
      assignedUserId ?? null,
      responseDraft !== undefined,
      responseDraft ?? "",
      requireUuid(id, "engagement ID"),
      context.organizationId,
    ]
  );
  if (!result.rows[0]) {
    throw workflowError("Engagement item was not found.", 404, "GOODADS_ENGAGEMENT_NOT_FOUND");
  }
  return rowToEngagement(result.rows[0]);
}

function normalizeApprovalPayload(payload) {
  const data = resources.normalizePayload(payload);
  const name = boundedText(data.name || data.title, 240);
  if (!name) throw workflowError("Approval request name is required.");
  const reviewType = boundedText(data.reviewType || "publishing", 40).toLowerCase();
  if (!["creative", "copy", "brand", "compliance", "budget", "publishing"].includes(reviewType)) {
    throw workflowError("Unsupported approval review type.");
  }
  const priority = boundedText(data.priority || "normal", 20).toLowerCase();
  if (!ENGAGEMENT_PRIORITIES.has(priority)) throw workflowError("Unsupported approval priority.");
  const publication = data.publication && typeof data.publication === "object"
    ? JSON.parse(JSON.stringify(data.publication))
    : null;
  if (publication) {
    const connectionIds = [...new Set((Array.isArray(publication.connectionIds)
      ? publication.connectionIds
      : []).map((value) => requireUuid(value, "connection ID")))];
    const text = boundedText(publication.content?.text || publication.text, 5000);
    if (!text || !connectionIds.length) {
      throw workflowError("Publishing approvals require post text and at least one account.");
    }
    publication.connectionIds = connectionIds;
    publication.content = { ...(publication.content || {}), text };
    publication.timezone = boundedText(publication.timezone || "UTC", 100);
    if (publication.scheduledFor) {
      const scheduled = new Date(publication.scheduledFor);
      if (Number.isNaN(scheduled.getTime())) throw workflowError("Approval publishing date is invalid.");
      publication.scheduledFor = scheduled.toISOString();
    }
  }
  const dueAt = data.dueAt
    ? (() => {
      const date = new Date(data.dueAt);
      if (Number.isNaN(date.getTime())) throw workflowError("Approval due date is invalid.");
      return date.toISOString();
    })()
    : null;
  return {
    ...data,
    name,
    status: "pending",
    reviewType,
    priority,
    description: boundedText(data.description, 4000),
    reviewer: boundedText(data.reviewer, 320).toLowerCase(),
    requester: boundedText(data.requester, 320).toLowerCase(),
    dueAt,
    publication,
    decision: null,
    decisionNote: "",
    decidedAt: null,
    decidedByUserId: null,
  };
}

async function saveApproval({ id = null, payload, context, userId, idempotencyKey = null }) {
  requireWrite(context);
  if (id) {
    const current = await resources.getResource({ type: "approvals", id, context });
    if (current.status !== "pending") {
      throw workflowError("A decided approval cannot be edited.", 409, "GOODADS_APPROVAL_ALREADY_DECIDED");
    }
  }
  const requestKey = id
    ? null
    : boundedText(idempotencyKey, 200);
  if (!id && !requestKey) {
    throw workflowError(
      "Idempotency-Key header is required.",
      400,
      "GOODADS_IDEMPOTENCY_REQUIRED"
    );
  }
  if (requestKey) {
    const existing = await query(
      `SELECT * FROM goodads_resources
       WHERE organization_id = $1
         AND resource_type = 'approvals'
         AND archived_at IS NULL
         AND data->>'requestKey' = $2
       LIMIT 1`,
      [context.organizationId, requestKey]
    );
    if (existing.rows[0]) return resources.rowToResource(existing.rows[0]);
  }
  try {
    return await resources.upsertResource({
      type: "approvals",
      id,
      payload: {
        ...normalizeApprovalPayload(payload),
        ...(requestKey ? { requestKey } : {}),
      },
      context,
      userId,
    });
  } catch (error) {
    if (requestKey && error.code === "23505") {
      const duplicate = await query(
        `SELECT * FROM goodads_resources
         WHERE organization_id = $1
           AND resource_type = 'approvals'
           AND archived_at IS NULL
           AND data->>'requestKey' = $2
         LIMIT 1`,
        [context.organizationId, requestKey]
      );
      if (duplicate.rows[0]) return resources.rowToResource(duplicate.rows[0]);
    }
    throw error;
  }
}

async function decideApproval({ id, decision, note, context, userId }) {
  requireManagement(context);
  const normalizedDecision = boundedText(decision, 20).toLowerCase();
  if (!["approved", "rejected"].includes(normalizedDecision)) {
    throw workflowError("Approval decision must be approved or rejected.");
  }
  const current = await resources.getResource({ type: "approvals", id, context });
  if (current.status === normalizedDecision) return current;
  if (current.status !== "pending") {
    throw workflowError("This review already has a final decision.", 409, "GOODADS_APPROVAL_ALREADY_DECIDED");
  }
  return resources.upsertResource({
    type: "approvals",
    id,
    payload: {
      ...current,
      status: normalizedDecision,
      decision: normalizedDecision,
      decisionNote: boundedText(note, 2000),
      decidedAt: new Date().toISOString(),
      decidedByUserId: userId,
    },
    context,
    userId,
  });
}

function normalizeAutomationPayload(payload) {
  const data = resources.normalizePayload(payload);
  const name = boundedText(data.name || data.title, 240);
  if (!name) throw workflowError("Automation name is required.");
  const triggerType = boundedText(data.triggerType || "manual", 40).toLowerCase();
  const actionType = boundedText(data.actionType, 40).toLowerCase();
  if (!AUTOMATION_TRIGGERS.has(triggerType)) {
    throw workflowError("Only manual and scheduled automation triggers are currently available.");
  }
  if (!AUTOMATION_ACTIONS.has(actionType)) {
    throw workflowError("Select an available automation action.");
  }
  const intervalMinutes = triggerType === "schedule"
    ? Math.min(Math.max(Number(data.intervalMinutes) || 60, 5), 10080)
    : null;
  const scheduledAt = triggerType === "schedule"
    ? (() => {
      const date = data.scheduledAt ? new Date(data.scheduledAt) : new Date(Date.now() + intervalMinutes * 60000);
      if (Number.isNaN(date.getTime())) throw workflowError("Automation schedule is invalid.");
      return date.toISOString();
    })()
    : null;
  return {
    ...data,
    name,
    status: data.status === "active" ? "active" : data.status === "paused" ? "paused" : "draft",
    triggerType,
    actionType,
    intervalMinutes,
    scheduledAt,
    description: boundedText(data.description, 4000),
    conditions: boundedText(data.conditions, 4000),
    guardrails: boundedText(data.guardrails, 4000),
    owner: boundedText(data.owner, 320).toLowerCase(),
  };
}

async function saveAutomation({ id = null, payload, context, userId }) {
  requireWrite(context);
  return resources.upsertResource({
    type: "automations",
    id,
    payload: normalizeAutomationPayload(payload),
    context,
    userId,
  });
}

function rowToRun(row) {
  return {
    id: row.id,
    automationId: row.automation_id,
    triggeredByUserId: row.triggered_by_user_id,
    triggerType: row.trigger_type,
    status: row.status,
    input: row.input || {},
    output: row.output || {},
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

async function executeAutomationAction(client, automation, triggeredByUserId) {
  const data = automation.data || {};
  const baseValues = [
    automation.organization_id,
    automation.project_id,
    automation.environment_id,
    automation.owner_user_id,
  ];
  const namePrefix = boundedText(data.namePrefix || automation.name, 180);
  switch (data.actionType) {
    case "create_draft": {
      const inserted = await client.query(
        `INSERT INTO goodads_resources (
           resource_type, organization_id, project_id, environment_id,
           owner_user_id, name, status, data
         ) VALUES ('content', $1, $2, $3, $4::uuid, $5, 'draft', $6::jsonb)
         RETURNING id`,
        [
          ...baseValues,
          `${namePrefix} — automated draft`,
          JSON.stringify({
            name: `${namePrefix} — automated draft`,
            status: "draft",
            description: boundedText(data.description, 4000),
            sourceAutomationId: automation.id,
            createdAt: new Date().toISOString(),
          }),
        ]
      );
      return { action: data.actionType, resourceType: "content", resourceId: inserted.rows[0].id };
    }
    case "request_approval": {
      const inserted = await client.query(
        `INSERT INTO goodads_resources (
           resource_type, organization_id, project_id, environment_id,
           owner_user_id, name, status, data
         ) VALUES ('approvals', $1, $2, $3, $4::uuid, $5, 'pending', $6::jsonb)
         RETURNING id`,
        [
          ...baseValues,
          `${namePrefix} — automated review`,
          JSON.stringify({
            name: `${namePrefix} — automated review`,
            status: "pending",
            reviewType: boundedText(data.reviewType || "compliance", 40),
            priority: boundedText(data.priority || "normal", 20),
            description: boundedText(data.description, 4000),
            sourceAutomationId: automation.id,
            requestedAt: new Date().toISOString(),
          }),
        ]
      );
      return { action: data.actionType, resourceType: "approvals", resourceId: inserted.rows[0].id };
    }
    case "notify_team": {
      const inserted = await client.query(
        `INSERT INTO goodads_resources (
           resource_type, organization_id, project_id, environment_id,
           owner_user_id, name, status, data
         ) VALUES ('notifications', $1, $2, $3, $4::uuid, $5, 'active', $6::jsonb)
         RETURNING id`,
        [
          ...baseValues,
          `${namePrefix} notification`,
          JSON.stringify({
            name: `${namePrefix} notification`,
            status: "active",
            message: boundedText(data.description || data.notes, 4000),
            sourceAutomationId: automation.id,
            createdAt: new Date().toISOString(),
          }),
        ]
      );
      return { action: data.actionType, resourceType: "notifications", resourceId: inserted.rows[0].id };
    }
    case "create_task": {
      const inserted = await client.query(
        `INSERT INTO goodads_resources (
           resource_type, organization_id, project_id, environment_id,
           owner_user_id, name, status, data
         ) VALUES ('calendar', $1, $2, $3, $4::uuid, $5, 'scheduled', $6::jsonb)
         RETURNING id`,
        [
          ...baseValues,
          `${namePrefix} task`,
          JSON.stringify({
            name: `${namePrefix} task`,
            status: "scheduled",
            eventType: "deadline",
            scheduledAt: new Date().toISOString(),
            description: boundedText(data.description, 4000),
            sourceAutomationId: automation.id,
          }),
        ]
      );
      return { action: data.actionType, resourceType: "calendar", resourceId: inserted.rows[0].id };
    }
    case "pause_campaign": {
      const campaignId = requireUuid(data.campaignId, "campaign ID");
      const paused = await client.query(
        `UPDATE goodads_resources
         SET status = 'paused',
             data = data || jsonb_build_object(
               'status', 'paused',
               'pausedByAutomationId', $3::text,
               'updatedAt', NOW()::text
             ),
             version = version + 1,
             updated_at = NOW()
         WHERE id = $1::uuid AND organization_id = $2
           AND resource_type = 'campaigns' AND archived_at IS NULL
         RETURNING id`,
        [campaignId, automation.organization_id, automation.id]
      );
      if (!paused.rows[0]) throw workflowError("The campaign selected by this automation is unavailable.");
      return { action: data.actionType, resourceType: "campaigns", resourceId: paused.rows[0].id };
    }
    default:
      throw workflowError("This automation action is not installed.");
  }
}

async function executeAutomationRow(automation, {
  triggerType,
  userId = null,
  input = {},
  idempotencyKey,
}) {
  const requestKey = boundedText(idempotencyKey, 200);
  if (!requestKey) {
    throw workflowError(
      "Idempotency-Key header is required.",
      400,
      "GOODADS_IDEMPOTENCY_REQUIRED"
    );
  }
  const started = await query(
    `INSERT INTO goodads_automation_runs (
       automation_id, organization_id, triggered_by_user_id,
       trigger_type, idempotency_key, status, input
     ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, 'running', $6::jsonb)
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      automation.id,
      automation.organization_id,
      userId,
      triggerType,
      requestKey,
      JSON.stringify(input && typeof input === "object" ? input : {}),
    ]
  );
  if (!started.rows[0]) {
    const existing = await query(
      `SELECT * FROM goodads_automation_runs
       WHERE organization_id = $1 AND idempotency_key = $2`,
      [automation.organization_id, requestKey]
    );
    if (existing.rows[0]) return rowToRun(existing.rows[0]);
    throw workflowError("Automation run could not be created.", 409, "GOODADS_AUTOMATION_RUN_CONFLICT");
  }
  const run = started.rows[0];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const output = await executeAutomationAction(client, automation, userId);
    const nextScheduledAt = automation.data?.triggerType === "schedule"
      ? new Date(Date.now() + Math.min(Math.max(Number(automation.data.intervalMinutes) || 60, 5), 10080) * 60000).toISOString()
      : null;
    await client.query(
      `UPDATE goodads_automation_runs
       SET status = 'completed', output = $2::jsonb, completed_at = NOW()
       WHERE id = $1::uuid`,
      [run.id, JSON.stringify(output)]
    );
    await client.query(
      `UPDATE goodads_resources
       SET data = data || $2::jsonb, version = version + 1, updated_at = NOW()
       WHERE id = $1::uuid`,
      [
        automation.id,
        JSON.stringify({
          lastRunAt: new Date().toISOString(),
          lastRunStatus: "completed",
          failureCount: 0,
          lastError: null,
          nextRunAt: nextScheduledAt,
          scheduledAt: nextScheduledAt,
          lastOutput: output,
        }),
      ]
    );
    await client.query("COMMIT");
    return { ...rowToRun(run), status: "completed", output, completedAt: new Date().toISOString() };
  } catch (error) {
    await client.query("ROLLBACK");
    const failureCount = Math.min(Number(automation.data?.failureCount || 0) + 1, 5);
    const retryMinutes = Math.min(1440, 5 * (2 ** Math.max(0, failureCount - 1)));
    await query(
      `UPDATE goodads_automation_runs
       SET status = 'failed', error_message = $2, completed_at = NOW()
       WHERE id = $1::uuid`,
      [run.id, boundedText(error.message, 2000)]
    ).catch(() => {});
    await query(
      `UPDATE goodads_resources
       SET status = CASE WHEN $3::integer >= 5 THEN 'failed' ELSE status END,
           data = data || $2::jsonb, version = version + 1, updated_at = NOW()
       WHERE id = $1::uuid`,
      [
        automation.id,
        JSON.stringify({
            lastRunAt: new Date().toISOString(),
            lastRunStatus: "failed",
            lastError: boundedText(error.message, 2000),
            failureCount,
            nextRunAt: automation.data?.triggerType === "schedule"
              ? new Date(Date.now() + retryMinutes * 60000).toISOString()
              : null,
          }),
          failureCount,
        ]
    ).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runAutomation({ id, input, context, userId, idempotencyKey }) {
  requireWrite(context);
  const safeInput = resources.normalizePayload(input || {});
  const selected = await query(
    `SELECT * FROM goodads_resources
     WHERE id = $1::uuid AND organization_id = $2
       AND resource_type = 'automations' AND archived_at IS NULL`,
    [requireUuid(id, "automation ID"), context.organizationId]
  );
  const automation = selected.rows[0];
  if (!automation) throw workflowError("Automation was not found.", 404, "GOODADS_AUTOMATION_NOT_FOUND");
  if (!["active", "ready"].includes(automation.status)) {
    throw workflowError("Activate this automation before running it.", 409, "GOODADS_AUTOMATION_NOT_ACTIVE");
  }
  return executeAutomationRow(automation, {
    triggerType: "manual",
    userId,
    input: safeInput,
    idempotencyKey,
  });
}

async function listAutomationRuns({ id, context, limit = 50 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const result = await query(
    `SELECT run.*
     FROM goodads_automation_runs run
     JOIN goodads_resources automation ON automation.id = run.automation_id
     WHERE run.automation_id = $1::uuid
       AND run.organization_id = $2
       AND automation.resource_type = 'automations'
     ORDER BY run.started_at DESC
     LIMIT $3`,
    [requireUuid(id, "automation ID"), context.organizationId, safeLimit]
  );
  return { items: result.rows.map(rowToRun) };
}

async function processDueAutomations(limit = 10) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const due = await query(
    `SELECT *
     FROM goodads_resources
     WHERE resource_type = 'automations'
       AND status = 'active'
       AND archived_at IS NULL
       AND data->>'triggerType' = 'schedule'
       AND COALESCE(
         CASE WHEN data->>'nextRunAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
           THEN (data->>'nextRunAt')::timestamptz END,
         CASE WHEN data->>'scheduledAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
           THEN (data->>'scheduledAt')::timestamptz END
       ) <= NOW()
     ORDER BY COALESCE(
       CASE WHEN data->>'nextRunAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
         THEN (data->>'nextRunAt')::timestamptz END,
       CASE WHEN data->>'scheduledAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
         THEN (data->>'scheduledAt')::timestamptz END
     ) ASC
     FOR UPDATE SKIP LOCKED
     LIMIT $1`,
    [safeLimit]
  );
  const results = [];
  for (const automation of due.rows) {
    try {
      const dueAt = automation.data?.nextRunAt || automation.data?.scheduledAt;
      const run = await executeAutomationRow(automation, {
        triggerType: "schedule",
        idempotencyKey: `schedule:${automation.id}:${dueAt}`,
      });
      results.push({ automationId: automation.id, runId: run.id, status: run.status });
    } catch (error) {
      results.push({ automationId: automation.id, status: "failed", error: boundedText(error.message, 500) });
    }
  }
  return { processed: results.length, results };
}

function workflowCapabilities() {
  return {
    engagementInbox: {
      available: true,
      signedIngestionConfigured: boundedText(process.env.GOODADS_ENGAGEMENT_WEBHOOK_SECRET, 500).length >= 32,
      supportedTypes: [...ENGAGEMENT_TYPES],
      providerReplying: false,
      replyUnavailableReason: "Provider reply adapters are not installed.",
    },
    approvalWorkflows: {
      available: true,
      decisionsRestrictedToManagement: true,
      approvedPublishingRelease: true,
      requiredForRoles: ["editor", "member"],
    },
    automations: {
      available: true,
      triggers: [...AUTOMATION_TRIGGERS],
      actions: [...AUTOMATION_ACTIONS],
      durableRuns: true,
      minimumScheduleMinutes: 5,
    },
  };
}

module.exports = {
  ingestEngagement,
  listEngagement,
  updateEngagement,
  saveApproval,
  decideApproval,
  saveAutomation,
  runAutomation,
  listAutomationRuns,
  processDueAutomations,
  workflowCapabilities,
  _test: {
    timingSafeHex,
    verifyEngagementSignature,
    normalizeEngagementEvent,
    normalizeApprovalPayload,
    normalizeAutomationPayload,
  },
};
