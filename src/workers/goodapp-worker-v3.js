"use strict";

process.env.GOODBASE_RUNTIME_ROLE =
  process.env.GOODBASE_RUNTIME_ROLE || "worker";
process.env.OTEL_SERVICE_NAME =
  process.env.OTEL_SERVICE_NAME || "goodbase-worker";
require("../telemetry/bootstrap");

const crypto = require("crypto");
const os = require("os");
const { observeWorkerTick } = require("../telemetry/metrics");
const { shutdownTelemetry } = require("../telemetry/bootstrap");

require("../config/env");

const database =
  require("../config/database");

const legacyJobs =
  require("../services/job.service");
const marketplaceMessages =
  require("../services/fleet-marketplace-message.service");

const pool =
  database.pool ||
  (
    typeof database.getPool === "function"
      ? database.getPool()
      : null
  );

const query =
  typeof database.query === "function"
    ? database.query.bind(database)
    : pool &&
      typeof pool.query === "function"
      ? pool.query.bind(pool)
      : null;

if (
  !query ||
  !pool ||
  typeof pool.connect !== "function"
) {
  throw new Error(
    "GoodOS PostgreSQL pool could not be resolved."
  );
}

const workerId =
  process.env.GOODAPP_WORKER_ID ||
  `goodapp-worker-v3-${os.hostname()}`;

const workerName =
  process.env.GOODAPP_WORKER_NAME ||
  "goodapp-worker-v3";

const intervalMs = Math.max(
  2000,
  Number(
    process.env.GOODAPP_WORKER_INTERVAL_MS ||
    5000
  )
);

let running = false;
let stopping = false;
let lastLegacyRun = 0;

function randomId(prefix) {
  return (
    prefix +
    "_" +
    crypto.randomUUID().replace(/-/g, "")
  );
}

async function transaction(callback) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await callback(client);

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recoverExpiredLocks() {
  await query(
    `
      UPDATE backend_event_outbox
      SET
        status = 'retrying',
        available_at = NOW(),
        locked_by = NULL,
        locked_until = NULL,
        error_message = COALESCE(
          error_message,
          'Recovered after worker lock expiration.'
        )
      WHERE status = 'processing'
        AND locked_until < NOW()
    `
  );
}

async function claimEvent() {
  return transaction(async client => {
    const result = await client.query(
      `
        WITH selected AS (
          SELECT id
          FROM backend_event_outbox
          WHERE status IN (
              'pending',
              'retrying'
            )
            AND available_at <= NOW()
            AND (
              locked_until IS NULL
              OR locked_until < NOW()
            )
          ORDER BY
            available_at ASC,
            created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE backend_event_outbox event
        SET
          status = 'processing',
          attempts = attempts + 1,
          locked_by = $1,
          locked_until =
            NOW() + INTERVAL '2 minutes',
          error_message = NULL
        FROM selected
        WHERE event.id = selected.id
        RETURNING event.*
      `,
      [workerId]
    );

    return result.rows[0] || null;
  });
}

async function publishEvent(event) {
  if (
    event.event_type ===
    "phase3.verification.force_failure"
  ) {
    throw new Error(
      "Intentional Phase 3 retry and dead-letter verification."
    );
  }

  return transaction(async client => {
    const publishedEventId =
      "evt3_" +
      event.id
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(-48);

    await client.query(
      `
        INSERT INTO backend_events (
          id,
          event_type,
          source,
          message,
          payload
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5::jsonb
        )
        ON CONFLICT (id)
        DO NOTHING
      `,
      [
        publishedEventId,
        event.event_type,
        event.source,
        event.message,
        JSON.stringify({
          ...(event.payload_json || {}),
          phase3OutboxId: event.id,
          phase3Metadata:
            event.metadata_json || {}
        })
      ]
    );

    const updated = await client.query(
      `
        UPDATE backend_event_outbox
        SET
          status = 'published',
          published_event_id = $2,
          published_at = NOW(),
          locked_by = NULL,
          locked_until = NULL,
          error_message = NULL
        WHERE id = $1
        RETURNING
          id,
          status,
          published_event_id
      `,
      [
        event.id,
        publishedEventId
      ]
    );

    if (!updated.rows[0]) {
      throw new Error(
        "Outbox record could not be marked published."
      );
    }

    return updated.rows[0];
  });
}

async function moveToDeadLetter(
  event,
  errorMessage
) {
  await transaction(async client => {
    await client.query(
      `
        UPDATE backend_event_outbox
        SET
          status = 'dead_letter',
          dead_lettered_at = NOW(),
          locked_by = NULL,
          locked_until = NULL,
          error_message = $2
        WHERE id = $1
      `,
      [
        event.id,
        errorMessage
      ]
    );

    await client.query(
      `
        INSERT INTO backend_dead_letters (
          id,
          source_table,
          source_id,
          event_type,
          payload_json,
          metadata_json,
          attempts,
          error_message
        )
        VALUES (
          $1,
          'backend_event_outbox',
          $2,
          $3,
          $4::jsonb,
          $5::jsonb,
          $6,
          $7
        )
        ON CONFLICT (
          source_table,
          source_id
        )
        DO UPDATE SET
          attempts = EXCLUDED.attempts,
          error_message =
            EXCLUDED.error_message,
          dead_lettered_at = NOW(),
          resolution_status = 'open',
          updated_at = NOW()
      `,
      [
        randomId("dead"),
        event.id,
        event.event_type,
        JSON.stringify(
          event.payload_json || {}
        ),
        JSON.stringify(
          event.metadata_json || {}
        ),
        Number(event.attempts || 1),
        errorMessage
      ]
    );
  });
}

async function retryOrDeadLetter(
  event,
  error
) {
  const errorMessage = String(
    error?.message ||
    error ||
    "Outbox publication failed."
  ).slice(0, 8000);

  const attempts =
    Number(event.attempts || 1);

  const maximum =
    Number(event.max_attempts || 5);

  if (attempts >= maximum) {
    await moveToDeadLetter(
      event,
      errorMessage
    );

    return "dead_letter";
  }

  const delay = Math.min(
    3600,
    Number(event.backoff_seconds || 30) *
      Math.pow(
        2,
        Math.max(0, attempts - 1)
      )
  );

  await query(
    `
      UPDATE backend_event_outbox
      SET
        status = 'retrying',
        available_at =
          NOW() +
          ($2::text || ' seconds')::interval,
        locked_by = NULL,
        locked_until = NULL,
        error_message = $3
      WHERE id = $1
    `,
    [
      event.id,
      delay,
      errorMessage
    ]
  );

  return "retrying";
}

async function processOutbox(
  limit = 20
) {
  const results = [];

  for (
    let index = 0;
    index < limit;
    index += 1
  ) {
    const event = await claimEvent();

    if (!event) {
      break;
    }

    try {
      const published =
        await publishEvent(event);

      results.push({
        id: event.id,
        status: published.status
      });
    } catch (error) {
      const status =
        await retryOrDeadLetter(
          event,
          error
        );

      results.push({
        id: event.id,
        status,
        error: error.message
      });
    }
  }

  return results;
}

async function heartbeat(
  status,
  metadata = {}
) {
  await legacyJobs.heartbeat(
    workerId,
    status,
    {
      phase: "3",
      workerName,
      processId: process.pid,
      hostname: os.hostname(),
      intervalMs,
      ...metadata
    }
  );
}

async function tick() {
  const tickStarted = process.hrtime.bigint();
  if (running || stopping) {
    return;
  }

  running = true;

  try {
    await recoverExpiredLocks();

    const outboxResults =
      await processOutbox();
    const marketplaceMessageResults =
      await marketplaceMessages.processScheduledTripMessages();

    let legacyBatchProcessed = false;

    if (
      Date.now() - lastLegacyRun >=
      60000
    ) {
      await legacyJobs.runDueJobs({
        workerId,
        source: workerName
      });

      lastLegacyRun = Date.now();
      legacyBatchProcessed = true;
    }

    await heartbeat("online", {
      outboxProcessed:
        outboxResults.length,
      marketplaceMessagesProcessed:
        marketplaceMessageResults.length,
      legacyBatchProcessed,
      lastTickAt:
        new Date().toISOString()
    });

    observeWorkerTick({
      status: "success",
      durationMs: Number(process.hrtime.bigint() - tickStarted) / 1e6,
      eventCount:
        outboxResults.length +
        marketplaceMessageResults.length,
    });

    if (
      outboxResults.length > 0 ||
      marketplaceMessageResults.length > 0 ||
      legacyBatchProcessed
    ) {
      console.log(
        "[goodapp-worker-v3] tick",
        JSON.stringify({
          outboxResults,
          marketplaceMessageResults,
          legacyBatchProcessed
        })
      );
    }
  } catch (error) {
    observeWorkerTick({
      status: "failed",
      durationMs: Number(process.hrtime.bigint() - tickStarted) / 1e6,
    });
    console.error(
      "[goodapp-worker-v3] tick failed:",
      error
    );

    try {
      await heartbeat("degraded", {
        lastError:
          String(error.message).slice(
            0,
            2000
          )
      });
    } catch (
      heartbeatError
    ) {
      console.error(
        "[goodapp-worker-v3] heartbeat failed:",
        heartbeatError.message
      );
    }
  } finally {
    running = false;
  }
}

async function shutdown(signal) {
  if (stopping) {
    return;
  }

  stopping = true;

  try {
    await heartbeat("stopping", {
      signal
    });
  } catch (error) {
    console.error(
      "[goodapp-worker-v3] shutdown heartbeat failed:",
      error.message
    );
  }

  await shutdownTelemetry();

  process.exit(0);
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "[goodapp-worker-v3] uncaught exception:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "[goodapp-worker-v3] unhandled rejection:",
      error
    );
  }
);

console.log(
  "[goodapp-worker-v3] starting",
  JSON.stringify({
    workerId,
    workerName,
    intervalMs,
    processId: process.pid
  })
);

heartbeat("starting")
  .then(tick)
  .catch(error => {
    console.error(
      "[goodapp-worker-v3] startup failed:",
      error
    );

    process.exit(1);
  });

setInterval(
  tick,
  intervalMs
);
