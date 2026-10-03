"use strict";

const crypto = require("node:crypto");
const database = require("../config/database");

const DEFAULT_REQUEST_LIMIT = 1_000;
const DEFAULT_CHARACTER_LIMIT = 200_000;

function positiveLimit(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function limits() {
  return {
    requests: positiveLimit(process.env.GOODSPEECH_MONTHLY_REQUEST_LIMIT, DEFAULT_REQUEST_LIMIT),
    characters: positiveLimit(process.env.GOODSPEECH_MONTHLY_CHARACTER_LIMIT, DEFAULT_CHARACTER_LIMIT),
  };
}

function periodBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function scope(context = {}) {
  return {
    organizationId: String(context.organizationId || "org_goodos"),
    projectId: context.projectId ? String(context.projectId) : null,
    environmentId: context.environmentId ? String(context.environmentId) : null,
  };
}

function quotaError(message, current, limit, metric) {
  const error = new Error(message);
  error.statusCode = 429;
  error.code = "GOODSPEECH_QUOTA_EXCEEDED";
  error.metric = metric;
  error.current = current;
  error.limit = limit;
  return error;
}

function usageSnapshot(row, configuredLimits = limits(), bounds = periodBounds()) {
  const requests = Number(row?.request_count || 0);
  const characters = Number(row?.text_characters || 0);
  const successes = Number(row?.successful_count || 0);
  const failures = Number(row?.failed_count || 0);
  const audioBytes = Number(row?.audio_bytes || 0);
  const latencyTotal = Number(row?.latency_ms_total || 0);
  const requestLimit = Number(row?.request_limit || configuredLimits.requests);
  const characterLimit = Number(row?.character_limit || configuredLimits.characters);
  return {
    period: {
      start: row?.period_start || bounds.start,
      end: row?.period_end || bounds.end,
      timezone: "UTC",
    },
    usage: {
      requests,
      successfulRequests: successes,
      failedRequests: failures,
      characters,
      audioBytes,
      averageLatencyMs: successes > 0 ? Math.round(latencyTotal / successes) : null,
    },
    limits: {
      requests: requestLimit,
      characters: characterLimit,
    },
    remaining: {
      requests: Math.max(0, requestLimit - requests),
      characters: Math.max(0, characterLimit - characters),
    },
    percentUsed: {
      requests: Math.min(100, Math.round((requests / requestLimit) * 100)),
      characters: Math.min(100, Math.round((characters / characterLimit) * 100)),
    },
    pricing: {
      status: "included_beta",
      currency: "USD",
      amountDueCents: 0,
      message: "GoodSpeech synthesis is included during beta; monthly safeguards still apply.",
    },
  };
}

async function getUsage({ userId, context }) {
  const configuredLimits = limits();
  const bounds = periodBounds();
  const currentScope = scope(context);
  const result = await database.query(
    `SELECT * FROM goodspeech_monthly_usage
     WHERE organization_id = $1 AND user_id = $2::uuid AND period_start = $3::date
     LIMIT 1`,
    [currentScope.organizationId, userId, bounds.start],
  );
  return usageSnapshot(result.rows[0], configuredLimits, bounds);
}

async function reserveUsage({ userId, context, characters }) {
  const quantity = Number(characters);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2_000) {
    throw Object.assign(new Error("A valid synthesis character count is required."), {
      statusCode: 400,
      code: "GOODSPEECH_USAGE_INVALID",
    });
  }

  const configuredLimits = limits();
  const bounds = periodBounds();
  const currentScope = scope(context);
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO goodspeech_monthly_usage (
         organization_id, project_id, environment_id, user_id, period_start, period_end,
         request_limit, character_limit
       ) VALUES ($1,$2,$3,$4::uuid,$5::date,$6::date,$7,$8)
       ON CONFLICT (organization_id, user_id, period_start) DO NOTHING`,
      [currentScope.organizationId, currentScope.projectId, currentScope.environmentId, userId,
        bounds.start, bounds.end, configuredLimits.requests, configuredLimits.characters],
    );
    const locked = await client.query(
      `SELECT * FROM goodspeech_monthly_usage
       WHERE organization_id = $1 AND user_id = $2::uuid AND period_start = $3::date
       FOR UPDATE`,
      [currentScope.organizationId, userId, bounds.start],
    );
    const row = locked.rows[0];
    const requestLimit = Number(row.request_limit || configuredLimits.requests);
    const characterLimit = Number(row.character_limit || configuredLimits.characters);
    const currentRequests = Number(row.request_count || 0);
    const currentCharacters = Number(row.text_characters || 0);
    if (currentRequests + 1 > requestLimit) {
      throw quotaError("Your monthly GoodSpeech generation limit has been reached.", currentRequests, requestLimit, "requests");
    }
    if (currentCharacters + quantity > characterLimit) {
      throw quotaError("Your monthly GoodSpeech character limit has been reached.", currentCharacters, characterLimit, "characters");
    }
    const updated = await client.query(
      `UPDATE goodspeech_monthly_usage
       SET request_count = request_count + 1,
           text_characters = text_characters + $4,
           project_id = COALESCE($5, project_id),
           environment_id = COALESCE($6, environment_id),
           updated_at = NOW()
       WHERE organization_id = $1 AND user_id = $2::uuid AND period_start = $3::date
       RETURNING *`,
      [currentScope.organizationId, userId, bounds.start, quantity, currentScope.projectId, currentScope.environmentId],
    );
    await client.query("COMMIT");
    return {
      reservationId: `gsr_${crypto.randomUUID().replace(/-/g, "")}`,
      characters: quantity,
      scope: currentScope,
      period: bounds,
      snapshot: usageSnapshot(updated.rows[0], configuredLimits, bounds),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function finishUsage({ userId, reservation, audioBytes, latencyMs, success, request }) {
  const bytes = Math.max(0, Math.round(Number(audioBytes) || 0));
  const latency = Math.max(0, Math.round(Number(latencyMs) || 0));
  const { organizationId, projectId, environmentId } = reservation.scope;
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const updated = success
      ? await client.query(
        `UPDATE goodspeech_monthly_usage
         SET successful_count = successful_count + 1,
             audio_bytes = audio_bytes + $4,
             latency_ms_total = latency_ms_total + $5,
             updated_at = NOW()
         WHERE organization_id = $1 AND user_id = $2::uuid AND period_start = $3::date
         RETURNING *`,
        [organizationId, userId, reservation.period.start, bytes, latency],
      )
      : await client.query(
        `UPDATE goodspeech_monthly_usage
         SET request_count = GREATEST(0, request_count - 1),
             text_characters = GREATEST(0, text_characters - $4),
             failed_count = failed_count + 1,
             updated_at = NOW()
         WHERE organization_id = $1 AND user_id = $2::uuid AND period_start = $3::date
         RETURNING *`,
        [organizationId, userId, reservation.period.start, reservation.characters],
      );

    if (success) {
      const eventId = `usageevt_${crypto.randomUUID().replace(/-/g, "")}`;
      const route = String(request?.originalUrl || "/api/goodspeech/v1/speech").split("?")[0].slice(0, 500);
      const metadata = JSON.stringify({
        reservationId: reservation.reservationId,
        audioBytes: bytes,
        latencyMs: latency,
      });
      await client.query(
        `INSERT INTO backend_usage_events (
           id, metric_key, category, source, quantity, unit, user_id,
           organization_id, project_id, environment_id, route, method, status_code, metadata_json
         ) VALUES ($1,'goodspeech.characters.monthly','ai-speech','goodspeech',$2,'characters',$3::uuid,$4,$5,$6,$7,'POST',200,$8::jsonb)`,
        [eventId, reservation.characters, userId, organizationId, projectId, environmentId, route, metadata],
      );
      await client.query(
        `INSERT INTO backend_meter_events (
           id, metric_key, meter_name, quantity, unit, billable,
           organization_id, project_id, environment_id, usage_event_id, metadata_json
         ) VALUES ($1,'goodspeech.characters.monthly','goodspeech_characters',$2,'characters',false,$3,$4,$5,$6,$7::jsonb)`,
        [`meter_${crypto.randomUUID().replace(/-/g, "")}`, reservation.characters, organizationId,
          projectId, environmentId, eventId, metadata],
      );
    }
    await client.query("COMMIT");
    return usageSnapshot(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[GoodSpeech usage] completion failed:", error.message);
    return null;
  } finally {
    client.release();
  }
}

module.exports = {
  DEFAULT_REQUEST_LIMIT,
  DEFAULT_CHARACTER_LIMIT,
  limits,
  periodBounds,
  usageSnapshot,
  getUsage,
  reserveUsage,
  finishUsage,
};
