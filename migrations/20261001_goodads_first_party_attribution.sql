BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_goodads_attribution_event_id
  ON goodads_resource_events (organization_id, (metadata->>'eventId'))
  WHERE event_type IN (
    'attribution.page_view',
    'attribution.lead',
    'attribution.purchase',
    'attribution.complete_registration',
    'attribution.subscribe'
  ) AND metadata ? 'eventId';

CREATE INDEX IF NOT EXISTS idx_goodads_attribution_reporting
  ON goodads_resource_events (organization_id, event_type, created_at DESC)
  WHERE event_type LIKE 'attribution.%';

COMMIT;
