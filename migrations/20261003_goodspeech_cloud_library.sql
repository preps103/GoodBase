BEGIN;

INSERT INTO backend_storage_buckets (
  id, name, visibility, status, created_by, max_file_size_bytes,
  allowed_mime_types, allowed_extensions, public_read_enabled,
  signed_url_ttl_seconds, file_versioning_enabled, virus_scan_required,
  encryption_mode, provider, provider_config_id, provider_bucket_name,
  provider_region, provider_endpoint, provider_prefix, cdn_enabled,
  cdn_base_url, cache_control, object_lock_enabled, lifecycle_json,
  cors_json, storage_class, checksum_algorithm, metadata_json,
  organization_id, project_id, environment_id
)
VALUES (
  'bucket_goodspeech_user_assets',
  'goodspeech-user-assets',
  'private',
  'active',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  104857600,
  ARRAY[
    'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/ogg', 'audio/webm',
    'video/mp4', 'video/webm',
    'image/png', 'image/jpeg', 'image/webp',
    'text/plain', 'application/json', 'application/x-subrip', 'text/vtt'
  ],
  ARRAY['.wav', '.mp3', '.ogg', '.webm', '.mp4', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.json', '.srt', '.vtt'],
  FALSE,
  300,
  TRUE,
  FALSE,
  'local',
  'local',
  'storage_provider_local_goodos',
  'goodspeech-user-assets',
  'local',
  'file:///var/www/GoodAppBackEnd/storage/buckets',
  'goodspeech',
  FALSE,
  NULL,
  'private, no-store',
  FALSE,
  '{"deleteAfterDays":null,"archiveAfterDays":null}'::jsonb,
  '{"allowedOrigins":["https://speech.goodos.app"],"allowedMethods":["GET","POST","DELETE"]}'::jsonb,
  'standard',
  'sha256',
  '{"application":"goodspeech","purpose":"private user media and generation history"}'::jsonb,
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
  virus_scan_required = EXCLUDED.virus_scan_required,
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

CREATE TABLE IF NOT EXISTS goodspeech_user_state (
  organization_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT goodspeech_user_state_size CHECK (octet_length(state_json::text) <= 262144)
);

CREATE TABLE IF NOT EXISTS goodspeech_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT,
  environment_id TEXT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_file_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 104857600),
  source TEXT NOT NULL DEFAULT 'Upload',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT goodspeech_asset_name_length CHECK (char_length(name) BETWEEN 1 AND 180),
  CONSTRAINT goodspeech_asset_source_length CHECK (char_length(source) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_assets_owner_created
  ON goodspeech_assets (organization_id, owner_user_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS goodspeech_generation_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT,
  environment_id TEXT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id UUID REFERENCES goodspeech_assets(id) ON DELETE SET NULL,
  script_text TEXT NOT NULL,
  voice TEXT NOT NULL,
  voice_label TEXT NOT NULL,
  style TEXT NOT NULL,
  tone TEXT NOT NULL,
  intensity INTEGER NOT NULL DEFAULT 50 CHECK (intensity BETWEEN 0 AND 100),
  generation_source TEXT NOT NULL DEFAULT 'goodbase' CHECK (generation_source IN ('goodbase', 'local')),
  duration_seconds NUMERIC(10, 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT goodspeech_history_script_length CHECK (char_length(script_text) BETWEEN 1 AND 2000),
  CONSTRAINT goodspeech_history_voice_length CHECK (char_length(voice) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_history_owner_created
  ON goodspeech_generation_history (organization_id, owner_user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_user_state TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_assets TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_generation_history TO goodapp_backend_user;

COMMIT;
