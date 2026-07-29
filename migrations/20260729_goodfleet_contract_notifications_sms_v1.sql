BEGIN;

ALTER TABLE fleet_customer_notifications
  ADD COLUMN IF NOT EXISTS recipient_phone text;

ALTER TABLE fleet_customer_notification_deliveries
  DROP CONSTRAINT IF EXISTS fleet_customer_notification_deliveries_channel_check;

ALTER TABLE fleet_customer_notification_deliveries
  ADD CONSTRAINT fleet_customer_notification_deliveries_channel_check
  CHECK (channel IN ('in_app', 'email', 'sms'));

ALTER TABLE goodbase_sms_deliveries
  DROP CONSTRAINT IF EXISTS goodbase_sms_deliveries_purpose_check;

ALTER TABLE goodbase_sms_deliveries
  ADD CONSTRAINT goodbase_sms_deliveries_purpose_check
  CHECK (purpose IN ('phone_otp', 'sms_mfa', 'phone_change', 'contract_signing'));

ALTER TABLE goodbase_sms_deliveries
  ADD COLUMN IF NOT EXISTS fleet_notification_id uuid
    REFERENCES fleet_customer_notifications(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS goodbase_sms_deliveries_fleet_notification_idx
  ON goodbase_sms_deliveries (fleet_notification_id, created_at DESC)
  WHERE fleet_notification_id IS NOT NULL;

COMMIT;
