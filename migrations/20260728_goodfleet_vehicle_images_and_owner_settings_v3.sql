BEGIN;

UPDATE fleet_vehicles
SET payload = jsonb_set(
      jsonb_set(
        payload,
        '{imageUrl}',
        to_jsonb('/vehicles/2014-chevrolet-cruze-blue-metallic.webp'::text),
        true
      ),
      '{color}',
      to_jsonb('Blue metallic glitter'::text),
      true
    ),
    version = version + 1,
    updated_at = now()
WHERE organization_id = 'org_goodos'
  AND lower(make) = 'chevrolet'
  AND lower(model) LIKE '%cruze%';

UPDATE fleet_vehicles
SET payload = jsonb_set(
      jsonb_set(
        payload,
        '{imageUrl}',
        to_jsonb('/vehicles/2014-hyundai-sonata-pearl-white.webp'::text),
        true
      ),
      '{color}',
      to_jsonb('Pearl white'::text),
      true
    ),
    version = version + 1,
    updated_at = now()
WHERE organization_id = 'org_goodos'
  AND lower(make) = 'hyundai'
  AND lower(model) LIKE '%sonata%';

COMMIT;
