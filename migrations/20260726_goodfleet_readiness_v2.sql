BEGIN;

ALTER TABLE fleet_vehicles
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE fleet_customers
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE fleet_bookings
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'fleet_bookings'::regclass
      AND conname = 'fleet_bookings_organization_id_id_v2_key'
  ) THEN
    IF to_regclass('fleet_bookings_org_id_unique_idx') IS NULL THEN
      EXECUTE 'CREATE UNIQUE INDEX fleet_bookings_org_id_unique_idx
        ON fleet_bookings (organization_id, id)';
    END IF;
    ALTER TABLE fleet_bookings
      ADD CONSTRAINT fleet_bookings_organization_id_id_v2_key
      UNIQUE USING INDEX fleet_bookings_org_id_unique_idx;
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE fleet_vehicles ADD CONSTRAINT fleet_vehicles_status_v2_check
    CHECK (status IN (
      'available','reserved','checked_out','in_transit','cleaning','turnaround',
      'inspection','maintenance','out_of_service','retired','blocked','recalled'
    )) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE fleet_customers ADD CONSTRAINT fleet_customers_status_v2_check
    CHECK (status IN ('active','suspended','blacklisted')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE fleet_customers ADD CONSTRAINT fleet_customers_license_status_v2_check
    CHECK (license_verification_status IN ('verified','pending','failed')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE fleet_bookings ADD CONSTRAINT fleet_bookings_status_v2_check
    CHECK (status IN (
      'quote','pending_payment','confirmed','assigned','checked_in','checked_out',
      'extended','completed','no_show','cancelled','refunded','overdue'
    )) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE fleet_bookings ADD CONSTRAINT fleet_bookings_payment_status_v2_check
    CHECK (payment_status IN ('unpaid','partial','paid','refunded','disputed','failed')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS fleet_workspace_state (
  organization_id text PRIMARY KEY,
  state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(state_json) = 'object')
);

CREATE TABLE IF NOT EXISTS fleet_payment_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  booking_id uuid,
  customer_id uuid,
  operation_type text NOT NULL CHECK (
    operation_type IN ('checkout', 'authorization', 'capture', 'refund', 'void')
  ),
  provider text NOT NULL DEFAULT 'stripe',
  provider_reference text,
  idempotency_key text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'requires_action', 'authorized', 'succeeded', 'failed', 'cancelled')
  ),
  request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code text,
  failure_message text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id),
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES fleet_customers(organization_id, id)
);

CREATE INDEX IF NOT EXISTS fleet_payment_operations_org_created_idx
  ON fleet_payment_operations (organization_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS fleet_payment_operations_provider_ref_idx
  ON fleet_payment_operations (organization_id, provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS fleet_payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'stripe',
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL,
  signature_verified boolean NOT NULL DEFAULT false,
  processing_status text NOT NULL DEFAULT 'received' CHECK (
    processing_status IN ('received', 'processed', 'ignored', 'failed')
  ),
  processing_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS fleet_payment_webhook_status_idx
  ON fleet_payment_webhook_events (processing_status, received_at);

CREATE INDEX IF NOT EXISTS fleet_vehicles_org_active_idx
  ON fleet_vehicles (organization_id, created_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS fleet_customers_org_active_idx
  ON fleet_customers (organization_id, created_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS fleet_bookings_org_active_idx
  ON fleet_bookings (organization_id, pickup_at DESC)
  WHERE archived_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodapp_backend_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON fleet_workspace_state,
         fleet_payment_operations,
         fleet_payment_webhook_events
      TO goodapp_backend_user;
  END IF;
END $$;

COMMIT;
