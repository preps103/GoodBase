BEGIN;

INSERT INTO backend_billing_plans (
  id,
  name,
  display_name,
  description,
  currency,
  monthly_price_cents,
  annual_price_cents,
  included_json,
  limits_json,
  features_json,
  status,
  sort_order,
  metadata_json,
  project_id,
  environment_id
)
VALUES
  (
    'plan_goodos_single_app',
    'single-app',
    'Single App',
    'Choose one GoodOS application.',
    'usd', 1900, 19000,
    '{"applicationCount":1}'::jsonb,
    '{"applications":1}'::jsonb,
    '["One application","Shared GoodOS account","Card or PayPal checkout"]'::jsonb,
    'active', 10,
    '{"purchaseTier":"single","pricingVersion":"2026-10-11","discountPercent":0}'::jsonb,
    'proj_goodos_platform', 'env_goodos_production'
  ),
  (
    'plan_goodos_five_app',
    'five-app',
    'Five App Pack',
    'Choose five GoodOS applications and save 11%.',
    'usd', 8500, 85000,
    '{"applicationCount":5}'::jsonb,
    '{"applications":5}'::jsonb,
    '["Five selected applications","Shared GoodOS account","11% bundle discount"]'::jsonb,
    'active', 20,
    '{"purchaseTier":"five","pricingVersion":"2026-10-11","discountPercent":11}'::jsonb,
    'proj_goodos_platform', 'env_goodos_production'
  ),
  (
    'plan_goodos_ten_app',
    'ten-app',
    'Ten App Pack',
    'Choose ten GoodOS applications and save 22%.',
    'usd', 14900, 149000,
    '{"applicationCount":10}'::jsonb,
    '{"applications":10}'::jsonb,
    '["Ten selected applications","Shared GoodOS account","22% bundle discount"]'::jsonb,
    'active', 30,
    '{"purchaseTier":"ten","pricingVersion":"2026-10-11","discountPercent":22}'::jsonb,
    'proj_goodos_platform', 'env_goodos_production'
  ),
  (
    'plan_goodos_suite',
    'goodos-suite',
    'Complete GoodOS Suite',
    'Every active GoodOS application in one subscription.',
    'usd', 24900, 249000,
    '{"applicationCount":"all"}'::jsonb,
    '{"applications":"all"}'::jsonb,
    '["Every active GoodOS application","New suite applications included","56% savings versus 30 single apps"]'::jsonb,
    'active', 40,
    '{"purchaseTier":"suite","pricingVersion":"2026-10-11","discountPercent":56}'::jsonb,
    'proj_goodos_platform', 'env_goodos_production'
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  currency = EXCLUDED.currency,
  monthly_price_cents = EXCLUDED.monthly_price_cents,
  annual_price_cents = EXCLUDED.annual_price_cents,
  included_json = EXCLUDED.included_json,
  limits_json = EXCLUDED.limits_json,
  features_json = EXCLUDED.features_json,
  status = EXCLUDED.status,
  sort_order = EXCLUDED.sort_order,
  metadata_json = backend_billing_plans.metadata_json || EXCLUDED.metadata_json,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id,
  updated_at = NOW();

COMMIT;
