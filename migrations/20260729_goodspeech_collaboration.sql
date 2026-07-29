BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS goodspeech_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES backend_teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planning',
  due_at TIMESTAMPTZ,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT goodspeech_project_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT goodspeech_project_description_length CHECK (char_length(description) <= 2000),
  CONSTRAINT goodspeech_project_status_valid CHECK (
    status IN ('planning', 'active', 'review', 'completed', 'archived')
  )
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_projects_team_updated
  ON goodspeech_projects (team_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_goodspeech_projects_org_updated
  ON goodspeech_projects (organization_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS goodspeech_project_members (
  project_id UUID NOT NULL REFERENCES goodspeech_projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_role TEXT NOT NULL DEFAULT 'editor',
  added_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT goodspeech_project_member_role_valid CHECK (
    project_role IN ('owner', 'editor', 'reviewer')
  )
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_project_members_user
  ON goodspeech_project_members (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS goodspeech_project_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES goodspeech_projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  due_at TIMESTAMPTZ,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT goodspeech_project_task_title_length CHECK (char_length(title) BETWEEN 1 AND 180),
  CONSTRAINT goodspeech_project_task_description_length CHECK (char_length(description) <= 2000),
  CONSTRAINT goodspeech_project_task_status_valid CHECK (
    status IN ('todo', 'in_progress', 'blocked', 'review', 'done')
  )
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_project_tasks_project
  ON goodspeech_project_tasks (project_id, sort_order, created_at);

CREATE INDEX IF NOT EXISTS idx_goodspeech_project_tasks_assignee
  ON goodspeech_project_tasks (assignee_user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS goodspeech_chat_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES backend_teams(id) ON DELETE CASCADE,
  project_id UUID REFERENCES goodspeech_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  channel_kind TEXT NOT NULL,
  direct_key TEXT,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT goodspeech_chat_channel_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT goodspeech_chat_channel_slug_valid CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  CONSTRAINT goodspeech_chat_channel_description_length CHECK (char_length(description) <= 500),
  CONSTRAINT goodspeech_chat_channel_kind_valid CHECK (
    channel_kind IN ('team', 'project', 'direct')
  ),
  CONSTRAINT goodspeech_chat_channel_scope_valid CHECK (
    (channel_kind = 'team' AND team_id IS NOT NULL AND project_id IS NULL AND direct_key IS NULL)
    OR
    (channel_kind = 'project' AND team_id IS NOT NULL AND project_id IS NOT NULL AND direct_key IS NULL)
    OR
    (channel_kind = 'direct' AND team_id IS NULL AND project_id IS NULL AND direct_key IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodspeech_chat_team_slug
  ON goodspeech_chat_channels (organization_id, team_id, slug)
  WHERE channel_kind = 'team' AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodspeech_chat_project_slug
  ON goodspeech_chat_channels (project_id, slug)
  WHERE channel_kind = 'project' AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodspeech_chat_direct_key
  ON goodspeech_chat_channels (organization_id, direct_key)
  WHERE channel_kind = 'direct' AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_goodspeech_chat_channels_org_updated
  ON goodspeech_chat_channels (organization_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS goodspeech_chat_channel_members (
  channel_id UUID NOT NULL REFERENCES goodspeech_chat_channels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL DEFAULT 'member',
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id),
  CONSTRAINT goodspeech_chat_member_role_valid CHECK (
    member_role IN ('member', 'moderator', 'owner')
  )
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_chat_members_user
  ON goodspeech_chat_channel_members (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS goodspeech_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES goodspeech_chat_channels(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reply_to_message_id UUID REFERENCES goodspeech_chat_messages(id) ON DELETE SET NULL,
  client_message_key TEXT,
  message_type TEXT NOT NULL DEFAULT 'message',
  body TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  CONSTRAINT goodspeech_chat_message_type_valid CHECK (
    message_type IN ('message', 'system')
  ),
  CONSTRAINT goodspeech_chat_message_body_length CHECK (
    char_length(body) BETWEEN 1 AND 4000
  ),
  CONSTRAINT goodspeech_chat_client_message_key_length CHECK (
    client_message_key IS NULL OR char_length(client_message_key) BETWEEN 8 AND 128
  )
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_chat_messages_channel_created
  ON goodspeech_chat_messages (channel_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodspeech_chat_message_idempotency
  ON goodspeech_chat_messages (organization_id, sender_user_id, client_message_key)
  WHERE client_message_key IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_projects TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_project_members TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_project_tasks TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_chat_channels TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_chat_channel_members TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_chat_messages TO goodapp_backend_user;

COMMIT;
