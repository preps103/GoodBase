CREATE TABLE IF NOT EXISTS goodbuilder_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  primary_domain TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  settings_json JSONB NOT NULL DEFAULT '{
    "schemaVersion": 1,
    "breakpoints": {"desktop": 1200, "tablet": 1024, "mobile": 767},
    "tokens": {"colors": {}, "typography": {}, "spacing": {}, "shadows": {}}
  }'::jsonb CHECK (jsonb_typeof(settings_json) = 'object'),
  published_snapshot_json JSONB CHECK (
    published_snapshot_json IS NULL OR jsonb_typeof(published_snapshot_json) = 'object'
  ),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS goodbuilder_sites_owner_updated_idx
  ON goodbuilder_sites(owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS goodbuilder_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES goodbuilder_sites(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','scheduled','archived')),
  is_home BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 0,
  document_json JSONB NOT NULL DEFAULT '{"schemaVersion":1,"root":[]}'::jsonb
    CHECK (jsonb_typeof(document_json) = 'object'),
  seo_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(seo_json) = 'object'),
  scheduled_for TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, slug)
);

CREATE UNIQUE INDEX IF NOT EXISTS goodbuilder_pages_one_home_idx
  ON goodbuilder_pages(site_id) WHERE is_home = TRUE AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS goodbuilder_pages_site_position_idx
  ON goodbuilder_pages(site_id, position, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS goodbuilder_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES goodbuilder_pages(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES goodbuilder_sites(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  document_json JSONB NOT NULL CHECK (jsonb_typeof(document_json) = 'object'),
  seo_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(seo_json) = 'object'),
  change_summary TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('autosave','manual','publish','restore','import')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS goodbuilder_revisions_page_created_idx
  ON goodbuilder_revisions(page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goodbuilder_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES goodbuilder_sites(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  template_type TEXT NOT NULL DEFAULT 'section' CHECK (
    template_type IN (
      'page','section','container','global-widget','header','footer','single',
      'archive','search','404','popup','loop','product','product-archive',
      'cart','checkout','account'
    )
  ),
  document_json JSONB NOT NULL DEFAULT '{"schemaVersion":1,"root":[]}'::jsonb
    CHECK (jsonb_typeof(document_json) = 'object'),
  conditions_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conditions_json) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, slug)
);

CREATE INDEX IF NOT EXISTS goodbuilder_templates_site_type_idx
  ON goodbuilder_templates(site_id, template_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS goodbuilder_publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES goodbuilder_sites(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_json JSONB NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS goodbuilder_publications_site_created_idx
  ON goodbuilder_publications(site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goodbuilder_form_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES goodbuilder_sites(id) ON DELETE CASCADE,
  page_id UUID REFERENCES goodbuilder_pages(id) ON DELETE SET NULL,
  form_key TEXT NOT NULL,
  data_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data_json) = 'object'),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','read','spam','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS goodbuilder_submissions_site_created_idx
  ON goodbuilder_form_submissions(site_id, created_at DESC);

INSERT INTO apps (
  id, name, domain, status, description,
  organization_id, project_id, environment_id
)
VALUES (
  'goodbuilder', 'GoodBuilder', 'builder.goodos.app', 'active',
  'Native visual website building and publishing for GoodOS',
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
