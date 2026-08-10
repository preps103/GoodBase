BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS goodscan_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  name TEXT NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'Photo Scan',
  status TEXT NOT NULL DEFAULT 'draft',
  quality TEXT,
  folder TEXT,
  use_case TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  thumbnail_url TEXT,
  preview_url TEXT,
  model_url TEXT,
  source_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  outputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
  processing_seconds INTEGER,
  credits_used INTEGER,
  progress NUMERIC(5,2),
  views BIGINT NOT NULL DEFAULT 0,
  appreciations BIGINT NOT NULL DEFAULT 0,
  failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT goodscan_asset_status_valid CHECK (status IN ('draft','queued','processing','completed','failed','cancelled')),
  CONSTRAINT goodscan_asset_visibility_valid CHECK (visibility IN ('private','workspace','public')),
  CONSTRAINT goodscan_asset_progress_valid CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100))
);

CREATE INDEX IF NOT EXISTS idx_goodscan_assets_owner_updated
  ON goodscan_assets (owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_goodscan_assets_public_updated
  ON goodscan_assets (updated_at DESC)
  WHERE visibility = 'public' AND status = 'completed';
CREATE INDEX IF NOT EXISTS idx_goodscan_assets_status
  ON goodscan_assets (status, updated_at DESC)
  WHERE status IN ('queued','processing');

CREATE TABLE IF NOT EXISTS goodscan_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  device_public_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_goodscan_devices_owner
  ON goodscan_devices (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS goodscan_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  action_url TEXT,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT goodscan_integration_status_valid CHECK (status IN ('connected','available','planned','error')),
  CONSTRAINT goodscan_integration_owner_slug_unique UNIQUE (owner_user_id, slug)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodscan_assets TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodscan_devices TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodscan_integrations TO goodapp_backend_user;

COMMIT;
