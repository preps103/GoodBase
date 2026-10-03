BEGIN;

CREATE TABLE IF NOT EXISTS goodspeech_quality_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT,
  environment_id TEXT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'needs_attention', 'failed')),
  reference_text TEXT NOT NULL,
  transcript_text TEXT,
  metric TEXT NOT NULL CHECK (metric IN ('word_error_rate', 'character_error_rate')),
  error_count INTEGER CHECK (error_count >= 0),
  reference_units INTEGER CHECK (reference_units >= 0),
  hypothesis_units INTEGER CHECK (hypothesis_units >= 0),
  error_rate_percent NUMERIC(6,2) CHECK (error_rate_percent BETWEEN 0 AND 999.99),
  quality_score INTEGER CHECK (quality_score BETWEEN 0 AND 100),
  tts_latency_ms INTEGER CHECK (tts_latency_ms >= 0),
  transcription_latency_ms INTEGER CHECK (transcription_latency_ms >= 0),
  total_latency_ms INTEGER CHECK (total_latency_ms >= 0),
  audio_bytes INTEGER CHECK (audio_bytes >= 0),
  tts_model TEXT,
  transcription_model TEXT,
  transcription_model_revision TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_quality_benchmarks_owner
  ON goodspeech_quality_benchmarks (organization_id, owner_user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_quality_benchmarks TO goodapp_backend_user;

COMMIT;
