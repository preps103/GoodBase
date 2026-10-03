BEGIN;

CREATE TABLE IF NOT EXISTS goodspeech_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  greeting TEXT NOT NULL,
  voice_name TEXT NOT NULL DEFAULT 'Kore',
  language TEXT NOT NULL DEFAULT 'en-us',
  enabled_tools TEXT[] NOT NULL DEFAULT ARRAY['knowledge_search','current_time','usage_summary','handoff']::TEXT[],
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 0 AND 365),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT goodspeech_agent_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT goodspeech_agent_prompt_length CHECK (char_length(system_prompt) BETWEEN 1 AND 8000),
  CONSTRAINT goodspeech_agent_greeting_length CHECK (char_length(greeting) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_agents_owner
  ON goodspeech_agents (organization_id, owner_user_id, updated_at DESC)
  WHERE status <> 'archived';

CREATE TABLE IF NOT EXISTS goodspeech_agent_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES goodspeech_agents(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, content_sha256),
  CONSTRAINT goodspeech_agent_knowledge_title_length CHECK (char_length(title) BETWEEN 1 AND 180),
  CONSTRAINT goodspeech_agent_knowledge_content_length CHECK (char_length(content) BETWEEN 1 AND 40000)
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_agent_knowledge_agent
  ON goodspeech_agent_knowledge (agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS goodspeech_agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES goodspeech_agents(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'api', 'test')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'handed_off', 'abandoned')),
  turn_count INTEGER NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  interruption_count INTEGER NOT NULL DEFAULT 0 CHECK (interruption_count >= 0),
  total_latency_ms BIGINT NOT NULL DEFAULT 0 CHECK (total_latency_ms >= 0),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('resolved', 'unresolved', 'handed_off')),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_agent_sessions_owner
  ON goodspeech_agent_sessions (organization_id, owner_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_goodspeech_agent_sessions_agent
  ON goodspeech_agent_sessions (agent_id, started_at DESC);

CREATE TABLE IF NOT EXISTS goodspeech_agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES goodspeech_agent_sessions(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  engine TEXT,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  interrupted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, sequence_number),
  CONSTRAINT goodspeech_agent_message_length CHECK (char_length(content) BETWEEN 1 AND 12000)
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_agent_messages_session
  ON goodspeech_agent_messages (session_id, sequence_number ASC);

CREATE TABLE IF NOT EXISTS goodspeech_agent_tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES goodspeech_agent_sessions(id) ON DELETE CASCADE,
  message_id UUID REFERENCES goodspeech_agent_messages(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'blocked')),
  arguments_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_agent_tool_calls_session
  ON goodspeech_agent_tool_calls (session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS goodspeech_agent_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES goodspeech_agents(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  input_text TEXT NOT NULL,
  expected_phrase TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'passed', 'failed')),
  last_response TEXT,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT goodspeech_agent_test_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT goodspeech_agent_test_input_length CHECK (char_length(input_text) BETWEEN 1 AND 2000),
  CONSTRAINT goodspeech_agent_test_expectation_length CHECK (char_length(expected_phrase) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS idx_goodspeech_agent_tests_agent
  ON goodspeech_agent_tests (agent_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_agents TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_agent_knowledge TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_agent_sessions TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_agent_messages TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_agent_tool_calls TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodspeech_agent_tests TO goodapp_backend_user;

COMMIT;
