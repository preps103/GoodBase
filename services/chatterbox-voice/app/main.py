"""Private, consent-gated Chatterbox Nano voice-cloning worker for GoodSpeech."""

from __future__ import annotations

import asyncio
import io
import logging
import os
import secrets
import tempfile
import threading
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import numpy as np
import torch
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from huggingface_hub import snapshot_download

from chatterbox.tts_turbo import ChatterboxTurboTTS

LOGGER = logging.getLogger("goodspeech.chatterbox")
MODEL_ID = "ResembleAI/chatterbox-nano"
MODEL_REVISION = "71ccd1d0081b430592cea481f4307e764e07bc64"
ENGINE_REVISION = "5de7a54aa4e5e2baadb0182dde554908b48b85c2"
SAMPLE_RATE = 24_000
MAX_TEXT_LENGTH = 1_000
MAX_REFERENCE_BYTES = 12 * 1024 * 1024
MIN_REFERENCE_SECONDS = 5.5
MAX_REFERENCE_SECONDS = 30.0

model: ChatterboxTurboTTS | None = None
generation_slot = threading.BoundedSemaphore(1)


def configured_token() -> str:
    token = os.getenv("CHATTERBOX_TTS_TOKEN", "").strip()
    if len(token) < 32:
        raise RuntimeError("CHATTERBOX_TTS_TOKEN must contain at least 32 characters")
    return token


def authorize(authorization: str | None) -> None:
    supplied = authorization[7:].strip() if authorization and authorization.startswith("Bearer ") else ""
    if not supplied or not secrets.compare_digest(supplied, configured_token()):
        raise HTTPException(status_code=401, detail="Unauthorized")


def validate_wav(reference: bytes) -> float:
    if not reference or len(reference) > MAX_REFERENCE_BYTES:
        raise HTTPException(status_code=413, detail="Reference audio must be a WAV file under 12 MB")
    if reference[:4] != b"RIFF" or reference[8:12] != b"WAVE":
        raise HTTPException(status_code=415, detail="Reference audio must be a PCM WAV file")
    try:
        with wave.open(io.BytesIO(reference), "rb") as reader:
            if reader.getnchannels() not in (1, 2) or reader.getsampwidth() not in (2, 3, 4):
                raise HTTPException(status_code=422, detail="Reference WAV format is unsupported")
            seconds = reader.getnframes() / max(1, reader.getframerate())
    except (EOFError, wave.Error) as error:
        raise HTTPException(status_code=422, detail="Reference WAV is invalid") from error
    if seconds < MIN_REFERENCE_SECONDS or seconds > MAX_REFERENCE_SECONDS:
        raise HTTPException(status_code=422, detail="Reference audio must be between 5.5 and 30 seconds")
    return seconds


def load_model() -> ChatterboxTurboTTS:
    torch.set_num_threads(max(1, int(os.getenv("CHATTERBOX_CPU_THREADS", "3"))))
    model_path = snapshot_download(
        repo_id=MODEL_ID,
        revision=MODEL_REVISION,
        allow_patterns=["*.safetensors", "*.json", "*.txt", "*.pt", "*.model"],
    )
    loaded = ChatterboxTurboTTS.from_local(model_path, device="cpu", nano=True)
    LOGGER.info("%s at %s is ready", MODEL_ID, MODEL_REVISION)
    return loaded


def wav_bytes(audio: torch.Tensor, sample_rate: int) -> bytes:
    samples = audio.detach().cpu().numpy().reshape(-1).astype(np.float32)
    samples = np.nan_to_num(samples, nan=0.0, posinf=1.0, neginf=-1.0)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm.tobytes())
    return output.getvalue()


def synthesize(text: str, reference: bytes) -> bytes:
    if model is None:
        raise RuntimeError("Chatterbox Nano is not ready")
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temporary:
            temporary.write(reference)
            temporary_path = Path(temporary.name)
        with generation_slot, torch.inference_mode():
            audio = model.generate(text, audio_prompt_path=str(temporary_path))
        return wav_bytes(audio, model.sr)
    finally:
        if temporary_path:
            temporary_path.unlink(missing_ok=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    configured_token()
    model = await asyncio.to_thread(load_model)
    yield
    model = None


app = FastAPI(
    title="GoodSpeech Chatterbox Voice",
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
    if model is None:
        raise HTTPException(status_code=503, detail="Model is loading")
    return {
        "status": "ready",
        "model": MODEL_ID,
        "modelRevision": MODEL_REVISION,
        "engineRevision": ENGINE_REVISION,
        "watermark": "Perth implicit watermark",
    }


@app.post("/v1/audio/speech")
async def speech(
    text: Annotated[str, Form(min_length=1, max_length=MAX_TEXT_LENGTH)],
    reference: Annotated[UploadFile, File()],
    authorization: Annotated[str | None, Header()] = None,
) -> Response:
    authorize(authorization)
    reference_bytes = await reference.read(MAX_REFERENCE_BYTES + 1)
    validate_wav(reference_bytes)
    try:
        audio = await asyncio.to_thread(synthesize, text.strip(), reference_bytes)
    except HTTPException:
        raise
    except Exception:
        LOGGER.exception("Chatterbox voice generation failed")
        raise HTTPException(status_code=500, detail="Voice generation failed") from None
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store, max-age=0",
            "X-GoodSpeech-Model": MODEL_ID,
            "X-GoodSpeech-Watermark": "perth-implicit-v1",
            "X-Content-Type-Options": "nosniff",
        },
    )
