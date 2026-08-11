# GoodSpeech Kokoro deployment

GoodSpeech uses the Apache-2.0 licensed `hexgrad/Kokoro-82M` model through a private inference service. Browser speech synthesis continues to call only:

`POST https://base.goodos.app/api/goodspeech/v1/speech`

GoodBase authenticates the user, validates and rate-limits the request, calls the loopback-only Kokoro service, records audit metadata, and returns transient WAV audio. The browser never receives the internal service token and cannot call Kokoro directly.

Authenticated clients also read `GET /api/goodspeech/v1/capabilities`. That
contract reports which application tools use GoodBase/Kokoro and which use a
privacy-preserving browser media engine. Unavailable and intentionally limited
engines carry an issue message instead of advertising false readiness.

Public monitors read `GET /api/goodspeech/v1/status`. It returns HTTP 503 when
Kokoro is unavailable and otherwise includes the GoodBase release commit plus
the truthful readiness of Kokoro, GoodMotion, and the optional avatar renderer.
With `GOODSPEECH_REQUIRED=true`, Kokoro also participates in the general
`/api/health/ready` traffic gate.

GoodSpeech exposes nine distinct personas backed by nine real Kokoro voices:
Kore, Puck, Charon, Fenrir, Zephyr, Amara, Celeste, Bennett, and Ellis.

## Production configuration

Run the idempotent provisioner from the active GoodBase checkout:

```sh
sudo npm run provision:goodspeech
```

On a supported NVIDIA host, enable and verify the private GoodMotion service in
the same deployment:

```sh
sudo env GOODSPEECH_ENABLE_VIDEO=1 npm run provision:goodspeech
```

The provisioner creates `/etc/goodbase/goodspeech.env` when needed, generates
the internal token, installs and starts the systemd unit, waits for Kokoro to
finish loading, and restarts the Base API processes. GoodBase loads this same
protected environment file on every start, so its token cannot drift from the
inference service token.

The environment file is owned by `root:goodapp` with mode `0640`: systemd can
start the service and the unprivileged Base API can read the shared values.
Override `GOODBASE_RUNTIME_USER`, `GOODBASE_PM2_USER`, or `GOODBASE_PM2_HOME`
when a server uses different service accounts.

## Security and operations

- Port `8880` is published only on loopback.
- GoodBase-to-Kokoro calls require a constant-time-checked bearer token of at least 32 characters.
- Containers run as an unprivileged user with all Linux capabilities removed, a read-only root filesystem, and a bounded temporary filesystem.
- Request text is limited to 2,000 characters and generated audio is limited to 24 MiB at the GoodBase boundary.
- The model cache is persistent so releases and restarts do not repeatedly download weights.
- GoodMotion reference inputs are deleted after processing and generated outputs expire according to `GOODMOTION_RETENTION_SECONDS`.
- Voice cloning is intentionally unavailable. Kokoro does not clone voices, and GoodSpeech must not imply that a stock voice is a user-provided voice.

## Verification

```sh
docker compose --env-file /etc/goodbase/goodspeech.env -f deploy/goodspeech/compose.yaml config --quiet
curl --fail http://127.0.0.1:8880/health/ready
curl --fail --cookie '<authenticated GoodBase session>' https://base.goodos.app/api/goodspeech/v1/health
npm run test:goodspeech
```
