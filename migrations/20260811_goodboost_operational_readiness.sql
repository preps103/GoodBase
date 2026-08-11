ALTER TABLE goodboost_social_connections
  ADD COLUMN IF NOT EXISTS next_sync_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS sync_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sync_locked_by TEXT,
  ADD COLUMN IF NOT EXISTS sync_locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_error TEXT;

ALTER TABLE goodboost_social_connections
  DROP CONSTRAINT IF EXISTS goodboost_social_connections_sync_attempts_check;
ALTER TABLE goodboost_social_connections
  ADD CONSTRAINT goodboost_social_connections_sync_attempts_check
  CHECK (sync_attempts >= 0);

CREATE INDEX IF NOT EXISTS goodboost_social_connections_sync_idx
  ON goodboost_social_connections(status,next_sync_at,last_synced_at)
  WHERE status='active';

ALTER TABLE goodboost_publishing_posts
  DROP CONSTRAINT IF EXISTS goodboost_publishing_posts_status_check;
ALTER TABLE goodboost_publishing_posts
  ADD CONSTRAINT goodboost_publishing_posts_status_check
  CHECK (status IN ('draft','pending_approval','scheduled','publishing','published','failed','cancelled'));

INSERT INTO backend_jobs (
  id,name,display_name,description,job_type,handler_key,status,priority,
  schedule_seconds,timeout_seconds,max_attempts,concurrency_key,next_run_at,
  metadata_json,organization_id,project_id,environment_id,created_by
)
VALUES (
  'job_goodboost_social_sync','goodboost.social.sync','GoodBoost Provider Synchronizer',
  'Refreshes due GoodBoost connections with bounded provider payloads and transactional audience, inbox, and metric ingestion.',
  'scheduled','goodboost.social.sync','active',5,300,240,3,
  'goodboost.social.sync',NOW(),
  '{"application":"goodboost","resource":"social-connections"}'::jsonb,
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

INSERT INTO goodbase_ai_policies (
  organization_id,project_id,environment_id,name,app_id,require_attestation,
  allowed_model_aliases,allowed_tools,max_input_tokens,max_output_tokens,
  requests_per_minute,tokens_per_day,safety_json,status,created_by
)
VALUES (
  'org_goodos','proj_goodos_platform','env_goodos_production',
  'GoodBoost Growth Tools','goodboost',FALSE,
  ARRAY['goodboost-growth']::TEXT[],ARRAY[]::TEXT[],4096,1200,30,250000,
  '{"blockedTerms":["buy followers","sell followers","credential stuffing","password harvesting"]}'::jsonb,
  'active',(SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
)
ON CONFLICT (organization_id,project_id,environment_id,name) DO UPDATE SET
  app_id='goodboost',
  require_attestation=FALSE,
  allowed_model_aliases=ARRAY['goodboost-growth']::TEXT[],
  allowed_tools=ARRAY[]::TEXT[],
  max_input_tokens=4096,
  max_output_tokens=1200,
  requests_per_minute=30,
  tokens_per_day=250000,
  safety_json=EXCLUDED.safety_json,
  status='active',
  updated_at=NOW();
