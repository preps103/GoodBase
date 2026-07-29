BEGIN;

ALTER TABLE goodads_resources
  DROP CONSTRAINT IF EXISTS goodads_resource_type_valid;

ALTER TABLE goodads_resources
  ADD CONSTRAINT goodads_resource_type_valid CHECK (
    resource_type IN (
      'campaigns', 'content', 'approvals', 'calendar', 'connections',
      'publishing_jobs', 'analytics', 'media', 'link_hubs', 'automations',
      'notifications', 'email_campaigns', 'designs', 'flyers',
      'business_cards', 'qr_codes', 'videos', 'brand', 'audit_events',
      'funnels', 'lead_forms', 'leads', 'rss_feeds'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodads_link_hubs_public_slug
  ON goodads_resources ((data->>'publicSlug'))
  WHERE resource_type = 'link_hubs'
    AND archived_at IS NULL
    AND COALESCE(data->>'publicSlug', '') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodads_rss_feeds_url
  ON goodads_resources (organization_id, LOWER(data->>'feedUrl'))
  WHERE resource_type = 'rss_feeds'
    AND archived_at IS NULL
    AND COALESCE(data->>'feedUrl', '') <> '';

CREATE INDEX IF NOT EXISTS idx_goodads_calendar_schedule
  ON goodads_resources (organization_id, (data->>'scheduledAt'))
  WHERE resource_type = 'calendar'
    AND archived_at IS NULL
    AND COALESCE(data->>'scheduledAt', '') <> '';

COMMIT;
