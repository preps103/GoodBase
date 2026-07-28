BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS goodads_chat_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  channel_type TEXT NOT NULL DEFAULT 'public',
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT goodads_chat_channel_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT goodads_chat_channel_slug_valid CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  CONSTRAINT goodads_chat_channel_description_length CHECK (char_length(description) <= 300),
  CONSTRAINT goodads_chat_channel_type_valid CHECK (
    channel_type IN ('public', 'private', 'management', 'announcements', 'direct')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodads_chat_channels_org_slug
  ON goodads_chat_channels (organization_id, slug)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_goodads_chat_channels_org_updated
  ON goodads_chat_channels (organization_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS goodads_chat_channel_members (
  channel_id UUID NOT NULL REFERENCES goodads_chat_channels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL DEFAULT 'member',
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id),
  CONSTRAINT goodads_chat_member_role_valid CHECK (
    member_role IN ('member', 'moderator', 'owner')
  )
);

CREATE INDEX IF NOT EXISTS idx_goodads_chat_members_user
  ON goodads_chat_channel_members (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS goodads_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES goodads_chat_channels(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reply_to_message_id UUID REFERENCES goodads_chat_messages(id) ON DELETE SET NULL,
  client_message_key TEXT,
  message_type TEXT NOT NULL DEFAULT 'message',
  body TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  CONSTRAINT goodads_chat_message_type_valid CHECK (
    message_type IN ('message', 'announcement', 'system')
  ),
  CONSTRAINT goodads_chat_message_body_length CHECK (
    char_length(body) BETWEEN 1 AND 4000
  ),
  CONSTRAINT goodads_chat_client_message_key_length CHECK (
    client_message_key IS NULL OR char_length(client_message_key) BETWEEN 8 AND 128
  )
);

CREATE INDEX IF NOT EXISTS idx_goodads_chat_messages_channel_created
  ON goodads_chat_messages (channel_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_goodads_chat_messages_org_created
  ON goodads_chat_messages (organization_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodads_chat_message_idempotency
  ON goodads_chat_messages (organization_id, sender_user_id, client_message_key)
  WHERE client_message_key IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON goodads_chat_channels TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodads_chat_channel_members TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodads_chat_messages TO goodapp_backend_user;

COMMIT;
