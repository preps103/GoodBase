BEGIN;

CREATE TABLE IF NOT EXISTS fleet_managed_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  category text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  original_name text NOT NULL,
  stored_name text NOT NULL,
  content_type text NOT NULL CHECK (
    content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
  ),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  checksum_sha256 char(64) NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, stored_name)
);

CREATE INDEX IF NOT EXISTS fleet_managed_assets_entity_idx
  ON fleet_managed_assets (organization_id, entity_type, entity_id, created_at DESC);

ALTER TABLE fleet_managed_assets
  DROP CONSTRAINT IF EXISTS fleet_managed_assets_category_check;
ALTER TABLE fleet_managed_assets
  ADD CONSTRAINT fleet_managed_assets_category_check CHECK (
    category IN (
      'damage_evidence',
      'damage_document',
      'maintenance_attachment',
      'inspection_attachment',
      'customer_document',
      'branding_asset',
      'vehicle_image',
      'expense_receipt'
    )
  );

ALTER TABLE fleet_managed_assets
  DROP CONSTRAINT IF EXISTS fleet_managed_assets_entity_type_check;
ALTER TABLE fleet_managed_assets
  ADD CONSTRAINT fleet_managed_assets_entity_type_check CHECK (
    entity_type IN ('damage_report', 'maintenance', 'inspection', 'customer', 'workspace', 'vehicle', 'expense')
  );

COMMIT;
