BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS fleet_workspace_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  workspace_version integer NOT NULL CHECK (workspace_version > 0),
  state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
  changed_sections jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(changed_sections) = 'array'),
  change_source text NOT NULL DEFAULT 'save'
    CHECK (change_source IN ('save', 'branch_delete', 'restore', 'migration')),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  previous_revision_hash text,
  revision_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, workspace_version)
);

CREATE INDEX IF NOT EXISTS fleet_workspace_revisions_org_created_idx
  ON fleet_workspace_revisions (organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_fleet_workspace_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'GoodFleet workspace recovery points are append-only.';
END;
$$;

DROP TRIGGER IF EXISTS fleet_workspace_revision_append_only
  ON fleet_workspace_revisions;

CREATE TRIGGER fleet_workspace_revision_append_only
BEFORE UPDATE OR DELETE
ON fleet_workspace_revisions
FOR EACH ROW
EXECUTE FUNCTION prevent_fleet_workspace_revision_mutation();

INSERT INTO fleet_workspace_revisions (
  organization_id,
  workspace_version,
  state_json,
  changed_sections,
  change_source,
  actor_id,
  previous_revision_hash,
  revision_hash,
  created_at
)
SELECT
  workspace.organization_id,
  workspace.version,
  workspace.state_json,
  COALESCE((
    SELECT jsonb_agg(section_name ORDER BY section_name)
      FROM jsonb_object_keys(workspace.state_json) AS section_name
  ), '[]'::jsonb),
  'migration',
  COALESCE(workspace.updated_by, workspace.created_by),
  NULL,
  encode(
    digest(
      workspace.organization_id || '|' ||
      workspace.version::text || '||' ||
      workspace.state_json::text,
      'sha256'
    ),
    'hex'
  ),
  workspace.updated_at
FROM fleet_workspace_state workspace
ON CONFLICT (organization_id, workspace_version) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodapp_backend_user') THEN
    GRANT SELECT, INSERT
      ON fleet_workspace_revisions
      TO goodapp_backend_user;
  END IF;
END $$;

COMMIT;
