# GoodOS UI widget

This package is the authoritative React UI contract for the GoodOS top bar and
centralized login surface. GoodBase owns authentication and provider
availability. Product applications supply branding, application-specific
authorization, and callbacks that invoke GoodBase.

`GoodOSTopBarWidget` owns the universal header shell, profile control, and the
complete appearance menu. Applications must render their header through this
widget and mark its appearance trigger with
`data-goodos-topbar-control="theme"`; do not copy the header or theme dialog
into product code.

Version 4.11.2 stores one `goodos_appearance_v1` preference, applies Day/Night
to the application root, publishes the selected accent as shared CSS tokens,
and emits `goodos:appearance-change`. Its minimal appearance popover is anchored
directly below the top-bar control, without an overlay or page blur, so users
see every change live. The five standard schemes are Graphite Blue, Deep Ocean,
Evergreen, Carbon Ember, and Purple Pulse.

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

The shared login widget intentionally does not render a full-width biometric or
passkey provider button. On supported devices it exposes the same passkey flow
through a compact, standardized fingerprint control inside the password field. Existing passkey
helpers, enrollment controls, and callback properties remain available.

Product repositories keep a vendored snapshot so production builds remain
deterministic and do not require registry access. Copy this package as a whole;
do not selectively reproduce its UI or behavior.
