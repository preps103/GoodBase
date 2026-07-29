# GoodBase product login contract

GoodOS uses its own hub-specific login. Every product application uses the shared GoodBase product contract.

Load `https://base.goodos.app/backend-login.css` and render one `[data-goodbase-login]` root containing a product-owned `[data-goodbase-login-brand]` region and a standardized `[data-goodbase-login-auth]` region. The product may set the four `--goodbase-login-*` color variables, but must not change auth-panel geometry or order.

The auth panel order is: heading, enabled Google/Apple/Microsoft provider buttons, GoodOS SSO, divider, email, password with forgot-password link, submit, create-account link, and security notice. Provider availability must come from GoodBase; a disabled provider must remain visibly disabled and must not use a provider-owned public homepage as a substitute. Provider login, email login, recovery, account creation, MFA, and session completion remain GoodBase operations.

Required hooks are `data-goodbase-login-auth`, `data-goodbase-login-panel`, `data-goodbase-login-providers`, `data-goodbase-login-provider`, `data-goodbase-login-divider`, `data-goodbase-login-fields`, `data-goodbase-login-field`, `data-goodbase-login-password`, `data-goodbase-login-password-toggle`, `data-goodbase-login-recovery`, `data-goodbase-login-submit`, and `data-goodbase-login-error`. Every password field must include a keyboard-accessible Show/Hide control with an updated accessible name and `aria-pressed` state.

All controls require accessible names, native keyboard behavior, visible focus, autocomplete attributes, live error/status announcements, and reduced-motion support.
