BEGIN;

WITH registry (
  id,
  name,
  domain,
  description
) AS (
  VALUES
    (
      'goodmac',
      'GoodMac',
      'mac.goodos.app',
      'Privacy-first Apple device cleanup, storage review, and organization'
    ),
    (
      'goodtrading',
      'GoodTrading',
      'trading.goodos.app',
      'Trading automation control room for disciplined strategy building, monitoring, and management'
    ),
    (
      'supplyguyz',
      'SupplyGuyz',
      'supplyguyz.goodos.app',
      'Field collections, inventory quality, team performance, payouts, and operations management'
    )
)
INSERT INTO apps (
  id,
  name,
  domain,
  status,
  description,
  organization_id,
  project_id,
  environment_id
)
SELECT
  registry.id,
  registry.name,
  registry.domain,
  'active',
  registry.description,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
FROM registry
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  domain = EXCLUDED.domain,
  status = EXCLUDED.status,
  description = EXCLUDED.description,
  organization_id = EXCLUDED.organization_id,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id,
  updated_at = NOW();

WITH registry (id) AS (
  VALUES
    ('goodmac'),
    ('goodtrading'),
    ('supplyguyz')
)
INSERT INTO app_memberships (
  user_id,
  app_id,
  role,
  status,
  organization_id,
  project_id,
  environment_id
)
SELECT
  users.id,
  registry.id,
  CASE
    WHEN users.platform_role = 'owner' THEN 'owner'
    ELSE 'admin'
  END,
  'active',
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
FROM users
CROSS JOIN registry
WHERE users.status = 'active'
  AND LOWER(users.email) LIKE '%@goodos.app'
ON CONFLICT (user_id, app_id) DO UPDATE SET
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  organization_id = EXCLUDED.organization_id,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id,
  updated_at = NOW();

COMMIT;
