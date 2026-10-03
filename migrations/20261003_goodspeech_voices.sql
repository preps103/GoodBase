BEGIN;

CREATE TABLE IF NOT EXISTS goodspeech_voice_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_asset_id UUID REFERENCES goodspeech_assets(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cloned', 'designed')),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'revoked', 'failed')),
  language TEXT NOT NULL DEFAULT 'en-us',
  design_prompt TEXT,
  base_voice TEXT,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  watermark TEXT NOT NULL,
  sample_sha256 TEXT,
  sample_duration_seconds NUMERIC(8,3),
  consent_version TEXT NOT NULL,
  consent_statement TEXT NOT NULL,
  identity_attested BOOLEAN NOT NULL DEFAULT FALSE,
  rights_attested BOOLEAN NOT NULL DEFAULT FALSE,
  adult_attested BOOLEAN NOT NULL DEFAULT FALSE,
  consent_granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consent_revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT goodspeech_voice_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT goodspeech_voice_prompt_length CHECK (design_prompt IS NULL OR char_length(design_prompt) BETWEEN 8 AND 1000)
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_voice_profiles_owner
  ON goodspeech_voice_profiles (organization_id, owner_user_id, updated_at DESC)
  WHERE status = 'ready';

CREATE TABLE IF NOT EXISTS goodspeech_voice_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voice_profile_id UUID NOT NULL REFERENCES goodspeech_voice_profiles(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('enrolled', 'designed', 'generated', 'revoked')),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_voice_events_profile
  ON goodspeech_voice_events (voice_profile_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_voice_profiles TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_voice_events TO goodapp_backend_user;

COMMIT;
