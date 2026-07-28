BEGIN;

CREATE TABLE IF NOT EXISTS goodcustom_staff (
  -- Core GoodBase accounts are owner-controlled. The application deployment
  -- role stores account identifiers without altering that ownership boundary.
  user_id UUID PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'employee'
    CHECK (role IN ('owner', 'manager', 'employee')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended')),
  invited_by UUID,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodcustom_chat_rooms (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('channel', 'direct')),
  name TEXT,
  description TEXT,
  direct_key TEXT UNIQUE,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_by UUID,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (kind = 'channel' AND name IS NOT NULL AND direct_key IS NULL)
    OR (kind = 'direct' AND name IS NULL AND direct_key IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodcustom_chat_default_room
ON goodcustom_chat_rooms(is_default)
WHERE is_default = true AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS goodcustom_chat_room_members (
  room_id UUID NOT NULL REFERENCES goodcustom_chat_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('admin', 'member')),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  muted_until TIMESTAMPTZ,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_goodcustom_chat_room_members_user
ON goodcustom_chat_room_members(user_id, removed_at);

CREATE TABLE IF NOT EXISTS goodcustom_chat_messages (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES goodcustom_chat_rooms(id) ON DELETE CASCADE,
  sender_user_id UUID NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  reply_to_message_id UUID REFERENCES goodcustom_chat_messages(id) ON DELETE SET NULL,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodcustom_chat_messages_room_created
ON goodcustom_chat_messages(room_id, created_at DESC);

DROP TRIGGER IF EXISTS set_goodcustom_staff_updated_at ON goodcustom_staff;
CREATE TRIGGER set_goodcustom_staff_updated_at
BEFORE UPDATE ON goodcustom_staff
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_goodcustom_chat_rooms_updated_at ON goodcustom_chat_rooms;
CREATE TRIGGER set_goodcustom_chat_rooms_updated_at
BEFORE UPDATE ON goodcustom_chat_rooms
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_goodcustom_chat_messages_updated_at ON goodcustom_chat_messages;
CREATE TRIGGER set_goodcustom_chat_messages_updated_at
BEFORE UPDATE ON goodcustom_chat_messages
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO goodcustom_chat_rooms (
  id,
  kind,
  name,
  description,
  is_default
)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'channel',
  'GoodCustom Team',
  'Daily coordination for the GoodCustom studio.',
  true
)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_default = true,
  archived_at = NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON goodcustom_staff TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodcustom_chat_rooms TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodcustom_chat_room_members TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodcustom_chat_messages TO goodapp_backend_user;

COMMIT;
