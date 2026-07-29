BEGIN;

CREATE TABLE IF NOT EXISTS goodads_ad_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES goodads_social_connections(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'meta')),
  provider_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'verified' CHECK (
    status IN ('verified', 'disabled', 'expired')
  ),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, provider, provider_account_id)
);

CREATE INDEX IF NOT EXISTS idx_goodads_ad_accounts_workspace
  ON goodads_ad_accounts (organization_id, status, provider, updated_at DESC);

CREATE TABLE IF NOT EXISTS goodads_provider_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES goodads_resources(id) ON DELETE CASCADE,
  ad_account_id UUID NOT NULL REFERENCES goodads_ad_accounts(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'meta')),
  provider_campaign_id TEXT,
  provider_resource_name TEXT,
  provider_budget_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'creating', 'paused', 'activating', 'active', 'pausing', 'failed', 'archived')
  ),
  campaign_version INTEGER NOT NULL,
  snapshot_hash TEXT NOT NULL,
  activation_approval_id UUID REFERENCES goodads_resources(id) ON DELETE SET NULL,
  receipt JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  last_synced_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, campaign_id, ad_account_id)
);

CREATE INDEX IF NOT EXISTS idx_goodads_provider_campaigns_workspace
  ON goodads_provider_campaigns (organization_id, campaign_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS goodads_ad_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  provider_campaign_id UUID NOT NULL REFERENCES goodads_provider_campaigns(id) ON DELETE CASCADE,
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  operation_type TEXT NOT NULL CHECK (
    operation_type IN ('create', 'sync', 'pause', 'activate', 'archive')
  ),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'processing', 'retrying', 'completed', 'failed', 'dead_letter')
  ),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  receipt JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_goodads_ad_operations_dispatch
  ON goodads_ad_operations (status, available_at, created_at)
  WHERE status IN ('queued', 'retrying');

INSERT INTO backend_jobs (
  id, name, display_name, description, job_type, handler_key, status,
  priority, schedule_seconds, timeout_seconds, max_attempts, concurrency_key,
  next_run_at, metadata_json, organization_id, project_id, environment_id, created_by
)
VALUES (
  'job_goodads_ad_operations_dispatch',
  'goodads.ads.dispatch',
  'GoodAds Paid Campaign Dispatcher',
  'Runs approved GoodAds paid-network operations with durable receipts and bounded retries.',
  'scheduled',
  'goodads.ads.dispatch',
  'active',
  5,
  30,
  120,
  3,
  'goodads.ads.dispatch',
  NOW(),
  '{"application":"goodads","resource":"paid_campaigns"}'::jsonb,
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

GRANT SELECT, INSERT, UPDATE ON goodads_ad_accounts TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE ON goodads_provider_campaigns TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE ON goodads_ad_operations TO goodapp_backend_user;

COMMIT;
