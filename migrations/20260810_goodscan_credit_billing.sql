BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS goodscan_credit_products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency ~ '^[a-z]{3}$'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO goodscan_credit_products
  (sku, name, description, credits, price_cents, currency, active, sort_order)
VALUES
  ('credits_starter_500', 'Starter', 'For previews, experiments, and occasional image generation.', 500, 900, 'usd', TRUE, 10),
  ('credits_creator_1500', 'Creator', 'For regular image-to-3D and production model generation.', 1500, 2400, 'usd', TRUE, 20),
  ('credits_studio_4000', 'Studio', 'For larger batches, high-detail assets, and advanced processing.', 4000, 5900, 'usd', TRUE, 30)
ON CONFLICT (sku) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  credits = EXCLUDED.credits,
  price_cents = EXCLUDED.price_cents,
  currency = EXCLUDED.currency,
  active = EXCLUDED.active,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS goodscan_credit_accounts (
  owner_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 100,
  lifetime_purchased INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_purchased >= 0),
  lifetime_granted INTEGER NOT NULL DEFAULT 100 CHECK (lifetime_granted >= 0),
  lifetime_spent INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_spent >= 0),
  lifetime_refunded INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_refunded >= 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency ~ '^[a-z]{3}$'),
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodscan_credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount <> 0),
  balance_after INTEGER NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'welcome_grant', 'purchase', 'generation_debit', 'generation_refund',
    'purchase_reversal', 'manual_adjustment'
  )),
  reference_type TEXT,
  reference_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_goodscan_credit_ledger_owner_created
  ON goodscan_credit_ledger (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goodscan_credit_checkout_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_sku TEXT NOT NULL REFERENCES goodscan_credit_products(sku) ON DELETE RESTRICT,
  credit_amount INTEGER NOT NULL CHECK (credit_amount > 0),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','failed','refunded','partially_refunded')),
  idempotency_key TEXT NOT NULL,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  checkout_url TEXT,
  amount_refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_refunded_cents >= 0),
  fulfilled_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_goodscan_checkout_owner_created
  ON goodscan_credit_checkout_sessions (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_goodscan_checkout_payment_intent
  ON goodscan_credit_checkout_sessions (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS goodscan_credit_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
  processing_status TEXT NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received','processed','ignored','failed')),
  related_checkout_id UUID REFERENCES goodscan_credit_checkout_sessions(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  processing_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS goodscan_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','cancelled')),
  quoted_credits INTEGER NOT NULL CHECK (quoted_credits > 0),
  manifest JSONB NOT NULL,
  provider TEXT,
  provider_job_id TEXT,
  debit_ledger_id UUID NOT NULL REFERENCES goodscan_credit_ledger(id) ON DELETE RESTRICT,
  refund_ledger_id UUID REFERENCES goodscan_credit_ledger(id) ON DELETE RESTRICT,
  progress NUMERIC(5,2),
  outputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_message TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_user_id, idempotency_key),
  CONSTRAINT goodscan_job_progress_valid CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100))
);
CREATE INDEX IF NOT EXISTS idx_goodscan_generation_jobs_owner_created
  ON goodscan_generation_jobs (owner_user_id, created_at DESC);

GRANT SELECT ON goodscan_credit_products TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE ON goodscan_credit_accounts TO goodapp_backend_user;
GRANT SELECT, INSERT ON goodscan_credit_ledger TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE ON goodscan_credit_checkout_sessions TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE ON goodscan_credit_webhook_events TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE ON goodscan_generation_jobs TO goodapp_backend_user;

COMMIT;
