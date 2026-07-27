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

-- Keep the original listing-only table intact. It was created by an earlier
-- deployment role, so the application deployment role cannot safely ALTER it.
-- The protected marketplace owns a dedicated table and imports legacy rows
-- without changing or weakening the original table's permissions.
CREATE TABLE IF NOT EXISTS goodswapz_marketplace_listings (
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

DO $$
BEGIN
  IF to_regclass('public.goodswapz_listings') IS NOT NULL THEN
    INSERT INTO goodswapz_marketplace_listings (
      id,
      organization_id,
      seller_user_id,
      platform,
      title,
      handle,
      account_url,
      subscribers,
      price_cents,
      monthly_revenue_cents,
      description,
      status,
      category,
      engagement_rate,
      image_url,
      country,
      original_email_included,
      audience_male_percent,
      escrow_accepted,
      instant_delivery,
      audience_report,
      transfer_method,
      ownership_verification_code,
      ownership_verified_at,
      ownership_verified_by,
      audience_age_range,
      audience_top_locations,
      metadata_json,
      created_at,
      updated_at
    )
    SELECT
      legacy.id,
      'org_goodos',
      legacy.user_id,
      CASE legacy.platform
        WHEN 'YouTube' THEN 'youtube'
        WHEN 'Instagram' THEN 'instagram'
        WHEN 'TikTok' THEN 'tiktok'
        WHEN 'Twitter/X' THEN 'twitter'
        WHEN 'Telegram' THEN 'telegram'
        ELSE LOWER(legacy.platform)
      END,
      legacy.title,
      legacy.handle,
      legacy.account_url,
      legacy.subscribers,
      ROUND(legacy.price * 100)::bigint,
      ROUND(legacy.monthly_revenue * 100)::bigint,
      legacy.description,
      legacy.status,
      legacy.category,
      legacy.engagement_rate,
      legacy.image_url,
      legacy.country,
      legacy.original_email_included,
      legacy.audience_male_percent,
      TRUE,
      legacy.instant_delivery,
      legacy.audience_report_available,
      legacy.transfer_method,
      legacy.ownership_verification_code,
      CASE WHEN legacy.status = 'active' THEN legacy.reviewed_at ELSE NULL END,
      CASE WHEN legacy.status = 'active' THEN legacy.reviewed_by ELSE NULL END,
      legacy.audience_age_json,
      legacy.audience_locations_json,
      jsonb_build_object('migratedFrom', 'goodswapz_listings'),
      legacy.created_at,
      legacy.updated_at
    FROM goodswapz_listings AS legacy
    ON CONFLICT (id) DO NOTHING;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_goodswapz_marketplace_listings_marketplace
ON goodswapz_marketplace_listings(organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_goodswapz_marketplace_listings_seller
ON goodswapz_marketplace_listings(seller_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodswapz_marketplace_listings_active_handle
ON goodswapz_marketplace_listings(organization_id, platform, LOWER(handle))
WHERE status IN ('pending_review', 'active', 'reserved');

CREATE TABLE IF NOT EXISTS goodswapz_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES goodswapz_marketplace_listings(id) ON DELETE CASCADE,
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
  listing_id UUID NOT NULL REFERENCES goodswapz_marketplace_listings(id) ON DELETE CASCADE,
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
  listing_id UUID NOT NULL REFERENCES goodswapz_marketplace_listings(id) ON DELETE RESTRICT,
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
  listing_id UUID NOT NULL REFERENCES goodswapz_marketplace_listings(id) ON DELETE RESTRICT,
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
