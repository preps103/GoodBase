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

CREATE OR REPLACE FUNCTION capture_fleet_workspace_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_hash text;
  prior_state jsonb;
  section_names jsonb;
  source_name text;
  calculated_hash text;
BEGIN
  IF TG_OP='INSERT' THEN
    prior_state := '{}'::jsonb;
  ELSE
    prior_state := COALESCE(OLD.state_json, '{}'::jsonb);
  END IF;

  SELECT revision_hash
    INTO prior_hash
    FROM fleet_workspace_revisions
   WHERE organization_id=NEW.organization_id
   ORDER BY workspace_version DESC
   LIMIT 1;

  SELECT COALESCE(jsonb_agg(section_name ORDER BY section_name), '[]'::jsonb)
    INTO section_names
    FROM (
      SELECT section_name
        FROM (
          SELECT jsonb_object_keys(prior_state) AS section_name
          UNION
          SELECT jsonb_object_keys(COALESCE(NEW.state_json, '{}'::jsonb)) AS section_name
        ) available_sections
       WHERE prior_state->section_name
             IS DISTINCT FROM
             COALESCE(NEW.state_json, '{}'::jsonb)->section_name
    ) changed;

  source_name := COALESCE(
    NULLIF(current_setting('goodfleet.workspace_change_source', true), ''),
    CASE WHEN TG_OP='INSERT' THEN 'migration' ELSE 'save' END
  );
  IF source_name NOT IN ('save', 'branch_delete', 'restore', 'migration') THEN
    source_name := 'save';
  END IF;

  calculated_hash := encode(
    digest(
      NEW.organization_id || '|' ||
      NEW.version::text || '|' ||
      COALESCE(prior_hash, '') || '|' ||
      NEW.state_json::text,
      'sha256'
    ),
    'hex'
  );

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
  ) VALUES (
    NEW.organization_id,
    NEW.version,
    NEW.state_json,
    section_names,
    source_name,
    COALESCE(NEW.updated_by, NEW.created_by),
    prior_hash,
    calculated_hash,
    COALESCE(NEW.updated_at, now())
  )
  ON CONFLICT (organization_id, workspace_version) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fleet_workspace_revision_capture
  ON fleet_workspace_state;

CREATE TRIGGER fleet_workspace_revision_capture
AFTER INSERT OR UPDATE OF state_json, version
ON fleet_workspace_state
FOR EACH ROW
EXECUTE FUNCTION capture_fleet_workspace_revision();

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
