BEGIN;

WITH registry (
  id,
  name,
  domain,
  description
) AS (
  VALUES
    (
      'gearheadracing',
      'GearHead Racing',
      'gearhead.goodos.app',
      'Competitive card racing, vehicle strategy, events, and championship progression'
    ),
    (
      'buyblack',
      'BuyBlack',
      'buyblack.goodos.app',
      'Black-owned business discovery, commerce, and community marketplace'
    ),
    (
      'goodsure',
      'GoodSure',
      'sure.goodos.app',
      'Insurance coverage discovery, policy management, claims, and protection tools'
    ),
    (
      'gpanel',
      'GoodPanel',
      'panel.goodos.app',
      'GoodOS hosting, infrastructure, domains, email, databases, and control-panel operations'
    ),
    (
      'goodbuilder',
      'GoodBuilder',
      'builder.goodos.app',
      'Native visual website building, content management, and publishing for GoodOS'
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
    ('gearheadracing'),
    ('buyblack'),
    ('goodsure'),
    ('gpanel'),
    ('goodbuilder')
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
  'owner',
  'active',
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
FROM users
CROSS JOIN registry
WHERE users.platform_role = 'owner'
  AND users.status = 'active'
ON CONFLICT (user_id, app_id) DO UPDATE SET
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  organization_id = EXCLUDED.organization_id,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id,
  updated_at = NOW();

COMMIT;
