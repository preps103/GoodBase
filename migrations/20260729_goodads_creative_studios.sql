BEGIN;

INSERT INTO backend_storage_buckets (
  id,
  name,
  visibility,
  status,
  created_by,
  max_file_size_bytes,
  allowed_mime_types,
  allowed_extensions,
  public_read_enabled,
  signed_url_ttl_seconds,
  file_versioning_enabled,
  virus_scan_required,
  encryption_mode,
  provider,
  provider_config_id,
  provider_bucket_name,
  provider_region,
  provider_endpoint,
  provider_prefix,
  cdn_enabled,
  cdn_base_url,
  cache_control,
  object_lock_enabled,
  lifecycle_json,
  cors_json,
  storage_class,
  checksum_algorithm,
  metadata_json,
  organization_id,
  project_id,
  environment_id
)
VALUES (
  'bucket_goodads_creative_assets',
  'goodads-creative-assets',
  'public',
  'active',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  104857600,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'video/mp4'],
  ARRAY['.png', '.jpg', '.jpeg', '.webp', '.mp4'],
  TRUE,
  900,
  TRUE,
  FALSE,
  'local',
  'local',
  'storage_provider_local_goodos',
  'goodads-creative-assets',
  'local',
  'file:///var/www/GoodAppBackEnd/storage/buckets',
  'goodads',
  FALSE,
  NULL,
  'public, max-age=31536000, immutable',
  FALSE,
  '{"deleteAfterDays":null,"archiveAfterDays":null}'::jsonb,
  '{"allowedOrigins":["https://ads.goodos.app"],"allowedMethods":["GET","HEAD"]}'::jsonb,
  'standard',
  'sha256',
  '{"application":"goodads","purpose":"campaign creative and video assets"}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  visibility = EXCLUDED.visibility,
  status = EXCLUDED.status,
  max_file_size_bytes = EXCLUDED.max_file_size_bytes,
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  allowed_extensions = EXCLUDED.allowed_extensions,
  public_read_enabled = EXCLUDED.public_read_enabled,
  file_versioning_enabled = EXCLUDED.file_versioning_enabled,
  provider = EXCLUDED.provider,
  provider_config_id = EXCLUDED.provider_config_id,
  provider_bucket_name = EXCLUDED.provider_bucket_name,
  provider_region = EXCLUDED.provider_region,
  provider_endpoint = EXCLUDED.provider_endpoint,
  provider_prefix = EXCLUDED.provider_prefix,
  cache_control = EXCLUDED.cache_control,
  lifecycle_json = EXCLUDED.lifecycle_json,
  cors_json = EXCLUDED.cors_json,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS goodads_creative_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT,
  environment_id TEXT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL DEFAULT 'video' CHECK (job_type IN ('video')),
  provider TEXT NOT NULL DEFAULT 'openai',
  provider_job_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  prompt TEXT NOT NULL DEFAULT '',
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  asset_file_id TEXT REFERENCES backend_storage_files(id) ON DELETE SET NULL,
  asset_url TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (organization_id, provider, provider_job_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodads_creative_jobs_idempotency
  ON goodads_creative_jobs (organization_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_goodads_creative_jobs_workspace
  ON goodads_creative_jobs (organization_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_goodads_creative_jobs_owner
  ON goodads_creative_jobs (owner_user_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodads_creative_jobs TO goodapp_backend_user;

COMMIT;
