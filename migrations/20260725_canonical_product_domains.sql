BEGIN;

UPDATE apps
SET
  domain = 'custom.goodos.app',
  updated_at = NOW()
WHERE id = 'goodcustoms'
  AND domain IS DISTINCT FROM 'custom.goodos.app';

UPDATE apps
SET
  domain = 'trust.goodos.app',
  updated_at = NOW()
WHERE id = 'goodtrusts'
  AND domain IS DISTINCT FROM 'trust.goodos.app';

DO $canonical_domain_validation$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM apps
    WHERE id = 'goodcustoms'
      AND domain = 'custom.goodos.app'
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'GoodCustoms canonical domain is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM apps
    WHERE id = 'goodtrusts'
      AND domain = 'trust.goodos.app'
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'GoodTrust canonical domain is missing';
  END IF;
END
$canonical_domain_validation$;

COMMIT;
