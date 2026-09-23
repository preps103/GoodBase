BEGIN;

CREATE TABLE IF NOT EXISTS goodscan_device_pairings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  desktop_device_id UUID NOT NULL REFERENCES goodscan_devices(id) ON DELETE CASCADE,
  phone_device_id UUID REFERENCES goodscan_devices(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  latest_asset_id UUID REFERENCES goodscan_assets(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT goodscan_device_pairing_status_valid
    CHECK (status IN ('pending', 'claimed', 'expired', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_goodscan_device_pairings_owner_updated
  ON goodscan_device_pairings (owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_goodscan_device_pairings_pending_expiry
  ON goodscan_device_pairings (expires_at)
  WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON goodscan_device_pairings TO goodapp_backend_user;

COMMIT;
