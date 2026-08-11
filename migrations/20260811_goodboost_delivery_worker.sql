ALTER TABLE goodboost_publishing_posts
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS locked_by TEXT,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_receipt JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE goodboost_publishing_posts
  DROP CONSTRAINT IF EXISTS goodboost_publishing_posts_attempts_check;
ALTER TABLE goodboost_publishing_posts
  ADD CONSTRAINT goodboost_publishing_posts_attempts_check
  CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10);

CREATE INDEX IF NOT EXISTS goodboost_posts_delivery_idx
  ON goodboost_publishing_posts(status,available_at,scheduled_for,created_at)
  WHERE status IN ('scheduled','publishing');

INSERT INTO backend_jobs (
  id,name,display_name,description,job_type,handler_key,status,priority,
  schedule_seconds,timeout_seconds,max_attempts,concurrency_key,next_run_at,
  metadata_json,organization_id,project_id,environment_id,created_by
)
VALUES (
  'job_goodboost_social_publish','goodboost.social.publish','GoodBoost Social Publisher',
  'Dispatches approved GoodBoost posts with bounded retries, worker locks, idempotency, and provider receipts.',
  'scheduled','goodboost.social.publish','active',4,10,240,3,
  'goodboost.social.publish',NOW(),
  '{"application":"goodboost","queue":"goodboost_publishing_posts"}'::jsonb,
  'org_goodos','proj_goodos_platform','env_goodos_production',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
)
ON CONFLICT (id) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  description=EXCLUDED.description,
  handler_key=EXCLUDED.handler_key,
  status='active',
  schedule_seconds=EXCLUDED.schedule_seconds,
  timeout_seconds=EXCLUDED.timeout_seconds,
  max_attempts=EXCLUDED.max_attempts,
  concurrency_key=EXCLUDED.concurrency_key,
  metadata_json=COALESCE(backend_jobs.metadata_json,'{}'::jsonb)||EXCLUDED.metadata_json,
  updated_at=NOW();
