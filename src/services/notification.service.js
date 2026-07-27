const crypto = require("crypto");
const nodemailer = require("nodemailer");
const database = require("../config/database");
const secretService = require("./secret.service");

function dbQuery(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  if (database.default && typeof database.default.query === "function") return database.default.query(sql, params);
  throw new Error("Database query function not found");
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function renderTemplate(template = "", variables = {}) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const value = key.split(".").reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : ""), variables);
    return value === undefined || value === null ? "" : String(value);
  });
}

async function getTemplate(templateKey) {
  if (!templateKey) return null;

  const result = await dbQuery(
    `
      SELECT *
      FROM backend_notification_templates
      WHERE template_key = $1
        AND status = 'active'
      LIMIT 1
    `,
    [templateKey]
  );

  return result.rows[0] || null;
}

async function secretOrEnv(key) {
  try {
    const secretValue = await secretService.getSecretValue(key);
    if (secretValue) return secretValue;
  } catch (_) {
    // Fall back to environment variables if Secrets V2 is unavailable.
  }

  return process.env[key] || null;
}

async function getSmtpConfig() {
  const host = await secretOrEnv("SMTP_HOST");
  const user = await secretOrEnv("SMTP_USER");
  const pass = await secretOrEnv("SMTP_PASS");

  if (!host || !user || !pass) return null;

  return {
    host,
    port: Number((await secretOrEnv("SMTP_PORT")) || 587),
    secure: String((await secretOrEnv("SMTP_SECURE")) || "false") === "true",
    servername: (await secretOrEnv("SMTP_TLS_SERVERNAME")) || host,
    user,
    pass,
    fromEmail: (await secretOrEnv("MAIL_FROM")) || (await secretOrEnv("SMTP_FROM")) || "no-reply@goodos.app",
    fromName: (await secretOrEnv("MAIL_FROM_NAME")) || "GoodOS",
    replyTo: (await secretOrEnv("MAIL_REPLY_TO")) || null,
  };
}

async function smtpConfigured() {
  return Boolean(await getSmtpConfig());
}

async function createTransporter() {
  const config = await getSmtpConfig();
  if (!config) return null;

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    tls: {
      servername: config.servername,
      rejectUnauthorized: true,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

function isLocalCompanyRecipient(email) {
  return /@(goodos\.app|ghostcreationz\.com)$/i.test(String(email || "").trim());
}

function createLocalCompanyTransporter() {
  return nodemailer.createTransport({
    host: "127.0.0.1",
    port: 25,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  });
}

async function syncFleetEmailDelivery(email, status, providerReference = null, errorCode = null) {
  if (!String(email?.id || "").startsWith("gfemail_")) return;
  const notificationId = String(email.notification_id || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(notificationId)) return;

  try {
    await dbQuery(
      `
        UPDATE fleet_customer_notification_deliveries
        SET status = $2,
            attempted_at = NOW(),
            delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE delivered_at END,
            provider_reference = COALESCE($3, provider_reference),
            error_code = $4,
            updated_at = NOW()
        WHERE notification_id = $1::uuid
          AND channel = 'email'
      `,
      [notificationId, status, providerReference, errorCode]
    );

    if (status !== "pending") {
      await dbQuery(
        `
          UPDATE fleet_customer_notifications
          SET status = CASE WHEN $2 = 'delivered' THEN 'delivered' ELSE 'partially_delivered' END
          WHERE id = $1::uuid
        `,
        [notificationId, status]
      );
    }
  } catch (error) {
    console.error("Unable to synchronize GoodFleet email delivery status", {
      notificationId,
      status,
      message: error.message,
    });
  }
}

async function createNotification(input = {}) {
  const ownerResult = await dbQuery("SELECT id, email, display_name FROM users ORDER BY created_at ASC LIMIT 1");
  const owner = ownerResult.rows[0] || {};
  const variables = input.variables || input.payload || {};
  const template = input.templateKey ? await getTemplate(input.templateKey) : null;
  const inputPayload =
    input.payload &&
    typeof input.payload === "object" &&
    !Array.isArray(input.payload)
      ? input.payload
      : {};
  const inputMetadata =
    input.metadata &&
    typeof input.metadata === "object" &&
    !Array.isArray(input.metadata)
      ? input.metadata
      : {};
  const appId = String(
    input.appId ||
    inputMetadata.appId ||
    inputMetadata.app_id ||
    inputPayload.appId ||
    inputPayload.app_id ||
    "goodos"
  ).trim().slice(0, 120) || "goodos";
  const payload = {
    ...inputPayload,
    appId,
  };
  const metadata = {
    ...inputMetadata,
    appId,
  };

  const title = input.title || renderTemplate(template?.subject_template || "GoodOS notification", variables);
  const message = input.message || renderTemplate(template?.body_text_template || "", variables);
  const html = template?.body_html_template ? renderTemplate(template.body_html_template, variables) : null;
  const explicitRecipientUserId = input.recipientUserId || input.userId || null;
  const explicitRecipientEmail = input.recipientEmail || input.email || null;
  const hasExplicitRecipient = Boolean(
    explicitRecipientUserId ||
    explicitRecipientEmail
  );
  const recipientUserId =
    explicitRecipientUserId ||
    (!hasExplicitRecipient ? owner.id : null) ||
    null;
  const recipientEmail =
    explicitRecipientEmail ||
    (!hasExplicitRecipient ? owner.email : null) ||
    null;
  const channel = input.channel || "in_app";
  const severity = input.severity || "info";
  const category = input.category || template?.category || "system";
  const notificationId = input.id || randomId("ntf");

  await dbQuery(
    `
      INSERT INTO backend_notifications (
        id,
        notification_key,
        category,
        channel,
        title,
        message,
        severity,
        status,
        recipient_user_id,
        recipient_email,
        source,
        source_id,
        action_url,
        payload_json,
        metadata_json,
        organization_id,
        project_id,
        environment_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,'unread',$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      notificationId,
      input.notificationKey || input.eventType || null,
      category,
      channel,
      title,
      message,
      severity,
      recipientUserId,
      recipientEmail,
      input.source || "notification-service",
      input.sourceId || null,
      input.actionUrl || null,
      JSON.stringify(payload),
      JSON.stringify(metadata),
      input.organizationId || "org_goodos",
      input.projectId || "proj_goodos_platform",
      input.environmentId || "env_goodos_production",
    ]
  );

  const messageId = randomId("msg");

  await dbQuery(
    `
      INSERT INTO backend_message_center (
        id,
        notification_id,
        user_id,
        email,
        title,
        body,
        severity,
        status,
        action_url,
        metadata_json,
        organization_id,
        project_id,
        environment_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,'unread',$8,$9::jsonb,$10,$11,$12)
    `,
    [
      messageId,
      notificationId,
      recipientUserId,
      recipientEmail,
      title,
      message,
      severity,
      input.actionUrl || null,
      JSON.stringify({
        source: input.source || "notification-service",
        appId,
      }),
      input.organizationId || "org_goodos",
      input.projectId || "proj_goodos_platform",
      input.environmentId || "env_goodos_production",
    ]
  );

  const queueId = randomId("ntq");

  await dbQuery(
    `
      INSERT INTO backend_notification_queue (
        id,
        notification_id,
        queue_type,
        channel,
        status,
        priority,
        scheduled_at,
        payload_json,
        metadata_json,
        organization_id,
        project_id,
        environment_id
      )
      VALUES ($1,$2,'notification',$3,'completed',$4,NOW(),$5::jsonb,$6::jsonb,$7,$8,$9)
    `,
    [
      queueId,
      notificationId,
      channel,
      Number(input.priority || 100),
      JSON.stringify({ title, message, severity }),
      JSON.stringify({
        messageId,
        appId,
      }),
      input.organizationId || "org_goodos",
      input.projectId || "proj_goodos_platform",
      input.environmentId || "env_goodos_production",
    ]
  );

  let emailQueue = null;

  if (input.queueEmail || channel === "email" || (Array.isArray(input.channels) && input.channels.includes("email"))) {
    emailQueue = await queueEmail({
      notificationId,
      templateKey: input.templateKey || template?.template_key || "system.notice",
      toEmail: recipientEmail,
      toName: input.toName || owner.display_name || recipientEmail,
      subject: title,
      bodyText: message,
      bodyHtml: html,
      payload: input.payload || variables || {},
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
    });
  }

  return {
    id: notificationId,
    messageId,
    queueId,
    emailQueue,
    title,
    message,
    severity,
    category,
    recipientEmail,
    appId,
  };
}

async function queueEmail(input = {}) {
  if (!input.toEmail) {
    const error = new Error("toEmail is required for email queue.");
    error.statusCode = 400;
    throw error;
  }

  const emailId = randomId("emailq");
  const smtpConfig = await getSmtpConfig();
  const smtpReady = Boolean(smtpConfig);
  const fromEmail = input.fromEmail || smtpConfig?.fromEmail || process.env.MAIL_FROM || process.env.SMTP_FROM || "no-reply@goodos.app";
  const fromName = input.fromName || smtpConfig?.fromName || process.env.MAIL_FROM_NAME || "GoodOS";

  await dbQuery(
    `
      INSERT INTO backend_email_queue (
        id,
        notification_id,
        template_key,
        to_email,
        to_name,
        from_email,
        from_name,
        reply_to_email,
        subject,
        body_text,
        body_html,
        provider,
        status,
        priority,
        scheduled_at,
        payload_json,
        metadata_json,
        organization_id,
        project_id,
        environment_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,NOW(),$14::jsonb,$15::jsonb,$16,$17,$18)
      RETURNING id, status, to_email AS "toEmail", subject
    `,
    [
      emailId,
      input.notificationId || null,
      input.templateKey || null,
      input.toEmail,
      input.toName || null,
      fromEmail,
      fromName,
      input.replyToEmail || smtpConfig?.replyTo || process.env.MAIL_REPLY_TO || null,
      input.subject || "GoodOS notification",
      input.bodyText || "",
      input.bodyHtml || null,
      smtpReady ? "smtp" : "internal-dry-run",
      Number(input.priority || 100),
      JSON.stringify(input.payload || {}),
      JSON.stringify({ smtpConfigured: smtpReady, source: smtpReady ? "secrets-v2-or-env" : "dry-run", phase: "25A" }),
      input.organizationId || "org_goodos",
      input.projectId || "proj_goodos_platform",
      input.environmentId || "env_goodos_production",
    ]
  );

  return {
    id: emailId,
    status: "pending",
    provider: smtpReady ? "smtp" : "internal-dry-run",
  };
}

async function processEmailQueue(limit = 10) {
  const rows = await dbQuery(
    `
      SELECT *
      FROM backend_email_queue
      WHERE status = 'pending'
        AND scheduled_at <= NOW()
      ORDER BY priority ASC, created_at ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit || 10), 1), 50)]
  );

  const transporter = await createTransporter();
  const localCompanyTransporter = createLocalCompanyTransporter();
  const processed = [];

  for (const email of rows.rows) {
    try {
      const selectedTransporter = isLocalCompanyRecipient(email.to_email)
        ? localCompanyTransporter
        : transporter;

      if (!selectedTransporter) {
        await dbQuery(
          `
            UPDATE backend_email_queue
            SET status = 'simulated',
                attempts = attempts + 1,
                sent_at = NOW(),
                last_attempt_at = NOW(),
                provider_message_id = $2,
                metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
                updated_at = NOW()
            WHERE id = $1
          `,
          [
            email.id,
            `dryrun_${email.id}`,
            JSON.stringify({ dryRun: true, reason: "SMTP not configured" }),
          ]
        );

        await syncFleetEmailDelivery(email, "failed", `dryrun_${email.id}`, "SMTP_NOT_CONFIGURED");
        processed.push({ id: email.id, status: "simulated" });
        continue;
      }

      const info = await selectedTransporter.sendMail({
        from: email.from_name ? `"${email.from_name}" <${email.from_email}>` : email.from_email,
        to: email.to_name ? `"${email.to_name}" <${email.to_email}>` : email.to_email,
        replyTo: email.reply_to_email || undefined,
        subject: email.subject,
        text: email.body_text || undefined,
        html: email.body_html || undefined,
      });

      await dbQuery(
        `
          UPDATE backend_email_queue
          SET status = 'sent',
              attempts = attempts + 1,
              sent_at = NOW(),
              last_attempt_at = NOW(),
              provider_message_id = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [email.id, info.messageId || null]
      );

      await syncFleetEmailDelivery(email, "delivered", info.messageId || null);
      processed.push({ id: email.id, status: "sent", providerMessageId: info.messageId || null });
    } catch (error) {
      const retryResult = await dbQuery(
        `
          UPDATE backend_email_queue
          SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
              attempts = attempts + 1,
              last_attempt_at = NOW(),
              error_message = $2,
              updated_at = NOW()
          WHERE id = $1
          RETURNING status
        `,
        [email.id, error.message]
      );

      await syncFleetEmailDelivery(
        email,
        retryResult.rows[0]?.status === "failed" ? "failed" : "pending",
        null,
        retryResult.rows[0]?.status === "failed" ? "EMAIL_DELIVERY_FAILED" : null
      );
      processed.push({ id: email.id, status: "failed", error: error.message });
    }
  }

  return {
    processedCount: processed.length,
    processed,
    smtpConfigured: Boolean(transporter),
    localCompanyDelivery: true,
  };
}

async function evaluateAlertRules() {
  const counters = await dbQuery(`
    SELECT *
    FROM backend_quota_counters
    WHERE status IN ('warning','over_limit')
    ORDER BY updated_at DESC
    LIMIT 50
  `);

  const created = [];

  for (const counter of counters.rows) {
    const existing = await dbQuery(
      `
        SELECT id
        FROM backend_alert_events
        WHERE rule_key = 'usage.quota.warning'
          AND source_id = $1
          AND status IN ('open','acknowledged')
          AND created_at >= NOW() - INTERVAL '1 hour'
        LIMIT 1
      `,
      [counter.id]
    );

    if (existing.rows[0]) continue;

    const alertId = randomId("alert");
    const title = `Quota ${counter.status}: ${counter.metric_key}`;
    const message = `${counter.metric_key} is ${counter.status}. Current ${counter.quantity} / Limit ${counter.quota_limit}.`;

    const notification = await createNotification({
      title,
      message,
      severity: counter.status === "over_limit" ? "critical" : "warning",
      category: "usage",
      source: "alert-rule",
      sourceId: counter.id,
      payload: counter,
      queueEmail: false,
    });

    await dbQuery(
      `
        INSERT INTO backend_alert_events (
          id,
          rule_id,
          rule_key,
          category,
          severity,
          title,
          message,
          source,
          source_id,
          status,
          notification_id,
          payload_json,
          metadata_json,
          organization_id,
          project_id,
          environment_id
        )
        VALUES ($1,'altrule_quota_warning','usage.quota.warning','usage',$2,$3,$4,'quota-counter',$5,'open',$6,$7::jsonb,$8::jsonb,$9,$10,$11)
      `,
      [
        alertId,
        counter.status === "over_limit" ? "critical" : "warning",
        title,
        message,
        counter.id,
        notification.id,
        JSON.stringify(counter),
        JSON.stringify({ generatedBy: "evaluateAlertRules" }),
        counter.organization_id || "org_goodos",
        counter.project_id || "proj_goodos_platform",
        counter.environment_id || "env_goodos_production",
      ]
    );

    created.push({ id: alertId, notificationId: notification.id, title });
  }

  return {
    createdCount: created.length,
    created,
  };
}

async function getNotificationSnapshot() {
  const templates = await dbQuery(`
    SELECT id, template_key AS "templateKey", name, category, channel_type AS "channelType", subject_template AS "subjectTemplate", status, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM backend_notification_templates
    ORDER BY category ASC, name ASC
    LIMIT 300
  `);

  const channels = await dbQuery(`
    SELECT id, name, display_name AS "displayName", channel_type AS "channelType", provider, status, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM backend_notification_channels
    ORDER BY name ASC
    LIMIT 300
  `);

  const notifications = await dbQuery(`
    SELECT id, notification_key AS "notificationKey", category, channel, title, message, severity, status, recipient_email AS "recipientEmail", source, source_id AS "sourceId", action_url AS "actionUrl", created_at AS "createdAt", read_at AS "readAt"
    FROM backend_notifications
    ORDER BY created_at DESC
    LIMIT 300
  `);

  const emailQueue = await dbQuery(`
    SELECT id, notification_id AS "notificationId", template_key AS "templateKey", to_email AS "toEmail", subject, provider, status, attempts, scheduled_at AS "scheduledAt", sent_at AS "sentAt", error_message AS "errorMessage", created_at AS "createdAt"
    FROM backend_email_queue
    ORDER BY created_at DESC
    LIMIT 300
  `);

  const alertRules = await dbQuery(`
    SELECT id, rule_key AS "ruleKey", name, category, source_table AS "sourceTable", metric_key AS "metricKey", severity, channel_names AS "channelNames", template_key AS "templateKey", throttle_minutes AS "throttleMinutes", status, last_triggered_at AS "lastTriggeredAt", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM backend_alert_rules
    ORDER BY category ASC, name ASC
    LIMIT 300
  `);

  const alertEvents = await dbQuery(`
    SELECT id, rule_key AS "ruleKey", category, severity, title, message, source, source_id AS "sourceId", status, notification_id AS "notificationId", created_at AS "createdAt", acknowledged_at AS "acknowledgedAt", resolved_at AS "resolvedAt"
    FROM backend_alert_events
    ORDER BY created_at DESC
    LIMIT 300
  `);

  const messageCenter = await dbQuery(`
    SELECT id, notification_id AS "notificationId", user_id AS "userId", email, title, body, severity, status, action_url AS "actionUrl", created_at AS "createdAt", read_at AS "readAt"
    FROM backend_message_center
    ORDER BY created_at DESC
    LIMIT 300
  `);

  const preferences = await dbQuery(`
    SELECT id, user_id AS "userId", email, category, channel, enabled, digest_frequency AS "digestFrequency", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM backend_notification_preferences
    ORDER BY category ASC, channel ASC
    LIMIT 300
  `);

  return {
    templates: templates.rows,
    channels: channels.rows,
    notifications: notifications.rows,
    emailQueue: emailQueue.rows,
    alertRules: alertRules.rows,
    alertEvents: alertEvents.rows,
    messageCenter: messageCenter.rows,
    preferences: preferences.rows,
    counts: {
      templates: templates.rows.length,
      channels: channels.rows.length,
      notifications: notifications.rows.length,
      unread: notifications.rows.filter((item) => item.status === "unread").length,
      emailQueue: emailQueue.rows.length,
      pendingEmail: emailQueue.rows.filter((item) => item.status === "pending").length,
      alertRules: alertRules.rows.length,
      openAlerts: alertEvents.rows.filter((item) => item.status === "open").length,
      messages: messageCenter.rows.length,
    },
  };
}

module.exports = {
  createNotification,
  queueEmail,
  processEmailQueue,
  evaluateAlertRules,
  getNotificationSnapshot,
  renderTemplate,
};
