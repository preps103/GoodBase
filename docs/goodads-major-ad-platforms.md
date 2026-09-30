# GoodAds major-platform campaign delivery

GoodAds exposes one paid-campaign contract for Google Search, Meta, YouTube,
TikTok, LinkedIn, X, Pinterest, and Snapchat. A provider is reported as
available only when its OAuth application, required server credentials, and a
native GoodBase adapter are all installed.

## Production safety contract

- New provider campaigns are created paused.
- Campaign activation requires an approved review bound to the exact campaign
  snapshot and provider account.
- One-click setup accepts only verified accounts sharing one currency and time
  zone.
- Provider operations are idempotent, queued, retry-bounded, and retain durable
  receipts.
- Unknown or unfinished providers fail closed. They are never routed through a
  different network's adapter.
- GoodAds never forwards provider OAuth tokens to configurable third-party
  adapter URLs.

## Adapter readiness

| Provider | OAuth identity | Account discovery | Paused delivery | Analytics |
| --- | --- | --- | --- | --- |
| Google Search | Google | Native | Native | Native |
| Meta (Facebook and Instagram) | Meta | Native | Native | Native |
| YouTube | Google | Registered | Not installed | Not installed |
| TikTok | TikTok | Registered | Not installed | Not installed |
| LinkedIn | LinkedIn | Registered | Not installed | Not installed |
| X | X | Registered | Not installed | Not installed |
| Pinterest | Pinterest | Registered | Not installed | Not installed |
| Snapchat | Snapchat Marketing API | Registered | Not installed | Not installed |

The six unfinished providers remain visible in the readiness contract so the
GoodAds interface can show the exact setup gap. They are deliberately excluded
from `supportedProviders` until an in-process adapter passes the paused-create,
lifecycle, analytics, retry, and approval-gate tests.

LinkedIn and Pinterest advertising scopes can be enabled for approved OAuth
applications with `GOODADS_LINKEDIN_ADS_OAUTH_ENABLED=true` and
`GOODADS_PINTEREST_ADS_OAUTH_ENABLED=true`. Snapchat uses
`GOODADS_SNAPCHAT_CLIENT_ID` and `GOODADS_SNAPCHAT_CLIENT_SECRET` with the
`snapchat-marketing-api` scope. These settings prepare account authorization;
they do not claim that delivery is installed.
