"""Private open-model video worker for GoodSpeech."""

from __future__ import annotations

import asyncio
from io import BytesIO
import os
import secrets
import time
import uuid
from pathlib import Path
from typing import Annotated

import torch
from diffusers import DiffusionPipeline
from diffusers.utils import export_to_video, load_image
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image

DATA_ROOT = Path(os.getenv("GOODMOTION_DATA_ROOT", "/var/lib/goodmotion"))
OUTPUT_ROOT = DATA_ROOT / "outputs"
INPUT_ROOT = DATA_ROOT / "inputs"
MAX_IMAGE_BYTES = 10 * 1024 * 1024
RETENTION_SECONDS = max(3_600, int(os.getenv("GOODMOTION_RETENTION_SECONDS", "86400")))
T2V_MODEL = os.getenv("GOODMOTION_T2V_MODEL", "Wan-AI/Wan2.1-T2V-1.3B")
I2V_MODEL = os.getenv("GOODMOTION_I2V_MODEL", "Wan-AI/Wan2.1-I2V-14B-480P")
ALLOWED_MODELS = {
    "wan-2.1-t2v-1.3b": ("text-to-video", T2V_MODEL),
    "wan-2.1-i2v-14b": ("image-to-video", I2V_MODEL),
}
DIMENSIONS = {
    ("16:9", "480p"): (832, 480),
    ("9:16", "480p"): (480, 832),
    ("1:1", "480p"): (640, 640),
    ("16:9", "720p"): (1280, 720),
    ("9:16", "720p"): (720, 1280),
    ("1:1", "720p"): (960, 960),
}
CAMERA_DIRECTION = {
    "auto": "",
    "dolly-in": "Camera direction: a smooth cinematic dolly in.",
    "pull-out": "Camera direction: a smooth reveal pulling away from the subject.",
    "pan-left": "Camera direction: a controlled pan to the left.",
    "pan-right": "Camera direction: a controlled pan to the right.",
    "orbit": "Camera direction: a stable partial orbit around the subject.",
    "handheld": "Camera direction: subtle natural handheld movement without jitter.",
}

jobs: dict[str, dict] = {}
pipeline: DiffusionPipeline | None = None
pipeline_model: str | None = None
generation_lock = asyncio.Lock()
cleanup_task: asyncio.Task | None = None


def configured_token() -> str:
    token = os.getenv("GOODMOTION_VIDEO_TOKEN", "").strip()
    if len(token) < 32:
        raise RuntimeError("GOODMOTION_VIDEO_TOKEN must contain at least 32 characters")
    return token


def authorize(authorization: str | None) -> None:
    supplied = authorization[7:].strip() if authorization and authorization.startswith("Bearer ") else ""
    if not supplied or not secrets.compare_digest(supplied, configured_token()):
        raise HTTPException(status_code=401, detail="Unauthorized")


def require_cuda() -> None:
    if not torch.cuda.is_available():
        raise HTTPException(status_code=503, detail="A CUDA GPU is required for GoodMotion generation")


def safe_job(job_id: str) -> dict:
    if not job_id.isalnum() or len(job_id) != 32 or job_id not in jobs:
        raise HTTPException(status_code=404, detail="Video job not found")
    return jobs[job_id]


async def save_upload(upload: UploadFile | None, job_id: str) -> Path | None:
    if upload is None:
        return None
    if upload.content_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise HTTPException(status_code=400, detail="Reference images must be PNG, JPEG, or WebP")
    contents = await upload.read(MAX_IMAGE_BYTES + 1)
    if not contents or len(contents) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Reference images must be 10 MB or smaller")
    expected_format = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}[upload.content_type]
    try:
        with Image.open(BytesIO(contents)) as source:
            source.verify()
            if source.format != expected_format:
                raise ValueError("format mismatch")
    except Exception as error:
        raise HTTPException(status_code=400, detail="Reference image content is invalid") from error
    extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[upload.content_type]
    target = INPUT_ROOT / f"{job_id}-start.{extension}"
    target.write_bytes(contents)
    return target


def load_pipeline(model_id: str) -> DiffusionPipeline:
    global pipeline, pipeline_model
    if pipeline is not None and pipeline_model == model_id:
        return pipeline
    if pipeline is not None:
        del pipeline
        pipeline = None
        pipeline_model = None
        torch.cuda.empty_cache()
    pipeline = DiffusionPipeline.from_pretrained(
        model_id,
        torch_dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
    )
    pipeline.enable_model_cpu_offload()
    pipeline_model = model_id
    return pipeline


def render_job(job_id: str) -> None:
    job = jobs[job_id]
    try:
        job.update(status="running", progress=5, message="Loading the open video model")
        mode, model_id = ALLOWED_MODELS[job["model"]]
        video_pipeline = load_pipeline(model_id)
        job.update(progress=22, message="Building the shot")
        width, height = DIMENSIONS[(job["aspect"], job["resolution"])]
        frames = max(49, min(129, job["duration"] * 16 + 1))
        generator = torch.Generator(device="cuda").manual_seed(job["seed"])
        prompt = "\n".join(part for part in [job["prompt"], CAMERA_DIRECTION[job["camera"]]] if part)
        arguments = {
            "prompt": prompt,
            "negative_prompt": job["negativePrompt"],
            "width": width,
            "height": height,
            "num_frames": frames,
            "num_inference_steps": 30 if mode == "text-to-video" else 40,
            "guidance_scale": 5.5,
            "generator": generator,
        }
        if mode == "image-to-video":
            arguments["image"] = load_image(job["startFrame"])
        job.update(progress=38, message="Generating temporal detail")
        output = video_pipeline(**arguments)
        generated_frames = output.frames[0]
        job.update(progress=92, message="Encoding the production file")
        output_path = OUTPUT_ROOT / f"{job_id}.mp4"
        export_to_video(generated_frames, str(output_path), fps=16)
        if not output_path.exists() or output_path.stat().st_size == 0:
            raise RuntimeError("Video encoding produced an empty file")
        job.update(
            status="completed",
            progress=100,
            message="Video ready",
            output=str(output_path),
            completedAt=time.time(),
        )
    except Exception:
        job.update(
            status="failed",
            message="The open video model could not complete this shot.",
            completedAt=time.time(),
        )
    finally:
        start_frame = job.get("startFrame")
        if start_frame:
            Path(start_frame).unlink(missing_ok=True)
            job["startFrame"] = None


async def run_job(job_id: str) -> None:
    async with generation_lock:
        await asyncio.to_thread(render_job, job_id)


def cleanup_stale_jobs() -> None:
    cutoff = time.time() - RETENTION_SECONDS
    for job_id, job in list(jobs.items()):
        completed_at = float(job.get("completedAt") or 0)
        if completed_at and completed_at < cutoff:
            output = job.get("output")
            if output:
                Path(output).unlink(missing_ok=True)
            jobs.pop(job_id, None)
    for root in (INPUT_ROOT, OUTPUT_ROOT):
        for item in root.glob("*"):
            try:
                if item.is_file() and item.stat().st_mtime < cutoff:
                    item.unlink(missing_ok=True)
            except OSError:
                continue


async def cleanup_loop() -> None:
    while True:
        await asyncio.sleep(3_600)
        await asyncio.to_thread(cleanup_stale_jobs)


app = FastAPI(
    title="GoodMotion Open Video",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.on_event("startup")
async def startup() -> None:
    global cleanup_task
    configured_token()
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    INPUT_ROOT.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(cleanup_stale_jobs)
    cleanup_task = asyncio.create_task(cleanup_loop())


@app.on_event("shutdown")
async def shutdown() -> None:
    global cleanup_task
    if cleanup_task is not None:
        cleanup_task.cancel()
        cleanup_task = None


@app.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "live"}


@app.get("/health/ready")
async def ready(
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, str]:
    authorize(authorization)
    require_cuda()
    return {
        "status": "ready",
        "engine": "goodmotion-open",
        "model": T2V_MODEL,
        "gpu": torch.cuda.get_device_name(0),
    }


@app.post("/v1/video/jobs", status_code=202)
async def create_job(
    authorization: Annotated[str | None, Header()] = None,
    mode: Annotated[str, Form()] = "text-to-video",
    model: Annotated[str, Form()] = "wan-2.1-t2v-1.3b",
    prompt: Annotated[str, Form()] = "",
    negativePrompt: Annotated[str, Form()] = "",
    aspect: Annotated[str, Form()] = "16:9",
    resolution: Annotated[str, Form()] = "480p",
    duration: Annotated[int, Form()] = 5,
    camera: Annotated[str, Form()] = "auto",
    seed: Annotated[int, Form()] = 0,
    startFrame: Annotated[UploadFile | None, File()] = None,
) -> dict:
    authorize(authorization)
    require_cuda()
    if model not in ALLOWED_MODELS or ALLOWED_MODELS[model][0] != mode:
        raise HTTPException(status_code=400, detail="The selected model does not support this workflow")
    if not prompt.strip() or len(prompt) > 3_000 or len(negativePrompt) > 1_500:
        raise HTTPException(status_code=400, detail="The prompt is missing or too long")
    if (aspect, resolution) not in DIMENSIONS or camera not in CAMERA_DIRECTION:
        raise HTTPException(status_code=400, detail="The selected video settings are unsupported")
    if duration not in {4, 5, 8}:
        raise HTTPException(status_code=400, detail="The selected duration is unsupported")
    job_id = uuid.uuid4().hex
    start_path = await save_upload(startFrame, job_id)
    if mode == "image-to-video" and start_path is None:
        raise HTTPException(status_code=400, detail="A start frame is required")
    jobs[job_id] = {
        "id": job_id,
        "status": "queued",
        "progress": 0,
        "message": "Waiting for the GPU",
        "mode": mode,
        "model": model,
        "prompt": prompt.strip(),
        "negativePrompt": negativePrompt.strip(),
        "aspect": aspect,
        "resolution": resolution,
        "duration": duration,
        "camera": camera,
        "seed": max(0, min(2_147_483_647, seed)),
        "startFrame": str(start_path) if start_path else None,
        "createdAt": time.time(),
    }
    asyncio.create_task(run_job(job_id))
    return {"jobId": job_id, "status": "queued", "progress": 0}


@app.get("/v1/video/jobs/{job_id}")
async def job_status(
    job_id: str,
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    authorize(authorization)
    job = safe_job(job_id)
    return {
        "jobId": job_id,
        "status": job["status"],
        "progress": job["progress"],
        "message": job["message"],
    }


@app.get("/v1/video/jobs/{job_id}/content")
async def job_content(
    job_id: str,
    authorization: Annotated[str | None, Header()] = None,
) -> FileResponse:
    authorize(authorization)
    job = safe_job(job_id)
    if job["status"] != "completed" or not job.get("output"):
        raise HTTPException(status_code=409, detail="The video is not ready")
    return FileResponse(
        job["output"],
        media_type="video/mp4",
        filename=f"goodmotion-{job_id}.mp4",
        headers={"Cache-Control": "private, no-store"},
    )
