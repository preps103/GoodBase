BEGIN;

CREATE TABLE IF NOT EXISTS fleet_staff_onboarding_progress (
  organization_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tour_version integer NOT NULL DEFAULT 1 CHECK (tour_version BETWEEN 1 AND 100),
  completed_modules text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_module text,
  role_at_start text,
  started_at timestamptz NOT NULL DEFAULT NOW(),
  dismissed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id),
  CHECK (cardinality(completed_modules) <= 30)
);

CREATE INDEX IF NOT EXISTS fleet_staff_onboarding_org_completion_idx
  ON fleet_staff_onboarding_progress (organization_id, completed_at, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON fleet_staff_onboarding_progress
  TO goodapp_backend_user;

COMMIT;
