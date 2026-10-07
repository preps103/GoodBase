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
| YouTube | Google | Native | Native, paused by default | Native campaign state |
| TikTok | TikTok Business | Native | Native, disabled by default | Native campaign state |
| LinkedIn | LinkedIn | Native | Native, paused by default | Native |
| X | X Ads (OAuth 1.0a) | Native | Native, paused by default | Native |
| Pinterest | Pinterest | Native | Native, paused by default | Native |
| Snapchat | Snapchat Marketing API | Native | Native, paused by default | Native |

Facebook and Instagram use one approved Meta developer application. Configure
either the `GOODADS_FACEBOOK_CLIENT_ID` / `GOODADS_FACEBOOK_CLIENT_SECRET` pair
or the corresponding `GOODADS_INSTAGRAM_*` pair, and register both GoodBase
callback URLs in that Meta application. Provider-specific variables remain
available as overrides when separate Meta applications are intentionally used.

X uses a separate X Ads authorization because the Ads API requires OAuth 1.0a
user context and approved Ads API access; the OAuth 2.0 connection used for
ordinary posting cannot be reused. Configure the approved application with
`GOODADS_X_ADS_CONSUMER_KEY` and `GOODADS_X_ADS_CONSUMER_SECRET` (the equivalent
`API_KEY`/`API_SECRET` names are also accepted), then reconnect after X grants
Ads API access.

The X Ads callback consumes both X's `oauth_token` and `oauth_verifier`; the
verifier is never logged or returned to the browser.

The native v12 adapter discovers only approved ad accounts, verifies an active
funding instrument, a full promotable user, campaign-management access, and the
`TWEET_COMPOSER` permission, resolves current country targets,
and creates a paused campaign, paused website-click line item, promoted-only
post, and promoted-post association. Stable GoodAds names plus progressive
provider receipts recover campaigns, line items, posts, targeting, and
associations after interrupted responses without silently duplicating the stack.
Traffic campaigns require bounded post text plus a public HTTPS destination;
conversion objectives fail closed until a verified X website tag exists.
Activation first confirms that X accepted the promoted post, then enables the
line item before the campaign, while pause stops the campaign first. Archive
pauses the stack before disassociating the post and
deleting the line item and campaign; the promoted-only post is retained for
provider auditability.

YouTube uses the approved Google Ads connection and creates an atomic Demand
Gen video stack: non-shared daily budget, paused campaign, YouTube-only ad
group channel controls, country targeting, YouTube video asset, managed square
logo asset, and responsive video ad. The campaign is the final spend barrier
and remains paused after one-click setup. Every retry first searches for the
stable GoodAds campaign identity so a successful provider response followed by
a local persistence interruption cannot duplicate the campaign.

YouTube setup currently supports website-traffic campaigns with Maximize
Clicks. The creative must reference an existing YouTube video and a managed
GoodOS PNG or JPEG square logo of at most 5 MB, plus a business name, headline,
and description within Google's current limits. Conversion objectives fail
closed until GoodAds can verify an eligible Google conversion action. Google
Search and YouTube both require an explicit EU political-advertising
declaration and use the ad account's local time zone for start and end times.

TikTok uses a separate TikTok for Business authorization, configured with
`GOODADS_TIKTOK_ADS_APP_ID` and `GOODADS_TIKTOK_ADS_CLIENT_SECRET`. It discovers
authorized advertiser accounts and their available advertising identities,
then creates a traffic campaign, ad group, uploaded-by-URL video, and ad with
every remotely spend-capable resource explicitly `DISABLE`. GoodAds persists
each provider identifier before creating the next resource so a retry resumes
the same stack instead of duplicating it. Country targets are resolved through
TikTok's region catalog for the selected account and placement.

TikTok setup currently requires a managed GoodOS HTTPS video, an available
advertising identity, ad text of at most 100 characters, and a daily budget of
at least 20 account-currency units (overridable with
`GOODADS_TIKTOK_MIN_DAILY_BUDGET`). The total ad-group budget is capped from the
selected daily budget and inclusive schedule. Conversion, sales, and lead
objectives fail closed until GoodAds can verify a TikTok Pixel or lead form.
Activation remains protected by the exact-snapshot approval gate; children are
enabled before the campaign, while pause and delete stop the parent first.

LinkedIn's native adapter discovers organization-backed ad accounts, resolves
current Bing geo targets, uploads managed GoodOS images, and creates a paused
Sponsored Content campaign with a draft direct-sponsored creative. Enable its
approved advertising scopes with `GOODADS_LINKEDIN_ADS_OAUTH_ENABLED=true`;
existing connections must reconnect to grant `r_ads` and `rw_ads`. The adapter
uses LinkedIn Marketing API version `202608` by default, overridable with
`GOODADS_LINKEDIN_API_VERSION=YYYYMM`.

LinkedIn campaigns require an explicit non-political-advertising confirmation
and acknowledgement of LinkedIn's targeting-discrimination notice. GoodAds
binds those confirmations to the immutable campaign snapshot, creates the
campaign paused with a draft direct-sponsored creative, and revalidates the
campaign, approval, account, authorization, and policy fields in the worker.
Activation promotes the creative to `ACTIVE` before enabling the parent
campaign, so the paused campaign remains the final spend barrier.

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
