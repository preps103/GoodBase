BEGIN;

CREATE TABLE IF NOT EXISTS goodspeech_privacy_settings (
  organization_id TEXT NOT NULL,
  project_id TEXT,
  environment_id TEXT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zero_retention BOOLEAN NOT NULL DEFAULT FALSE,
  generation_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (generation_retention_days BETWEEN 0 AND 365),
  agent_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (agent_retention_days BETWEEN 0 AND 365),
  residency_region TEXT NOT NULL DEFAULT 'us-west' CHECK (residency_region IN ('us-west')),
  model_training_opt_out BOOLEAN NOT NULL DEFAULT TRUE CHECK (model_training_opt_out = TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, owner_user_id),
  CONSTRAINT goodspeech_zero_retention_enforced CHECK (
    zero_retention = FALSE OR (generation_retention_days = 0 AND agent_retention_days = 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_privacy_retention
  ON goodspeech_privacy_settings (zero_retention, generation_retention_days, agent_retention_days, updated_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_privacy_settings TO goodapp_backend_user;

COMMIT;
