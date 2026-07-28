BEGIN;

CREATE TABLE IF NOT EXISTS goodcustom_quote_requests (
  id UUID PRIMARY KEY,
  request_key TEXT,
  requester_user_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  email TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  phone TEXT NOT NULL CHECK (char_length(phone) BETWEEN 7 AND 30),
  car_model TEXT NOT NULL CHECK (char_length(car_model) BETWEEN 1 AND 100),
  service TEXT NOT NULL
    CHECK (service IN (
      'wrap',
      'ppf',
      'ceramic-tint',
      'starlight',
      'mats',
      'smart-tint',
      'other'
    )),
  message TEXT NOT NULL DEFAULT '' CHECK (char_length(message) <= 1500),
  starting_estimate_cents BIGINT NOT NULL
    CHECK (starting_estimate_cents BETWEEN 1 AND 10000000),
  options_json JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(options_json) = 'array'),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'quoted', 'scheduled', 'closed')),
  deleted_at TIMESTAMPTZ,
  deleted_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goodcustom_quote_request_key
ON goodcustom_quote_requests(requester_user_id, request_key)
WHERE request_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_goodcustom_quotes_status_created
ON goodcustom_quote_requests(status, created_at DESC)
WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS set_goodcustom_quote_requests_updated_at
ON goodcustom_quote_requests;
CREATE TRIGGER set_goodcustom_quote_requests_updated_at
BEFORE UPDATE ON goodcustom_quote_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE
ON goodcustom_quote_requests
TO goodapp_backend_user;

COMMIT;
