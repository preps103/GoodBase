BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS fleet_contract_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  description text,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 10000),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'archived')),
  content_text text NOT NULL CHECK (char_length(content_text) BETWEEN 50 AND 100000),
  consumer_disclosure_text text NOT NULL
    CHECK (char_length(consumer_disclosure_text) BETWEEN 50 AND 10000),
  content_hash char(64) NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name, version),
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS fleet_contract_templates_org_status_idx
  ON fleet_contract_templates (organization_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS fleet_contract_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  contract_number text NOT NULL,
  booking_id uuid NOT NULL,
  template_id uuid NOT NULL,
  template_version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft', 'sent', 'viewed', 'partially_signed', 'completed',
      'declined', 'voided', 'expired'
    )),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  message text,
  content_snapshot text NOT NULL CHECK (char_length(content_snapshot) BETWEEN 50 AND 100000),
  disclosure_snapshot text NOT NULL CHECK (char_length(disclosure_snapshot) BETWEEN 50 AND 10000),
  document_hash char(64) NOT NULL,
  completed_record_hash char(64),
  expires_at timestamptz,
  sent_at timestamptz,
  completed_at timestamptz,
  declined_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  last_reminded_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, contract_number),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id),
  FOREIGN KEY (organization_id, template_id)
    REFERENCES fleet_contract_templates(organization_id, id)
);

CREATE INDEX IF NOT EXISTS fleet_contract_envelopes_org_status_idx
  ON fleet_contract_envelopes (organization_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS fleet_contract_envelopes_booking_idx
  ON fleet_contract_envelopes (organization_id, booking_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fleet_contract_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  envelope_id uuid NOT NULL,
  recipient_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  recipient_role text NOT NULL DEFAULT 'customer'
    CHECK (recipient_role IN ('customer', 'company_representative', 'witness')),
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  signing_order integer NOT NULL DEFAULT 1 CHECK (signing_order BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'viewed', 'signed', 'declined')),
  access_token_hash char(64) UNIQUE,
  access_token_expires_at timestamptz,
  viewed_at timestamptz,
  consented_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  signature_type text CHECK (signature_type IN ('typed', 'drawn')),
  signature_text text,
  signature_data text,
  signature_hash char(64),
  consent_record jsonb,
  signed_ip inet,
  signed_user_agent text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (organization_id, envelope_id)
    REFERENCES fleet_contract_envelopes(organization_id, id)
    ON DELETE CASCADE,
  UNIQUE (envelope_id, email, recipient_role),
  CHECK (signature_data IS NULL OR octet_length(signature_data) <= 524288),
  CHECK (consent_record IS NULL OR jsonb_typeof(consent_record) = 'object')
);

CREATE INDEX IF NOT EXISTS fleet_contract_recipients_email_idx
  ON fleet_contract_recipients (lower(email), status, updated_at DESC);
CREATE INDEX IF NOT EXISTS fleet_contract_recipients_envelope_idx
  ON fleet_contract_recipients (organization_id, envelope_id, signing_order);

CREATE TABLE IF NOT EXISTS fleet_contract_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  envelope_id uuid NOT NULL,
  recipient_id uuid REFERENCES fleet_contract_recipients(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 100),
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_event_hash char(64),
  event_hash char(64) NOT NULL,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (organization_id, envelope_id)
    REFERENCES fleet_contract_envelopes(organization_id, id)
    ON DELETE CASCADE,
  UNIQUE (envelope_id, sequence_number),
  UNIQUE (envelope_id, event_hash)
);

CREATE INDEX IF NOT EXISTS fleet_contract_events_envelope_idx
  ON fleet_contract_events (organization_id, envelope_id, sequence_number);

CREATE OR REPLACE FUNCTION prevent_fleet_contract_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fleet_contract_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS fleet_contract_events_append_only
  ON fleet_contract_events;
CREATE TRIGGER fleet_contract_events_append_only
  BEFORE UPDATE OR DELETE ON fleet_contract_events
  FOR EACH ROW EXECUTE FUNCTION prevent_fleet_contract_event_mutation();

GRANT SELECT, INSERT, UPDATE, DELETE
  ON fleet_contract_templates, fleet_contract_envelopes, fleet_contract_recipients
  TO goodapp_backend_user;
GRANT SELECT, INSERT
  ON fleet_contract_events
  TO goodapp_backend_user;

INSERT INTO fleet_contract_templates (
  organization_id,
  name,
  description,
  version,
  status,
  content_text,
  consumer_disclosure_text,
  content_hash,
  published_at
)
SELECT
  source.organization_id,
  'Standard Rental Agreement',
  'Starter agreement for ordinary passenger-vehicle rentals. Review with qualified counsel before production use.',
  1,
  'active',
  'GOODFLEET RENTAL AGREEMENT

Agreement number: {{contract_number}}
Reservation: {{reservation_number}}

RENTER
{{customer_name}}
{{customer_email}}

VEHICLE
{{vehicle_year}} {{vehicle_make}} {{vehicle_model}}
Pickup: {{pickup_at}}
Return: {{return_at}}
Pickup location: {{pickup_location}}

CHARGES
Estimated rental total: {{total_amount}}
Security deposit authorization: {{deposit_amount}}

RENTAL TERMS
The renter accepts responsibility for the vehicle during the rental period and agrees to return it at the agreed time and location, in substantially the same condition, subject to ordinary wear. The renter will promptly report collisions, damage, theft, warning lights, or unsafe operating conditions. Only authorized drivers may operate the vehicle. Fuel, mileage, tolls, citations, late-return charges, cleaning, damage, and other approved charges may be assessed according to the disclosed rate schedule and applicable law.

INSURANCE AND LOSS
The renter must maintain or select the coverage required for this reservation. Coverage, exclusions, deductibles, and claims procedures are governed by the selected coverage documents and applicable law.

PRIVACY AND ELECTRONIC RECORDS
The parties agree that this agreement and related notices may be provided electronically when the renter gives separate consent. The renter may request a printable copy from GoodFleet support.

ACKNOWLEDGMENT
By signing, the renter confirms that the agreement was available for review, the information supplied is accurate, and the renter intends the electronic signature to be associated with this agreement.',
  'Electronic records consent: I agree to receive and sign this rental agreement electronically for this transaction. I can download or print the agreement before and after signing. I may request a paper copy or withdraw electronic consent before signing by contacting GoodFleet support. A current browser capable of displaying and saving this page is required. Selecting “I agree” and completing the signature demonstrates that I can access this electronic record.',
  repeat('0', 64),
  NOW()
FROM (
  SELECT DISTINCT organization_id
  FROM fleet_bookings
) AS source
ON CONFLICT (organization_id, name, version) DO NOTHING;

UPDATE fleet_contract_templates
SET content_hash = encode(
  digest(content_text || '|' || consumer_disclosure_text, 'sha256'),
  'hex'
)
WHERE name = 'Standard Rental Agreement'
  AND version = 1
  AND content_hash = repeat('0', 64);

COMMIT;
