"use strict";

const database = require("../config/database");
const storage = require("./storage-v2.service");

const RETENTION_OPTIONS = Object.freeze([0, 7, 30, 90, 365]);
const RESIDENCY_REGION = "us-west";
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanupAt = 0;

function governanceError(message, statusCode = 400, code = "GOODSPEECH_GOVERNANCE_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

function scope(context = {}) {
  return {
    organizationId: String(context.organizationId || "org_goodos"),
    projectId: context.projectId ? String(context.projectId) : null,
    environmentId: context.environmentId ? String(context.environmentId) : null,
  };
}

function retentionDays(value, fallback = 30) {
  const parsed = Number(value);
  if (!RETENTION_OPTIONS.includes(parsed)) {
    if (value === undefined) return fallback;
    throw governanceError(`Retention must be one of ${RETENTION_OPTIONS.join(", ")} days.`);
  }
  return parsed;
}

function publicSettings(row = {}) {
  const zeroRetention = row.zero_retention === true;
  return {
    zeroRetention,
    generationRetentionDays: Number(row.generation_retention_days ?? 30),
    agentRetentionDays: Number(row.agent_retention_days ?? 30),
    residency: {
      region: row.residency_region || RESIDENCY_REGION,
      label: "United States — West",
      status: "enforced",
      availableRegions: [RESIDENCY_REGION],
    },
    modelTraining: {
      enabled: false,
      optOutEnforced: row.model_training_opt_out !== false,
      message: "GoodSpeech content is not used to train shared models.",
    },
    retainedData: zeroRetention ? "none_after_request" : "policy_controlled",
    updatedAt: row.updated_at || null,
  };
}

async function ensureSettings({ context, userId }) {
  const current = scope(context);
  const result = await database.query(
    `INSERT INTO goodspeech_privacy_settings
       (organization_id, project_id, environment_id, owner_user_id)
     VALUES ($1,$2,$3,$4::uuid)
     ON CONFLICT (organization_id, owner_user_id) DO UPDATE
     SET project_id=COALESCE(EXCLUDED.project_id, goodspeech_privacy_settings.project_id),
         environment_id=COALESCE(EXCLUDED.environment_id, goodspeech_privacy_settings.environment_id)
     RETURNING *`,
    [current.organizationId, current.projectId, current.environmentId, userId],
  );
  return result.rows[0];
}

async function getPrivacySettings(input) {
  return publicSettings(await ensureSettings(input));
}

async function shouldRetainGeneratedContent(input) {
  const row = await ensureSettings(input);
  return row.zero_retention !== true && Number(row.generation_retention_days) > 0;
}

async function purgeHistoryRows(rows, reason) {
  const purged = [];
  for (const row of rows) {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM goodspeech_generation_history WHERE id=$1::uuid", [row.history_id]);
      if (row.asset_id) await client.query("UPDATE goodspeech_assets SET deleted_at=COALESCE(deleted_at,NOW()) WHERE id=$1::uuid", [row.asset_id]);
      await client.query("COMMIT");
      if (row.storage_file_id) {
        await storage.softDeleteObject({
          fileId: row.storage_file_id,
          actorId: row.owner_user_id,
          createdBy: row.owner_user_id,
          reason,
        }).catch((error) => console.error("[GoodSpeech privacy] storage cleanup failed:", error.message));
      }
      purged.push(row.history_id);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return purged;
}

async function purgeStudioRows(rows, reason) {
  let studioParts = 0;
  let studioMasters = 0;
  for (const job of rows) {
    const parts = await database.query(
      `DELETE FROM goodspeech_studio_job_parts WHERE job_id=$1::uuid RETURNING storage_file_id`,
      [job.id],
    );
    studioParts += parts.rowCount;
    for (const part of parts.rows) {
      await storage.softDeleteObject({ fileId: part.storage_file_id, actorId: job.owner_user_id, createdBy: job.owner_user_id, reason })
        .catch((error) => console.error("[GoodSpeech privacy] Studio part cleanup failed:", error.message));
    }
    if (job.output_asset_id) {
      const asset = await database.query(
        `UPDATE goodspeech_assets SET deleted_at=COALESCE(deleted_at,NOW())
         WHERE id=$1::uuid AND owner_user_id=$2::uuid RETURNING storage_file_id`,
        [job.output_asset_id, job.owner_user_id],
      );
      if (asset.rows[0]) {
        studioMasters += 1;
        await storage.softDeleteObject({ fileId: asset.rows[0].storage_file_id, actorId: job.owner_user_id, createdBy: job.owner_user_id, reason })
          .catch((error) => console.error("[GoodSpeech privacy] Studio master cleanup failed:", error.message));
      }
    }
    await database.query(
      `UPDATE goodspeech_studio_jobs SET
         status=CASE WHEN status IN ('queued','retrying','processing') THEN 'cancelled' ELSE status END,
         cancellation_requested=TRUE, clips_json='[]'::jsonb, output_asset_id=NULL,
         locked_by=NULL, locked_until=NULL, completed_at=COALESCE(completed_at,NOW()), updated_at=NOW()
       WHERE id=$1::uuid`,
      [job.id],
    );
  }
  return { studioJobs: rows.length, studioParts, studioMasters };
}

async function purgeUserContent({ context, userId }) {
  const current = scope(context);
  let purgedHistoryCount = 0;
  while (true) {
    const history = await database.query(
      `SELECT history.id AS history_id, history.owner_user_id, asset.id AS asset_id, asset.storage_file_id
       FROM goodspeech_generation_history history
       LEFT JOIN goodspeech_assets asset ON asset.id=history.asset_id
       WHERE history.organization_id=$1 AND history.owner_user_id=$2::uuid
       ORDER BY history.created_at ASC LIMIT 250`,
      [current.organizationId, userId],
    );
    if (!history.rowCount) break;
    purgedHistoryCount += (await purgeHistoryRows(history.rows, "GoodSpeech privacy purge")).length;
  }
  const tools = await database.query(
    `DELETE FROM goodspeech_agent_tool_calls call
     USING goodspeech_agent_sessions session
     WHERE call.session_id=session.id AND session.organization_id=$1 AND session.owner_user_id=$2::uuid
     RETURNING call.id`,
    [current.organizationId, userId],
  );
  const messages = await database.query(
    `DELETE FROM goodspeech_agent_messages message
     USING goodspeech_agent_sessions session
     WHERE message.session_id=session.id AND session.organization_id=$1 AND session.owner_user_id=$2::uuid
     RETURNING message.id`,
    [current.organizationId, userId],
  );
  await database.query(
    `UPDATE goodspeech_agent_tests SET last_response=NULL
     WHERE organization_id=$1 AND owner_user_id=$2::uuid`,
    [current.organizationId, userId],
  );
  const studio = await database.query(
    `SELECT id, owner_user_id, output_asset_id FROM goodspeech_studio_jobs
     WHERE organization_id=$1 AND owner_user_id=$2::uuid
       AND (clips_json<>'[]'::jsonb OR output_asset_id IS NOT NULL OR status IN ('queued','retrying','processing'))`,
    [current.organizationId, userId],
  );
  const studioResult = await purgeStudioRows(studio.rows, "GoodSpeech privacy purge");
  return { histories: purgedHistoryCount, agentMessages: messages.rowCount, agentToolCalls: tools.rowCount, ...studioResult };
}

async function enforceSessionRetention({ sessionId, context, userId }) {
  const current = scope(context);
  const privacy = await ensureSettings({ context, userId });
  if (privacy.zero_retention !== true) return { purged: false };
  const tools = await database.query(
    `DELETE FROM goodspeech_agent_tool_calls call USING goodspeech_agent_sessions session
     WHERE call.session_id=session.id AND session.id=$1::uuid
       AND session.organization_id=$2 AND session.owner_user_id=$3::uuid RETURNING call.id`,
    [sessionId, current.organizationId, userId],
  );
  const messages = await database.query(
    `DELETE FROM goodspeech_agent_messages message USING goodspeech_agent_sessions session
     WHERE message.session_id=session.id AND session.id=$1::uuid
       AND session.organization_id=$2 AND session.owner_user_id=$3::uuid RETURNING message.id`,
    [sessionId, current.organizationId, userId],
  );
  return { purged: true, agentMessages: messages.rowCount, agentToolCalls: tools.rowCount };
}

async function updatePrivacySettings({ payload = {}, context, userId }) {
  const current = scope(context);
  const existing = await ensureSettings({ context, userId });
  const zeroRetention = payload.zeroRetention === undefined ? existing.zero_retention === true : payload.zeroRetention === true;
  const generationDays = zeroRetention ? 0 : retentionDays(payload.generationRetentionDays, Number(existing.generation_retention_days));
  const agentDays = zeroRetention ? 0 : retentionDays(payload.agentRetentionDays, Number(existing.agent_retention_days));
  if (payload.residencyRegion !== undefined && payload.residencyRegion !== RESIDENCY_REGION) {
    throw governanceError("This GoodSpeech deployment currently enforces United States — West residency.", 409, "GOODSPEECH_RESIDENCY_UNAVAILABLE");
  }
  if (payload.modelTrainingEnabled === true) {
    throw governanceError("Shared-model training cannot be enabled for GoodSpeech content.", 409, "GOODSPEECH_TRAINING_DISABLED");
  }
  const result = await database.query(
    `UPDATE goodspeech_privacy_settings
     SET project_id=COALESCE($3,project_id), environment_id=COALESCE($4,environment_id),
         zero_retention=$5, generation_retention_days=$6, agent_retention_days=$7,
         residency_region=$8, model_training_opt_out=TRUE, updated_at=NOW()
     WHERE organization_id=$1 AND owner_user_id=$2::uuid RETURNING *`,
    [current.organizationId, userId, current.projectId, current.environmentId, zeroRetention,
      generationDays, agentDays, RESIDENCY_REGION],
  );
  const purge = zeroRetention ? await purgeUserContent({ context, userId }) : null;
  return { ...publicSettings(result.rows[0]), purge };
}

async function purgeExpiredContent(limit = 25, now = Date.now()) {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return [];
  lastCleanupAt = now;
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const expired = await database.query(
    `SELECT history.id AS history_id, history.owner_user_id, asset.id AS asset_id, asset.storage_file_id
     FROM goodspeech_generation_history history
     JOIN goodspeech_privacy_settings privacy
       ON privacy.organization_id=history.organization_id AND privacy.owner_user_id=history.owner_user_id
     LEFT JOIN goodspeech_assets asset ON asset.id=history.asset_id
     WHERE privacy.zero_retention=TRUE
        OR history.created_at < NOW()-(privacy.generation_retention_days*INTERVAL '1 day')
     ORDER BY history.created_at ASC LIMIT $1`,
    [boundedLimit],
  );
  const purgedHistory = await purgeHistoryRows(expired.rows, "GoodSpeech retention policy");
  const agentTools = await database.query(
    `DELETE FROM goodspeech_agent_tool_calls call
     USING goodspeech_agent_sessions session, goodspeech_privacy_settings privacy
     WHERE call.session_id=session.id
       AND privacy.organization_id=session.organization_id AND privacy.owner_user_id=session.owner_user_id
       AND session.ended_at IS NOT NULL
       AND (privacy.zero_retention=TRUE OR session.ended_at < NOW()-(privacy.agent_retention_days*INTERVAL '1 day'))
     RETURNING call.id`,
  );
  const agentMessages = await database.query(
    `DELETE FROM goodspeech_agent_messages message
     USING goodspeech_agent_sessions session, goodspeech_privacy_settings privacy
     WHERE message.session_id=session.id
       AND privacy.organization_id=session.organization_id AND privacy.owner_user_id=session.owner_user_id
       AND session.ended_at IS NOT NULL
       AND (privacy.zero_retention=TRUE OR session.ended_at < NOW()-(privacy.agent_retention_days*INTERVAL '1 day'))
     RETURNING message.id`,
  );
  const expiredStudio = await database.query(
    `SELECT job.id, job.owner_user_id, job.output_asset_id
     FROM goodspeech_studio_jobs job
     JOIN goodspeech_privacy_settings privacy
       ON privacy.organization_id=job.organization_id AND privacy.owner_user_id=job.owner_user_id
     WHERE job.clips_json<>'[]'::jsonb
       AND (privacy.zero_retention=TRUE OR COALESCE(job.completed_at,job.created_at) < NOW()-(privacy.generation_retention_days*INTERVAL '1 day'))
     ORDER BY COALESCE(job.completed_at,job.created_at) ASC LIMIT $1`,
    [boundedLimit],
  );
  const studioResult = await purgeStudioRows(expiredStudio.rows, "GoodSpeech retention policy");
  const result = { histories: purgedHistory.length, agentMessages: agentMessages.rowCount, agentToolCalls: agentTools.rowCount, ...studioResult };
  return Object.values(result).some((value) => Number(value) > 0) ? [result] : [];
}

async function qualitySummary({ context, userId }) {
  const current = scope(context);
  const [latencies, monthly] = await Promise.all([
    database.query(
      `SELECT COUNT(*)::int AS samples,
        ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(NULLIF(metadata_json->>'firstByteMs','')::numeric,NULLIF(metadata_json->>'latencyMs','')::numeric)))::int AS p50_first_audio_ms,
        ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY COALESCE(NULLIF(metadata_json->>'firstByteMs','')::numeric,NULLIF(metadata_json->>'latencyMs','')::numeric)))::int AS p95_first_audio_ms,
        ROUND(AVG(NULLIF(metadata_json->>'latencyMs','')::numeric))::int AS average_generation_ms
       FROM backend_usage_events
       WHERE organization_id=$1 AND user_id=$2::uuid AND metric_key='goodspeech.characters.monthly'
         AND created_at>=NOW()-INTERVAL '30 days'
         AND COALESCE(metadata_json->>'firstByteMs',metadata_json->>'latencyMs','') ~ '^[0-9]+$'`,
      [current.organizationId, userId],
    ),
    database.query(
      `SELECT COALESCE(SUM(successful_count),0)::int AS successes, COALESCE(SUM(failed_count),0)::int AS failures
       FROM goodspeech_monthly_usage WHERE organization_id=$1 AND user_id=$2::uuid AND period_start>=date_trunc('month',NOW())-INTERVAL '1 month'`,
      [current.organizationId, userId],
    ),
  ]);
  const latency = latencies.rows[0] || {};
  const counts = monthly.rows[0] || {};
  const total = Number(counts.successes || 0) + Number(counts.failures || 0);
  const failureRate = total ? Number(((Number(counts.failures || 0) / total) * 100).toFixed(2)) : null;
  return {
    windowDays: 30,
    samples: Number(latency.samples || 0),
    firstAudioMs: { p50: latency.p50_first_audio_ms === null ? null : Number(latency.p50_first_audio_ms), p95: latency.p95_first_audio_ms === null ? null : Number(latency.p95_first_audio_ms) },
    averageGenerationMs: latency.average_generation_ms === null ? null : Number(latency.average_generation_ms),
    reliability: { successes: Number(counts.successes || 0), failures: Number(counts.failures || 0), failureRatePercent: failureRate },
    objectives: { p95FirstAudioMs: 1000, failureRatePercent: 1 },
    objectiveStatus: {
      firstAudio: latency.p95_first_audio_ms === null ? "collecting" : Number(latency.p95_first_audio_ms) <= 1000 ? "met" : "missed",
      reliability: failureRate === null ? "collecting" : failureRate <= 1 ? "met" : "missed",
    },
  };
}

module.exports = {
  RETENTION_OPTIONS,
  RESIDENCY_REGION,
  retentionDays,
  publicSettings,
  getPrivacySettings,
  updatePrivacySettings,
  shouldRetainGeneratedContent,
  purgeUserContent,
  enforceSessionRetention,
  purgeExpiredContent,
  qualitySummary,
};
