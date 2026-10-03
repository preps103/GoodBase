BEGIN;

CREATE TABLE IF NOT EXISTS goodspeech_monthly_usage (
  organization_id TEXT NOT NULL,
  project_id TEXT,
  environment_id TEXT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  request_count BIGINT NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  successful_count BIGINT NOT NULL DEFAULT 0 CHECK (successful_count >= 0),
  failed_count BIGINT NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  text_characters BIGINT NOT NULL DEFAULT 0 CHECK (text_characters >= 0),
  audio_bytes BIGINT NOT NULL DEFAULT 0 CHECK (audio_bytes >= 0),
  latency_ms_total BIGINT NOT NULL DEFAULT 0 CHECK (latency_ms_total >= 0),
  request_limit BIGINT NOT NULL CHECK (request_limit > 0),
  character_limit BIGINT NOT NULL CHECK (character_limit > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id, period_start),
  CONSTRAINT goodspeech_usage_period_valid CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_usage_user_period
  ON goodspeech_monthly_usage (user_id, period_start DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_monthly_usage TO goodapp_backend_user;

COMMIT;
