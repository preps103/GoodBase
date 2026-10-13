"use strict";

const crypto = require("crypto");
const fs = require("fs");
const database = require("../config/database");
const notificationService = require("./notification.service");

const SECRET_FILE = process.env.GOODBASE_ALERT_WEBHOOK_SECRET_FILE || "/etc/goodbase/alert-webhook.secret";
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_ALERTS = 100;

function clean(value, maximum = 500) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

function secret() {
  if (process.env.GOODBASE_ALERT_WEBHOOK_SECRET) return process.env.GOODBASE_ALERT_WEBHOOK_SECRET;
  try { return fs.readFileSync(SECRET_FILE, "utf8").trim(); } catch { return ""; }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifySignature({ timestamp, nonce, signature, body }) {
  const key = secret();
  const timestampNumber = Number(timestamp);
  if (!key) return { ok: false, status: 503, code: "GOODBASE_ALERT_SECRET_UNAVAILABLE" };
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() - timestampNumber) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, status: 401, code: "GOODBASE_ALERT_SIGNATURE_EXPIRED" };
  }
  if (!/^[a-f0-9-]{16,100}$/i.test(String(nonce || ""))) {
    return { ok: false, status: 401, code: "GOODBASE_ALERT_NONCE_INVALID" };
  }
  const expected = crypto.createHmac("sha256", key).update(`${timestamp}.${nonce}.${body}`).digest("hex");
  const supplied = String(signature || "").replace(/^sha256=/, "");
  return safeEqual(expected, supplied)
    ? { ok: true, timestamp: new Date(timestampNumber) }
    : { ok: false, status: 401, code: "GOODBASE_ALERT_SIGNATURE_INVALID" };
}

function severity(value) {
  const normalized = clean(value, 20).toLowerCase();
  return ["critical", "warning", "info"].includes(normalized) ? normalized : "warning";
}

function boundedObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [clean(key, 100), clean(item, 1000)]));
}

function dateOrNull(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

function isQuietHours(policy, now = new Date()) {
  const quiet = policy.quiet_hours_json || {};
  if (!quiet.enabled) return false;
  let local;
  try { local = new Intl.DateTimeFormat("en-CA", { timeZone: policy.timezone || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now); }
  catch { local = now.toISOString().slice(11, 16); }
  const start = /^\d{2}:\d{2}$/.test(quiet.start) ? quiet.start : "22:00";
  const end = /^\d{2}:\d{2}$/.test(quiet.end) ? quiet.end : "07:00";
  return start <= end ? local >= start && local < end : local >= start || local < end;
}

async function activePolicy() {
  const result = await database.query("SELECT * FROM goodbase_on_call_policies WHERE status='active' ORDER BY created_at LIMIT 1");
  return result.rows[0] || null;
}

async function receiveAlertmanagerPayload({ payload, body, timestamp, nonce }) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.alerts)) {
    const error = new Error("A bounded Alertmanager webhook payload is required."); error.statusCode = 400; throw error;
  }
  if (payload.alerts.length > MAX_ALERTS) {
    const error = new Error(`No more than ${MAX_ALERTS} alerts may be delivered at once.`); error.statusCode = 413; throw error;
  }
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  const policy = await activePolicy();
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await client.query(
      `INSERT INTO goodbase_alert_receipts(payload_hash,group_key,receiver,alert_count,signature_timestamp,signature_nonce,payload_json)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(payload_hash) DO NOTHING RETURNING *`,
      [hash,clean(payload.groupKey,500),clean(payload.receiver,200),payload.alerts.length,new Date(Number(timestamp)),nonce,JSON.stringify({ status:clean(payload.status,30),commonLabels:boundedObject(payload.commonLabels),externalURL:clean(payload.externalURL,1000) })]
    );
    if (!receipt.rows[0]) { await client.query("ROLLBACK"); return { duplicate: true, accepted: 0 }; }
    let accepted = 0;
    for (const item of payload.alerts) {
      const labels = boundedObject(item.labels);
      const annotations = boundedObject(item.annotations);
      const state = item.status === "resolved" ? "resolved" : "firing";
      const fingerprint = clean(item.fingerprint || crypto.createHash("sha256").update(JSON.stringify(labels)).digest("hex"),128);
      const start = dateOrNull(item.startsAt);
      if (state === "resolved") {
        const resolvedInstances = await client.query(
          `UPDATE goodbase_alert_instances SET status='resolved',resolved_at=NOW(),ends_at=COALESCE($2,ends_at),last_received_at=NOW()
           WHERE fingerprint=$1 AND status='firing'
           RETURNING id`,
          [fingerprint,dateOrNull(item.endsAt)]
        );
        await client.query(
          `UPDATE goodbase_alert_delivery_attempts delivery SET status='cancelled',updated_at=NOW()
           FROM goodbase_alert_instances alert WHERE alert.id=delivery.alert_instance_id AND alert.fingerprint=$1 AND delivery.status IN('pending','retrying')`,
          [fingerprint]
        );
        const resolvedIds = resolvedInstances.rows.map((row) => String(row.id));
        if (resolvedIds.length) {
          await client.query(
            `UPDATE backend_notifications
             SET status='archived', archived_at=COALESCE(archived_at,NOW()), updated_at=NOW()
             WHERE category='observability'
               AND source_id = ANY($1::text[])
               AND archived_at IS NULL`,
            [resolvedIds]
          );
        }
      }
      const dedupe = crypto.createHash("sha256").update(`${fingerprint}.${state}.${start?.toISOString() || ""}`).digest("hex");
      const instance = await client.query(
        `INSERT INTO goodbase_alert_instances(receipt_id,policy_id,fingerprint,deduplication_key,alert_name,severity,status,labels_json,annotations_json,starts_at,ends_at,resolved_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,CASE WHEN $7='resolved' THEN NOW() END)
         ON CONFLICT(deduplication_key) DO UPDATE SET occurrence_count=goodbase_alert_instances.occurrence_count+1,last_received_at=NOW(),ends_at=EXCLUDED.ends_at,resolved_at=EXCLUDED.resolved_at
         RETURNING *, (xmax=0) AS inserted`,
        [receipt.rows[0].id,policy?.id||null,fingerprint,dedupe,clean(labels.alertname||"Goodbase alert",200),severity(labels.severity),state,JSON.stringify(labels),JSON.stringify(annotations),start,dateOrNull(item.endsAt)]
      );
      if (!instance.rows[0].inserted || state === "resolved") continue;
      accepted += 1;
      const steps = Array.isArray(policy?.escalation_json) ? policy.escalation_json.slice(0,10) : [{delayMinutes:0,channel:"in_app"}];
      for (let index=0; index<steps.length; index+=1) {
        const step=steps[index]||{}; const channel=["email","in_app"].includes(step.channel)?step.channel:"in_app";
        const quiet=isQuietHours(policy||{}) && !(instance.rows[0].severity==="critical" && policy?.quiet_hours_json?.criticalBypass!==false);
        await client.query(
          `INSERT INTO goodbase_alert_delivery_attempts(alert_instance_id,policy_id,escalation_step,channel,recipient,status,next_attempt_at,metadata_json)
           VALUES($1,$2,$3,$4,$5,$6,NOW()+($7::text||' minutes')::interval,$8::jsonb) ON CONFLICT DO NOTHING`,
          [instance.rows[0].id,policy?.id||null,index,channel,policy?.recipient_email||null,quiet?"suppressed":"pending",Math.min(Math.max(Number(step.delayMinutes)||0,0),1440),JSON.stringify({quietHours:quiet})]
        );
      }
    }
    await client.query("UPDATE goodbase_alert_receipts SET status='processed',processed_at=NOW() WHERE id=$1",[receipt.rows[0].id]);
    await client.query("COMMIT");
    return { duplicate:false,accepted,receiptId:receipt.rows[0].id };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

async function processDueDeliveries(limit=25) {
  const due = await database.query(
    `SELECT delivery.*,alert.alert_name,alert.severity,alert.status alert_status,alert.annotations_json,alert.labels_json,policy.recipient_user_id,policy.recipient_email
     FROM goodbase_alert_delivery_attempts delivery JOIN goodbase_alert_instances alert ON alert.id=delivery.alert_instance_id
     LEFT JOIN goodbase_on_call_policies policy ON policy.id=delivery.policy_id
     WHERE delivery.status IN('pending','retrying') AND delivery.next_attempt_at<=NOW()
     ORDER BY delivery.next_attempt_at FOR UPDATE OF delivery SKIP LOCKED LIMIT $1`,[Math.min(Math.max(Number(limit)||25,1),100)]);
  const processed=[];
  for (const item of due.rows) {
    try {
      if(item.alert_status==="resolved"){await database.query("UPDATE goodbase_alert_delivery_attempts SET status='cancelled',updated_at=NOW() WHERE id=$1",[item.id]);continue;}
      const summary=clean(item.annotations_json?.summary||item.alert_name,500);
      const description=clean(item.annotations_json?.description||"Goodbase production alert requires attention.",4000);
      const notification=await notificationService.createNotification({
        notificationKey:`observability.${item.alert_instance_id}.${item.escalation_step}.${item.channel}`,
        title:`[${item.severity.toUpperCase()}] ${summary}`,message:description,severity:item.severity,category:"observability",channel:item.channel,
        recipientUserId:item.recipient_user_id,recipientEmail:item.recipient_email,queueEmail:item.channel==="email",source:"alertmanager",sourceId:String(item.alert_instance_id),
        payload:{labels:item.labels_json,annotations:item.annotations_json},metadata:{deliveryAttemptId:item.id,escalationStep:item.escalation_step}
      });
      await database.query(`UPDATE goodbase_alert_delivery_attempts SET status=$2,attempt_count=attempt_count+1,notification_id=$3,email_queue_id=$4,updated_at=NOW(),delivered_at=CASE WHEN $2='sent' THEN NOW() END WHERE id=$1`,[item.id,item.channel==="email"?"queued":"sent",notification.id,notification.emailQueue?.id||null]);
      await database.query(
        `UPDATE backend_notifications
         SET status='archived', archived_at=COALESCE(archived_at,NOW()), updated_at=NOW()
         WHERE source='alert-delivery-monitor'
           AND source_id=$1
           AND archived_at IS NULL`,
        [String(item.alert_instance_id)]
      );
      processed.push({id:item.id,status:item.channel==="email"?"queued":"sent"});
    } catch(error){
      await database.query(`UPDATE goodbase_alert_delivery_attempts SET attempt_count=attempt_count+1,status=CASE WHEN attempt_count+1>=max_attempts THEN 'failed' ELSE 'retrying' END,next_attempt_at=NOW()+(LEAST(3600,POWER(2,attempt_count+1)*15)::text||' seconds')::interval,last_error=$2,updated_at=NOW() WHERE id=$1`,[item.id,clean(error.message,1000)]);
      processed.push({id:item.id,status:"retrying"});
    }
  }
  await database.query(`UPDATE goodbase_alert_delivery_attempts delivery SET status=CASE email.status WHEN 'sent' THEN 'sent' WHEN 'simulated' THEN 'simulated' WHEN 'failed' THEN 'failed' ELSE delivery.status END,provider_message_id=email.provider_message_id,last_error=email.error_message,delivered_at=CASE WHEN email.status='sent' THEN COALESCE(delivery.delivered_at,email.sent_at,NOW()) ELSE delivery.delivered_at END,updated_at=NOW() FROM backend_email_queue email WHERE email.id=delivery.email_queue_id AND delivery.status='queued'`);
  const newlyFailed=await database.query(
    `UPDATE goodbase_alert_delivery_attempts SET metadata_json=metadata_json||'{"failureNotified":true}'::jsonb,updated_at=NOW()
     WHERE status='failed' AND COALESCE((metadata_json->>'failureNotified')::boolean,FALSE)=FALSE
     RETURNING id,alert_instance_id,channel,recipient,last_error`
  );
  for(const failure of newlyFailed.rows){
    const existing = await database.query(
      `SELECT id FROM backend_notifications
       WHERE notification_key=$1 AND archived_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [`observability.delivery.failed.${failure.id}`]
    );
    if (!existing.rows[0]) {
      await notificationService.createNotification({
        notificationKey:`observability.delivery.failed.${failure.id}`,title:"Goodbase alert delivery failed",
        message:`${failure.channel} delivery to ${clean(failure.recipient||"the configured on-call recipient",320)} exhausted its retry budget. ${clean(failure.last_error||"No provider detail was returned.",1000)}`,
        severity:"critical",category:"observability",channel:"in_app",queueEmail:false,source:"alert-delivery-monitor",sourceId:String(failure.alert_instance_id),
        metadata:{deliveryAttemptId:failure.id}
      });
    }
  }
  return {processedCount:processed.length,failedDeliveryAlerts:newlyFailed.rowCount,processed};
}

async function snapshot(limit=100) {
  const [receipts,instances,deliveries,policies,counts]=await Promise.all([
    database.query("SELECT id,group_key,receiver,status,alert_count,received_at,processed_at FROM goodbase_alert_receipts ORDER BY received_at DESC LIMIT $1",[limit]),
    database.query("SELECT id,alert_name,severity,status,occurrence_count,first_received_at,last_received_at,resolved_at FROM goodbase_alert_instances ORDER BY last_received_at DESC LIMIT $1",[limit]),
    database.query("SELECT id,alert_instance_id,escalation_step,channel,recipient,status,attempt_count,next_attempt_at,notification_id,email_queue_id,last_error,created_at,delivered_at FROM goodbase_alert_delivery_attempts ORDER BY created_at DESC LIMIT $1",[limit]),
    database.query("SELECT id,name,status,timezone,quiet_hours_json,routes_json,escalation_json,recipient_email,created_at,updated_at FROM goodbase_on_call_policies ORDER BY created_at"),
    database.query("SELECT COUNT(*) FILTER(WHERE status='firing')::int firing,COUNT(*) FILTER(WHERE severity='critical' AND status='firing')::int critical FROM goodbase_alert_instances")
  ]);
  return {receipts:receipts.rows,alerts:instances.rows,deliveries:deliveries.rows,policies:policies.rows,counts:counts.rows[0]};
}

module.exports={verifySignature,receiveAlertmanagerPayload,processDueDeliveries,snapshot,isQuietHours};
