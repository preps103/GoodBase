BEGIN;

ALTER TABLE goodads_ad_accounts
  DROP CONSTRAINT IF EXISTS goodads_ad_accounts_provider_check;
ALTER TABLE goodads_ad_accounts
  ADD CONSTRAINT goodads_ad_accounts_provider_check
  CHECK (provider IN (
    'google', 'meta', 'youtube', 'tiktok', 'linkedin', 'x', 'pinterest', 'snapchat'
  )) NOT VALID;
ALTER TABLE goodads_ad_accounts
  VALIDATE CONSTRAINT goodads_ad_accounts_provider_check;

ALTER TABLE goodads_provider_campaigns
  DROP CONSTRAINT IF EXISTS goodads_provider_campaigns_provider_check;
ALTER TABLE goodads_provider_campaigns
  ADD CONSTRAINT goodads_provider_campaigns_provider_check
  CHECK (provider IN (
    'google', 'meta', 'youtube', 'tiktok', 'linkedin', 'x', 'pinterest', 'snapchat'
  )) NOT VALID;
ALTER TABLE goodads_provider_campaigns
  VALIDATE CONSTRAINT goodads_provider_campaigns_provider_check;

ALTER TABLE goodads_analytics_snapshots
  DROP CONSTRAINT IF EXISTS goodads_analytics_snapshots_provider_check;
ALTER TABLE goodads_analytics_snapshots
  ADD CONSTRAINT goodads_analytics_snapshots_provider_check
  CHECK (provider IN (
    'google', 'meta', 'youtube', 'tiktok', 'linkedin', 'x', 'pinterest', 'snapchat'
  )) NOT VALID;
ALTER TABLE goodads_analytics_snapshots
  VALIDATE CONSTRAINT goodads_analytics_snapshots_provider_check;

COMMIT;
