BEGIN;

CREATE TABLE IF NOT EXISTS fleet_host_team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  host_profile_id uuid NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  invited_email text NOT NULL,
  display_name text,
  role text NOT NULL DEFAULT 'cohost' CHECK (
    role IN ('team_manager', 'cohost', 'vehicle_manager', 'messenger')
  ),
  status text NOT NULL DEFAULT 'invited' CHECK (
    status IN ('invited', 'active', 'suspended', 'revoked')
  ),
  permissions_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(permissions_json) = 'array'
  ),
  invited_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  invited_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, host_profile_id, invited_email),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, host_profile_id)
    REFERENCES fleet_host_profiles(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fleet_host_team_members_user_idx
  ON fleet_host_team_members (organization_id, user_id, status)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS fleet_host_team_members_email_ci_idx
  ON fleet_host_team_members (
    organization_id, host_profile_id, lower(invited_email)
  )
  WHERE status <> 'revoked';

CREATE TABLE IF NOT EXISTS fleet_host_team_vehicle_access (
  organization_id text NOT NULL,
  team_member_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  permissions_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(permissions_json) = 'array'
  ),
  granted_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, team_member_id, vehicle_id),
  FOREIGN KEY (organization_id, team_member_id)
    REFERENCES fleet_host_team_members(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, vehicle_id)
    REFERENCES fleet_vehicles(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fleet_host_team_vehicle_access_vehicle_idx
  ON fleet_host_team_vehicle_access (organization_id, vehicle_id);

CREATE TABLE IF NOT EXISTS fleet_roadside_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  booking_id uuid,
  customer_id uuid,
  vehicle_id uuid,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assistance_type text NOT NULL CHECK (
    assistance_type IN (
      'tow', 'flat_tire', 'battery', 'lockout', 'fuel',
      'mechanical', 'accident', 'other'
    )
  ),
  priority text NOT NULL DEFAULT 'urgent' CHECK (
    priority IN ('standard', 'urgent', 'emergency')
  ),
  status text NOT NULL DEFAULT 'requested' CHECK (
    status IN (
      'requested', 'awaiting_provider', 'dispatched', 'en_route',
      'arrived', 'resolved', 'cancelled', 'failed'
    )
  ),
  latitude numeric(10,7),
  longitude numeric(10,7),
  address text,
  notes text NOT NULL DEFAULT '',
  safety_concern boolean NOT NULL DEFAULT false,
  provider text,
  provider_reference text,
  provider_status text,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  dispatched_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, booking_id)
    REFERENCES fleet_bookings(organization_id, id) ON DELETE SET NULL,
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES fleet_customers(organization_id, id) ON DELETE SET NULL,
  FOREIGN KEY (organization_id, vehicle_id)
    REFERENCES fleet_vehicles(organization_id, id) ON DELETE SET NULL,
  CHECK (
    (latitude IS NULL AND longitude IS NULL) OR
    (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
  )
);

CREATE INDEX IF NOT EXISTS fleet_roadside_cases_open_idx
  ON fleet_roadside_cases (organization_id, status, created_at DESC)
  WHERE status NOT IN ('resolved', 'cancelled');

CREATE TABLE IF NOT EXISTS fleet_roadside_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  case_id uuid NOT NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(details_json) = 'object'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, case_id)
    REFERENCES fleet_roadside_cases(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fleet_roadside_events_case_idx
  ON fleet_roadside_events (organization_id, case_id, created_at);

CREATE TABLE IF NOT EXISTS fleet_telematics_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  vehicle_id uuid NOT NULL,
  provider text NOT NULL,
  external_vehicle_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'connected', 'degraded', 'disabled')
  ),
  capabilities_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(capabilities_json) = 'array'
  ),
  safe_configuration_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(safe_configuration_json) = 'object'
  ),
  last_synced_at timestamptz,
  last_error_code text,
  configured_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, vehicle_id),
  UNIQUE (organization_id, provider, external_vehicle_id),
  FOREIGN KEY (organization_id, vehicle_id)
    REFERENCES fleet_vehicles(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fleet_telematics_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  connection_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  latitude numeric(10,7),
  longitude numeric(10,7),
  speed_mph numeric(8,2),
  odometer_miles numeric(12,2),
  fuel_percent numeric(5,2),
  battery_percent numeric(5,2),
  ignition_on boolean,
  doors_locked boolean,
  heading_degrees numeric(6,2),
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  raw_reference text,
  FOREIGN KEY (organization_id, connection_id)
    REFERENCES fleet_telematics_connections(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, vehicle_id)
    REFERENCES fleet_vehicles(organization_id, id) ON DELETE CASCADE,
  CHECK (
    (latitude IS NULL AND longitude IS NULL) OR
    (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
  )
);

CREATE INDEX IF NOT EXISTS fleet_telematics_snapshots_vehicle_idx
  ON fleet_telematics_snapshots (organization_id, vehicle_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS fleet_telematics_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  connection_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  command text NOT NULL CHECK (
    command IN ('locate', 'lock', 'unlock', 'honk', 'lights')
  ),
  status text NOT NULL DEFAULT 'requested' CHECK (
    status IN ('requested', 'dispatched', 'succeeded', 'failed', 'denied')
  ),
  idempotency_key text NOT NULL,
  provider_reference text,
  error_code text,
  request_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(request_json) = 'object'
  ),
  response_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(response_json) = 'object'
  ),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, connection_id)
    REFERENCES fleet_telematics_connections(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, vehicle_id)
    REFERENCES fleet_vehicles(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fleet_telematics_commands_vehicle_idx
  ON fleet_telematics_commands (organization_id, vehicle_id, requested_at DESC);

COMMIT;
