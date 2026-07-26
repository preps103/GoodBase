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
      'funnels', 'lead_forms', 'leads'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodads_lead_forms_public_slug
  ON goodads_resources ((data->>'publicSlug'))
  WHERE resource_type = 'lead_forms'
    AND archived_at IS NULL
    AND COALESCE(data->>'publicSlug', '') <> '';

CREATE INDEX IF NOT EXISTS idx_goodads_leads_stage
  ON goodads_resources (organization_id, (data->>'stage'), updated_at DESC)
  WHERE resource_type = 'leads' AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_goodads_leads_email
  ON goodads_resources (organization_id, LOWER(data->>'email'))
  WHERE resource_type = 'leads'
    AND archived_at IS NULL
    AND COALESCE(data->>'email', '') <> '';

CREATE INDEX IF NOT EXISTS idx_goodads_growth_funnel
  ON goodads_resources (organization_id, (data->>'funnelId'), updated_at DESC)
  WHERE resource_type IN ('lead_forms', 'leads')
    AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodads_lead_capture_idempotency
  ON goodads_resource_events (organization_id, (metadata->>'idempotencyKey'))
  WHERE event_type = 'leads.captured'
    AND COALESCE(metadata->>'idempotencyKey', '') <> '';

COMMIT;
