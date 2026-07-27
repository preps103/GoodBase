BEGIN;

DO $$
DECLARE
  matched_users INTEGER;
  password_ready_users INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER
  INTO matched_users
  FROM users
  WHERE LOWER(email) IN ('ryan@goodos.app', 'marissa@goodos.app');

  IF matched_users <> 2 THEN
    RAISE EXCEPTION
      'Manager access migration requires both ryan@goodos.app and marissa@goodos.app to exist; found % account(s).',
      matched_users;
  END IF;

  SELECT COUNT(*)::INTEGER
  INTO password_ready_users
  FROM users
  WHERE LOWER(email) IN ('ryan@goodos.app', 'marissa@goodos.app')
    AND password_hash IS NOT NULL
    AND LENGTH(password_hash) > 0;

  IF password_ready_users <> 2 THEN
    RAISE EXCEPTION
      'Manager access migration requires both tester accounts to have completed password setup; found % password-ready account(s).',
      password_ready_users;
  END IF;
END
$$;

UPDATE users
SET
  platform_role = 'admin',
  status = 'active',
  email_verified = TRUE,
  failed_login_count = 0,
  locked_until = NULL,
  updated_at = NOW()
WHERE LOWER(email) IN ('ryan@goodos.app', 'marissa@goodos.app');

UPDATE backend_user_roles
SET
  status = 'revoked',
  revoked_at = COALESCE(revoked_at, NOW()),
  updated_at = NOW()
WHERE user_id IN (
  SELECT id
  FROM users
  WHERE LOWER(email) IN ('ryan@goodos.app', 'marissa@goodos.app')
)
  AND scope_type = 'platform'
  AND scope_id = '*'
  AND role_id <> 'role_manager'
  AND status = 'active';

INSERT INTO backend_user_roles (
  id,
  user_id,
  role_id,
  role_name,
  scope_type,
  scope_id,
  status,
  assigned_by,
  assigned_at,
  revoked_at,
  metadata_json,
  organization_id,
  project_id,
  environment_id
)
SELECT
  'userrole_' || REPLACE(account.id::TEXT, '-', '') || '_manager',
  account.id,
  'role_manager',
  'manager',
  'platform',
  '*',
  'active',
  owner_account.id,
  NOW(),
  NULL,
  '{"source":"20260727_manager_testers_access","purpose":"cross-application-testing"}'::JSONB,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
FROM users account
LEFT JOIN LATERAL (
  SELECT id
  FROM users
  WHERE platform_role = 'owner'
    AND status = 'active'
  ORDER BY created_at ASC
  LIMIT 1
) owner_account ON TRUE
WHERE LOWER(account.email) IN ('ryan@goodos.app', 'marissa@goodos.app')
ON CONFLICT (user_id, role_id, scope_type, scope_id) DO UPDATE
SET
  role_name = 'manager',
  status = 'active',
  assigned_by = EXCLUDED.assigned_by,
  assigned_at = NOW(),
  revoked_at = NULL,
  metadata_json = EXCLUDED.metadata_json,
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
  account.id,
  application.id,
  'admin',
  'active',
  COALESCE(application.organization_id, 'org_goodos'),
  COALESCE(application.project_id, 'proj_goodos_platform'),
  COALESCE(application.environment_id, 'env_goodos_production')
FROM users account
CROSS JOIN apps application
WHERE LOWER(account.email) IN ('ryan@goodos.app', 'marissa@goodos.app')
  AND application.status = 'active'
ON CONFLICT (user_id, app_id) DO UPDATE
SET
  role = 'admin',
  status = 'active',
  organization_id = EXCLUDED.organization_id,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id,
  updated_at = NOW();

UPDATE sessions
SET revoked_at = NOW()
WHERE user_id IN (
  SELECT id
  FROM users
  WHERE LOWER(email) IN ('ryan@goodos.app', 'marissa@goodos.app')
)
  AND revoked_at IS NULL;

INSERT INTO backend_admin_audit_logs (
  id,
  actor,
  action,
  target_type,
  target_id,
  after_json
)
SELECT
  'audit_manager_access_' || REPLACE(account.id::TEXT, '-', ''),
  COALESCE(owner_account.email, 'system:manager-access-migration'),
  'auth.user.manager_access_granted',
  'user',
  account.id::TEXT,
  JSONB_BUILD_OBJECT(
    'email', LOWER(account.email),
    'platformRole', 'admin',
    'accessLevel', 'manager',
    'allActiveApplications', TRUE,
    'source', '20260727_manager_testers_access'
  )
FROM users account
LEFT JOIN LATERAL (
  SELECT email
  FROM users
  WHERE platform_role = 'owner'
    AND status = 'active'
  ORDER BY created_at ASC
  LIMIT 1
) owner_account ON TRUE
WHERE LOWER(account.email) IN ('ryan@goodos.app', 'marissa@goodos.app')
ON CONFLICT (id) DO UPDATE
SET
  actor = EXCLUDED.actor,
  after_json = EXCLUDED.after_json;

COMMIT;
