BEGIN;

ALTER TABLE fleet_chat_channels
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'workspace';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fleet_chat_channels_visibility_check'
  ) THEN
    ALTER TABLE fleet_chat_channels
      ADD CONSTRAINT fleet_chat_channels_visibility_check
      CHECK (visibility IN ('workspace', 'management', 'private'));
  END IF;
END
$$;

UPDATE fleet_chat_channels
   SET visibility='private'
 WHERE channel_type='direct'
   AND visibility<>'private';

CREATE INDEX IF NOT EXISTS fleet_chat_channels_visibility_idx
  ON fleet_chat_channels (organization_id, visibility, updated_at DESC);

COMMIT;
