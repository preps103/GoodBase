"use strict";

const database = require("../config/database");
const transcription = require("./goodspeech-transcription.service");

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 60_000;
const TTS_MODEL = "hexgrad/Kokoro-82M";
const QUALITY_BENCHMARKS = Object.freeze({
  "en-us": { voice: "af_heart", text: "GoodSpeech turns careful direction into clear, natural, and dependable audio." },
  "en-gb": { voice: "bf_emma", text: "GoodSpeech turns careful direction into clear, natural, and dependable audio." },
  es: { voice: "ef_dora", text: "GoodSpeech convierte una dirección cuidadosa en un audio claro, natural y confiable." },
  "fr-fr": { voice: "ff_siwis", text: "GoodSpeech transforme une direction précise en un son clair, naturel et fiable." },
  hi: { voice: "hf_alpha", text: "गुडस्पीच सावधानी से दिए गए निर्देशों को स्पष्ट, स्वाभाविक और भरोसेमंद आवाज़ में बदलता है।" },
  it: { voice: "if_sara", text: "GoodSpeech trasforma indicazioni precise in un audio chiaro, naturale e affidabile." },
  "ja-jp": { voice: "jf_alpha", text: "グッドスピーチは丁寧な指示を明瞭で自然な音声に変えます。" },
  "pt-br": { voice: "pf_dora", text: "O GoodSpeech transforma orientações cuidadosas em áudio claro, natural e confiável." },
  "zh-cn": { voice: "zf_xiaobei", text: "GoodSpeech 将细致的指导转化为清晰、自然且可靠的语音。" },
});

function qualityError(message, statusCode = 400, code = "GOODSPEECH_QUALITY_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().trim();
}

function units(value, language) {
  const text = normalize(value);
  if (language === "ja-jp" || language === "zh-cn") {
    return Array.from(text).filter((character) => /[\p{L}\p{N}]/u.test(character));
  }
  return text.match(/[\p{L}\p{N}']+/gu) || [];
}

function editDistance(reference, hypothesis) {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= hypothesis.length; column += 1) {
      current[column] = reference[row - 1] === hypothesis[column - 1]
        ? previous[column - 1]
        : Math.min(previous[column - 1], previous[column], current[column - 1]) + 1;
    }
    previous = current;
  }
  return previous[hypothesis.length];
}

function benchmarkMetric(referenceText, transcriptText, language) {
  const reference = units(referenceText, language);
  const hypothesis = units(transcriptText, language);
  const errorCount = editDistance(reference, hypothesis);
  const errorRate = reference.length ? errorCount / reference.length : 1;
  const errorRatePercent = Number((errorRate * 100).toFixed(2));
  return {
    metric: language === "ja-jp" || language === "zh-cn" ? "character_error_rate" : "word_error_rate",
    errorCount,
    referenceUnits: reference.length,
    hypothesisUnits: hypothesis.length,
    errorRatePercent,
    qualityScore: Math.max(0, Math.min(100, Math.round((1 - errorRate) * 100))),
    status: errorRatePercent <= 20 ? "passed" : "needs_attention",
  };
}

function provider() {
  const base = String(process.env.KOKORO_TTS_URL || "").trim();
  const token = String(process.env.KOKORO_TTS_TOKEN || "").trim();
  if (!/^https?:\/\//.test(base) || token.length < 32) return null;
  return { endpoint: `${base.replace(/\/+$/, "")}/v1/audio/speech`, token };
}

async function readAudio(response) {
  if (!response.body) throw qualityError("The speech engine returned no audio.", 502, "GOODSPEECH_QUALITY_TTS_INVALID");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_AUDIO_BYTES) {
        await reader.cancel();
        throw qualityError("The speech quality sample was unexpectedly large.", 502, "GOODSPEECH_QUALITY_AUDIO_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const audio = Buffer.concat(chunks, total);
  if (audio.length < 44 || audio.subarray(0, 4).toString("ascii") !== "RIFF" || audio.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw qualityError("The speech engine returned invalid audio.", 502, "GOODSPEECH_QUALITY_TTS_INVALID");
  }
  return audio;
}

async function synthesize(sample, language, fetchFn) {
  const configured = provider();
  if (!configured) throw qualityError("GoodBase managed speech is not configured.", 503, "GOODSPEECH_QUALITY_TTS_NOT_CONFIGURED");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetchFn(configured.endpoint, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${configured.token}`,
        Accept: "audio/wav",
        "Content-Type": "application/json",
        "X-GoodBase-Service": "GoodSpeech Quality",
      },
      body: JSON.stringify({ model: TTS_MODEL, input: sample.text, voice: sample.voice, language, speed: 1, response_format: "wav" }),
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw qualityError("The managed speech engine rejected the quality sample.", 502, "GOODSPEECH_QUALITY_TTS_REJECTED");
    }
    return { audio: await readAudio(response), latencyMs: Date.now() - started };
  } catch (error) {
    if (error?.name === "AbortError") throw qualityError("Managed speech timed out.", 504, "GOODSPEECH_QUALITY_TTS_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function storeResult({ current, userId, language, sample, transcriptResult, metrics, ttsLatencyMs, audioBytes, totalLatencyMs }) {
  const result = await database.query(
    `INSERT INTO goodspeech_quality_benchmarks (
       organization_id, project_id, environment_id, owner_user_id, language, status,
       reference_text, transcript_text, metric, error_count, reference_units, hypothesis_units,
       error_rate_percent, quality_score, tts_latency_ms, transcription_latency_ms,
       total_latency_ms, audio_bytes, tts_model, transcription_model, transcription_model_revision
     ) VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING id, created_at`,
    [current.organizationId, current.projectId, current.environmentId, userId, language, metrics.status,
      sample.text, transcriptResult.text, metrics.metric, metrics.errorCount, metrics.referenceUnits,
      metrics.hypothesisUnits, metrics.errorRatePercent, metrics.qualityScore, ttsLatencyMs,
      transcriptResult.latencyMs, totalLatencyMs, audioBytes, TTS_MODEL, transcriptResult.model,
      transcriptResult.modelRevision],
  );
  return result.rows[0];
}

async function run({ language = "en-us", context, userId, request, fetchFn = global.fetch }) {
  const normalizedLanguage = String(language || "en-us").trim().toLowerCase();
  const sample = QUALITY_BENCHMARKS[normalizedLanguage];
  if (!sample) throw qualityError("Choose one of GoodSpeech's supported quality-check languages.");
  if (typeof fetchFn !== "function") throw qualityError("The private quality engines are unavailable.", 503, "GOODSPEECH_QUALITY_UNAVAILABLE");
  const current = {
    organizationId: String(context?.organizationId || "org_goodos"),
    projectId: context?.projectId ? String(context.projectId) : null,
    environmentId: context?.environmentId ? String(context.environmentId) : null,
  };
  const started = Date.now();
  const synthesis = await synthesize(sample, normalizedLanguage, fetchFn);
  const transcriptResult = await transcription.transcribe({
    file: { buffer: synthesis.audio, size: synthesis.audio.length, mimetype: "audio/wav", originalname: `goodspeech-quality-${normalizedLanguage}.wav` },
    language: normalizedLanguage,
    context: current,
    userId,
    request,
    fetchFn,
  });
  const metrics = benchmarkMetric(sample.text, transcriptResult.text, normalizedLanguage);
  const totalLatencyMs = Date.now() - started;
  const stored = await storeResult({ current, userId, language: normalizedLanguage, sample, transcriptResult, metrics, ttsLatencyMs: synthesis.latencyMs, audioBytes: synthesis.audio.length, totalLatencyMs });
  return {
    id: stored.id,
    createdAt: stored.created_at,
    language: normalizedLanguage,
    status: metrics.status,
    ...metrics,
    ttsLatencyMs: synthesis.latencyMs,
    transcriptionLatencyMs: transcriptResult.latencyMs,
    totalLatencyMs,
    audioBytes: synthesis.audio.length,
    ttsModel: TTS_MODEL,
    transcriptionModel: transcriptResult.model,
    transcriptionModelRevision: transcriptResult.modelRevision,
    referenceText: sample.text,
    transcriptText: transcriptResult.text,
    audioRetained: false,
  };
}

module.exports = {
  QUALITY_BENCHMARKS,
  benchmarkMetric,
  run,
  _internal: { editDistance, normalize, provider, readAudio, units },
};
