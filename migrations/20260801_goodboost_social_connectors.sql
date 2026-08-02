CREATE TABLE IF NOT EXISTS goodboost_social_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','needs_reconnect','disconnected')),
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  token_reference TEXT,
  follower_count INTEGER,
  following_count INTEGER,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id,platform,provider_account_id)
);

CREATE TABLE IF NOT EXISTS goodboost_social_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES goodboost_social_connections(id) ON DELETE CASCADE,
  provider_user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  profile_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('not-following-back','mutual','fan','recently-unfollowed')),
  follows_you BOOLEAN NOT NULL DEFAULT FALSE,
  you_follow BOOLEAN NOT NULL DEFAULT FALSE,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_changed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(connection_id,provider_user_id)
);

CREATE TABLE IF NOT EXISTS goodboost_social_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES goodboost_social_connections(id) ON DELETE CASCADE,
  relationship_id UUID REFERENCES goodboost_social_relationships(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('follow','unfollow')),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
  provider_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(user_id,idempotency_key)
);

CREATE INDEX IF NOT EXISTS goodboost_social_connections_user_idx ON goodboost_social_connections(user_id,status);
CREATE INDEX IF NOT EXISTS goodboost_social_relationships_status_idx ON goodboost_social_relationships(connection_id,status);
CREATE INDEX IF NOT EXISTS goodboost_social_actions_daily_idx ON goodboost_social_actions(user_id,created_at,action,status);

