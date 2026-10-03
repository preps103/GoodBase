"""Private Kokoro inference service for GoodSpeech."""

from __future__ import annotations

import asyncio
import io
import logging
import os
import secrets
import threading
import wave
from contextlib import asynccontextmanager
from typing import Annotated

import numpy as np
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response, StreamingResponse
from kokoro import KPipeline
from pydantic import BaseModel, ConfigDict, Field

LOGGER = logging.getLogger("goodspeech.kokoro")
SAMPLE_RATE = 24_000
MAX_TEXT_LENGTH = 2_000
MODEL_ID = "hexgrad/Kokoro-82M"
MODEL_SHA256 = "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4"
ALLOWED_VOICES = frozenset({
    "af_bella",
    "af_heart",
    "af_kore",
    "af_sky",
    "am_fenrir",
    "am_michael",
    "am_onyx",
    "am_puck",
    "bm_george",
    "bf_emma",
    "ef_dora",
    "em_alex",
    "ff_siwis",
    "hf_alpha",
    "hm_omega",
    "if_sara",
    "im_nicola",
    "pf_dora",
    "pm_alex",
})
LANGUAGES = {
    "en-us": {"code": "a", "voices": frozenset({"af_bella", "af_heart", "af_kore", "af_sky", "am_fenrir", "am_michael", "am_onyx", "am_puck", "bm_george"})},
    "en-gb": {"code": "b", "voices": frozenset({"bf_emma", "bm_george"})},
    "es": {"code": "e", "voices": frozenset({"ef_dora", "em_alex"})},
    "fr-fr": {"code": "f", "voices": frozenset({"ff_siwis"})},
    "hi": {"code": "h", "voices": frozenset({"hf_alpha", "hm_omega"})},
    "it": {"code": "i", "voices": frozenset({"if_sara", "im_nicola"})},
    "pt-br": {"code": "p", "voices": frozenset({"pf_dora", "pm_alex"})},
}

pipeline: KPipeline | None = None
pipelines: dict[str, KPipeline] = {}
generation_slots = threading.BoundedSemaphore(max(1, int(os.getenv("KOKORO_CONCURRENCY", "1"))))


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str = MODEL_ID
    input: str = Field(min_length=1, max_length=MAX_TEXT_LENGTH)
    voice: str
    language: str = "en-us"
    speed: float = Field(default=1, ge=0.8, le=1.2)
    response_format: str = "wav"


def configured_token() -> str:
    token = os.getenv("KOKORO_TTS_TOKEN", "").strip()
    if len(token) < 32:
        raise RuntimeError("KOKORO_TTS_TOKEN must contain at least 32 characters")
    return token


def authorize(authorization: str | None) -> None:
    expected = configured_token()
    supplied = ""
    if authorization and authorization.startswith("Bearer "):
        supplied = authorization[7:].strip()
    if not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def load_pipeline() -> KPipeline:
    LOGGER.info("Loading %s", MODEL_ID)
    return KPipeline(lang_code="a", repo_id=MODEL_ID)


def pipeline_for(language: str) -> KPipeline:
    if pipeline is None:
        raise RuntimeError("Kokoro is not ready")
    config = LANGUAGES.get(language)
    if config is None:
        raise ValueError("Unsupported language")
    code = config["code"]
    if code not in pipelines:
        pipelines[code] = KPipeline(lang_code=code, repo_id=MODEL_ID, model=pipeline.model)
    return pipelines[code]


def wav_bytes(chunks: list[np.ndarray]) -> bytes:
    if not chunks:
        raise RuntimeError("Kokoro returned no audio")
    audio = np.concatenate([np.asarray(chunk, dtype=np.float32) for chunk in chunks])
    audio = np.nan_to_num(audio, nan=0.0, posinf=1.0, neginf=-1.0)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm.tobytes())
    return output.getvalue()


def pcm_bytes(audio: np.ndarray) -> bytes:
    normalized = np.nan_to_num(np.asarray(audio, dtype=np.float32), nan=0.0, posinf=1.0, neginf=-1.0)
    return (np.clip(normalized, -1.0, 1.0) * 32767).astype("<i2").tobytes()


def synthesize(request: SpeechRequest) -> bytes:
    if pipeline is None:
        raise RuntimeError("Kokoro is not ready")
    with generation_slots:
        selected_pipeline = pipeline_for(request.language)
        chunks = [
            audio
            for _, _, audio in selected_pipeline(
                request.input.strip(),
                voice=request.voice,
                speed=request.speed,
                split_pattern=r"(?<=[.!?])\s+|\n+",
            )
        ]
    return wav_bytes(chunks)


def synthesize_pcm_stream(request: SpeechRequest):
    if pipeline is None:
        raise RuntimeError("Kokoro is not ready")
    with generation_slots:
        selected_pipeline = pipeline_for(request.language)
        produced = False
        for _, _, audio in selected_pipeline(
            request.input.strip(),
            voice=request.voice,
            speed=request.speed,
            split_pattern=r"(?<=[.!?])\s+|\n+",
        ):
            chunk = pcm_bytes(audio)
            if chunk:
                produced = True
                yield chunk
        if not produced:
            raise RuntimeError("Kokoro returned no audio")


@asynccontextmanager
async def lifespan(_: FastAPI):
    global pipeline, pipelines
    configured_token()
    pipeline = await asyncio.to_thread(load_pipeline)
    pipelines = {"a": pipeline}
    LOGGER.info("%s ready", MODEL_ID)
    yield
    pipeline = None
    pipelines = {}


app = FastAPI(
    title="GoodSpeech Kokoro",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


@app.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "live"}


@app.get("/health/ready")
async def ready() -> dict[str, str | list[str]]:
    if pipeline is None:
        raise HTTPException(status_code=503, detail="Model is loading")
    return {
        "status": "ready",
        "model": MODEL_ID,
        "modelSha256": MODEL_SHA256,
        "languages": sorted(LANGUAGES),
    }


@app.get("/v1/audio/voices")
async def voices(
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, list[str]]:
    authorize(authorization)
    return {"voices": sorted(ALLOWED_VOICES), "languages": sorted(LANGUAGES)}


def validate_language_voice(request: SpeechRequest) -> None:
    config = LANGUAGES.get(request.language)
    if config is None:
        raise HTTPException(status_code=422, detail="Unsupported language")
    if request.voice not in config["voices"]:
        raise HTTPException(status_code=422, detail="Voice does not support the requested language")


@app.post("/v1/audio/speech")
async def speech(
    request: SpeechRequest,
    authorization: Annotated[str | None, Header()] = None,
) -> Response:
    authorize(authorization)
    if request.model != MODEL_ID:
        raise HTTPException(status_code=422, detail="Unsupported model")
    if request.voice not in ALLOWED_VOICES:
        raise HTTPException(status_code=422, detail="Unsupported voice")
    validate_language_voice(request)
    if request.response_format != "wav":
        raise HTTPException(status_code=422, detail="Unsupported response format")

    try:
        audio = await asyncio.to_thread(synthesize, request)
    except HTTPException:
        raise
    except Exception:
        LOGGER.exception("Kokoro generation failed")
        raise HTTPException(status_code=500, detail="Speech generation failed") from None

    return Response(
        content=audio,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store, max-age=0",
            "X-GoodSpeech-Model": MODEL_ID,
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.post("/v1/audio/speech/stream")
async def speech_stream(
    request: SpeechRequest,
    authorization: Annotated[str | None, Header()] = None,
) -> StreamingResponse:
    authorize(authorization)
    if request.model != MODEL_ID:
        raise HTTPException(status_code=422, detail="Unsupported model")
    if request.voice not in ALLOWED_VOICES:
        raise HTTPException(status_code=422, detail="Unsupported voice")
    validate_language_voice(request)

    return StreamingResponse(
        synthesize_pcm_stream(request),
        media_type="audio/pcm",
        headers={
            "Cache-Control": "no-store, max-age=0",
            "X-GoodSpeech-Model": MODEL_ID,
            "X-GoodSpeech-Audio-Format": "pcm_s16le",
            "X-GoodSpeech-Sample-Rate": str(SAMPLE_RATE),
            "X-GoodSpeech-Channels": "1",
            "X-Content-Type-Options": "nosniff",
        },
    )
