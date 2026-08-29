# GoodApps shared UI widget audit

Date: 2026-07-29

## Scope

This audit covers the 15 production GoodApps registered in the GoodBase deployment
manifest, plus the GoodBase and GoodID platform services.

| Application | Repository |
| --- | --- |
| GoodOS | `preps103/GoodOS` |
| GoodAds | `preps103/GoodAds-v1.2` |
| GoodBoost | `preps103/GoodBoost` |
| GoodBuilder | `preps103/goodbuilder` |
| GoodCustoms | `preps103/Goodloe-Customs` |
| GoodDesigner | `preps103/GoodDesigner` |
| GoodEditor | `preps103/GoodEditor` |
| GoodEscrow | `preps103/GoodEscrow` |
| GoodFleet | `preps103/GoodFleet-v2.52` |
| GoodQR | `preps103/GoodQR` |
| GoodScan | `preps103/GoodScan-3D` |
| GoodSpeech | `preps103/GoodSpeech` |
| GoodSwapz | `preps103/GoodSwapz` |
| GoodTrust | `preps103/GoodTrusts-v1.7` |
| GoodVoice | `preps103/GoodVoice-v1.3` |

GoodBackend was identified as a retired record and is not a deployment target.
It was not modified or deleted.

## Findings

- Every product application uses React 19 and Vite, so one React top-bar package
  can serve the full suite.
- The top bar had been copied into every repository and had drifted into at least
  six implementations.
- GoodAds still rendered a page-specific header even though a copied widget file
  existed in its repository.
- The ADA control had both a canonical GoodBase-hosted implementation and local
  React copies in several applications. Those applications could mount two
  accessibility controls.
- GoodBuilder did not load the shared ADA control.
- GoodAds, GoodQR, and GoodTrust did not consistently load the shared ADA assets.
- Product-specific ADA theme files are valid token overrides and are retained.

## Canonical contracts

### Top bar

- Package: `@goodos/topbar-widget`
- Version: `3.0.0`
- Source: `preps103/GoodOSUIWidgets`
- Immutable distribution:
  `https://base.goodos.app/packages/goodos-topbar-widget-3.0.0.tgz`
- Standard desktop height: `77px`
- The package supports the legacy child layout and the structured identity,
  search, actions, controls, and account zones during migration.

### ADA widget

- Stylesheet: `https://base.goodos.app/backend-ada.css?v=3.0.0`
- Script: `https://base.goodos.app/backend-ada.js?v=3.0.0`
- Launcher: `90 × 46px`
- Icon: `20 × 20px`
- Position: `24px` from the right and bottom
- Panel: `400 × 750px`, `85vh` maximum height
- Panel position: `24px` from the right and `96px` from the bottom
- Product color schemes remain token-based theme overrides; placement remains
  owned by the shared widget and is unchanged.

## Removal policy

Only files proven to duplicate a shared implementation or to be unreferenced are
removed. Deployment directories, data files, repositories, environment files,
and retired records are not deleted by this migration.

The migration removes:

- local `GoodOSTopBarWidget.tsx` copies after imports use the package;
- local React ADA launchers after the shared script is loaded;
- GoodTrust's copied `backend-ada.css` and `backend-ada.js`;
- stale, unreferenced versioned top-bar CSS files.

Product-specific theme files are retained because they contain application color
tokens, not widget behavior.

## Acceptance checks

Each application must satisfy all of the following:

1. `package.json` depends on the immutable shared top-bar package.
2. No local top-bar widget implementation remains.
3. `index.html` loads the versioned shared ADA stylesheet and script exactly once.
4. No local ADA launcher is mounted.
5. The ADA launcher remains in its current bottom-right location.
6. The application production build succeeds.
7. Existing repository tests succeed.
8. The deployed page exposes a single top-bar widget and a single ADA root.
