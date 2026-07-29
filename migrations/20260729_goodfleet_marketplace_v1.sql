BEGIN;

ALTER TABLE fleet_customers
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS fleet_customers_org_user_unique_idx
  ON fleet_customers (organization_id, user_id)
  WHERE user_id IS NOT NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS fleet_host_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending_review' CHECK (
    status IN ('pending_review', 'active', 'paused', 'suspended')
  ),
  onboarding_status text NOT NULL DEFAULT 'profile_required' CHECK (
    onboarding_status IN (
      'profile_required', 'identity_required', 'vehicle_required',
      'under_review', 'approved'
    )
  ),
  identity_verification_status text NOT NULL DEFAULT 'pending' CHECK (
    identity_verification_status IN ('pending', 'verified', 'failed')
  ),
  payout_provider text,
  payout_account_reference text,
  payout_status text NOT NULL DEFAULT 'not_configured' CHECK (
    payout_status IN ('not_configured', 'pending', 'ready', 'restricted')
  ),
  support_phone text,
  bio text,
  response_time_minutes integer CHECK (response_time_minutes IS NULL OR response_time_minutes >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS fleet_host_profiles_status_idx
  ON fleet_host_profiles (organization_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS fleet_vehicle_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  vehicle_id uuid NOT NULL,
  host_profile_id uuid,
  operator_managed boolean NOT NULL DEFAULT false,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'pending_review', 'active', 'paused', 'rejected', 'archived')
  ),
  instant_book boolean NOT NULL DEFAULT false,
  delivery_enabled boolean NOT NULL DEFAULT false,
  delivery_radius_miles numeric(8,2) CHECK (
    delivery_radius_miles IS NULL OR delivery_radius_miles >= 0
  ),
  delivery_fee numeric(12,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
  minimum_trip_days integer NOT NULL DEFAULT 1 CHECK (minimum_trip_days BETWEEN 1 AND 365),
  maximum_trip_days integer NOT NULL DEFAULT 30 CHECK (maximum_trip_days BETWEEN 1 AND 365),
  advance_notice_hours integer NOT NULL DEFAULT 12 CHECK (advance_notice_hours BETWEEN 0 AND 720),
  trip_buffer_hours integer NOT NULL DEFAULT 2 CHECK (trip_buffer_hours BETWEEN 0 AND 168),
  mileage_limit_per_day integer CHECK (mileage_limit_per_day IS NULL OR mileage_limit_per_day > 0),
  additional_mile_rate numeric(12,2) CHECK (additional_mile_rate IS NULL OR additional_mile_rate >= 0),
  rules_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rules_json) = 'object'),
  features_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(features_json) = 'array'),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id, vehicle_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, vehicle_id)
    REFERENCES fleet_vehicles(organization_id, id),
  FOREIGN KEY (organization_id, host_profile_id)
    REFERENCES fleet_host_profiles(organization_id, id),
  CHECK (operator_managed OR host_profile_id IS NOT NULL),
  CHECK (maximum_trip_days >= minimum_trip_days)
);

CREATE INDEX IF NOT EXISTS fleet_vehicle_listings_marketplace_idx
  ON fleet_vehicle_listings (organization_id, status, updated_at DESC)
  WHERE archived_at IS NULL;

ALTER TABLE fleet_bookings
  ADD COLUMN IF NOT EXISTS guest_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS listing_id uuid,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  ALTER TABLE fleet_bookings
    ADD CONSTRAINT fleet_bookings_listing_fk
    FOREIGN KEY (organization_id, listing_id)
    REFERENCES fleet_vehicle_listings(organization_id, id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS fleet_bookings_guest_idx
  ON fleet_bookings (guest_user_id, created_at DESC)
  WHERE guest_user_id IS NOT NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS fleet_booking_additional_drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  booking_id uuid NOT NULL,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  full_name text NOT NULL,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'invited' CHECK (
    status IN ('invited', 'accepted', 'verification_required', 'approved', 'rejected', 'removed')
  ),
  license_verification_status text NOT NULL DEFAULT 'pending' CHECK (
    license_verification_status IN ('pending', 'verified', 'failed')
  ),
  invited_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  approved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, booking_id, email),
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fleet_booking_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  booking_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_type text NOT NULL CHECK (
    request_type IN ('dates', 'location', 'delivery', 'vehicle', 'extension', 'other')
  ),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'declined', 'withdrawn')
  ),
  requested_changes jsonb NOT NULL CHECK (jsonb_typeof(requested_changes) = 'object'),
  decision_note text,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fleet_booking_change_requests_open_idx
  ON fleet_booking_change_requests (organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS fleet_trip_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  booking_id uuid NOT NULL,
  listing_id uuid,
  guest_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  host_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'closed', 'moderation_hold')
  ),
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, booking_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, listing_id)
    REFERENCES fleet_vehicle_listings(organization_id, id)
);

CREATE INDEX IF NOT EXISTS fleet_trip_conversations_guest_idx
  ON fleet_trip_conversations (guest_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS fleet_trip_conversations_host_idx
  ON fleet_trip_conversations (host_user_id, updated_at DESC)
  WHERE host_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fleet_trip_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  conversation_id uuid NOT NULL,
  sender_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sender_role text NOT NULL CHECK (sender_role IN ('guest', 'host', 'staff', 'system')),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  client_message_id text NOT NULL,
  attachments_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(attachments_json) = 'array'
  ),
  moderation_status text NOT NULL DEFAULT 'accepted' CHECK (
    moderation_status IN ('accepted', 'flagged', 'hidden')
  ),
  scheduled_at timestamptz,
  delivered_at timestamptz,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, conversation_id)
    REFERENCES fleet_trip_conversations(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, sender_user_id, client_message_id)
);

CREATE INDEX IF NOT EXISTS fleet_trip_messages_conversation_idx
  ON fleet_trip_messages (organization_id, conversation_id, created_at)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS fleet_trip_messages_scheduled_idx
  ON fleet_trip_messages (scheduled_at)
  WHERE scheduled_at IS NOT NULL AND delivered_at IS NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS fleet_trip_message_reads (
  conversation_id uuid NOT NULL REFERENCES fleet_trip_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS fleet_trip_message_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (
    reason IN ('harassment', 'payment_request', 'unsafe_behavior', 'spam', 'privacy', 'other')
  ),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 2000),
  status text NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'reviewing', 'resolved', 'dismissed')
  ),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  resolution_notes text NOT NULL DEFAULT '' CHECK (char_length(resolution_notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, conversation_id)
    REFERENCES fleet_trip_conversations(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, message_id)
    REFERENCES fleet_trip_messages(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, message_id, reporter_user_id)
);

CREATE INDEX IF NOT EXISTS fleet_trip_message_reports_open_idx
  ON fleet_trip_message_reports (organization_id, status, created_at DESC)
  WHERE status IN ('open', 'reviewing');

CREATE TABLE IF NOT EXISTS fleet_trip_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  booking_id uuid NOT NULL,
  reviewer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewer_role text NOT NULL CHECK (reviewer_role IN ('guest', 'host')),
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 2000),
  status text NOT NULL DEFAULT 'published' CHECK (
    status IN ('published', 'hidden', 'under_review')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, booking_id, reviewer_user_id),
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id) ON DELETE CASCADE
);

INSERT INTO fleet_vehicle_listings (
  organization_id,
  vehicle_id,
  host_profile_id,
  operator_managed,
  title,
  description,
  status,
  instant_book,
  delivery_enabled,
  minimum_trip_days,
  maximum_trip_days,
  advance_notice_hours,
  trip_buffer_hours,
  mileage_limit_per_day,
  published_at
)
SELECT
  vehicle.organization_id,
  vehicle.id,
  NULL,
  true,
  concat(vehicle.model_year, ' ', vehicle.make, ' ', vehicle.model),
  'Professionally managed GoodFleet vehicle.',
  CASE
    WHEN vehicle.status IN ('retired', 'blocked', 'recalled') THEN 'paused'
    ELSE 'active'
  END,
  false,
  false,
  1,
  30,
  12,
  2,
  200,
  now()
FROM fleet_vehicles vehicle
WHERE vehicle.archived_at IS NULL
ON CONFLICT (organization_id, vehicle_id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodapp_backend_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON fleet_host_profiles,
         fleet_vehicle_listings,
         fleet_booking_additional_drivers,
         fleet_booking_change_requests,
         fleet_trip_conversations,
         fleet_trip_messages,
         fleet_trip_message_reads,
         fleet_trip_message_reports,
         fleet_trip_reviews
      TO goodapp_backend_user;
  END IF;
END $$;

COMMIT;
