-- Retire historical observability notifications whose source alerts are no
-- longer firing. The delivery service keeps this lifecycle synchronized for
-- every new resolved Alertmanager payload.
UPDATE backend_notifications notification
SET status = 'archived',
    archived_at = COALESCE(notification.archived_at, NOW()),
    updated_at = NOW()
FROM goodbase_alert_instances alert
WHERE notification.category = 'observability'
  AND notification.source_id = alert.id::text
  AND alert.status = 'resolved'
  AND notification.archived_at IS NULL;

-- Keep one visible record for a repeated delivery-failure key and archive the
-- older duplicates created before notification-key idempotency was enforced.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY notification_key
           ORDER BY created_at DESC, id DESC
         ) AS occurrence
  FROM backend_notifications
  WHERE category = 'observability'
    AND notification_key LIKE 'observability.delivery.failed.%'
    AND archived_at IS NULL
)
UPDATE backend_notifications notification
SET status = 'archived',
    archived_at = NOW(),
    updated_at = NOW()
FROM ranked
WHERE notification.id = ranked.id
  AND ranked.occurrence > 1;
