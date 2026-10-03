FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    NUMBA_CACHE_DIR=/tmp/numba \
    TOKENIZERS_PARALLELISM=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends git libsndfile1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu torch==2.6.0+cpu torchaudio==2.6.0+cpu \
    && pip install -r requirements.txt \
    && pip install --no-deps "git+https://github.com/resemble-ai/chatterbox.git@5de7a54aa4e5e2baadb0182dde554908b48b85c2"

COPY app ./app
RUN useradd --system --uid 10001 --home /nonexistent --shell /usr/sbin/nologin goodspeech \
    && mkdir -p /var/lib/chatterbox/models \
    && chown -R goodspeech:goodspeech /app /var/lib/chatterbox

USER goodspeech
EXPOSE 8881
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8881", "--workers", "1", "--no-server-header"]
