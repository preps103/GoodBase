BEGIN;

ALTER TABLE fleet_customers
  ALTER COLUMN license_number DROP NOT NULL,
  ALTER COLUMN license_expiry DROP NOT NULL;

ALTER TABLE fleet_customers
  ADD COLUMN IF NOT EXISTS license_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS license_verified_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS license_verification_method text;

DO $$
BEGIN
  ALTER TABLE fleet_customers
    ADD CONSTRAINT fleet_customers_license_verification_method_check
    CHECK (
      license_verification_method IS NULL OR
      license_verification_method IN ('in_person')
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS fleet_customers_org_verification_idx
  ON fleet_customers (organization_id, license_verification_status, license_expiry)
  WHERE archived_at IS NULL;

INSERT INTO backend_organization_memberships (
  id,
  organization_id,
  user_id,
  role,
  status
)
SELECT
  gen_random_uuid()::text,
  membership.organization_id,
  membership.user_id,
  CASE membership.role
    WHEN 'owner' THEN 'owner'
    WHEN 'admin' THEN 'admin'
    WHEN 'manager' THEN 'manager'
    ELSE 'member'
  END,
  'active'
FROM app_memberships membership
WHERE membership.app_id = 'goodfleet'
  AND membership.status = 'active'
  AND membership.organization_id IS NOT NULL
ON CONFLICT (organization_id, user_id) DO NOTHING;

COMMIT;
