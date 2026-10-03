BEGIN;

CREATE TABLE IF NOT EXISTS goodspeech_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint_url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  events TEXT[] NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT goodspeech_webhook_url_length CHECK (char_length(endpoint_url) BETWEEN 12 AND 2048),
  CONSTRAINT goodspeech_webhook_event_count CHECK (cardinality(events) BETWEEN 1 AND 10),
  UNIQUE (organization_id, owner_user_id, endpoint_url)
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_webhooks_owner
  ON goodspeech_webhooks (organization_id, owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS goodspeech_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES goodspeech_webhooks(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'retrying', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  response_status INTEGER,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (webhook_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_webhook_deliveries_due
  ON goodspeech_webhook_deliveries (next_attempt_at, created_at)
  WHERE status IN ('pending', 'retrying');

GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_webhooks TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_webhook_deliveries TO goodapp_backend_user;

COMMIT;
