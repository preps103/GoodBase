"""Dependency-free GoodSpeech API client and webhook verifier."""

import hashlib
import hmac
import json
import mimetypes
from pathlib import Path
import time
import uuid
import urllib.error
import urllib.request

from .client import GoodbaseError


class GoodSpeechClient:
    def __init__(self, url="https://base.goodos.app", access_token=None, api_key=None, timeout=60):
        self.url = url.rstrip("/")
        self.access_token = access_token
        self.api_key = api_key
        self.timeout = timeout

    def _headers(self, accept="application/json"):
        headers = {"Accept": accept}
        if self.access_token:
            headers["Authorization"] = "Bearer " + self.access_token
        if self.api_key:
            headers["X-Goodbase-API-Key"] = self.api_key
        return headers

    def request(self, path, method="GET", body=None, extra_headers=None):
        payload = None if body is None else json.dumps(body).encode("utf-8")
        headers = self._headers()
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if extra_headers:
            headers.update(extra_headers)
        request = urllib.request.Request(self.url + "/api/goodspeech/v1" + path, data=payload, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            detail = json.loads(error.read() or b"{}")
            raise GoodbaseError(detail.get("message", str(error)), error.code, detail.get("code"), error.headers.get("x-request-id")) from error

    def health(self):
        return self.request("/health")

    def capabilities(self):
        return self.request("/capabilities")

    def usage(self):
        return self.request("/usage")

    def usage_preferences(self):
        return self.request("/usage/preferences")

    def update_usage_preferences(self, payload):
        return self.request("/usage/preferences", "PATCH", payload)

    def voices(self):
        return self.request("/voices/")

    def agents(self):
        return self.request("/agents/bootstrap")

    def create_designed_voice(self, payload):
        return self.request("/voices/design", "POST", payload)

    def design_voice_candidates(self, payload):
        return self.request("/voices/design/candidates", "POST", payload)

    def preview_designed_voice(self, payload):
        body = json.dumps(payload).encode("utf-8")
        headers = self._headers("audio/wav, application/json")
        headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.url + "/api/goodspeech/v1/voices/design/preview", data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.read(), dict(response.headers)
        except urllib.error.HTTPError as error:
            detail = json.loads(error.read() or b"{}")
            raise GoodbaseError(detail.get("message", str(error)), error.code, detail.get("code"), error.headers.get("x-request-id")) from error

    def start_agent_session(self, agent_id, payload=None):
        return self.request(f"/agents/{agent_id}/sessions", "POST", payload or {})

    def send_agent_turn(self, session_id, payload):
        return self.request(f"/agents/sessions/{session_id}/turns", "POST", payload)

    def interrupt_agent_session(self, session_id):
        return self.request(f"/agents/sessions/{session_id}/interrupt", "POST", {})

    def complete_agent_session(self, session_id, payload=None):
        return self.request(f"/agents/sessions/{session_id}/complete", "POST", payload or {})

    def list_webhooks(self):
        return self.request("/webhooks")

    def create_webhook(self, payload):
        return self.request("/webhooks", "POST", payload)

    def test_webhook(self, webhook_id):
        return self.request(f"/webhooks/{webhook_id}/test", "POST", {})

    def delete_webhook(self, webhook_id):
        return self.request(f"/webhooks/{webhook_id}", "DELETE")

    def privacy_settings(self):
        return self.request("/governance/privacy")

    def update_privacy_settings(self, payload):
        return self.request("/governance/privacy", "PATCH", payload)

    def purge_retained_content(self):
        return self.request("/governance/privacy/purge", "POST", {})

    def quality_summary(self):
        return self.request("/governance/quality")

    def list_studio_jobs(self):
        return self.request("/studio/jobs")

    def create_studio_job(self, payload, idempotency_key=None):
        key = idempotency_key or str(uuid.uuid4())
        return self.request("/studio/jobs", "POST", payload, {"Idempotency-Key": key})

    def get_studio_job(self, job_id):
        return self.request(f"/studio/jobs/{job_id}")

    def cancel_studio_job(self, job_id):
        return self.request(f"/studio/jobs/{job_id}/cancel", "POST", {})

    def retry_studio_job(self, job_id):
        return self.request(f"/studio/jobs/{job_id}/retry", "POST", {})

    def transcription_health(self):
        return self.request("/transcriptions/health")

    def transcribe(self, file_path, language="auto"):
        path = Path(file_path)
        audio = path.read_bytes()
        if not audio:
            raise ValueError("GoodSpeech transcribe requires a non-empty audio file.")
        boundary = "----GoodSpeech" + uuid.uuid4().hex
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        safe_name = path.name.replace('"', "").replace("\r", "").replace("\n", "")
        body = b"".join([
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\n{language or 'auto'}\r\n".encode("utf-8"),
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{safe_name}\"\r\nContent-Type: {content_type}\r\n\r\n".encode("utf-8"),
            audio,
            f"\r\n--{boundary}--\r\n".encode("ascii"),
        ])
        headers = self._headers()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        request = urllib.request.Request(self.url + "/api/goodspeech/v1/transcriptions", data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=max(self.timeout, 900)) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            detail = json.loads(error.read() or b"{}")
            raise GoodbaseError(detail.get("message", str(error)), error.code, detail.get("code"), error.headers.get("x-request-id")) from error

    def synthesize(self, payload, stream=False):
        path = "/speech/stream" if stream else "/speech"
        body = json.dumps(payload).encode("utf-8")
        headers = self._headers("application/octet-stream" if stream else "audio/wav, application/json")
        headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.url + "/api/goodspeech/v1" + path, data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.read(), dict(response.headers)
        except urllib.error.HTTPError as error:
            detail = json.loads(error.read() or b"{}")
            raise GoodbaseError(detail.get("message", str(error)), error.code, detail.get("code"), error.headers.get("x-request-id")) from error


def verify_goodspeech_webhook(payload, signature, timestamp, secret, tolerance_seconds=300, now=None):
    try:
        timestamp_number = int(timestamp)
    except (TypeError, ValueError):
        return False
    current = time.time() if now is None else now
    if abs(current - timestamp_number) > tolerance_seconds:
        return False
    supplied = str(signature or "").removeprefix("sha256=").lower()
    if len(supplied) != 64 or not secret:
        return False
    body = payload if isinstance(payload, bytes) else str(payload).encode("utf-8")
    expected = hmac.new(secret.encode("utf-8"), str(timestamp_number).encode("ascii") + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(supplied, expected)
