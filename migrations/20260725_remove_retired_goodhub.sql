BEGIN;

-- GoodHub has been retired and must not remain addressable through the
-- application registry or deployment control plane.
DELETE FROM app_memberships
WHERE app_id = 'goodhub';

DELETE FROM backend_deployment_sites
WHERE app_id = 'goodhub';

DELETE FROM apps
WHERE id = 'goodhub';

-- GoodBackend was renamed to GoodBase. Keep this cleanup idempotent for
-- environments that may have missed the original rename migration.
DELETE FROM apps
WHERE id = 'goodbackend'
   OR lower(coalesce(domain, '')) = 'backend.goodos.app';

UPDATE apps
SET
  name = 'GoodBase',
  domain = 'base.goodos.app',
  status = 'active',
  updated_at = NOW()
WHERE id = 'goodbase'
  AND (
    name IS DISTINCT FROM 'GoodBase'
    OR domain IS DISTINCT FROM 'base.goodos.app'
    OR status IS DISTINCT FROM 'active'
  );

DO $cleanup_validation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM apps
    WHERE id IN ('goodhub', 'goodbackend')
       OR lower(coalesce(domain, '')) IN ('hub.goodos.app', 'backend.goodos.app')
  ) THEN
    RAISE EXCEPTION 'Retired GoodHub or GoodBackend registry data remains';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM apps
    WHERE id = 'goodbase'
      AND name = 'GoodBase'
      AND domain = 'base.goodos.app'
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Canonical GoodBase registry row is missing';
  END IF;
END
$cleanup_validation$;

COMMIT;
