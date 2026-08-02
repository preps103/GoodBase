CREATE TABLE IF NOT EXISTS goodboost_publishing_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES goodboost_social_connections(id) ON DELETE SET NULL,
  platform TEXT NOT NULL,
  content TEXT NOT NULL,
  media_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  scheduled_for TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','scheduled','publishing','published','failed')),
  approval_note TEXT,
  provider_post_id TEXT,
  error_reason TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS goodboost_inbox_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES goodboost_social_connections(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('comment','mention','message','review')),
  author_name TEXT NOT NULL,
  author_username TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','open','resolved','archived')),
  sentiment TEXT CHECK (sentiment IN ('positive','neutral','negative')),
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(connection_id,provider_item_id)
);

CREATE TABLE IF NOT EXISTS goodboost_metric_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES goodboost_social_connections(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  followers BIGINT NOT NULL DEFAULT 0 CHECK (followers >= 0),
  impressions BIGINT NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  reach BIGINT NOT NULL DEFAULT 0 CHECK (reach >= 0),
  engagements BIGINT NOT NULL DEFAULT 0 CHECK (engagements >= 0),
  clicks BIGINT NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  video_views BIGINT NOT NULL DEFAULT 0 CHECK (video_views >= 0),
  posts_published INTEGER NOT NULL DEFAULT 0 CHECK (posts_published >= 0),
  source TEXT NOT NULL DEFAULT 'provider',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(connection_id,recorded_at)
);

CREATE INDEX IF NOT EXISTS goodboost_posts_user_schedule_idx ON goodboost_publishing_posts(user_id,status,scheduled_for);
CREATE INDEX IF NOT EXISTS goodboost_inbox_user_status_idx ON goodboost_inbox_items(user_id,status,received_at DESC);
CREATE INDEX IF NOT EXISTS goodboost_metrics_user_recorded_idx ON goodboost_metric_snapshots(user_id,recorded_at DESC);

