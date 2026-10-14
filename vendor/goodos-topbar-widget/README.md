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

Version 4.22.1 normalizes the four universal controls in one fixed order:
appearance, notifications, help, and profile. GoodOS declares
`notificationMode="master"` and may show the user's combined entitled feed.
Every product declares `notificationMode="application"` with its fixed
`notificationAppId` and must use the application-scoped GoodBase notification
endpoints. Product notification centers must never request the unscoped master
feed.

The shared floating support bar includes the full GoodOS accessibility suite:
display filters and color-vision profiles, text scale and spacing controls,
speech and keyboard-navigation assistance, motion and pointer controls, and
reading/focus aids. Preferences persist in `goodos_accessibility_v1` and apply
immediately without changing the standardized four-action floating bar.

Version 4.19.0 stores one `goodos_appearance_v1` preference, applies Day/Night
to the application root, publishes the selected accent as shared CSS tokens,
and emits `goodos:appearance-change`. Its minimal appearance popover is anchored
directly below the top-bar control, without an overlay or page blur, so users
see every change live. The shared tokens now drive the application canvas, top
bar, brand mark, sidebar, active navigation, cards, borders, buttons, focus
states, and ambient surfaces. The five standard schemes are Graphite Blue, Deep
Ocean, Evergreen, Carbon Ember, and Purple Pulse.

The widget also mounts the canonical floating support bar with ADA, assistant
chat, live support, and email actions. Its shell, focus treatment, and hover
states use the active GoodOS appearance tokens, so the bar updates immediately
when the user changes color scheme.

The ADA action now owns the shared accessibility panel. Text sizing, high
contrast, reduced motion, readable type, and underlined links apply immediately
across the complete application and persist on the device. Product-specific
legacy ADA launchers must be retired rather than displayed beside this control.

Each scheme uses its complete three-tone palette for layered gradients across
the popover, top bar, sidebar, selected controls, and featured surfaces. Subtle
ambient movement is enabled only when reduced motion has not been requested.
The appearance surface uses a structured product-panel hierarchy, elevated mode
cards, palette-specific accent rails, and restrained application materials so
color remains expressive without washing out content or reducing contrast.

The widget also owns the responsive top-bar geometry: a restrained desktop
search width, icon-only collapsed search at compact widths with focus expansion,
44px interaction targets, 22px universal visuals, and an application action
lane immediately to the right of Search for product-specific controls.
Application actions retain their labels, widths, menus, and behavior on desktop;
the widget standardizes their alignment and hit targets without replacing them.

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
