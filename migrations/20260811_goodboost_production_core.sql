CREATE TABLE IF NOT EXISTS goodboost_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO apps (
  id, name, domain, status, description,
  organization_id, project_id, environment_id
)
VALUES (
  'goodboost', 'GoodBoost', 'boost.goodos.app', 'active',
  'GoodOS social-audience and growth-operations workspace',
  'org_goodos', 'proj_goodos_platform', 'env_goodos_production'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  domain = EXCLUDED.domain,
  status = EXCLUDED.status,
  description = EXCLUDED.description,
  organization_id = EXCLUDED.organization_id,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id;

COMMENT ON TABLE goodboost_profiles IS
  'Current GoodBoost user preferences. Retired exchange prototype tables are not part of the production bootstrap.';
