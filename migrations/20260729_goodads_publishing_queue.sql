BEGIN;

ALTER TABLE goodads_publish_jobs
  DROP CONSTRAINT IF EXISTS goodads_publish_jobs_status_check;

ALTER TABLE goodads_publish_jobs
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS locked_by TEXT,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE goodads_publish_jobs
  ADD CONSTRAINT goodads_publish_jobs_status_check
  CHECK (status IN (
    'scheduled', 'queued', 'processing', 'retrying',
    'completed', 'partial', 'failed', 'cancelled', 'dead_letter'
  ));

ALTER TABLE goodads_publish_jobs
  DROP CONSTRAINT IF EXISTS goodads_publish_jobs_attempts_check;
ALTER TABLE goodads_publish_jobs
  ADD CONSTRAINT goodads_publish_jobs_attempts_check
  CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10);

CREATE INDEX IF NOT EXISTS idx_goodads_publish_jobs_dispatch
  ON goodads_publish_jobs (status, available_at, scheduled_for, created_at)
  WHERE status IN ('scheduled', 'queued', 'retrying', 'processing');

CREATE TABLE IF NOT EXISTS goodads_publish_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES goodads_publish_jobs(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES goodads_social_connections(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'retrying', 'completed', 'failed', 'cancelled', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_until TIMESTAMPTZ,
  receipt JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_post_id TEXT,
  provider_post_url TEXT,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, connection_id)
);

CREATE INDEX IF NOT EXISTS idx_goodads_publish_targets_dispatch
  ON goodads_publish_targets (status, available_at, created_at)
  WHERE status IN ('queued', 'retrying', 'processing');

INSERT INTO backend_jobs (
  id, name, display_name, description, job_type, handler_key, status,
  priority, schedule_seconds, timeout_seconds, max_attempts, concurrency_key,
  next_run_at, metadata_json, organization_id, project_id, environment_id, created_by
)
VALUES (
  'job_goodads_social_publish',
  'goodads.social.publish',
  'GoodAds Social Publisher',
  'Dispatches due GoodAds publishing targets with bounded retries and durable provider receipts.',
  'scheduled',
  'goodads.social.publish',
  'active',
  4,
  10,
  240,
  3,
  'goodads.social.publish',
  NOW(),
  '{"application":"goodads","queue":"goodads_publish_targets"}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
)
ON CONFLICT (id) DO UPDATE SET
  handler_key = EXCLUDED.handler_key,
  status = 'active',
  schedule_seconds = EXCLUDED.schedule_seconds,
  timeout_seconds = EXCLUDED.timeout_seconds,
  concurrency_key = EXCLUDED.concurrency_key,
  metadata_json = COALESCE(backend_jobs.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
  updated_at = NOW();

GRANT SELECT, INSERT, UPDATE ON goodads_publish_jobs TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodads_publish_targets TO goodapp_backend_user;

COMMIT;
