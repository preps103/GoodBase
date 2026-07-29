BEGIN;

CREATE TABLE IF NOT EXISTS goodads_competitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  project_id TEXT,
  environment_id TEXT,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  domain TEXT NOT NULL,
  display_name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'US',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodads_competitors_domain
  ON goodads_competitors (organization_id, LOWER(domain))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_goodads_competitors_workspace
  ON goodads_competitors (organization_id, status, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS goodads_competitor_creatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id UUID NOT NULL REFERENCES goodads_competitors(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  project_id TEXT,
  environment_id TEXT,
  captured_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source_provider TEXT NOT NULL CHECK (source_provider IN (
    'manual', 'similarweb', 'meta_library', 'google_transparency',
    'tiktok_creative_center', 'linkedin_ad_library'
  )),
  provenance TEXT NOT NULL CHECK (provenance IN ('user_observed', 'licensed_api', 'public_library')),
  source_ad_id TEXT,
  source_url TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('search', 'display', 'video', 'social', 'product', 'other')),
  ad_format TEXT NOT NULL CHECK (ad_format IN ('text', 'image', 'video', 'carousel', 'html5', 'native', 'product', 'other')),
  headline TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  call_to_action TEXT NOT NULL DEFAULT '',
  landing_url TEXT,
  creative_url TEXT,
  preview_image_url TEXT,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  countries TEXT[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT NOT NULL DEFAULT '',
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodads_competitor_creative_provider_id
  ON goodads_competitor_creatives (organization_id, source_provider, source_ad_id)
  WHERE archived_at IS NULL AND source_ad_id IS NOT NULL AND source_ad_id <> '';

CREATE INDEX IF NOT EXISTS idx_goodads_competitor_creatives_workspace
  ON goodads_competitor_creatives (organization_id, competitor_id, channel, last_seen_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS goodads_competitor_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id UUID NOT NULL REFERENCES goodads_competitors(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  source_provider TEXT NOT NULL CHECK (source_provider IN ('similarweb')),
  country TEXT NOT NULL DEFAULT 'US',
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  fingerprint TEXT,
  error_message TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodads_competitor_snapshots_workspace
  ON goodads_competitor_snapshots (organization_id, competitor_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS goodads_competitor_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id UUID NOT NULL REFERENCES goodads_competitors(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL CHECK (alert_type IN (
    'new_competitor', 'strategy_change', 'spend_change', 'network_change', 'sync_failed'
  )),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'notice', 'warning')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodads_competitor_alerts_workspace
  ON goodads_competitor_alerts (organization_id, acknowledged_at, created_at DESC);

INSERT INTO backend_jobs (
  id, name, display_name, description, job_type, handler_key, status,
  priority, schedule_seconds, timeout_seconds, max_attempts, concurrency_key,
  next_run_at, metadata_json, organization_id, project_id, environment_id, created_by
)
VALUES (
  'job_goodads_competitor_sync',
  'goodads.competitors.sync',
  'GoodAds Competitor Intelligence Sync',
  'Refreshes licensed competitor intelligence for tracked GoodAds domains.',
  'scheduled',
  'goodads.competitors.sync',
  'active',
  5,
  21600,
  300,
  3,
  'goodads.competitors.sync',
  NOW(),
  '{"application":"goodads","resource":"competitor-intelligence"}'::jsonb,
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

GRANT SELECT, INSERT, UPDATE, DELETE ON goodads_competitors TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodads_competitor_creatives TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE ON goodads_competitor_snapshots TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE ON goodads_competitor_alerts TO goodapp_backend_user;

COMMIT;
