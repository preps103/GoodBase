BEGIN;

CREATE TABLE IF NOT EXISTS fleet_incidental_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  idempotency_key text NOT NULL,
  source_provider text NOT NULL DEFAULT 'manual',
  source_reference text,
  charge_type text NOT NULL CHECK (charge_type IN (
    'toll','citation','fuel','ev_charging','mileage','cleaning',
    'smoking','late_return','damage','other'
  )),
  description text NOT NULL,
  occurred_at timestamptz NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  license_plate text,
  vin text,
  transponder_reference text,
  vehicle_id uuid,
  booking_id uuid,
  customer_id uuid,
  match_status text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN (
    'unmatched','suggested','auto_matched','confirmed','rejected'
  )),
  match_confidence numeric(4,3) NOT NULL DEFAULT 0 CHECK (
    match_confidence >= 0 AND match_confidence <= 1
  ),
  match_reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  workflow_status text NOT NULL DEFAULT 'imported' CHECK (workflow_status IN (
    'imported','review_required','approved','disputed','collection_pending',
    'collected','waived','failed'
  )),
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  dispute_deadline timestamptz,
  duplicate_of uuid REFERENCES fleet_incidental_charges(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, vehicle_id)
    REFERENCES fleet_vehicles(organization_id, id),
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id),
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES fleet_customers(organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS fleet_incidental_source_reference_idx
  ON fleet_incidental_charges (organization_id, source_provider, source_reference)
  WHERE source_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS fleet_incidental_review_queue_idx
  ON fleet_incidental_charges (organization_id, workflow_status, occurred_at DESC);

CREATE INDEX IF NOT EXISTS fleet_incidental_booking_idx
  ON fleet_incidental_charges (organization_id, booking_id, occurred_at DESC)
  WHERE booking_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fleet_incidental_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  incidental_id uuid NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, incidental_id)
    REFERENCES fleet_incidental_charges(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fleet_incidental_events_timeline_idx
  ON fleet_incidental_events (organization_id, incidental_id, created_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodapp_backend_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON fleet_incidental_charges,
         fleet_incidental_events
      TO goodapp_backend_user;
  END IF;
END $$;

COMMIT;
