"""Private Kokoro inference service for GoodSpeech."""

from __future__ import annotations

import asyncio
import io
import logging
import os
import secrets
import wave
from contextlib import asynccontextmanager
from typing import Annotated

import numpy as np
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
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
})

pipeline: KPipeline | None = None
generation_slots = asyncio.Semaphore(max(1, int(os.getenv("KOKORO_CONCURRENCY", "1"))))


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str = MODEL_ID
    input: str = Field(min_length=1, max_length=MAX_TEXT_LENGTH)
    voice: str
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


def synthesize(request: SpeechRequest) -> bytes:
    if pipeline is None:
        raise RuntimeError("Kokoro is not ready")
    chunks = [
        audio
        for _, _, audio in pipeline(
            request.input.strip(),
            voice=request.voice,
            speed=request.speed,
            split_pattern=r"\n+",
        )
    ]
    return wav_bytes(chunks)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global pipeline
    configured_token()
    pipeline = await asyncio.to_thread(load_pipeline)
    LOGGER.info("%s ready", MODEL_ID)
    yield
    pipeline = None


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
async def ready() -> dict[str, str]:
    if pipeline is None:
        raise HTTPException(status_code=503, detail="Model is loading")
    return {
        "status": "ready",
        "model": MODEL_ID,
        "modelSha256": MODEL_SHA256,
    }


@app.get("/v1/audio/voices")
async def voices(
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, list[str]]:
    authorize(authorization)
    return {"voices": sorted(ALLOWED_VOICES)}


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
    if request.response_format != "wav":
        raise HTTPException(status_code=422, detail="Unsupported response format")

    try:
        async with generation_slots:
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
