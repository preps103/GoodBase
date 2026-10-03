BEGIN;

CREATE TABLE IF NOT EXISTS goodspeech_podcast_feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT,
  environment_id TEXT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_token TEXT NOT NULL UNIQUE CHECK (public_token ~ '^[A-Za-z0-9_-]{43}$'),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  author TEXT NOT NULL DEFAULT 'GoodSpeech creator' CHECK (char_length(author) BETWEEN 1 AND 120),
  language TEXT NOT NULL DEFAULT 'en-us' CHECK (char_length(language) BETWEEN 2 AND 20),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodspeech_podcast_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID NOT NULL REFERENCES goodspeech_podcast_feeds(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES goodspeech_assets(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 180),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  episode_number INTEGER CHECK (episode_number IS NULL OR episode_number BETWEEN 1 AND 1000000),
  duration_seconds NUMERIC(12,3) CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (feed_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_podcast_feeds_owner
  ON goodspeech_podcast_feeds (organization_id, owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_goodspeech_podcast_episodes_feed
  ON goodspeech_podcast_episodes (feed_id, published_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_podcast_feeds TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_podcast_episodes TO goodapp_backend_user;

COMMIT;
