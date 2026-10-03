"use strict";

const crypto = require("node:crypto");
const database = require("../config/database");
const usageService = require("./goodspeech-usage.service");

const ALLOWED_TOOLS = Object.freeze(["knowledge_search", "current_time", "usage_summary", "handoff"]);
const ALLOWED_VOICES = new Set(["Kore", "Puck", "Charon", "Fenrir", "Zephyr", "Amara", "Celeste", "Bennett", "Ellis"]);
const ALLOWED_LANGUAGES = new Set(["en-us", "en-gb", "es", "fr-fr", "hi", "it", "pt-br"]);
const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "what", "when", "where", "which", "who", "with", "you", "your"]);

function requestError(message, statusCode = 400, code = "GOODSPEECH_AGENT_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

function boundedText(value, maximum, label, minimum = 1) {
  const text = String(value ?? "").trim().replace(/\u0000/g, "");
  if (text.length < minimum || text.length > maximum) {
    throw requestError(`${label} must be between ${minimum} and ${maximum} characters.`);
  }
  return text;
}

function scope(context = {}) {
  return { organizationId: String(context.organizationId || "org_goodos") };
}

function validateAgent(payload = {}, partial = false) {
  const result = {};
  if (!partial || payload.name !== undefined) result.name = boundedText(payload.name, 80, "Agent name");
  if (!partial || payload.systemPrompt !== undefined) {
    result.systemPrompt = boundedText(payload.systemPrompt, 8000, "System prompt");
  }
  if (!partial || payload.greeting !== undefined) result.greeting = boundedText(payload.greeting, 500, "Greeting");
  if (!partial || payload.voice !== undefined) {
    result.voice = ALLOWED_VOICES.has(payload.voice) ? payload.voice : "Kore";
  }
  if (!partial || payload.language !== undefined) {
    result.language = ALLOWED_LANGUAGES.has(payload.language) ? payload.language : "en-us";
  }
  if (!partial || payload.tools !== undefined) {
    const tools = Array.isArray(payload.tools) ? [...new Set(payload.tools.map(String))] : ALLOWED_TOOLS;
    if (tools.some((tool) => !ALLOWED_TOOLS.includes(tool))) throw requestError("Agent includes an unsupported tool.");
    result.tools = tools;
  }
  if (!partial || payload.retentionDays !== undefined) {
    const retentionDays = Number(payload.retentionDays ?? 30);
    if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 365) {
      throw requestError("Retention must be between 0 and 365 days.");
    }
    result.retentionDays = retentionDays;
  }
  if (partial && payload.status !== undefined) {
    if (!["active", "paused", "archived"].includes(payload.status)) throw requestError("Agent status is invalid.");
    result.status = payload.status;
  }
  return result;
}

function validateKnowledge(payload = {}) {
  const title = boundedText(payload.title, 180, "Knowledge title");
  const content = boundedText(payload.content, 40000, "Knowledge content");
  return { title, content, checksum: crypto.createHash("sha256").update(content).digest("hex") };
}

function tokens(value) {
  return [...new Set(String(value || "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])]
    .filter((token) => !STOP_WORDS.has(token))
    .slice(0, 100);
}

function rankKnowledge(question, documents = []) {
  const queryTokens = tokens(question);
  return documents.map((document) => {
    const titleTokens = new Set(tokens(document.title));
    const contentTokens = new Set(tokens(document.content));
    const score = queryTokens.reduce((total, token) => total + (titleTokens.has(token) ? 4 : 0) + (contentTokens.has(token) ? 1 : 0), 0);
    return { ...document, score };
  }).filter((document) => document.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
}

function matchingExcerpt(content, question) {
  const queryTokens = new Set(tokens(question));
  const sentences = String(content).split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  const ranked = sentences.map((sentence) => ({
    sentence,
    score: tokens(sentence).reduce((total, token) => total + (queryTokens.has(token) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score);
  return (ranked[0]?.sentence || sentences[0] || String(content)).slice(0, 900);
}

function selectTool(input, enabledTools = ALLOWED_TOOLS) {
  const text = String(input || "").toLowerCase();
  if (enabledTools.includes("handoff") && /\b(speak|talk|connect|transfer)\b.{0,24}\b(human|person|representative|support)\b/.test(text)) return "handoff";
  if (enabledTools.includes("usage_summary") && /\b(usage|quota|monthly limit|characters remaining|generations remaining)\b/.test(text)) return "usage_summary";
  if (enabledTools.includes("current_time") && /\b(current time|what time|today'?s date|current date|what day)\b/.test(text)) return "current_time";
  return enabledTools.includes("knowledge_search") ? "knowledge_search" : null;
}

function groundedReply({ agent, input, matches = [], toolName, toolResult }) {
  if (toolName === "handoff") return "I’ve marked this conversation for a human handoff. Your transcript and context are preserved for the next person.";
  if (toolName === "current_time") return `The current time is ${toolResult.localTime}.`;
  if (toolName === "usage_summary") {
    const { usage, remaining, limits } = toolResult;
    return `You have used ${usage.requests} of ${limits.requests} speech generations and ${usage.characters} characters. ${remaining.requests} generations and ${remaining.characters} characters remain this month.`;
  }
  if (matches.length) {
    const source = matches[0];
    return `${matchingExcerpt(source.content, input)}\n\nSource: ${source.title}`;
  }
  return `I don’t have a grounded answer for that yet. Add the relevant material to ${agent.name}’s knowledge base, or ask me to connect you with a person.`;
}

async function ownedAgent({ agentId, context, userId, activeOnly = false }, client = database) {
  const currentScope = scope(context);
  const result = await client.query(
    `SELECT * FROM goodspeech_agents
     WHERE id = $1::uuid AND organization_id = $2 AND owner_user_id = $3::uuid
       ${activeOnly ? "AND status = 'active'" : ""}
     LIMIT 1`,
    [agentId, currentScope.organizationId, userId],
  );
  if (!result.rows[0]) throw requestError("Agent not found.", 404, "GOODSPEECH_AGENT_NOT_FOUND");
  return result.rows[0];
}

async function bootstrap({ context, userId }) {
  const currentScope = scope(context);
  const [agents, analytics] = await Promise.all([
    database.query(
      `SELECT agent_record.*,
              (SELECT COUNT(*)::int FROM goodspeech_agent_knowledge knowledge WHERE knowledge.agent_id = agent_record.id) AS knowledge_count,
              (SELECT COUNT(*)::int FROM goodspeech_agent_sessions session_record WHERE session_record.agent_id = agent_record.id) AS session_count,
              (SELECT COUNT(*)::int FROM goodspeech_agent_tests test_record WHERE test_record.agent_id = agent_record.id) AS test_count
       FROM goodspeech_agents agent_record
       WHERE agent_record.organization_id = $1 AND agent_record.owner_user_id = $2::uuid AND agent_record.status <> 'archived'
       ORDER BY agent_record.updated_at DESC`,
      [currentScope.organizationId, userId],
    ),
    analyticsSummary({ context, userId }),
  ]);
  return { agents: agents.rows, analytics, capabilities: { realtimeVoice: true, interruption: true, rag: true, tools: ALLOWED_TOOLS, automatedTests: true } };
}

async function createAgent({ payload, context, userId }) {
  const value = validateAgent(payload);
  const currentScope = scope(context);
  const result = await database.query(
    `INSERT INTO goodspeech_agents (
       organization_id, owner_user_id, name, system_prompt, greeting, voice_name, language, enabled_tools, retention_days
     ) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8::text[],$9)
     RETURNING *`,
    [currentScope.organizationId, userId, value.name, value.systemPrompt, value.greeting, value.voice, value.language, value.tools, value.retentionDays],
  );
  return result.rows[0];
}

async function updateAgent({ agentId, payload, context, userId }) {
  await ownedAgent({ agentId, context, userId });
  const value = validateAgent(payload, true);
  const currentScope = scope(context);
  const result = await database.query(
    `UPDATE goodspeech_agents SET
       name = COALESCE($4, name), system_prompt = COALESCE($5, system_prompt), greeting = COALESCE($6, greeting),
       voice_name = COALESCE($7, voice_name), language = COALESCE($8, language), enabled_tools = COALESCE($9::text[], enabled_tools),
       retention_days = COALESCE($10, retention_days), status = COALESCE($11, status), updated_at = NOW()
     WHERE id = $1::uuid AND organization_id = $2 AND owner_user_id = $3::uuid RETURNING *`,
    [agentId, currentScope.organizationId, userId, value.name || null, value.systemPrompt || null, value.greeting || null,
      value.voice || null, value.language || null, value.tools || null, value.retentionDays ?? null, value.status || null],
  );
  return result.rows[0];
}

async function addKnowledge({ agentId, payload, context, userId }) {
  await ownedAgent({ agentId, context, userId });
  const value = validateKnowledge(payload);
  const currentScope = scope(context);
  const result = await database.query(
    `INSERT INTO goodspeech_agent_knowledge (agent_id, organization_id, owner_user_id, title, content, content_sha256)
     VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6)
     ON CONFLICT (agent_id, content_sha256) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, updated_at = NOW()
     RETURNING id, agent_id, title, content_sha256, created_at, updated_at`,
    [agentId, currentScope.organizationId, userId, value.title, value.content, value.checksum],
  );
  return result.rows[0];
}

async function listKnowledge({ agentId, context, userId }) {
  await ownedAgent({ agentId, context, userId });
  const result = await database.query(
    `SELECT id, agent_id, title, content_sha256, char_length(content)::int AS character_count, created_at, updated_at
     FROM goodspeech_agent_knowledge WHERE agent_id = $1::uuid AND owner_user_id = $2::uuid ORDER BY updated_at DESC`,
    [agentId, userId],
  );
  return result.rows;
}

async function deleteKnowledge({ agentId, knowledgeId, context, userId }) {
  await ownedAgent({ agentId, context, userId });
  const result = await database.query(
    `DELETE FROM goodspeech_agent_knowledge WHERE id = $1::uuid AND agent_id = $2::uuid AND owner_user_id = $3::uuid RETURNING id`,
    [knowledgeId, agentId, userId],
  );
  if (!result.rows[0]) throw requestError("Knowledge document not found.", 404, "GOODSPEECH_AGENT_KNOWLEDGE_NOT_FOUND");
  return { id: result.rows[0].id, deleted: true };
}

async function startSession({ agentId, payload = {}, context, userId }) {
  const agent = await ownedAgent({ agentId, context, userId, activeOnly: true });
  const currentScope = scope(context);
  const channel = ["web", "api", "test"].includes(payload.channel) ? payload.channel : "web";
  const metadata = JSON.stringify(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {});
  if (Buffer.byteLength(metadata) > 8192) throw requestError("Session metadata is too large.", 413);
  const result = await database.query(
    `INSERT INTO goodspeech_agent_sessions (agent_id, organization_id, owner_user_id, channel, metadata_json)
     VALUES ($1::uuid,$2,$3::uuid,$4,$5::jsonb) RETURNING *`,
    [agent.id, currentScope.organizationId, userId, channel, metadata],
  );
  return { ...result.rows[0], greeting: agent.greeting, agent: { id: agent.id, name: agent.name, voice: agent.voice_name, language: agent.language } };
}

async function ownedSession({ sessionId, context, userId }, client = database) {
  const currentScope = scope(context);
  const result = await client.query(
    `SELECT session_record.*, agent_record.name AS agent_name, agent_record.system_prompt, agent_record.greeting,
            agent_record.voice_name, agent_record.language, agent_record.enabled_tools
     FROM goodspeech_agent_sessions session_record
     JOIN goodspeech_agents agent_record ON agent_record.id = session_record.agent_id
     WHERE session_record.id = $1::uuid AND session_record.organization_id = $2 AND session_record.owner_user_id = $3::uuid LIMIT 1`,
    [sessionId, currentScope.organizationId, userId],
  );
  if (!result.rows[0]) throw requestError("Agent session not found.", 404, "GOODSPEECH_AGENT_SESSION_NOT_FOUND");
  return result.rows[0];
}

async function executeTool({ toolName, session, input, context, userId }) {
  const started = Date.now();
  let result = {};
  if (toolName === "current_time") {
    result = { iso: new Date().toISOString(), localTime: new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "long", timeZone: "UTC" }).format(new Date()), timezone: "UTC" };
  } else if (toolName === "usage_summary") {
    result = await usageService.getUsage({ context, userId });
  } else if (toolName === "handoff") {
    result = { requested: true, reason: input.slice(0, 500) };
  } else if (toolName === "knowledge_search") {
    const documents = await database.query(
      `SELECT id, title, content FROM goodspeech_agent_knowledge WHERE agent_id = $1::uuid AND owner_user_id = $2::uuid ORDER BY updated_at DESC LIMIT 100`,
      [session.agent_id, userId],
    );
    result = { matches: rankKnowledge(input, documents.rows) };
  }
  return { result, latencyMs: Date.now() - started };
}

async function turn({ sessionId, payload, context, userId }) {
  const input = boundedText(payload?.text, 2000, "Message");
  const started = Date.now();
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const session = await ownedSession({ sessionId, context, userId }, client);
    if (session.status !== "active") throw requestError("This conversation has ended.", 409, "GOODSPEECH_AGENT_SESSION_CLOSED");
    const sequence = Number(session.turn_count) * 2 + 1;
    await client.query(
      `INSERT INTO goodspeech_agent_messages (session_id, sequence_number, role, content) VALUES ($1::uuid,$2,'user',$3)`,
      [session.id, sequence, input],
    );
    const toolName = selectTool(input, session.enabled_tools || []);
    const tool = toolName ? await executeTool({ toolName, session, input, context, userId }) : { result: {}, latencyMs: 0 };
    const matches = toolName === "knowledge_search" ? tool.result.matches : [];
    const agent = { name: session.agent_name, systemPrompt: session.system_prompt };
    const reply = groundedReply({ agent, input, matches, toolName, toolResult: tool.result });
    const latencyMs = Date.now() - started;
    const assistant = await client.query(
      `INSERT INTO goodspeech_agent_messages (session_id, sequence_number, role, content, engine, latency_ms)
       VALUES ($1::uuid,$2,'assistant',$3,'goodspeech-grounded-v1',$4) RETURNING *`,
      [session.id, sequence + 1, reply, latencyMs],
    );
    if (toolName) {
      await client.query(
        `INSERT INTO goodspeech_agent_tool_calls (session_id, message_id, tool_name, status, arguments_json, result_json, latency_ms)
         VALUES ($1::uuid,$2::uuid,$3,'succeeded',$4::jsonb,$5::jsonb,$6)`,
        [session.id, assistant.rows[0].id, toolName, JSON.stringify({ text: input.slice(0, 500) }), JSON.stringify(tool.result), tool.latencyMs],
      );
    }
    const nextStatus = toolName === "handoff" ? "handed_off" : "active";
    const updated = await client.query(
      `UPDATE goodspeech_agent_sessions SET turn_count = turn_count + 1, total_latency_ms = total_latency_ms + $2,
         status = $3, outcome = CASE WHEN $3 = 'handed_off' THEN 'handed_off' ELSE outcome END,
         ended_at = CASE WHEN $3 = 'handed_off' THEN NOW() ELSE ended_at END, updated_at = NOW()
       WHERE id = $1::uuid RETURNING *`,
      [session.id, latencyMs, nextStatus],
    );
    await client.query("COMMIT");
    return {
      session: updated.rows[0],
      message: assistant.rows[0],
      toolCall: toolName ? { name: toolName, latencyMs: tool.latencyMs } : null,
      citations: matches.map((match) => ({ id: match.id, title: match.title })),
      voice: session.voice_name,
      language: session.language,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function interrupt({ sessionId, context, userId }) {
  const session = await ownedSession({ sessionId, context, userId });
  if (session.status !== "active") throw requestError("This conversation has ended.", 409);
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE goodspeech_agent_messages SET interrupted = TRUE WHERE id = (
         SELECT id FROM goodspeech_agent_messages WHERE session_id = $1::uuid AND role = 'assistant' ORDER BY sequence_number DESC LIMIT 1
       )`,
      [session.id],
    );
    const result = await client.query(
      `UPDATE goodspeech_agent_sessions SET interruption_count = interruption_count + 1, updated_at = NOW() WHERE id = $1::uuid RETURNING *`,
      [session.id],
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function completeSession({ sessionId, payload = {}, context, userId }) {
  const session = await ownedSession({ sessionId, context, userId });
  if (!session) throw requestError("Agent session not found.", 404);
  const outcome = ["resolved", "unresolved", "handed_off"].includes(payload.outcome) ? payload.outcome : "unresolved";
  const result = await database.query(
    `UPDATE goodspeech_agent_sessions SET status = CASE WHEN $2 = 'handed_off' THEN 'handed_off' ELSE 'completed' END,
       outcome = $2, ended_at = COALESCE(ended_at, NOW()), updated_at = NOW() WHERE id = $1::uuid RETURNING *`,
    [session.id, outcome],
  );
  return result.rows[0];
}

async function getSession({ sessionId, context, userId }) {
  const session = await ownedSession({ sessionId, context, userId });
  const [messages, tools] = await Promise.all([
    database.query(`SELECT * FROM goodspeech_agent_messages WHERE session_id = $1::uuid ORDER BY sequence_number ASC`, [session.id]),
    database.query(`SELECT * FROM goodspeech_agent_tool_calls WHERE session_id = $1::uuid ORDER BY created_at ASC`, [session.id]),
  ]);
  return { session, messages: messages.rows, toolCalls: tools.rows };
}

async function analyticsSummary({ context, userId, agentId = null }) {
  const currentScope = scope(context);
  const result = await database.query(
    `SELECT COUNT(*)::int AS conversations,
            COALESCE(SUM(turn_count),0)::int AS turns,
            COALESCE(SUM(interruption_count),0)::int AS interruptions,
            COUNT(*) FILTER (WHERE outcome = 'resolved')::int AS resolved,
            COUNT(*) FILTER (WHERE outcome = 'handed_off')::int AS handed_off,
            ROUND(COALESCE(AVG(CASE WHEN turn_count > 0 THEN total_latency_ms::numeric / turn_count END),0))::int AS average_turn_latency_ms,
            COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '24 hours')::int AS conversations_24h
     FROM goodspeech_agent_sessions
     WHERE organization_id = $1 AND owner_user_id = $2::uuid AND ($3::uuid IS NULL OR agent_id = $3::uuid)`,
    [currentScope.organizationId, userId, agentId],
  );
  return result.rows[0];
}

async function createTest({ agentId, payload, context, userId }) {
  await ownedAgent({ agentId, context, userId });
  const currentScope = scope(context);
  const name = boundedText(payload?.name, 120, "Test name");
  const input = boundedText(payload?.input, 2000, "Test input");
  const expected = boundedText(payload?.expectedPhrase, 500, "Expected phrase");
  const result = await database.query(
    `INSERT INTO goodspeech_agent_tests (agent_id, organization_id, owner_user_id, name, input_text, expected_phrase)
     VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6) RETURNING *`,
    [agentId, currentScope.organizationId, userId, name, input, expected],
  );
  return result.rows[0];
}

async function listTests({ agentId, context, userId }) {
  await ownedAgent({ agentId, context, userId });
  const result = await database.query(
    `SELECT * FROM goodspeech_agent_tests WHERE agent_id = $1::uuid AND owner_user_id = $2::uuid ORDER BY updated_at DESC`,
    [agentId, userId],
  );
  return result.rows;
}

async function runTest({ agentId, testId, context, userId }) {
  const agent = await ownedAgent({ agentId, context, userId, activeOnly: true });
  const testResult = await database.query(
    `SELECT * FROM goodspeech_agent_tests WHERE id = $1::uuid AND agent_id = $2::uuid AND owner_user_id = $3::uuid LIMIT 1`,
    [testId, agentId, userId],
  );
  const test = testResult.rows[0];
  if (!test) throw requestError("Agent test not found.", 404, "GOODSPEECH_AGENT_TEST_NOT_FOUND");
  const documents = await database.query(
    `SELECT id, title, content FROM goodspeech_agent_knowledge WHERE agent_id = $1::uuid AND owner_user_id = $2::uuid`,
    [agentId, userId],
  );
  const matches = rankKnowledge(test.input_text, documents.rows);
  const response = groundedReply({ agent, input: test.input_text, matches, toolName: "knowledge_search", toolResult: { matches } });
  const passed = response.toLowerCase().includes(test.expected_phrase.toLowerCase());
  const updated = await database.query(
    `UPDATE goodspeech_agent_tests SET status = $4, last_response = $5, last_run_at = NOW(), updated_at = NOW()
     WHERE id = $1::uuid AND agent_id = $2::uuid AND owner_user_id = $3::uuid RETURNING *`,
    [testId, agentId, userId, passed ? "passed" : "failed", response],
  );
  return updated.rows[0];
}

module.exports = {
  ALLOWED_TOOLS,
  validateAgent,
  validateKnowledge,
  rankKnowledge,
  selectTool,
  groundedReply,
  bootstrap,
  createAgent,
  updateAgent,
  addKnowledge,
  listKnowledge,
  deleteKnowledge,
  startSession,
  turn,
  interrupt,
  completeSession,
  getSession,
  analyticsSummary,
  createTest,
  listTests,
  runTest,
};
