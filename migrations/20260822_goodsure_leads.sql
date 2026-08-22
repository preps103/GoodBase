BEGIN;

CREATE TABLE IF NOT EXISTS goodsure_leads (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  email TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  phone TEXT NOT NULL CHECK (char_length(phone) BETWEEN 7 AND 30),
  age INTEGER NOT NULL CHECK (age BETWEEN 18 AND 100),
  coverage_amount BIGINT NOT NULL CHECK (coverage_amount BETWEEN 10000 AND 10000000),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'dialing', 'transferred', 'warmed', 'closed', 'lost')),
  ai_notes TEXT NOT NULL DEFAULT '' CHECK (char_length(ai_notes) <= 8000),
  dial_attempts INTEGER NOT NULL DEFAULT 0 CHECK (dial_attempts BETWEEN 0 AND 10000),
  last_dial_time TIMESTAMPTZ,
  transfer_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodsure_leads_status_created
ON goodsure_leads(status, created_at DESC);

DROP TRIGGER IF EXISTS set_goodsure_leads_updated_at ON goodsure_leads;
CREATE TRIGGER set_goodsure_leads_updated_at
BEFORE UPDATE ON goodsure_leads
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO backend_table_api_rules (
  id, table_name, api_slug, display_name, description,
  read_enabled, write_enabled, insert_enabled, update_enabled, delete_enabled,
  exposed_columns, searchable_columns, allowed_api_key_scopes, allowed_app_ids,
  max_rows, status, organization_id, project_id, environment_id, metadata_json
)
VALUES (
  'tblapi_goodsure_leads',
  'goodsure_leads',
  'goodsure-leads',
  'GoodSure leads',
  'Validated insurance lead intake and staff workflow records.',
  true, true, true, true, false,
  ARRAY['id','name','email','phone','age','coverage_amount','status','ai_notes','dial_attempts','last_dial_time','transfer_time','created_at','updated_at'],
  ARRAY['name','email','phone','status'],
  ARRAY['read:db','write:db'],
  ARRAY['goodsure'],
  500,
  'active',
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production',
  '{"managedBy":"GoodSure","containsSensitiveData":true}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  table_name = EXCLUDED.table_name,
  api_slug = EXCLUDED.api_slug,
  read_enabled = EXCLUDED.read_enabled,
  write_enabled = EXCLUDED.write_enabled,
  insert_enabled = EXCLUDED.insert_enabled,
  update_enabled = EXCLUDED.update_enabled,
  delete_enabled = EXCLUDED.delete_enabled,
  exposed_columns = EXCLUDED.exposed_columns,
  searchable_columns = EXCLUDED.searchable_columns,
  allowed_api_key_scopes = EXCLUDED.allowed_api_key_scopes,
  allowed_app_ids = EXCLUDED.allowed_app_ids,
  max_rows = EXCLUDED.max_rows,
  status = EXCLUDED.status,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

GRANT SELECT, INSERT, UPDATE ON goodsure_leads TO goodapp_backend_user;

COMMIT;
