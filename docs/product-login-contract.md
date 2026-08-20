# GoodBase product login contract

GoodOS and every product application use the shared GoodBase authentication contract. Each application keeps its own branded left-hand panel and accent color; the right-hand authentication card is a single uniform surface supplied by `GoodOSLoginShell` and `GoodOSLoginWidget` from the authoritative GoodBase `@goodos/topbar-widget` package.

Load `https://base.goodos.app/backend-login.css` and render one `[data-goodbase-login]` root containing a product-owned `[data-goodbase-login-brand]` region and a standardized `[data-goodbase-login-auth]` region. The product may set the `--goodbase-login-*` color variables, but must not change auth-card geometry or order.

The auth panel order is: heading, one two-by-two provider grid containing Google, Apple, Microsoft, and GoodOS, divider, email, password with preview and forgot-password controls, submit, create-account link, and security notice. On a narrow phone the provider grid becomes one column. Provider availability must come from GoodBase; a disabled provider remains visibly disabled and must not use a provider-owned public homepage as a substitute. Provider login, email login, recovery, account creation, MFA, and session completion remain GoodBase operations.

After authentication every application must call `GET /api/auth/authorize/:appId` with the shared GoodOS cookie. A `200` response permits entry. A `403 APPLICATION_ACCESS_DENIED` response must render an access-denied state and must not expose application data or navigation. Ordinary accounts receive only explicitly assigned applications. Verified `@goodos.app` employee identities are an intentional organization policy exception and receive active administrator memberships across the GoodOS application portfolio while preserving any owner role.

Required hooks are `data-goodbase-login-auth`, `data-goodbase-login-panel`, `data-goodbase-login-providers`, `data-goodbase-login-provider`, `data-goodbase-login-divider`, `data-goodbase-login-fields`, `data-goodbase-login-field`, `data-goodbase-login-password`, `data-goodbase-login-password-toggle`, `data-goodbase-login-recovery`, `data-goodbase-login-submit`, and `data-goodbase-login-error`. Every password field must include a keyboard-accessible Show/Hide control with an updated accessible name and `aria-pressed` state.

All controls require accessible names, native keyboard behavior, visible focus, autocomplete attributes, live error/status announcements, and reduced-motion support.
