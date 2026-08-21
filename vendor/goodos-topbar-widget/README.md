# GoodOS UI widget

This package is the authoritative React UI contract for the GoodOS top bar and
centralized login surface. GoodBase owns authentication and provider
availability. Product applications supply branding, application-specific
authorization, and callbacks that invoke GoodBase.

Use `GoodOSLoginShell` for the two-panel page structure and
`GoodOSLoginWidget` for the authentication panel. Do not fork the panel markup
or authentication behavior inside product repositories.

The shell automatically carries the widget `accent` into the branded half and
adds the shared ambient sweep and orbit treatment. Product panels still own
their logo, copy, artwork, and base palette. Motion is disabled when the user
requests reduced motion.

The authentication side contains one canonical, width-limited login card. The
card belongs to `GoodOSLoginWidget`; applications must not wrap it in another
card, add a second width cap, or restyle its controls.

Use `loadGoodOSIdentityProviders` to populate the widget's provider
availability from GoodBase, `goodOSIdentityProviderUrl` to start a configured
provider, and `goodOSAccountUrl` for shared sign-in, registration, and recovery
routes. Product code must not assume that a provider is enabled.

Product repositories keep a vendored snapshot so production builds remain
deterministic and do not require registry access. From the GoodBase repository,
run `npm run auth:widget:check` to detect drift or
`npm run auth:widget:sync` to refresh all available sibling
repositories from this authoritative source.
