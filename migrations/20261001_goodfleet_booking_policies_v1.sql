BEGIN;

CREATE TABLE IF NOT EXISTS fleet_booking_policy_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  booking_id uuid NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('cancellation','no_show')),
  source text NOT NULL CHECK (source IN ('customer','employee','system')),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'recorded' CHECK (
    status IN ('recorded','review_required','settled','waived')
  ),
  fee_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  refund_due numeric(12,2) NOT NULL DEFAULT 0 CHECK (refund_due >= 0),
  balance_due numeric(12,2) NOT NULL DEFAULT 0 CHECK (balance_due >= 0),
  policy_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(policy_json) = 'object'),
  outcome_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(outcome_json) = 'object'),
  idempotency_key text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,idempotency_key),
  FOREIGN KEY (organization_id,booking_id)
    REFERENCES fleet_bookings(organization_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS fleet_booking_policy_actions_booking_idx
  ON fleet_booking_policy_actions (organization_id,booking_id,created_at DESC);
CREATE INDEX IF NOT EXISTS fleet_booking_policy_actions_review_idx
  ON fleet_booking_policy_actions (organization_id,status,created_at DESC)
  WHERE status='review_required';

CREATE TABLE IF NOT EXISTS fleet_inventory_transfer_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  booking_id uuid NOT NULL,
  vehicle_id uuid,
  origin_branch_id text NOT NULL,
  destination_branch_id text NOT NULL,
  expected_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned','completed','cancelled')
  ),
  completed_at timestamptz,
  cancelled_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,booking_id),
  FOREIGN KEY (organization_id,booking_id)
    REFERENCES fleet_bookings(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,vehicle_id)
    REFERENCES fleet_vehicles(organization_id,id) ON DELETE SET NULL,
  CHECK (origin_branch_id <> destination_branch_id)
);

CREATE INDEX IF NOT EXISTS fleet_inventory_transfer_plans_schedule_idx
  ON fleet_inventory_transfer_plans (organization_id,status,expected_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='goodapp_backend_user') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE
      ON fleet_booking_policy_actions,fleet_inventory_transfer_plans
      TO goodapp_backend_user;
  END IF;
END $$;

COMMIT;
