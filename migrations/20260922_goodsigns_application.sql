BEGIN;

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
VALUES (
  'goodsigns',
  'GoodSigns',
  'signs.goodos.app',
  'active',
  'Cross-platform sign design, vinyl cutting, cutter profiles, and production workflows',
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  domain = EXCLUDED.domain,
  status = EXCLUDED.status,
  description = EXCLUDED.description,
  organization_id = EXCLUDED.organization_id,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id,
  updated_at = NOW();

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
  'goodsigns',
  CASE WHEN users.platform_role = 'owner' THEN 'owner' ELSE 'admin' END,
  'active',
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
FROM users
WHERE users.status = 'active'
  AND (
    users.platform_role = 'owner'
    OR LOWER(users.email) LIKE '%@goodos.app'
  )
ON CONFLICT (user_id, app_id) DO UPDATE SET
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  organization_id = EXCLUDED.organization_id,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id,
  updated_at = NOW();

COMMIT;
