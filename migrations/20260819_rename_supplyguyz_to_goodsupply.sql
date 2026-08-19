BEGIN;

UPDATE apps
SET
  name = 'GoodSupply',
  updated_at = NOW()
WHERE id = 'supplyguyz'
  AND name IS DISTINCT FROM 'GoodSupply';

COMMIT;
