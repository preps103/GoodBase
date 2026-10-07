BEGIN;

ALTER TABLE goodads_oauth_states
  ADD COLUMN IF NOT EXISTS connection_context JSONB NOT NULL DEFAULT '{"connectionOwner":"workspace"}'::jsonb;

COMMIT;
