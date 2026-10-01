BEGIN;

CREATE TABLE IF NOT EXISTS fleet_financial_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  idempotency_key text NOT NULL,
  case_number text NOT NULL,
  case_type text NOT NULL CHECK (case_type IN ('fraud_review','chargeback','collection')),
  title text NOT NULL,
  description text,
  amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open','investigating','evidence_due','response_ready','submitted',
    'payment_plan','resolved_won','resolved_lost','collected','written_off'
  )),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  booking_id uuid,
  customer_id uuid,
  payment_operation_id uuid REFERENCES fleet_payment_operations(id) ON DELETE SET NULL,
  external_reference text,
  external_deadline timestamptz,
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_json) = 'array'),
  notes text,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, case_number),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id),
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES fleet_customers(organization_id, id)
);

CREATE INDEX IF NOT EXISTS fleet_financial_cases_queue_idx
  ON fleet_financial_cases (organization_id, status, priority, external_deadline, created_at DESC);

CREATE INDEX IF NOT EXISTS fleet_financial_cases_booking_idx
  ON fleet_financial_cases (organization_id, booking_id, created_at DESC)
  WHERE booking_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS fleet_financial_cases_external_reference_idx
  ON fleet_financial_cases (organization_id, case_type, external_reference)
  WHERE external_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS fleet_financial_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  case_id uuid NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details_json) = 'object'),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, case_id)
    REFERENCES fleet_financial_cases(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fleet_financial_case_events_timeline_idx
  ON fleet_financial_case_events (organization_id, case_id, created_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodapp_backend_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON fleet_financial_cases,
         fleet_financial_case_events
      TO goodapp_backend_user;
  END IF;
END $$;

COMMIT;
