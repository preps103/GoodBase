BEGIN;

UPDATE apps
SET
  domain = 'sure.goodos.app',
  updated_at = NOW()
WHERE id = 'goodsure'
  AND domain IS DISTINCT FROM 'sure.goodos.app';

UPDATE apps
SET
  name = 'GoodSupply',
  domain = 'supply.goodos.app',
  updated_at = NOW()
WHERE id = 'supplyguyz'
  AND (name IS DISTINCT FROM 'GoodSupply'
    OR domain IS DISTINCT FROM 'supply.goodos.app');

DO $canonical_application_domain_validation$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM apps
    WHERE id = 'goodsure'
      AND domain = 'sure.goodos.app'
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'GoodSure canonical domain is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM apps
    WHERE id = 'supplyguyz'
      AND name = 'GoodSupply'
      AND domain = 'supply.goodos.app'
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'GoodSupply canonical registry entry is missing';
  END IF;
END
$canonical_application_domain_validation$;

COMMIT;
