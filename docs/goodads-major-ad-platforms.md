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
| LinkedIn | LinkedIn | Native | Native, paused + draft only | Not installed |
| X | X | Registered | Not installed | Not installed |
| Pinterest | Pinterest | Native | Native, paused by default | Not installed |
| Snapchat | Snapchat Marketing API | Native | Native, paused by default | Not installed |

The three unfinished providers remain visible in the readiness contract so the
GoodAds interface can show the exact setup gap. They are deliberately excluded
from `supportedProviders` until an in-process adapter passes the paused-create,
lifecycle, analytics, retry, and approval-gate tests.

LinkedIn's native adapter discovers organization-backed ad accounts, resolves
current Bing geo targets, uploads managed GoodOS images, and creates a paused
Sponsored Content campaign with a draft direct-sponsored creative. Enable its
approved advertising scopes with `GOODADS_LINKEDIN_ADS_OAUTH_ENABLED=true`;
existing connections must reconnect to grant `r_ads` and `rw_ads`. The adapter
uses LinkedIn Marketing API version `202608` by default, overridable with
`GOODADS_LINKEDIN_API_VERSION=YYYYMM`.

LinkedIn activation remains deliberately disabled. GoodAds does not yet
present LinkedIn's required political-advertising and targeting-discrimination
confirmations, so the adapter can set up and archive campaigns but cannot
request an activation review or activate one. This preserves the no-spend
contract while making the campaign fully reviewable in LinkedIn Campaign
Manager.

Pinterest's native v5 adapter discovers advertiser accounts and requires owner,
admin, or campaign-manager access plus an account currency and IANA time zone.
It creates a paused campaign with campaign-budget optimization, a paused
country-targeted ad group, an ad-only image Pin, and a paused promoted-Pin ad.
Every Pinterest ID is persisted before the next resource is created so a retry
resumes instead of duplicating the campaign stack. Traffic, awareness, and
engagement campaigns are supported. Sales, conversion, and lead campaigns fail
closed until a Pinterest Tag or lead form is verified. Activation follows the
same exact-snapshot approval gate as Meta, Google, and Snapchat; child resources
are activated before the parent campaign, while pause runs parent first.

Enable Pinterest advertising scopes for an approved OAuth application with
`GOODADS_PINTEREST_ADS_OAUTH_ENABLED=true`. Existing Pinterest connections must
reconnect to grant `ads:read`, `ads:write`, and `pins:write`.

Snapchat's native adapter uses `GOODADS_SNAPCHAT_CLIENT_ID` and
`GOODADS_SNAPCHAT_CLIENT_SECRET` with the `snapchat-marketing-api` scope. It
verifies an active ad account, campaign-write role, funding source, currency,
time zone, and an accessible shared Public Profile. The adapter accepts bounded
JPEG, PNG, MP4, or MOV media from managed GoodOS HTTPS storage; creates the
media, Web View creative, campaign, ad squad, and ad; and persists every
provider identifier before continuing. Every campaign, ad squad, and ad is
created `PAUSED`. Traffic, awareness, and engagement objectives are supported
without claiming a Pixel or lead-form integration. Sales, conversion, and lead
objectives fail closed until those event sources are verified.

Snapchat activation follows the same exact-snapshot approval gate as Meta and
Google. Child resources are activated before the parent campaign, so the parent
remains the final no-spend barrier. Pause runs in the opposite order. Snapchat
does not expose an archive status, so GoodAds archives locally only after all
remote resources are confirmed paused and records that distinction in the
durable provider receipt.
