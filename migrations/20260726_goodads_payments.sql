BEGIN;

CREATE TABLE IF NOT EXISTS goodads_payment_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'paypal', 'square')),
  environment TEXT NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'live')),
  credential_ciphertext TEXT NOT NULL,
  credential_iv TEXT NOT NULL,
  credential_tag TEXT NOT NULL,
  account_reference TEXT NOT NULL DEFAULT '',
  account_label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending_webhook'
    CHECK (status IN ('pending_webhook', 'connected', 'error', 'disconnected')),
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  connected_by UUID NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_goodads_payment_connections_tenant
  ON goodads_payment_connections (organization_id, status, provider);

CREATE TABLE IF NOT EXISTS goodads_payment_preferences (
  organization_id TEXT PRIMARY KEY,
  default_provider TEXT CHECK (default_provider IS NULL OR default_provider IN ('stripe', 'paypal', 'square')),
  enabled_providers TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
    CHECK (enabled_providers <@ ARRAY['stripe', 'paypal', 'square']::TEXT[]),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  updated_by UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodads_payment_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  public_slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 999999999),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  enabled_providers TEXT[] NOT NULL
    CHECK (
      cardinality(enabled_providers) > 0
      AND enabled_providers <@ ARRAY['stripe', 'paypal', 'square']::TEXT[]
    ),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  success_message TEXT NOT NULL DEFAULT 'Payment received. Thank you.',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL,
  updated_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_goodads_payment_offers_tenant
  ON goodads_payment_offers (organization_id, status, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS goodads_payment_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  offer_id UUID NOT NULL REFERENCES goodads_payment_offers(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'paypal', 'square')),
  idempotency_key TEXT NOT NULL,
  public_token_hash TEXT NOT NULL,
  provider_reference TEXT,
  checkout_url TEXT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  customer_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('creating', 'pending', 'approved', 'completed', 'failed', 'expired', 'cancelled', 'refunded')),
  failure_code TEXT,
  failure_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (provider, provider_reference)
);

CREATE INDEX IF NOT EXISTS idx_goodads_payment_sessions_tenant
  ON goodads_payment_sessions (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_goodads_payment_sessions_offer
  ON goodads_payment_sessions (offer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goodads_payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  connection_id UUID NOT NULL REFERENCES goodads_payment_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'paypal', 'square')),
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed')),
  error_message TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE (connection_id, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_goodads_payment_webhooks_status
  ON goodads_payment_webhook_events (processing_status, received_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodads_payment_connections TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodads_payment_preferences TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodads_payment_offers TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE ON goodads_payment_sessions TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE ON goodads_payment_webhook_events TO goodapp_backend_user;

COMMIT;
