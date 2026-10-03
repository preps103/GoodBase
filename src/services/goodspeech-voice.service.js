"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { query } = require("../config/database");
const storage = require("./storage-v2.service");
const library = require("./goodspeech-library.service");

const CLONE_MODEL = "ResembleAI/chatterbox-nano";
const CLONE_MODEL_REVISION = "71ccd1d0081b430592cea481f4307e764e07bc64";
const KOKORO_MODEL = "hexgrad/Kokoro-82M";
const KOKORO_MODEL_REVISION = "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4";
const CONSENT_VERSION = "goodspeech-self-voice-v1";
const DESIGN_CONSENT_VERSION = "goodspeech-designed-voice-v1";
const CONSENT_STATEMENT = "I consent to create a GoodSpeech voice model of my own voice.";
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
const MAX_GENERATED_BYTES = 24 * 1024 * 1024;
const ALLOWED_LANGUAGES = new Set(["en-us", "en-gb", "es", "fr-fr", "hi", "it", "ja-jp", "pt-br", "zh-cn"]);
const KOKORO_VOICES = Object.freeze({
  Kore: "af_kore", Puck: "am_puck", Charon: "am_onyx", Fenrir: "am_fenrir",
  Zephyr: "af_sky", Amara: "af_heart", Celeste: "af_bella", Bennett: "bm_george", Ellis: "am_michael",
});
const FEMALE_VOICES = new Set(["Kore", "Zephyr", "Amara", "Celeste"]);
const LANGUAGE_VOICES = Object.freeze({
  "en-us": { female: "af_heart", male: "am_michael" },
  "en-gb": { female: "bf_emma", male: "bm_george" },
  es: { female: "ef_dora", male: "em_alex" },
  "fr-fr": { female: "ff_siwis", male: "ff_siwis" },
  hi: { female: "hf_alpha", male: "hm_omega" },
  it: { female: "if_sara", male: "im_nicola" },
  "ja-jp": { female: "jf_alpha", male: "jm_kumo" },
  "pt-br": { female: "pf_dora", male: "pm_alex" },
  "zh-cn": { female: "zf_xiaobei", male: "zm_yunjian" },
});
const ENGLISH_DESIGN_VOICES = Object.freeze([
  { name: "Amara", voice: "af_heart", trait: "warm and empathetic" },
  { name: "Celeste", voice: "af_bella", trait: "expressive and polished" },
  { name: "Zephyr", voice: "af_sky", trait: "bright and airy" },
  { name: "Kore", voice: "af_kore", trait: "clear and composed" },
  { name: "Puck", voice: "am_puck", trait: "energetic and playful" },
  { name: "Fenrir", voice: "am_fenrir", trait: "bold and cinematic" },
  { name: "Charon", voice: "am_onyx", trait: "deep and authoritative" },
  { name: "Ellis", voice: "am_michael", trait: "grounded and conversational" },
  { name: "Bennett", voice: "bm_george", trait: "refined British narration" },
]);

function voiceError(message, statusCode = 400, code = "GOODSPEECH_VOICE_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

function text(value, maximum, fallback = "") {
  return String(value || "").trim().slice(0, maximum) || fallback;
}

function uuid(value, label = "voice ID") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw voiceError(`A valid ${label} is required.`, 400, "GOODSPEECH_VOICE_ID_INVALID");
  }
  return normalized;
}

function parseBoolean(value) {
  return value === true || value === "true" || value === "1" || value === "on";
}

function wavDuration(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw voiceError("Upload a valid PCM WAV reference.", 415, "GOODSPEECH_VOICE_SAMPLE_INVALID");
  }
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "fmt " && chunkSize >= 16 && offset + 8 + chunkSize <= buffer.length) {
      const format = buffer.readUInt16LE(offset + 8);
      const channels = buffer.readUInt16LE(offset + 10);
      const sampleRate = buffer.readUInt32LE(offset + 12);
      byteRate = buffer.readUInt32LE(offset + 16);
      const bits = buffer.readUInt16LE(offset + 22);
      if (![1, 3].includes(format) || ![1, 2].includes(channels) || sampleRate < 8_000 || sampleRate > 96_000 || ![16, 24, 32].includes(bits)) {
        throw voiceError("Reference WAV must be mono or stereo PCM audio.", 422, "GOODSPEECH_VOICE_SAMPLE_FORMAT");
      }
    }
    if (chunkId === "data") dataBytes += Math.min(chunkSize, Math.max(0, buffer.length - offset - 8));
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  const seconds = byteRate > 0 ? dataBytes / byteRate : 0;
  if (seconds < 5.5 || seconds > 30) {
    throw voiceError("Reference audio must be between 5.5 and 30 seconds.", 422, "GOODSPEECH_VOICE_SAMPLE_DURATION");
  }
  return Number(seconds.toFixed(3));
}

function record(row) {
  const recipe = decodeDesignRecipe(row.base_voice);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    language: row.language,
    designPrompt: row.design_prompt || null,
    baseVoice: recipe?.label || row.base_voice || null,
    designCandidateId: recipe?.candidateId || null,
    designBlend: recipe?.voices || [],
    designSpeed: recipe?.speed || null,
    model: row.model_id,
    modelRevision: row.model_revision,
    watermark: row.watermark,
    sampleDurationSeconds: row.sample_duration_seconds === null ? null : Number(row.sample_duration_seconds),
    consentVersion: row.consent_version,
    consentGrantedAt: row.consent_granted_at,
    consentRevokedAt: row.consent_revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listVoices({ context, userId }) {
  const result = await query(
    `SELECT * FROM goodspeech_voice_profiles
     WHERE organization_id = $1 AND owner_user_id = $2::uuid AND status <> 'revoked'
     ORDER BY updated_at DESC LIMIT 100`,
    [context.organizationId, userId],
  );
  return result.rows.map(record);
}

function assertCloneConsent(payload = {}) {
  if (text(payload.consentPhrase, 200) !== CONSENT_STATEMENT) {
    throw voiceError("Type the voice-consent statement exactly before creating a clone.", 422, "GOODSPEECH_VOICE_CONSENT_REQUIRED");
  }
  if (!parseBoolean(payload.identityAttested) || !parseBoolean(payload.rightsAttested) || !parseBoolean(payload.adultAttested)) {
    throw voiceError("Self-identity, voice rights, and adult consent must all be confirmed.", 422, "GOODSPEECH_VOICE_ATTESTATION_REQUIRED");
  }
}

async function createClonedVoice({ file, payload, context, userId }) {
  assertCloneConsent(payload);
  if (!file?.buffer || file.buffer.length > MAX_REFERENCE_BYTES) {
    throw voiceError("Choose a WAV reference under 12 MB.", 413, "GOODSPEECH_VOICE_SAMPLE_TOO_LARGE");
  }
  if (!["audio/wav", "audio/x-wav"].includes(String(file.mimetype || "").toLowerCase())) {
    throw voiceError("Voice cloning accepts PCM WAV references only.", 415, "GOODSPEECH_VOICE_SAMPLE_TYPE");
  }
  const duration = wavDuration(file.buffer);
  const name = text(payload.name, 80);
  if (!name) throw voiceError("Give the voice a name.", 400, "GOODSPEECH_VOICE_NAME_REQUIRED");
  const asset = await library.uploadAsset({
    file,
    source: "Voice Lab reference",
    metadata: { kind: "voice-reference", consentVersion: CONSENT_VERSION },
    context,
    userId,
  });
  try {
    const result = await query(
      `INSERT INTO goodspeech_voice_profiles (
         organization_id, project_id, environment_id, owner_user_id, storage_asset_id,
         name, kind, language, model_id, model_revision, watermark, sample_sha256,
         sample_duration_seconds, consent_version, consent_statement,
         identity_attested, rights_attested, adult_attested
       ) VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6,'cloned','en-us',$7,$8,'perth-implicit-v1',$9,$10,$11,$12,TRUE,TRUE,TRUE)
       RETURNING *`,
      [context.organizationId, context.projectId, context.environmentId, userId, asset.id,
        name, CLONE_MODEL, CLONE_MODEL_REVISION, crypto.createHash("sha256").update(file.buffer).digest("hex"),
        duration, CONSENT_VERSION, CONSENT_STATEMENT],
    );
    await addEvent(result.rows[0], "enrolled", { sampleDurationSeconds: duration, consentVersion: CONSENT_VERSION });
    return record(result.rows[0]);
  } catch (error) {
    await library.deleteAsset({ assetId: asset.id, context, userId }).catch(() => {});
    throw error;
  }
}

function selectDesignedVoice(prompt) {
  const normalized = prompt.toLowerCase();
  if (/deep|authoritative|gravel|cinematic|baritone/.test(normalized)) return "Charon";
  if (/british|uk|english accent/.test(normalized)) return "Bennett";
  if (/energetic|playful|animated|youthful/.test(normalized)) return "Puck";
  if (/warm|empathetic|gentle|reassuring/.test(normalized)) return "Amara";
  if (/bright|clear|optimistic/.test(normalized)) return "Zephyr";
  const choices = ["Kore", "Fenrir", "Celeste", "Ellis"];
  return choices[crypto.createHash("sha256").update(normalized).digest()[0] % choices.length];
}

function designSpeed(prompt) {
  const normalized = prompt.toLowerCase();
  if (/slow|measured|deliberate|calm|meditative/.test(normalized)) return 0.94;
  if (/fast|quick|energetic|urgent|animated/.test(normalized)) return 1.06;
  return 1;
}

function designCandidates(promptValue, languageValue = "en-us") {
  const prompt = text(promptValue, 1000);
  if (prompt.length < 8) throw voiceError("Describe the voice in at least eight characters.", 422, "GOODSPEECH_VOICE_PROMPT_REQUIRED");
  const language = ALLOWED_LANGUAGES.has(languageValue) ? languageValue : "en-us";
  const seed = crypto.createHash("sha256").update(`${language}:${prompt.toLowerCase()}`).digest();
  const requestedSpeed = designSpeed(prompt);
  let recipes;

  if (language === "en-us") {
    const anchorName = selectDesignedVoice(prompt);
    const anchorIndex = Math.max(0, ENGLISH_DESIGN_VOICES.findIndex((item) => item.name === anchorName));
    const remaining = ENGLISH_DESIGN_VOICES.filter((_, index) => index !== anchorIndex);
    const support = remaining[seed[1] % remaining.length];
    const contrast = remaining[(seed[2] + 3) % remaining.length] === support
      ? remaining[(seed[2] + 4) % remaining.length]
      : remaining[(seed[2] + 3) % remaining.length];
    const anchor = ENGLISH_DESIGN_VOICES[anchorIndex];
    recipes = [
      { voices: [anchor, support], speed: requestedSpeed - 0.02, label: "Signature blend", description: `${anchor.trait}, balanced with ${support.trait}` },
      { voices: [anchor, contrast], speed: requestedSpeed, label: "Focused blend", description: `${anchor.trait}, shaped by ${contrast.trait}` },
      { voices: [support, contrast], speed: requestedSpeed + 0.02, label: "Contrast blend", description: `${support.trait}, paired with ${contrast.trait}` },
    ];
  } else {
    const voices = [...new Set(Object.values(LANGUAGE_VOICES[language]))];
    recipes = voices.length > 1
      ? [
        { voices: [{ voice: voices[0] }], speed: requestedSpeed - 0.03, label: "Measured", description: "A composed interpretation with deliberate pacing" },
        { voices: voices.map((voice) => ({ voice })), speed: requestedSpeed, label: "Balanced blend", description: "A new blended timbre built from both language voices" },
        { voices: [{ voice: voices[1] }], speed: requestedSpeed + 0.03, label: "Brisk", description: "A direct interpretation with brighter pacing" },
      ]
      : [
        { voices: [{ voice: voices[0] }], speed: requestedSpeed - 0.06, label: "Measured", description: "A calm, deliberate interpretation" },
        { voices: [{ voice: voices[0] }], speed: requestedSpeed, label: "Natural", description: "A balanced, natural interpretation" },
        { voices: [{ voice: voices[0] }], speed: requestedSpeed + 0.06, label: "Brisk", description: "A brighter, more energetic interpretation" },
      ];
  }

  return recipes.map((recipe, index) => ({
    id: `candidate-${index + 1}`,
    label: recipe.label,
    description: recipe.description,
    blendCount: recipe.voices.length,
    speed: Number(Math.min(1.2, Math.max(0.8, recipe.speed)).toFixed(2)),
    voices: recipe.voices.map((item) => item.voice),
  }));
}

function encodeDesignRecipe(candidate) {
  return JSON.stringify({
    v: 1,
    id: candidate.id,
    label: candidate.label,
    voices: candidate.voices,
    speed: candidate.speed,
  });
}

function decodeDesignRecipe(value) {
  if (!value || !String(value).trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed?.v !== 1 || !Array.isArray(parsed.voices) || !parsed.voices.length || parsed.voices.length > 3) return null;
    return {
      candidateId: text(parsed.id, 40),
      label: text(parsed.label, 80, "Designed blend"),
      voices: parsed.voices.map((voice) => text(voice, 40)).filter(Boolean),
      speed: Math.min(1.2, Math.max(0.8, Number(parsed.speed) || 1)),
    };
  } catch {
    return null;
  }
}

function resolveDesign(payload = {}) {
  const prompt = text(payload.prompt, 1000);
  const language = ALLOWED_LANGUAGES.has(payload.language) ? payload.language : "en-us";
  const candidates = designCandidates(prompt, language);
  const candidate = candidates.find((item) => item.id === payload.candidateId) || (!payload.candidateId ? candidates[0] : null);
  if (!candidate) throw voiceError("Choose a valid designed voice candidate.", 422, "GOODSPEECH_VOICE_CANDIDATE_INVALID");
  return { prompt, language, candidate };
}

async function createDesignedVoice({ payload, context, userId }) {
  const name = text(payload?.name, 80);
  if (!name) throw voiceError("Give the designed voice a name.", 400, "GOODSPEECH_VOICE_NAME_REQUIRED");
  const { prompt, language, candidate } = resolveDesign(payload);
  const baseVoice = encodeDesignRecipe(candidate);
  const result = await query(
    `INSERT INTO goodspeech_voice_profiles (
       organization_id, project_id, environment_id, owner_user_id, name, kind, language,
       design_prompt, base_voice, model_id, model_revision, watermark, consent_version,
       consent_statement, identity_attested, rights_attested, adult_attested
     ) VALUES ($1,$2,$3,$4::uuid,$5,'designed',$6,$7,$8,$9,$10,'goodbase-generation-provenance-v1',
       $11,'AI-designed voice; no human identity sample supplied.',FALSE,TRUE,TRUE)
     RETURNING *`,
    [context.organizationId, context.projectId, context.environmentId, userId, name, language,
      prompt, baseVoice, KOKORO_MODEL, KOKORO_MODEL_REVISION, DESIGN_CONSENT_VERSION],
  );
  await addEvent(result.rows[0], "designed", {
    promptSha256: crypto.createHash("sha256").update(prompt).digest("hex"),
    candidateId: candidate.id,
    blendCount: candidate.blendCount,
    speed: candidate.speed,
  });
  return record(result.rows[0]);
}

async function loadVoice({ voiceId, context, userId, includeRevoked = false }) {
  const result = await query(
    `SELECT * FROM goodspeech_voice_profiles
     WHERE id = $1::uuid AND organization_id = $2 AND owner_user_id = $3::uuid
       AND ($4::boolean OR status = 'ready') LIMIT 1`,
    [uuid(voiceId), context.organizationId, userId, includeRevoked],
  );
  if (!result.rows[0]) throw voiceError("Voice profile not found.", 404, "GOODSPEECH_VOICE_NOT_FOUND");
  return result.rows[0];
}

async function readAssetBytes(assetId, context, userId) {
  const asset = await library.getAsset({ assetId, context, userId });
  const object = await storage.getFileById(asset.storage_file_id);
  const descriptor = await storage.resolveDownload(object, 180);
  if (descriptor.type === "local") return fs.readFile(descriptor.path);
  const response = await fetch(descriptor.url, { redirect: "error", cache: "no-store" });
  if (!response.ok) throw voiceError("Voice reference could not be loaded.", 502, "GOODSPEECH_VOICE_REFERENCE_UNAVAILABLE");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_REFERENCE_BYTES) throw voiceError("Voice reference is oversized.", 502, "GOODSPEECH_VOICE_REFERENCE_OVERSIZED");
  return bytes;
}

function cloneProvider() {
  const base = text(process.env.CHATTERBOX_TTS_URL, 500);
  const token = text(process.env.CHATTERBOX_TTS_TOKEN, 500);
  if (!/^https?:\/\//.test(base) || token.length < 32) return null;
  return { endpoint: `${base.replace(/\/+$/, "")}/v1/audio/speech`, health: `${base.replace(/\/+$/, "")}/health/ready`, token };
}

async function boundedAudio(response) {
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw voiceError("Voice engine rejected the generation request.", 502, "GOODSPEECH_VOICE_ENGINE_REJECTED");
  }
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("audio/")) throw voiceError("Voice engine returned an invalid response.", 502, "GOODSPEECH_VOICE_ENGINE_INVALID");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_GENERATED_BYTES) throw voiceError("Voice engine returned invalid audio.", 502, "GOODSPEECH_VOICE_AUDIO_INVALID");
  return { bytes, contentType: contentType.split(";")[0] };
}

async function generateClone(profile, script, context, userId, signal) {
  const provider = cloneProvider();
  if (!provider) throw voiceError("The private cloning engine is not configured.", 503, "GOODSPEECH_VOICE_ENGINE_UNAVAILABLE");
  const reference = await readAssetBytes(profile.storage_asset_id, context, userId);
  const form = new FormData();
  form.append("text", script);
  form.append("reference", new Blob([reference], { type: "audio/wav" }), "reference.wav");
  return boundedAudio(await fetch(provider.endpoint, {
    method: "POST",
    signal,
    redirect: "error",
    headers: { Authorization: `Bearer ${provider.token}`, "X-GoodBase-Service": "GoodSpeech Voice Lab" },
    body: form,
  }));
}

async function generateDesign(profile, script, signal) {
  const endpoint = text(process.env.KOKORO_TTS_URL, 500);
  const token = text(process.env.KOKORO_TTS_TOKEN, 500);
  if (!/^https?:\/\//.test(endpoint) || token.length < 32) throw voiceError("The speech engine is not configured.", 503, "GOODSPEECH_VOICE_ENGINE_UNAVAILABLE");
  const recipe = decodeDesignRecipe(profile.base_voice);
  const languageVoices = LANGUAGE_VOICES[profile.language] || LANGUAGE_VOICES["en-us"];
  const voice = recipe
    ? recipe.voices.join(",")
    : profile.language === "en-us"
      ? (KOKORO_VOICES[profile.base_voice] || KOKORO_VOICES.Kore)
      : (FEMALE_VOICES.has(profile.base_voice) ? languageVoices.female : languageVoices.male);
  const speed = recipe?.speed || 1;
  return boundedAudio(await fetch(`${endpoint.replace(/\/+$/, "")}/v1/audio/speech`, {
    method: "POST",
    signal,
    redirect: "error",
    headers: { Accept: "audio/wav", Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-GoodBase-Service": "GoodSpeech Voice Lab" },
    body: JSON.stringify({ model: KOKORO_MODEL, input: script, voice, language: profile.language, speed, response_format: "wav" }),
  }));
}

async function previewDesignedVoice({ payload, signal }) {
  const { prompt, language, candidate } = resolveDesign(payload);
  const script = text(payload?.text, 1_000);
  if (!script) throw voiceError("Enter text to preview the voice candidates.", 400, "GOODSPEECH_VOICE_TEXT_REQUIRED");
  const profile = { language, base_voice: encodeDesignRecipe(candidate) };
  const audio = await generateDesign(profile, script, signal);
  return { ...audio, candidate, promptSha256: crypto.createHash("sha256").update(prompt).digest("hex") };
}

async function generateSpeech({ voiceId, script, context, userId, signal }) {
  const normalizedScript = text(script, 1_000);
  if (!normalizedScript) throw voiceError("Enter text for this voice to speak.", 400, "GOODSPEECH_VOICE_TEXT_REQUIRED");
  const profile = await loadVoice({ voiceId, context, userId });
  const started = Date.now();
  const audio = profile.kind === "cloned"
    ? await generateClone(profile, normalizedScript, context, userId, signal)
    : await generateDesign(profile, normalizedScript, signal);
  await addEvent(profile, "generated", { characters: normalizedScript.length, audioBytes: audio.bytes.length, latencyMs: Date.now() - started });
  return { ...audio, profile: record(profile), latencyMs: Date.now() - started };
}

async function revokeVoice({ voiceId, context, userId }) {
  const profile = await loadVoice({ voiceId, context, userId });
  const result = await query(
    `UPDATE goodspeech_voice_profiles SET status = 'revoked', consent_revoked_at = NOW(), updated_at = NOW()
     WHERE id = $1::uuid RETURNING *`, [profile.id],
  );
  await addEvent(result.rows[0], "revoked", { referenceDeleted: Boolean(profile.storage_asset_id) });
  if (profile.storage_asset_id) await library.deleteAsset({ assetId: profile.storage_asset_id, context, userId }).catch(() => {});
  return record(result.rows[0]);
}

async function addEvent(profile, eventType, metadata) {
  await query(
    `INSERT INTO goodspeech_voice_events (voice_profile_id, organization_id, owner_user_id, event_type, metadata_json)
     VALUES ($1::uuid,$2,$3::uuid,$4,$5::jsonb)`,
    [profile.id, profile.organization_id, profile.owner_user_id, eventType, JSON.stringify(metadata || {})],
  );
}

async function checkHealth({ fetchFn = global.fetch, timeoutMs = 4_000 } = {}) {
  const provider = cloneProvider();
  if (!provider) return { ready: false, code: "GOODSPEECH_VOICE_NOT_CONFIGURED", message: "The private cloning engine is not configured." };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(provider.health, { cache: "no-store", redirect: "error", signal: controller.signal });
    if (!response.ok) return { ready: false, code: "GOODSPEECH_VOICE_LOADING", message: "The private cloning engine is loading." };
    const data = await response.json();
    return { ready: true, code: "GOODSPEECH_VOICE_READY", message: "Private voice cloning is ready.", ...data };
  } catch {
    return { ready: false, code: "GOODSPEECH_VOICE_UNAVAILABLE", message: "The private cloning engine is unavailable." };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  CLONE_MODEL,
  CLONE_MODEL_REVISION,
  CONSENT_STATEMENT,
  CONSENT_VERSION,
  MAX_REFERENCE_BYTES,
  checkHealth,
  createClonedVoice,
  createDesignedVoice,
  designCandidates,
  generateSpeech,
  listVoices,
  previewDesignedVoice,
  revokeVoice,
  _internal: { decodeDesignRecipe, designCandidates, encodeDesignRecipe, parseBoolean, record, selectDesignedVoice, uuid, wavDuration },
};
