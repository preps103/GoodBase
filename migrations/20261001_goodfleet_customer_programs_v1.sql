BEGIN;

CREATE TABLE IF NOT EXISTS fleet_corporate_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  idempotency_key text NOT NULL,
  name text NOT NULL,
  account_code text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','closed')),
  contact_name text,
  billing_email text,
  contact_phone text,
  payment_terms_days integer NOT NULL DEFAULT 0
    CHECK (payment_terms_days BETWEEN 0 AND 90),
  credit_limit numeric(12,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, account_code),
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS fleet_corporate_accounts_status_idx
  ON fleet_corporate_accounts (organization_id, status, name);

CREATE TABLE IF NOT EXISTS fleet_corporate_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  corporate_account_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  member_code text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','ended')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, corporate_account_id, customer_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, corporate_account_id)
    REFERENCES fleet_corporate_accounts(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES fleet_customers(organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS fleet_corporate_memberships_active_customer_idx
  ON fleet_corporate_memberships (organization_id, customer_id)
  WHERE status='active';

CREATE TABLE IF NOT EXISTS fleet_negotiated_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  corporate_account_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  name text NOT NULL,
  vehicle_category text NOT NULL DEFAULT '*',
  branch_id text,
  discount_percent numeric(5,2) NOT NULL
    CHECK (discount_percent > 0 AND discount_percent <= 80),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive')),
  starts_on date,
  ends_on date,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, corporate_account_id)
    REFERENCES fleet_corporate_accounts(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fleet_negotiated_rates_match_idx
  ON fleet_negotiated_rates (
    organization_id, corporate_account_id, status, vehicle_category, branch_id,
    starts_on, ends_on
  );

CREATE TABLE IF NOT EXISTS fleet_loyalty_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','closed')),
  tier text NOT NULL DEFAULT 'member'
    CHECK (tier IN ('member','silver','gold','platinum')),
  points_balance integer NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  lifetime_points integer NOT NULL DEFAULT 0 CHECK (lifetime_points >= 0),
  discount_percent numeric(5,2) NOT NULL DEFAULT 0
    CHECK (discount_percent >= 0 AND discount_percent <= 25),
  joined_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, customer_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES fleet_customers(organization_id, id)
);

CREATE INDEX IF NOT EXISTS fleet_loyalty_accounts_queue_idx
  ON fleet_loyalty_accounts (organization_id, status, tier, updated_at DESC);

CREATE TABLE IF NOT EXISTS fleet_loyalty_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  loyalty_account_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  booking_id uuid,
  event_type text NOT NULL
    CHECK (event_type IN ('rental_earned','manual_award','correction','redemption','expiration')),
  points_delta integer NOT NULL CHECK (points_delta <> 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  notes text,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, loyalty_account_id)
    REFERENCES fleet_loyalty_accounts(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id)
);

CREATE INDEX IF NOT EXISTS fleet_loyalty_events_timeline_idx
  ON fleet_loyalty_events (organization_id, loyalty_account_id, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodapp_backend_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON fleet_corporate_accounts,
         fleet_corporate_memberships,
         fleet_negotiated_rates,
         fleet_loyalty_accounts,
         fleet_loyalty_events
      TO goodapp_backend_user;
  END IF;
END $$;

COMMIT;
