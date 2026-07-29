BEGIN;

ALTER TABLE fleet_bookings
  DROP CONSTRAINT IF EXISTS fleet_bookings_status_v2_check;

ALTER TABLE fleet_bookings
  ADD CONSTRAINT fleet_bookings_status_v2_check
  CHECK (status IN (
    'quote',
    'pending_payment',
    'confirmed',
    'assigned',
    'checked_in',
    'checked_out',
    'extended',
    'needs_attention',
    'completed',
    'no_show',
    'cancelled',
    'refunded',
    'overdue'
  ));

COMMIT;
