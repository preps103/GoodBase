# GoodAds production integrations

GoodAds always uses `https://base.goodos.app` as its application API. Provider secrets and AI keys belong in the GoodBase runtime, never in the browser build.

## AI generation

- `GOODADS_GEMINI_API_KEY` (preferred; `GEMINI_API_KEY` and `GOOGLE_AI_API_KEY` remain compatible)
- `GOODADS_GEMINI_MODEL` (optional; defaults to `gemini-2.5-flash`)

## Social OAuth

Each enabled provider needs an HTTPS GoodBase-controlled OAuth start URL:

- `GOODADS_GOOGLE_OAUTH_START_URL`
- `GOODADS_FACEBOOK_OAUTH_START_URL`
- `GOODADS_INSTAGRAM_OAUTH_START_URL`
- `GOODADS_THREADS_OAUTH_START_URL`
- `GOODADS_LINKEDIN_OAUTH_START_URL`
- `GOODADS_X_OAUTH_START_URL`
- `GOODADS_TIKTOK_OAUTH_START_URL`
- `GOODADS_PINTEREST_OAUTH_START_URL`
- `GOODADS_REDDIT_OAUTH_START_URL`

The OAuth service is responsible for state validation, PKCE where applicable, encrypted token storage, callback handling, and creating a tenant-scoped `connections` record.

## Publishing and campaign adapters

GoodBase dispatches provider work only when both an adapter URL and the shared adapter token are configured:

- `GOODADS_PROVIDER_ADAPTER_TOKEN`
- `GOODADS_[PROVIDER]_PUBLISH_URL`
- `GOODADS_[PROVIDER]_CAMPAIGN_URL`

Adapter URLs must use HTTPS. GoodBase sends a bearer token, an idempotency key, the provider, the tenant-scoped connection ID, and the requested payload. A successful adapter should return JSON containing a provider receipt identifier (`receiptId`, `postId`, or `campaignId`) and may return an HTTPS `url`.

If any required credential, connection, or adapter is missing, GoodBase rejects the operation rather than reporting a false success.
