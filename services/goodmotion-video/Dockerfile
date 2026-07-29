FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/var/lib/goodmotion/models \
    GOODMOTION_DATA_ROOT=/var/lib/goodmotion

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg python3.11 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system goodmotion \
    && useradd --system --gid goodmotion --home-dir /var/lib/goodmotion goodmotion \
    && install -d -o goodmotion -g goodmotion /app /var/lib/goodmotion/models /var/lib/goodmotion/outputs /var/lib/goodmotion/inputs

WORKDIR /app
COPY requirements.txt ./
RUN python3 -m pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cu124 \
      torch==2.6.0 torchvision==0.21.0 \
    && python3 -m pip install --no-cache-dir --requirement requirements.txt
COPY --chown=goodmotion:goodmotion app ./app

USER goodmotion
EXPOSE 8890

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
  CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8890/health/live', timeout=4)"]

CMD ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8890", "--workers", "1", "--no-server-header"]
