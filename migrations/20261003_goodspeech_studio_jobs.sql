BEGIN;

CREATE TABLE IF NOT EXISTS goodspeech_studio_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT,
  environment_id TEXT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  project_name TEXT NOT NULL,
  clips_json JSONB NOT NULL CHECK (jsonb_typeof(clips_json) = 'array'),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','retrying','processing','completed','failed','cancelled')),
  progress SMALLINT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  current_clip INTEGER NOT NULL DEFAULT 0 CHECK (current_clip >= 0),
  total_clips INTEGER NOT NULL CHECK (total_clips BETWEEN 1 AND 24),
  total_characters INTEGER NOT NULL CHECK (total_characters BETWEEN 1 AND 18000),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  cancellation_requested BOOLEAN NOT NULL DEFAULT FALSE,
  output_asset_id UUID REFERENCES goodspeech_assets(id) ON DELETE SET NULL,
  output_size_bytes BIGINT,
  output_duration_seconds NUMERIC(12,3),
  error_code TEXT,
  error_message TEXT,
  locked_by TEXT,
  locked_until TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, owner_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS goodspeech_studio_job_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES goodspeech_studio_jobs(id) ON DELETE CASCADE,
  clip_index INTEGER NOT NULL CHECK (clip_index >= 0 AND clip_index < 24),
  storage_file_id TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  duration_seconds NUMERIC(12,3),
  reservation_json JSONB NOT NULL CHECK (jsonb_typeof(reservation_json) = 'object'),
  usage_recorded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, clip_index)
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_studio_jobs_queue
  ON goodspeech_studio_jobs (status, available_at, created_at)
  WHERE status IN ('queued','retrying','processing');
CREATE INDEX IF NOT EXISTS idx_goodspeech_studio_jobs_owner
  ON goodspeech_studio_jobs (organization_id, owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_goodspeech_studio_parts_job
  ON goodspeech_studio_job_parts (job_id, clip_index);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_studio_jobs TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_studio_job_parts TO goodapp_backend_user;

COMMIT;
