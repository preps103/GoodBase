"""Private Faster-Whisper inference service for GoodSpeech."""

from __future__ import annotations

import asyncio
import os
import secrets
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from faster_whisper import WhisperModel
from huggingface_hub import snapshot_download

MODEL_ID = "Systran/faster-whisper-small"
MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_SEGMENTS = 20_000
ALLOWED_SUFFIXES = {".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".webm", ".aac", ".flac"}

model: WhisperModel | None = None
model_path = ""
generation_slots = asyncio.Semaphore(max(1, int(os.getenv("FASTER_WHISPER_CONCURRENCY", "1"))))


def configured_token() -> str:
    token = os.getenv("FASTER_WHISPER_TOKEN", "").strip()
    if len(token) < 32:
        raise RuntimeError("FASTER_WHISPER_TOKEN must contain at least 32 characters")
    return token


def authorize(authorization: str | None) -> None:
    supplied = authorization[7:].strip() if authorization and authorization.startswith("Bearer ") else ""
    if not supplied or not secrets.compare_digest(supplied, configured_token()):
        raise HTTPException(status_code=401, detail="Unauthorized")


def load_model() -> tuple[WhisperModel, str]:
    revision = os.getenv("FASTER_WHISPER_MODEL_REVISION", MODEL_REVISION).strip() or MODEL_REVISION
    cache_root = os.getenv("HF_HOME", "/var/lib/faster-whisper/models")
    snapshot = snapshot_download(repo_id=MODEL_ID, revision=revision, cache_dir=cache_root)
    loaded = WhisperModel(
        snapshot,
        device="cpu",
        compute_type="int8",
        cpu_threads=max(1, int(os.getenv("FASTER_WHISPER_CPU_THREADS", "3"))),
        num_workers=1,
    )
    return loaded, snapshot


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model, model_path
    configured_token()
    model, model_path = await asyncio.to_thread(load_model)
    yield
    model = None
    model_path = ""


app = FastAPI(
    title="GoodSpeech Faster-Whisper",
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
async def ready() -> dict[str, str | bool]:
    if model is None:
        raise HTTPException(status_code=503, detail="Model is loading")
    return {
        "status": "ready",
        "model": MODEL_ID,
        "modelRevision": os.getenv("FASTER_WHISPER_MODEL_REVISION", MODEL_REVISION),
        "computeType": "int8",
        "wordTimestamps": True,
        "vad": True,
    }


async def save_bounded_upload(upload: UploadFile) -> Path:
    suffix = Path(upload.filename or "audio.wav").suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        suffix = ".audio"
    descriptor, name = tempfile.mkstemp(prefix="goodspeech-stt-", suffix=suffix)
    os.close(descriptor)
    path = Path(name)
    total = 0
    try:
        with path.open("wb") as output:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Audio file exceeds the 50 MB limit")
                output.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="Audio file is empty")
        return path
    except Exception:
        path.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


def transcribe_file(path: Path, language: str | None) -> dict:
    if model is None:
        raise RuntimeError("Faster-Whisper is not ready")
    segments, info = model.transcribe(
        str(path),
        language=language or None,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=True,
    )
    output_segments = []
    transcript_parts = []
    for index, segment in enumerate(segments):
        if index >= MAX_SEGMENTS:
            raise RuntimeError("Transcription produced too many segments")
        clean_text = str(segment.text or "").strip()
        if clean_text:
            transcript_parts.append(clean_text)
        words = [
            {
                "word": str(word.word or "").strip(),
                "start": round(float(word.start or 0), 3),
                "end": round(float(word.end or 0), 3),
                "probability": round(float(word.probability or 0), 5),
            }
            for word in (segment.words or [])
            if str(word.word or "").strip()
        ]
        output_segments.append({
            "id": index,
            "text": clean_text,
            "start": round(float(segment.start or 0), 3),
            "end": round(float(segment.end or 0), 3),
            "words": words,
        })
    return {
        "text": " ".join(transcript_parts).strip(),
        "language": info.language,
        "languageProbability": round(float(info.language_probability or 0), 5),
        "durationSeconds": round(float(info.duration or 0), 3),
        "durationAfterVadSeconds": round(float(getattr(info, "duration_after_vad", 0) or 0), 3),
        "segments": output_segments,
        "model": MODEL_ID,
        "modelRevision": os.getenv("FASTER_WHISPER_MODEL_REVISION", MODEL_REVISION),
    }


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: Annotated[UploadFile, File()],
    language: Annotated[str, Form()] = "",
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    authorize(authorization)
    normalized_language = language.strip().lower()
    if normalized_language and (len(normalized_language) < 2 or len(normalized_language) > 12 or not normalized_language.replace("-", "").isalpha()):
        raise HTTPException(status_code=422, detail="Language must be an ISO language code")
    path = await save_bounded_upload(file)
    try:
        async with generation_slots:
            return await asyncio.to_thread(transcribe_file, path, normalized_language or None)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Transcription failed") from None
    finally:
        path.unlink(missing_ok=True)
