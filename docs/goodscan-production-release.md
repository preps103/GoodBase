# GoodScan production release

GoodScan credit billing is ready only when the application code, ledger schema,
and Stripe webhook configuration are promoted together.

## Required production configuration

- `DATABASE_URL`
- `STRIPE_SECRET_KEY`
- `GOODSCAN_STRIPE_WEBHOOK_SECRET` (preferred) or `STRIPE_WEBHOOK_SECRET`
- Stripe webhook destination:
  `https://base.goodos.app/api/goodscan/v1/credits/webhooks/stripe`
- Stripe events:
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.expired`, and `charge.refunded`

Never store these values in Git or expose them to the GoodScan browser bundle.

## Release sequence

1. Require the Goodbase Required CI, Goodbase Assurance, and Goodbase SDK
   Conformance checks to pass for the exact commit.
2. Fast-forward the production GoodBase checkout to that commit.
3. Run `npm ci`.
4. Run `npm run migrate:goodscan`. The migration command is serialized with a
   PostgreSQL advisory lock and is safe when multiple instances restart.
5. Run `npm run readiness:goodscan`. Do not restart traffic-serving instances
   unless it returns `"ready": true`.
6. Restart GoodBase using the existing production process manager.
7. Verify `GET https://base.goodos.app/api/goodscan/v1/health` returns `200`.
8. Verify an authenticated `GET /api/goodscan/v1/credits` returns products,
   account balance, and the ledger without exposing payment secrets.

`npm run build` also applies the GoodScan migrations, and production startup
keeps the same migration as a fail-closed fallback. These redundant gates are
intentional; a server must never expose credit routes against a missing schema.
