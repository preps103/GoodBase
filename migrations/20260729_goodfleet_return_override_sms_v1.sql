BEGIN;

ALTER TABLE goodbase_sms_deliveries
  DROP CONSTRAINT IF EXISTS goodbase_sms_deliveries_purpose_check;

ALTER TABLE goodbase_sms_deliveries
  ADD CONSTRAINT goodbase_sms_deliveries_purpose_check
  CHECK (purpose IN (
    'phone_otp',
    'sms_mfa',
    'phone_change',
    'contract_signing',
    'fleet_return'
  ));

COMMIT;
