BEGIN;

CREATE TABLE IF NOT EXISTS goodads_analytics_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  provider_campaign_id UUID NOT NULL REFERENCES goodads_provider_campaigns(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'meta')),
  provider_account_id TEXT NOT NULL,
  provider_campaign_reference TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT '',
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  impressions BIGINT NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks BIGINT NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  conversions NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (conversions >= 0),
  spend_micros BIGINT NOT NULL DEFAULT 0 CHECK (spend_micros >= 0),
  conversion_value_micros BIGINT NOT NULL DEFAULT 0 CHECK (conversion_value_micros >= 0),
  raw_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_campaign_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_goodads_analytics_workspace
  ON goodads_analytics_snapshots (organization_id, period_start, period_end, captured_at DESC);

INSERT INTO backend_jobs (
  id, name, display_name, description, job_type, handler_key, status,
  priority, schedule_seconds, timeout_seconds, max_attempts, concurrency_key,
  next_run_at, metadata_json, organization_id, project_id, environment_id, created_by
)
VALUES (
  'job_goodads_analytics_sync',
  'goodads.analytics.sync',
  'GoodAds Provider Analytics Sync',
  'Refreshes verified paid-campaign delivery metrics from configured providers.',
  'scheduled',
  'goodads.analytics.sync',
  'active',
  4,
  900,
  180,
  3,
  'goodads.analytics.sync',
  NOW(),
  '{"application":"goodads","resource":"analytics"}'::jsonb,
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

GRANT SELECT, INSERT, UPDATE ON goodads_analytics_snapshots TO goodapp_backend_user;

COMMIT;
