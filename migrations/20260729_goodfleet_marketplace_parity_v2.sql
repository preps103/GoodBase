BEGIN;

ALTER TABLE fleet_vehicle_listings
  ADD COLUMN IF NOT EXISTS photos_json jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(photos_json) = 'array'),
  ADD COLUMN IF NOT EXISTS availability_json jsonb NOT NULL DEFAULT
    '{"unavailableRanges":[],"pickupDays":[0,1,2,3,4,5,6]}'::jsonb
    CHECK (jsonb_typeof(availability_json) = 'object'),
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

ALTER TABLE goodbase_sms_deliveries
  DROP CONSTRAINT IF EXISTS goodbase_sms_deliveries_purpose_check;

ALTER TABLE goodbase_sms_deliveries
  ADD CONSTRAINT goodbase_sms_deliveries_purpose_check
  CHECK (
    purpose IN (
      'phone_otp','sms_mfa','phone_change','contract_signing',
      'fleet_return','fleet_notification'
    )
  );

UPDATE fleet_vehicle_listings listing
   SET photos_json=jsonb_build_array(vehicle.payload->>'imageUrl')
  FROM fleet_vehicles vehicle
 WHERE vehicle.organization_id=listing.organization_id
   AND vehicle.id=listing.vehicle_id
   AND jsonb_array_length(listing.photos_json)=0
   AND NULLIF(vehicle.payload->>'imageUrl','') IS NOT NULL;

ALTER TABLE fleet_booking_additional_drivers
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

CREATE INDEX IF NOT EXISTS fleet_booking_additional_drivers_user_idx
  ON fleet_booking_additional_drivers (organization_id, user_id, updated_at DESC)
  WHERE user_id IS NOT NULL AND status <> 'removed';

ALTER TABLE fleet_booking_change_requests
  ADD COLUMN IF NOT EXISTS quoted_total numeric(12,2)
    CHECK (quoted_total IS NULL OR quoted_total >= 0),
  ADD COLUMN IF NOT EXISTS applied_at timestamptz;

ALTER TABLE fleet_trip_reviews
  ADD COLUMN IF NOT EXISTS private_feedback text
    CHECK (private_feedback IS NULL OR char_length(private_feedback) <= 2000),
  ADD COLUMN IF NOT EXISTS response text
    CHECK (response IS NULL OR char_length(response) <= 2000),
  ADD COLUMN IF NOT EXISTS responded_at timestamptz,
  ADD COLUMN IF NOT EXISTS flag_reason text
    CHECK (flag_reason IS NULL OR char_length(flag_reason) <= 1000);

CREATE TABLE IF NOT EXISTS fleet_claim_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  booking_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  reported_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'reported' CHECK (
    status IN (
      'reported','evidence_review','estimate_pending','insurer_review',
      'customer_response','approved','repair_authorized','disputed',
      'settled','closed','denied'
    )
  ),
  incident_at timestamptz NOT NULL DEFAULT now(),
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 10 AND 4000),
  liability text NOT NULL DEFAULT 'undetermined' CHECK (
    liability IN ('guest','host','operator','third_party','shared','undetermined')
  ),
  estimated_amount numeric(12,2) CHECK (
    estimated_amount IS NULL OR estimated_amount >= 0
  ),
  final_amount numeric(12,2) CHECK (final_amount IS NULL OR final_amount >= 0),
  insurer_name text,
  insurer_claim_reference text,
  decision_note text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, vehicle_id)
    REFERENCES fleet_vehicles(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS fleet_claim_cases_booking_idx
  ON fleet_claim_cases (organization_id, booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fleet_claim_cases_work_queue_idx
  ON fleet_claim_cases (organization_id, status, updated_at DESC)
  WHERE status NOT IN ('closed','denied');

CREATE TABLE IF NOT EXISTS fleet_claim_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  claim_id uuid NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  evidence_type text NOT NULL CHECK (
    evidence_type IN ('photo','condition_report','estimate','invoice','police_report','insurance_document','other')
  ),
  file_name text NOT NULL,
  file_url text NOT NULL,
  storage_reference text,
  mime_type text,
  checksum_sha256 text,
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, claim_id)
    REFERENCES fleet_claim_cases(organization_id, id) ON DELETE CASCADE
);

ALTER TABLE fleet_claim_evidence
  ADD COLUMN IF NOT EXISTS storage_reference text;

CREATE INDEX IF NOT EXISTS fleet_claim_evidence_claim_idx
  ON fleet_claim_evidence (organization_id, claim_id, created_at);

CREATE TABLE IF NOT EXISTS fleet_claim_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  claim_id uuid NOT NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, claim_id)
    REFERENCES fleet_claim_cases(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fleet_claim_events_claim_idx
  ON fleet_claim_events (organization_id, claim_id, created_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodapp_backend_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON fleet_claim_cases, fleet_claim_evidence, fleet_claim_events
      TO goodapp_backend_user;
  END IF;
END $$;

COMMIT;
