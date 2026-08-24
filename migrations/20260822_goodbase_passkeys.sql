BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS goodbase_passkey_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  device_type TEXT,
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  label TEXT NOT NULL DEFAULT 'Passkey',
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- July's identity-platform migration created an earlier passkey table shape.
-- Upgrade that table in place so production data is preserved and the current
-- WebAuthn service can store and verify credentials.
ALTER TABLE goodbase_passkey_credentials
  ADD COLUMN IF NOT EXISTS public_key BYTEA,
  ADD COLUMN IF NOT EXISTS counter BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transports_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS device_type TEXT,
  ADD COLUMN IF NOT EXISTS backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT 'Passkey',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'goodbase_passkey_credentials'
      AND column_name = 'public_key_cose'
  ) THEN
    EXECUTE $upgrade$
      UPDATE goodbase_passkey_credentials
      SET public_key = COALESCE(public_key, public_key_cose),
          counter = CASE
            WHEN counter = 0 THEN COALESCE(sign_count, 0)
            ELSE counter
          END,
          transports_json = CASE
            WHEN transports_json = '[]'::jsonb THEN COALESCE(to_jsonb(transports), '[]'::jsonb)
            ELSE transports_json
          END,
          label = COALESCE(NULLIF(label, 'Passkey'), nickname, 'Passkey'),
          updated_at = COALESCE(updated_at, created_at, NOW())
    $upgrade$;

    ALTER TABLE goodbase_passkey_credentials
      ALTER COLUMN organization_id DROP NOT NULL,
      ALTER COLUMN public_key_cose DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'goodbase_passkey_credentials'
      AND column_name = 'id'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE goodbase_passkey_credentials
      ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
  END IF;
END
$$;

ALTER TABLE goodbase_passkey_credentials
  ALTER COLUMN public_key SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_goodbase_passkey_credentials_user
  ON goodbase_passkey_credentials(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goodbase_passkey_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
  challenge TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodbase_passkey_challenges_active
  ON goodbase_passkey_challenges(purpose, expires_at)
  WHERE consumed_at IS NULL;

COMMIT;
