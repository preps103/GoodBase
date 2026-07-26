# GoodSwapz marketplace and protected handoff

GoodSwapz is mounted inside GoodBase at `/api/swapz/v1`. It is isolated from other applications through an active GoodSwapz entitlement, resolved organization context, dedicated `goodswapz_*` tables, participant-only transaction queries, and `appId: "goodswapz"` notification records.

## Deployment

1. Back up the production database.
2. Apply `migrations/20260726_goodswapz_marketplace_handoff.sql`.
3. Configure:
   - `GOODESCROW_WEBHOOK_SECRET` (required, at least 32 random characters)
   - `GOODSWAPZ_DOCUMENT_ENCRYPTION_KEY` (required, at least 32 random characters)
   - `GOODSWAPZ_PRIVATE_STORAGE_PATH` (optional private persistent volume)
   - `GOODESCROW_APP_URL` (optional; defaults to `https://escrow.goodos.app`)
4. Ensure the private storage path is not served by Express or a reverse proxy and is writable only by the GoodBase service user.
5. Restart GoodBase.
6. Verify `GET /api/swapz/v1/health` reports `schemaReady: true`.

GoodBase permits `https://swapz.goodos.app` as an exact credentialed CORS origin. `Idempotency-Key` is included in the allowed request headers.

## Trust boundaries

- GoodBase derives the user, role, application access, and organization from the authenticated session.
- Listing ownership review and identity review require owner/admin access plus verified MFA.
- Seller listing creation/publication and buyer transaction initiation require approved GoodSwapz identity verification.
- Offers and transaction initiation support idempotency keys.
- The public escrow webhook verifies an HMAC-SHA256 signature and a timestamp no more than five minutes old, records event IDs for replay protection, and permits only defined state transitions.
- Identity files are limited to three files of 5 MB each, validated by MIME type and file signature, and encrypted with AES-256-GCM before private storage.
- GoodSwapz rejects handoff notes and evidence that appear to contain passwords, one-time codes, recovery secrets, session cookies, bearer tokens, or private/API keys.

## Handoff state model

`awaiting_funding → ready → in_progress → buyer_review → completed`

`ready`, `in_progress`, or `buyer_review` may move to `disputed`. A failed or cancelled external transaction moves the handoff to `cancelled`.

Each supported social platform receives an ordered checklist that uses the platform's native permission, ownership, contact, session, recovery, and security controls. A system-confirmed deposit step must be complete before the seller can start. Required seller, buyer, and shared steps must complete in sequence. The buyer's final receipt requires MFA.

GoodSwapz and GoodEscrow coordinate transaction workflow and signed provider state; they do not claim to custody or settle funds. Any payment or custody remains with the connected external provider.

## Notifications and audit

Listings, offers, identity decisions, external deposit changes, handoff completion, and disputes create GoodBase notification-center records scoped to the recipient, organization, and GoodSwapz app. Critical state mutations also create GoodBase audit entries with the authenticated actor and request IP.
