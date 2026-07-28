BEGIN;

CREATE TABLE IF NOT EXISTS fleet_customer_checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  booking_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (
    status IN ('draft', 'submitted', 'approved', 'rejected')
  ),
  checklist_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, booking_id),
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id),
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES fleet_customers(organization_id, id),
  CHECK (jsonb_typeof(checklist_json) = 'object')
);

CREATE INDEX IF NOT EXISTS fleet_customer_checkins_customer_idx
  ON fleet_customer_checkins (organization_id, customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fleet_customer_support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  customer_id uuid NOT NULL,
  booking_id uuid,
  ticket_number text NOT NULL,
  subject text NOT NULL,
  category text NOT NULL CHECK (
    category IN ('reservation', 'roadside', 'billing', 'documents', 'other')
  ),
  priority text NOT NULL DEFAULT 'normal' CHECK (
    priority IN ('normal', 'high', 'urgent')
  ),
  status text NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'waiting_on_customer', 'in_progress', 'resolved', 'closed')
  ),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (organization_id, ticket_number),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES fleet_customers(organization_id, id),
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id)
);

CREATE INDEX IF NOT EXISTS fleet_customer_support_tickets_customer_idx
  ON fleet_customer_support_tickets (organization_id, customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fleet_customer_support_tickets_status_idx
  ON fleet_customer_support_tickets (organization_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS fleet_customer_support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  ticket_id uuid NOT NULL,
  sender_type text NOT NULL CHECK (
    sender_type IN ('customer', 'employee', 'system')
  ),
  sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, ticket_id)
    REFERENCES fleet_customer_support_tickets(organization_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fleet_customer_support_messages_ticket_idx
  ON fleet_customer_support_messages (organization_id, ticket_id, created_at);

-- Restore the two verified GoodFleet inventory records that were present in the
-- legacy operating ledger. Vehicle identifiers remain explicitly provisional
-- until their physical VIN, plate, registration, and insurance documents are
-- verified in the fleet workspace.
INSERT INTO fleet_vehicles (
  organization_id,
  vin,
  license_plate,
  make,
  model,
  model_year,
  status,
  assigned_branch_id,
  daily_rate,
  registration_expiry,
  insurance_expiry,
  payload
)
VALUES
  (
    'org_goodos',
    'PENDING-SONATA-2014',
    'PENDING-SONATA',
    'Hyundai',
    'Sonata 2.0 Turbo',
    2014,
    'available',
    'br-1',
    45.00,
    NULL,
    NULL,
    jsonb_build_object(
      'legacyVehicleId', 'car-sonata',
      'trim', 'Standard',
      'color', 'To be confirmed',
      'category', 'Economy',
      'seats', 5,
      'doors', 4,
      'transmission', 'automatic',
      'fuelType', 'gasoline',
      'mileage', 0,
      'fuelLevel', 0,
      'imageUrl', '',
      'ownershipType', 'owned',
      'recallStatus', 'unknown',
      'recordCompleteness', 'identity-and-compliance-details-pending',
      'dataProvenance', 'recovered-legacy-live-ledger'
    )
  ),
  (
    'org_goodos',
    'PENDING-CRUZE-2014',
    'PENDING-CRUZE',
    'Chevrolet',
    'Cruze LT 2.0 Turbo',
    2014,
    'available',
    'br-1',
    40.00,
    NULL,
    NULL,
    jsonb_build_object(
      'legacyVehicleId', 'car-cruze',
      'trim', 'LT',
      'color', 'To be confirmed',
      'category', 'Economy',
      'seats', 5,
      'doors', 4,
      'transmission', 'automatic',
      'fuelType', 'gasoline',
      'mileage', 0,
      'fuelLevel', 0,
      'imageUrl', '',
      'ownershipType', 'owned',
      'recallStatus', 'unknown',
      'recordCompleteness', 'identity-and-compliance-details-pending',
      'dataProvenance', 'recovered-legacy-live-ledger'
    )
  )
ON CONFLICT (organization_id, vin) DO UPDATE SET
  make = EXCLUDED.make,
  model = EXCLUDED.model,
  model_year = EXCLUDED.model_year,
  assigned_branch_id = EXCLUDED.assigned_branch_id,
  daily_rate = EXCLUDED.daily_rate,
  payload = fleet_vehicles.payload || EXCLUDED.payload,
  archived_at = NULL,
  version = fleet_vehicles.version + 1,
  updated_at = now();

UPDATE fleet_bookings booking
SET vehicle_id = vehicle.id,
    payload = booking.payload
      - 'vehicleAssignmentPending'
      || jsonb_build_object('vehicleAssignmentRestoredAt', now()),
    version = booking.version + 1,
    updated_at = now()
FROM fleet_vehicles vehicle
WHERE booking.organization_id = 'org_goodos'
  AND vehicle.organization_id = booking.organization_id
  AND booking.vehicle_id IS NULL
  AND booking.payload->>'legacyVehicleId' = vehicle.payload->>'legacyVehicleId';

UPDATE fleet_vehicles vehicle
SET status = CASE
      WHEN EXISTS (
        SELECT 1
        FROM fleet_bookings booking
        WHERE booking.organization_id = vehicle.organization_id
          AND booking.vehicle_id = vehicle.id
          AND booking.archived_at IS NULL
          AND booking.status IN ('checked_in', 'checked_out', 'extended', 'overdue')
      ) THEN 'checked_out'
      WHEN EXISTS (
        SELECT 1
        FROM fleet_bookings booking
        WHERE booking.organization_id = vehicle.organization_id
          AND booking.vehicle_id = vehicle.id
          AND booking.archived_at IS NULL
          AND booking.status IN ('pending_payment', 'confirmed', 'assigned')
          AND booking.return_at >= now()
      ) THEN 'reserved'
      ELSE 'available'
    END,
    updated_at = now()
WHERE vehicle.organization_id = 'org_goodos'
  AND vehicle.payload->>'legacyVehicleId' IN ('car-sonata', 'car-cruze');

INSERT INTO fleet_audit_events (
  organization_id,
  actor_id,
  action,
  entity_type,
  entity_id,
  after_json
)
SELECT
  vehicle.organization_id,
  NULL,
  'vehicle.inventory.restored',
  'vehicle',
  vehicle.id::text,
  jsonb_build_object(
    'make', vehicle.make,
    'model', vehicle.model,
    'modelYear', vehicle.model_year,
    'status', vehicle.status,
    'dataProvenance', vehicle.payload->>'dataProvenance'
  )
FROM fleet_vehicles vehicle
WHERE vehicle.organization_id = 'org_goodos'
  AND vehicle.payload->>'legacyVehicleId' IN ('car-sonata', 'car-cruze')
  AND NOT EXISTS (
    SELECT 1
    FROM fleet_audit_events event
    WHERE event.organization_id = vehicle.organization_id
      AND event.action = 'vehicle.inventory.restored'
      AND event.entity_id = vehicle.id::text
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodapp_backend_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON fleet_customer_checkins,
         fleet_customer_support_tickets,
         fleet_customer_support_messages
      TO goodapp_backend_user;
  END IF;
END $$;

COMMIT;
