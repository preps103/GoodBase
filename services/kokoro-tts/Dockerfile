FROM python:3.11.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/var/lib/kokoro/models \
    PORT=8880

RUN apt-get update \
    && apt-get install --no-install-recommends -y espeak-ng libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system kokoro \
    && useradd --system --gid kokoro --home-dir /var/lib/kokoro kokoro \
    && install -d -o kokoro -g kokoro /app /var/lib/kokoro/models

WORKDIR /app
COPY requirements.txt ./
RUN apt-get update \
    && apt-get install --no-install-recommends -y build-essential \
    && pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      torch==2.7.1 \
    && pip install --no-cache-dir --requirement requirements.txt \
    && pip install --no-cache-dir \
      https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl \
    && python -c "import spacy; spacy.load('en_core_web_sm')" \
    && python -c "from transformers.models.albert.modeling_albert import AlbertModel; from kokoro import KPipeline" \
    && apt-get purge --auto-remove -y build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY --chown=kokoro:kokoro app ./app

USER kokoro
EXPOSE 8880

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8880/health/ready', timeout=4)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8880", "--workers", "1", "--no-server-header"]
