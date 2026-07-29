BEGIN;

CREATE TABLE IF NOT EXISTS fleet_condition_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  booking_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('departure', 'return')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'reviewed')),
  captured_by_type text NOT NULL CHECK (captured_by_type IN ('employee', 'customer')),
  captured_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  mileage integer CHECK (mileage IS NULL OR mileage >= 0),
  fuel_level integer CHECK (fuel_level IS NULL OR fuel_level BETWEEN 0 AND 100),
  condition_notes text,
  acknowledgement_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, booking_id, phase),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id),
  FOREIGN KEY (organization_id, vehicle_id)
    REFERENCES fleet_vehicles(organization_id, id),
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES fleet_customers(organization_id, id),
  CHECK (jsonb_typeof(acknowledgement_json) = 'object')
);

CREATE INDEX IF NOT EXISTS fleet_condition_reports_booking_idx
  ON fleet_condition_reports (organization_id, booking_id, phase);

CREATE INDEX IF NOT EXISTS fleet_condition_reports_vehicle_idx
  ON fleet_condition_reports (organization_id, vehicle_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS fleet_condition_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  report_id uuid NOT NULL,
  slot text NOT NULL CHECK (
    slot IN (
      'front',
      'rear',
      'driver_side',
      'passenger_side',
      'dashboard',
      'front_interior',
      'rear_interior',
      'odometer',
      'fuel_gauge'
    )
  ),
  file_name text NOT NULL,
  content_type text NOT NULL CHECK (
    content_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  captured_by uuid REFERENCES users(id) ON DELETE SET NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, slot),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, report_id)
    REFERENCES fleet_condition_reports(organization_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fleet_condition_photos_report_idx
  ON fleet_condition_photos (organization_id, report_id, slot);

COMMIT;
