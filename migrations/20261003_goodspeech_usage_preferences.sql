BEGIN;

CREATE TABLE IF NOT EXISTS goodspeech_usage_preferences (
  organization_id TEXT NOT NULL,
  project_id TEXT,
  environment_id TEXT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_budget BIGINT NOT NULL CHECK (request_budget > 0),
  character_budget BIGINT NOT NULL CHECK (character_budget > 0),
  warning_percent INTEGER NOT NULL DEFAULT 80 CHECK (warning_percent BETWEEN 50 AND 95),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, owner_user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_usage_preferences TO goodapp_backend_user;

COMMIT;
