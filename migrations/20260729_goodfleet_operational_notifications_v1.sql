BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS backend_notifications_goodfleet_operation_once_idx
  ON backend_notifications (
    organization_id,
    source,
    source_id,
    recipient_user_id
  )
  WHERE source = 'goodfleet-operations'
    AND source_id IS NOT NULL
    AND recipient_user_id IS NOT NULL;

COMMIT;
