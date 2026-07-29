BEGIN;

ALTER TABLE goodads_publish_jobs
  ADD COLUMN IF NOT EXISTS approval_id UUID
    REFERENCES goodads_resources(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_goodads_publish_jobs_approval
  ON goodads_publish_jobs (organization_id, approval_id)
  WHERE approval_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodads_approval_request_key
  ON goodads_resources (organization_id, (data->>'requestKey'))
  WHERE resource_type = 'approvals'
    AND archived_at IS NULL
    AND COALESCE(data->>'requestKey', '') <> '';

CREATE TABLE IF NOT EXISTS goodads_engagement_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES goodads_social_connections(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (
    item_type IN ('comment', 'direct_message', 'mention', 'review')
  ),
  author_name TEXT NOT NULL DEFAULT '',
  author_handle TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  permalink TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (
    status IN ('new', 'open', 'pending', 'resolved', 'archived')
  ),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (
    priority IN ('low', 'normal', 'high', 'urgent')
  ),
  moderation_status TEXT NOT NULL DEFAULT 'visible' CHECK (
    moderation_status IN ('visible', 'hidden', 'spam', 'escalated')
  ),
  sentiment TEXT NOT NULL DEFAULT 'unknown' CHECK (
    sentiment IN ('positive', 'neutral', 'negative', 'unknown')
  ),
  assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  response_draft TEXT NOT NULL DEFAULT '',
  provider_created_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, provider, provider_item_id)
);

CREATE INDEX IF NOT EXISTS idx_goodads_engagement_inbox
  ON goodads_engagement_items (organization_id, status, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_goodads_engagement_assignee
  ON goodads_engagement_items (organization_id, assigned_user_id, updated_at DESC)
  WHERE assigned_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS goodads_automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES goodads_resources(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  triggered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'completed', 'skipped', 'failed')
  ),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE goodads_automation_runs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

UPDATE goodads_automation_runs
SET idempotency_key = 'legacy:' || id::text
WHERE idempotency_key IS NULL;

ALTER TABLE goodads_automation_runs
  ALTER COLUMN idempotency_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodads_automation_run_idempotency
  ON goodads_automation_runs (organization_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_goodads_automation_runs_rule
  ON goodads_automation_runs (organization_id, automation_id, started_at DESC);

INSERT INTO backend_jobs (
  id, name, display_name, description, job_type, handler_key, status,
  priority, schedule_seconds, timeout_seconds, max_attempts, concurrency_key,
  next_run_at, metadata_json, organization_id, project_id, environment_id, created_by
)
VALUES (
  'job_goodads_automation_dispatch',
  'goodads.automations.dispatch',
  'GoodAds Automation Dispatcher',
  'Runs due GoodAds workflow rules with durable execution history and bounded actions.',
  'scheduled',
  'goodads.automations.dispatch',
  'active',
  5,
  60,
  120,
  3,
  'goodads.automations.dispatch',
  NOW(),
  '{"application":"goodads","resource":"automations"}'::jsonb,
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

GRANT SELECT, INSERT, UPDATE ON goodads_engagement_items TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE ON goodads_automation_runs TO goodapp_backend_user;

COMMIT;
