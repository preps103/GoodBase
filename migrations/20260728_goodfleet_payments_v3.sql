BEGIN;

ALTER TABLE fleet_payment_operations
  DROP CONSTRAINT IF EXISTS fleet_payment_operations_operation_type_check;

ALTER TABLE fleet_payment_operations
  ADD CONSTRAINT fleet_payment_operations_operation_type_check CHECK (
    operation_type IN (
      'checkout', 'invoice', 'manual_payment', 'authorization',
      'capture', 'refund', 'void', 'increment', 'dispute'
    )
  );

ALTER TABLE fleet_payment_operations
  DROP CONSTRAINT IF EXISTS fleet_payment_operations_status_check;

ALTER TABLE fleet_payment_operations
  ADD CONSTRAINT fleet_payment_operations_status_check CHECK (
    status IN (
      'pending', 'requires_payment_method', 'requires_action', 'authorized',
      'captured', 'succeeded', 'partially_refunded', 'refunded',
      'voided', 'failed', 'cancelled', 'disputed'
    )
  );

ALTER TABLE fleet_payment_operations
  ADD COLUMN IF NOT EXISTS parent_operation_id uuid
    REFERENCES fleet_payment_operations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS receipt_url text,
  ADD COLUMN IF NOT EXISTS processed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz;

CREATE INDEX IF NOT EXISTS fleet_payment_operations_booking_created_idx
  ON fleet_payment_operations (organization_id, booking_id, created_at DESC)
  WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS fleet_payment_operations_parent_idx
  ON fleet_payment_operations (parent_operation_id)
  WHERE parent_operation_id IS NOT NULL;

ALTER TABLE fleet_payment_webhook_events
  ADD COLUMN IF NOT EXISTS organization_id text,
  ADD COLUMN IF NOT EXISTS related_operation_id uuid
    REFERENCES fleet_payment_operations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS fleet_payment_webhook_events_org_received_idx
  ON fleet_payment_webhook_events (organization_id, received_at DESC)
  WHERE organization_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodapp_backend_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON fleet_payment_operations,
         fleet_payment_webhook_events
      TO goodapp_backend_user;
  END IF;
END $$;

COMMIT;
