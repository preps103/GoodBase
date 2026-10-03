FROM python:3.11.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/var/lib/faster-whisper/models \
    PORT=8882

RUN apt-get update \
    && apt-get install --no-install-recommends -y libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system whisper \
    && useradd --system --gid whisper --home-dir /var/lib/faster-whisper whisper \
    && install -d -o whisper -g whisper /app /var/lib/faster-whisper/models

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt \
    && python -c "from faster_whisper import WhisperModel; from huggingface_hub import snapshot_download"
COPY --chown=whisper:whisper app ./app

USER whisper
EXPOSE 8882

HEALTHCHECK --interval=30s --timeout=5s --start-period=900s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8882/health/ready', timeout=4)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8882", "--workers", "1", "--no-server-header"]
