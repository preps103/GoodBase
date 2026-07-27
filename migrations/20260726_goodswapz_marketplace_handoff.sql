BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO apps (
  id,
  name,
  domain,
  status,
  description,
  organization_id,
  project_id,
  environment_id
)
VALUES (
  'goodswapz',
  'GoodSwapz',
  'swapz.goodos.app',
  'active',
  'GoodOS marketplace and protected social-account handoff application.',
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  domain = EXCLUDED.domain,
  status = EXCLUDED.status,
  description = EXCLUDED.description,
  organization_id = EXCLUDED.organization_id,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id,
  updated_at = NOW();

INSERT INTO app_memberships (
  user_id,
  app_id,
  role,
  status,
  organization_id,
  project_id,
  environment_id
)
SELECT
  account.id,
  'goodswapz',
  CASE
    WHEN account.platform_role = 'owner' THEN 'owner'
    WHEN account.platform_role = 'admin' THEN 'admin'
    ELSE 'member'
  END,
  'active',
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
FROM users AS account
WHERE account.platform_role IN ('owner', 'admin')
ON CONFLICT (user_id, app_id) DO UPDATE
SET
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  organization_id = EXCLUDED.organization_id,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS goodswapz_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  seller_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  platform TEXT NOT NULL CHECK (platform IN ('youtube', 'instagram', 'tiktok', 'twitter', 'telegram')),
  title TEXT NOT NULL,
  handle TEXT NOT NULL,
  account_url TEXT NOT NULL,
  subscribers BIGINT NOT NULL CHECK (subscribers >= 0),
  price_cents BIGINT NOT NULL CHECK (price_cents > 0),
  monthly_revenue_cents BIGINT NOT NULL DEFAULT 0 CHECK (monthly_revenue_cents >= 0),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('draft', 'pending_review', 'active', 'reserved', 'rejected', 'sold', 'archived')),
  category TEXT NOT NULL,
  engagement_rate NUMERIC(7, 3) NOT NULL DEFAULT 0 CHECK (engagement_rate >= 0 AND engagement_rate <= 100),
  image_url TEXT,
  country TEXT NOT NULL,
  original_email_included BOOLEAN NOT NULL DEFAULT FALSE,
  audience_male_percent NUMERIC(7, 3) NOT NULL DEFAULT 50 CHECK (audience_male_percent >= 0 AND audience_male_percent <= 100),
  escrow_accepted BOOLEAN NOT NULL DEFAULT TRUE,
  instant_delivery BOOLEAN NOT NULL DEFAULT FALSE,
  audience_report BOOLEAN NOT NULL DEFAULT FALSE,
  transfer_method TEXT NOT NULL,
  ownership_verification_code TEXT NOT NULL UNIQUE,
  ownership_verified_at TIMESTAMPTZ,
  ownership_verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
  review_note TEXT,
  audience_age_range JSONB NOT NULL DEFAULT '{}'::jsonb,
  audience_top_locations JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Upgrade the listing-only GoodSwapz schema already present in production.
-- Legacy columns remain readable during the rollout, while all new writes use
-- the organization-scoped integer-money contract below.
ALTER TABLE goodswapz_listings
  ADD COLUMN IF NOT EXISTS organization_id TEXT REFERENCES backend_organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS seller_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS price_cents BIGINT,
  ADD COLUMN IF NOT EXISTS monthly_revenue_cents BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escrow_accepted BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS audience_report BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ownership_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ownership_verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_note TEXT,
  ADD COLUMN IF NOT EXISTS audience_age_range JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS audience_top_locations JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata_json JSONB DEFAULT '{}'::jsonb;

ALTER TABLE goodswapz_listings
  DROP CONSTRAINT IF EXISTS goodswapz_listings_platform_check,
  DROP CONSTRAINT IF EXISTS goodswapz_listings_status_check,
  DROP CONSTRAINT IF EXISTS goodswapz_listings_subscribers_check,
  DROP CONSTRAINT IF EXISTS goodswapz_listings_price_cents_check,
  DROP CONSTRAINT IF EXISTS goodswapz_listings_monthly_revenue_cents_check;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'goodswapz_listings' AND column_name = 'user_id'
  ) THEN
    EXECUTE 'UPDATE goodswapz_listings SET seller_user_id = COALESCE(seller_user_id, user_id)';
    EXECUTE 'ALTER TABLE goodswapz_listings ALTER COLUMN user_id DROP NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'goodswapz_listings' AND column_name = 'price'
  ) THEN
    EXECUTE 'UPDATE goodswapz_listings SET price_cents = COALESCE(price_cents, ROUND(price * 100)::bigint)';
    EXECUTE 'ALTER TABLE goodswapz_listings ALTER COLUMN price DROP NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'goodswapz_listings' AND column_name = 'monthly_revenue'
  ) THEN
    EXECUTE 'UPDATE goodswapz_listings SET monthly_revenue_cents = ROUND(monthly_revenue * 100)::bigint';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'goodswapz_listings' AND column_name = 'audience_report_available'
  ) THEN
    EXECUTE 'UPDATE goodswapz_listings SET audience_report = audience_report_available';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'goodswapz_listings' AND column_name = 'audience_age_json'
  ) THEN
    EXECUTE 'UPDATE goodswapz_listings SET audience_age_range = audience_age_json';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'goodswapz_listings' AND column_name = 'audience_locations_json'
  ) THEN
    EXECUTE 'UPDATE goodswapz_listings SET audience_top_locations = audience_locations_json';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'goodswapz_listings' AND column_name = 'reviewed_at'
  ) THEN
    EXECUTE 'UPDATE goodswapz_listings SET ownership_verified_at = COALESCE(ownership_verified_at, reviewed_at) WHERE status = ''active''';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'goodswapz_listings' AND column_name = 'reviewed_by'
  ) THEN
    EXECUTE 'UPDATE goodswapz_listings SET ownership_verified_by = COALESCE(ownership_verified_by, reviewed_by) WHERE status = ''active''';
  END IF;
END
$$;

UPDATE goodswapz_listings
SET
  organization_id = COALESCE(organization_id, 'org_goodos'),
  platform = CASE platform
    WHEN 'YouTube' THEN 'youtube'
    WHEN 'Instagram' THEN 'instagram'
    WHEN 'TikTok' THEN 'tiktok'
    WHEN 'Twitter/X' THEN 'twitter'
    WHEN 'Telegram' THEN 'telegram'
    ELSE LOWER(platform)
  END,
  monthly_revenue_cents = COALESCE(monthly_revenue_cents, 0),
  escrow_accepted = COALESCE(escrow_accepted, TRUE),
  audience_report = COALESCE(audience_report, FALSE),
  audience_age_range = COALESCE(audience_age_range, '{}'::jsonb),
  audience_top_locations = COALESCE(audience_top_locations, '{}'::jsonb),
  metadata_json = COALESCE(metadata_json, '{}'::jsonb);

ALTER TABLE goodswapz_listings
  ALTER COLUMN organization_id SET DEFAULT 'org_goodos',
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN seller_user_id SET NOT NULL,
  ALTER COLUMN price_cents SET NOT NULL,
  ALTER COLUMN monthly_revenue_cents SET DEFAULT 0,
  ALTER COLUMN monthly_revenue_cents SET NOT NULL,
  ALTER COLUMN escrow_accepted SET DEFAULT TRUE,
  ALTER COLUMN escrow_accepted SET NOT NULL,
  ALTER COLUMN audience_report SET DEFAULT FALSE,
  ALTER COLUMN audience_report SET NOT NULL,
  ALTER COLUMN audience_age_range SET DEFAULT '{}'::jsonb,
  ALTER COLUMN audience_age_range SET NOT NULL,
  ALTER COLUMN audience_top_locations SET DEFAULT '{}'::jsonb,
  ALTER COLUMN audience_top_locations SET NOT NULL,
  ALTER COLUMN metadata_json SET DEFAULT '{}'::jsonb,
  ALTER COLUMN metadata_json SET NOT NULL;

ALTER TABLE goodswapz_listings
  ADD CONSTRAINT goodswapz_listings_platform_check
    CHECK (platform IN ('youtube', 'instagram', 'tiktok', 'twitter', 'telegram')),
  ADD CONSTRAINT goodswapz_listings_status_check
    CHECK (status IN ('draft', 'pending_review', 'active', 'reserved', 'rejected', 'sold', 'archived')),
  ADD CONSTRAINT goodswapz_listings_subscribers_check
    CHECK (subscribers >= 0),
  ADD CONSTRAINT goodswapz_listings_price_cents_check
    CHECK (price_cents > 0),
  ADD CONSTRAINT goodswapz_listings_monthly_revenue_cents_check
    CHECK (monthly_revenue_cents >= 0);

CREATE INDEX IF NOT EXISTS idx_goodswapz_listings_marketplace
ON goodswapz_listings(organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_goodswapz_listings_seller
ON goodswapz_listings(seller_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodswapz_listings_active_handle
ON goodswapz_listings(organization_id, platform, LOWER(handle))
WHERE status IN ('pending_review', 'active', 'reserved');

CREATE TABLE IF NOT EXISTS goodswapz_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES goodswapz_listings(id) ON DELETE CASCADE,
  buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn', 'expired')),
  idempotency_key TEXT,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodswapz_offers_listing
ON goodswapz_offers(listing_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_goodswapz_offers_buyer
ON goodswapz_offers(buyer_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodswapz_offers_idempotency
ON goodswapz_offers(buyer_user_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS goodswapz_watchlist (
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES goodswapz_listings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, listing_id)
);

CREATE TABLE IF NOT EXISTS goodswapz_identity_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id_type TEXT NOT NULL CHECK (id_type IN ('license', 'passport')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  review_note TEXT,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodswapz_verifications_user
ON goodswapz_identity_verifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goodswapz_identity_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id UUID NOT NULL REFERENCES goodswapz_identity_verifications(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('front', 'back', 'selfie')),
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL,
  encryption_version TEXT NOT NULL DEFAULT 'aes-256-gcm-v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodswapz_escrow_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES goodswapz_listings(id) ON DELETE RESTRICT,
  buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seller_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  offer_id UUID REFERENCES goodswapz_offers(id) ON DELETE SET NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  fee_cents BIGINT NOT NULL CHECK (fee_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'funded', 'failed', 'cancelled', 'disputed', 'completed')),
  external_reference TEXT,
  idempotency_key TEXT,
  funded_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodswapz_escrow_user
ON goodswapz_escrow_transactions(buyer_user_id, seller_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodswapz_escrow_idempotency
ON goodswapz_escrow_transactions(buyer_user_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS goodswapz_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES goodswapz_listings(id) ON DELETE RESTRICT,
  transaction_id UUID NOT NULL UNIQUE REFERENCES goodswapz_escrow_transactions(id) ON DELETE RESTRICT,
  buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seller_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  platform TEXT NOT NULL CHECK (platform IN ('youtube', 'instagram', 'tiktok', 'twitter', 'telegram')),
  status TEXT NOT NULL DEFAULT 'awaiting_funding'
    CHECK (status IN ('awaiting_funding', 'ready', 'in_progress', 'buyer_review', 'completed', 'disputed', 'cancelled')),
  seller_started_at TIMESTAMPTZ,
  buyer_confirmed_at TIMESTAMPTZ,
  review_deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  dispute_reason TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodswapz_handoffs_participants
ON goodswapz_handoffs(buyer_user_id, seller_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS goodswapz_handoff_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_id UUID NOT NULL REFERENCES goodswapz_handoffs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  required_actor TEXT NOT NULL CHECK (required_actor IN ('system', 'seller', 'buyer', 'both')),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  seller_confirmed_at TIMESTAMPTZ,
  buyer_confirmed_at TIMESTAMPTZ,
  system_confirmed_at TIMESTAMPTZ,
  evidence_reference TEXT,
  completion_note TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (handoff_id, step_key),
  UNIQUE (handoff_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_goodswapz_handoff_steps_order
ON goodswapz_handoff_steps(handoff_id, sequence_number);

CREATE TABLE IF NOT EXISTS goodswapz_handoff_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_id UUID NOT NULL REFERENCES goodswapz_handoffs(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodswapz_handoff_events_timeline
ON goodswapz_handoff_events(handoff_id, created_at ASC);

CREATE TABLE IF NOT EXISTS goodswapz_escrow_webhook_events (
  event_id TEXT PRIMARY KEY,
  transaction_id UUID REFERENCES goodswapz_escrow_transactions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
