BEGIN;

ALTER TABLE goodads_competitor_snapshots
  DROP CONSTRAINT IF EXISTS goodads_competitor_snapshots_source_provider_check;
ALTER TABLE goodads_competitor_snapshots
  ADD CONSTRAINT goodads_competitor_snapshots_source_provider_check
  CHECK (source_provider IN ('similarweb', 'public_web'));

ALTER TABLE goodads_competitor_snapshots
  DROP CONSTRAINT IF EXISTS goodads_competitor_snapshots_status_check;
ALTER TABLE goodads_competitor_snapshots
  ADD CONSTRAINT goodads_competitor_snapshots_status_check
  CHECK (status IN ('completed', 'partial', 'failed'));

ALTER TABLE goodads_competitor_alerts
  DROP CONSTRAINT IF EXISTS goodads_competitor_alerts_alert_type_check;
ALTER TABLE goodads_competitor_alerts
  ADD CONSTRAINT goodads_competitor_alerts_alert_type_check
  CHECK (alert_type IN (
    'new_competitor', 'strategy_change', 'site_change', 'spend_change',
    'network_change', 'sync_failed'
  ));

CREATE INDEX IF NOT EXISTS idx_goodads_competitor_snapshots_latest_source
  ON goodads_competitor_snapshots (organization_id, competitor_id, source_provider, captured_at DESC);

UPDATE backend_jobs
SET
  display_name = 'GoodAds Full Competitor Intelligence Scan',
  description = 'Refreshes public first-party website observations and licensed competitor estimates.',
  timeout_seconds = 600,
  metadata_json = COALESCE(metadata_json, '{}'::jsonb)
    || '{"application":"goodads","resource":"competitor-intelligence","scanner":"public-web","licensedProvider":"similarweb"}'::jsonb,
  updated_at = NOW()
WHERE id = 'job_goodads_competitor_sync';

COMMIT;
