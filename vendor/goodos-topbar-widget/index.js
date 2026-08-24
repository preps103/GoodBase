import {
  Fragment,
  cloneElement,
  createElement,
  isValidElement,
  useEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";

export const GOODOS_TOPBAR_WIDGET_VERSION = "3.0.0";
export const GOODOS_LOGIN_WIDGET_VERSION = "1.6.0";
export const GOODOS_LOGIN_SHELL_VERSION = "1.2.0";
export const GOODOS_AUTH_ORIGIN = "https://base.goodos.app";
export const GOODOS_PASSKEY_ORIGIN = "https://goodos.app";

export async function loadGoodOSIdentityProviders(origin = GOODOS_AUTH_ORIGIN) {
  const response = await fetch(`${origin.replace(/\/$/, "")}/api/oidc/providers`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || payload.error || "GoodBase provider discovery failed.");
  }
  const providers = payload.providers || payload.data?.providers || [];
  return Array.isArray(providers)
    ? providers.filter((provider) => provider?.available === true)
    : [];
}

export function goodOSIdentityProviderUrl(providerId, redirect, origin = GOODOS_AUTH_ORIGIN) {
  const url = new URL(`/api/oidc/start/${encodeURIComponent(providerId)}`, origin);
  url.searchParams.set("returnTo", redirect);
  return url.toString();
}

export function goodOSAccountUrl(mode, redirect, origin = GOODOS_AUTH_ORIGIN) {
  const url = new URL("/auth/ui", origin);
  if (mode && mode !== "login") url.searchParams.set("mode", mode);
  url.searchParams.set("redirect", redirect);
  return url.toString();
}

export function goodOSPasskeyHandoffUrl(redirect, origin = GOODOS_PASSKEY_ORIGIN) {
  const url = new URL("/", origin);
  url.searchParams.set("passkey", "1");
  url.searchParams.set("returnTo", redirect);
  return url.toString();
}

export function goodOSPasskeysSupported() {
  return typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.get === "function";
}

function classes(...values) {
  return values.filter(Boolean).join(" ");
}

function buildStructuredTopBar({
  appName,
  workspaceLabel,
  brandIcon,
  leadingControl,
  search,
  actions,
  controls,
  onBrandClick,
  className,
  brandClassName,
  brandMarkClassName,
  workspaceClassName,
  searchClassName,
  style,
}) {
  if (!appName) {
    throw new Error(
      "GoodOSTopBarWidget requires either children or an appName.",
    );
  }

  return createElement(
    "header",
    {
      className: classes("goodos-topbar", className),
      "data-goodos-topbar": "",
      style,
    },
    createElement(
      "div",
      {
        className: "goodos-topbar__identity",
        "data-goodos-topbar-identity": "",
      },
      leadingControl,
      createElement(
        "button",
        {
          type: "button",
          className: classes("goodos-topbar__brand", brandClassName),
          "data-goodos-topbar-brand": "",
          onClick: onBrandClick,
          "aria-label": `Open ${appName} home`,
        },
        createElement(
          "span",
          {
            className: classes(
              "goodos-topbar__brand-mark",
              brandMarkClassName,
            ),
            "data-goodos-topbar-brand-mark": "",
            "aria-hidden": "true",
          },
          brandIcon,
        ),
        createElement("span", null, appName),
      ),
      createElement(
        "span",
        {
          className: classes("goodos-topbar__workspace", workspaceClassName),
          "data-goodos-topbar-workspace": "",
          title: workspaceLabel,
        },
        workspaceLabel,
      ),
    ),
    createElement(
      "div",
      {
        className: classes("goodos-topbar__search", searchClassName),
        "data-goodos-topbar-search": "",
      },
      search,
    ),
    createElement(
      "nav",
      {
        className: "goodos-topbar__actions",
        "data-goodos-topbar-actions": "",
        "aria-label": `${appName} actions`,
      },
      actions,
    ),
    createElement(
      "nav",
      {
        className: "goodos-topbar__controls",
        "data-goodos-topbar-controls": "",
        "aria-label": "Universal controls",
      },
      controls,
    ),
  );
}

/**
 * Canonical GoodOS suite top-bar shell.
 *
 * It supports the current structured API and the legacy children API so every
 * product can migrate without losing application-owned behavior. The portal
 * keeps the bar outside product overflow and stacking contexts; the spacer
 * reserves the shared responsive bar height.
 */
export function GoodOSTopBarWidget(props) {
  const bar = props.children ?? buildStructuredTopBar(props);
  const instrumentedBar = isValidElement(bar)
    ? cloneElement(bar, {
        "data-goodos-topbar-widget-version": GOODOS_TOPBAR_WIDGET_VERSION,
      })
    : bar;
  const mountedBar =
    typeof document === "undefined"
      ? instrumentedBar
      : createPortal(instrumentedBar, document.body);
  const mountedProfile =
    typeof document === "undefined"
      ? null
      : createPortal(
          createElement(UniversalProfileMenu, {
            appName: props.appName || "GoodOS",
          }),
          document.body,
        );

  return createElement(
    Fragment,
    null,
    createElement("div", {
      className: "goodos-topbar-widget__spacer",
      "data-goodos-topbar-spacer": "",
      "data-goodos-topbar-widget-version": GOODOS_TOPBAR_WIDGET_VERSION,
      "aria-hidden": "true",
    }),
    mountedBar,
    mountedProfile,
  );
}

const profileMenuCss = String.raw`
.goodos-universal-profile{position:fixed;z-index:2147483002;top:19px;right:20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e5e7eb}
.goodos-universal-profile__trigger{display:grid;width:42px;height:42px;padding:0;overflow:hidden;place-items:center;border:2px solid rgba(255,255,255,.86);border-radius:50%;background:linear-gradient(135deg,#6366f1,#06b6d4);color:#fff;cursor:pointer;font:inherit;font-size:13px;font-weight:850;box-shadow:0 4px 14px rgba(15,23,42,.28)}
.goodos-universal-profile__trigger img{width:100%;height:100%;object-fit:cover}
.goodos-universal-profile__menu{position:absolute;top:50px;right:0;width:250px;padding:10px;border:1px solid rgba(148,163,184,.24);border-radius:16px;background:rgba(15,23,42,.98);box-shadow:0 24px 64px rgba(0,0,0,.38);backdrop-filter:blur(18px)}
.goodos-universal-profile__identity{display:block;padding:10px 10px 12px;border-bottom:1px solid rgba(148,163,184,.16)}
.goodos-universal-profile__identity strong,.goodos-universal-profile__identity span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.goodos-universal-profile__identity strong{font-size:14px}.goodos-universal-profile__identity span{margin-top:3px;color:#94a3b8;font-size:11px}
.goodos-universal-profile__signout{display:flex;width:100%;min-height:42px;align-items:center;gap:9px;margin-top:8px;padding:0 11px;border:0;border-radius:10px;background:transparent;color:#fca5a5;cursor:pointer;font:inherit;font-size:13px;font-weight:800;text-align:left}.goodos-universal-profile__signout:hover{background:rgba(239,68,68,.12)}.goodos-universal-profile__signout:disabled{cursor:wait;opacity:.6}
@media(max-width:620px){.goodos-universal-profile{top:15px;right:14px}.goodos-universal-profile__trigger{width:38px;height:38px}.goodos-universal-profile__menu{top:46px;width:min(250px,calc(100vw - 28px))}}
`;

function UniversalProfileMenu({ appName }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cached = null;
    for (const key of ["goodos_current_user", "goodtrusts_user"]) {
      try {
        cached = JSON.parse(window.localStorage.getItem(key) || "null");
      } catch {
        cached = null;
      }
      if (cached?.email) break;
    }
    if (cached) setProfile(cached);

    const token = ["goodos_token", "goodos_auth_token", "auth_token", "goodtrusts_token", "token"]
      .map((key) => window.localStorage.getItem(key))
      .find(Boolean);
    void fetch(`${GOODOS_AUTH_ORIGIN}/api/auth/me`, {
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => payload?.user && setProfile(payload.user))
      .catch(() => {});
  }, []);

  const displayName = profile?.displayName || [profile?.firstName, profile?.lastName].filter(Boolean).join(" ") || profile?.email || appName;
  const initials = String(displayName || "G").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const avatarUrl = profile?.avatarUrl || profile?.avatar_url || null;

  const signOut = async () => {
    if (typeof window === "undefined") return;
    setBusy(true);
    const token = ["goodos_token", "goodos_auth_token", "auth_token", "goodtrusts_token", "token"]
      .map((key) => window.localStorage.getItem(key))
      .find(Boolean);
    try {
      await fetch(`${GOODOS_AUTH_ORIGIN}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      // Local credentials are still removed so a failed network cannot trap the user.
    }
    for (const key of ["goodos_token", "goodos_auth_token", "goodos_current_user", "goodos_current_apps", "auth_token", "goodtrusts_token", "goodtrusts_user", "token", "isAuthenticated"]) {
      window.localStorage.removeItem(key);
    }
    window.location.replace(`${window.location.origin}/?signed_out=1`);
  };

  return createElement(
    "div",
    { className: "goodos-universal-profile", "data-goodos-profile-menu": "" },
    createElement("style", null, profileMenuCss),
    createElement(
      "button",
      { type: "button", className: "goodos-universal-profile__trigger", onClick: () => setOpen((value) => !value), "aria-label": "Open user profile menu", "aria-expanded": open },
      avatarUrl ? createElement("img", { src: avatarUrl, alt: "" }) : initials,
    ),
    open && createElement(
      "div",
      { className: "goodos-universal-profile__menu", role: "menu" },
      createElement("span", { className: "goodos-universal-profile__identity" }, createElement("strong", null, displayName), createElement("span", null, profile?.email || "GoodOS account")),
      createElement("button", { type: "button", role: "menuitem", className: "goodos-universal-profile__signout", disabled: busy, onClick: signOut }, createElement("span", { "aria-hidden": "true" }, "↪"), busy ? "Signing out…" : "Sign out"),
    ),
  );
}

const loginWidgetCss = String.raw`
.goodos-login-shell.goodos-login-shell{display:grid!important;width:100%;height:100dvh;min-width:0;min-height:100vh;grid-template-columns:repeat(2,minmax(0,1fr))!important;overflow:hidden;background:#f4f7fb}
.goodos-login-shell *{box-sizing:border-box}
.goodos-login-shell__brand,.goodos-login-shell__auth{position:relative;min-width:0;min-height:0;overflow:hidden}
.goodos-login-shell__brand{isolation:isolate;background:#eaf2ff}
.goodos-login-shell__brand>*{position:relative;z-index:1;width:100%;height:100%;min-height:100dvh}
.goodos-login-shell__brand:before,.goodos-login-shell__brand:after{position:absolute;z-index:2;pointer-events:none;content:""}
.goodos-login-shell__brand:before{inset:-10%;background:radial-gradient(circle at 76% 22%,color-mix(in srgb,var(--goodos-login-brand-accent) 20%,transparent),transparent 24%),linear-gradient(112deg,transparent 28%,color-mix(in srgb,var(--goodos-login-brand-accent) 9%,transparent) 46%,transparent 64%);background-position:center,-110% 0;background-size:auto,220% 100%;opacity:.72;animation:goodos-login-brand-sweep 13s ease-in-out infinite}
.goodos-login-shell__brand:after{right:-13vw;bottom:-17vw;width:min(46vw,720px);aspect-ratio:1;border:1px solid color-mix(in srgb,var(--goodos-login-brand-accent) 34%,transparent);border-radius:50%;background:repeating-conic-gradient(from 0deg,color-mix(in srgb,var(--goodos-login-brand-accent) 46%,transparent) 0 1deg,transparent 1deg 18deg);opacity:.2;-webkit-mask:radial-gradient(circle,transparent 0 57%,#000 57.25% 57.7%,transparent 58% 70%,#000 70.25% 70.7%,transparent 71%);mask:radial-gradient(circle,transparent 0 57%,#000 57.25% 57.7%,transparent 58% 70%,#000 70.25% 70.7%,transparent 71%);animation:goodos-login-brand-orbit 38s linear infinite}
@keyframes goodos-login-brand-sweep{0%,18%{background-position:center,-110% 0}55%,100%{background-position:center,130% 0}}
@keyframes goodos-login-brand-orbit{to{transform:rotate(1turn)}}
.goodos-login-shell.goodos-login-shell:is(.buyblack-login-shell,.gearhead-login,.goodads-login,.goodboost-login,.goodbuilder-login-shell,.goodcustoms-login,.gooddesigner-login,.goodeditor-login,.goodescrow-login,.goodfleet-login,.goodscan-login,.goodspeech-login,.goodswapz-login,.goodtrusts-login,.goodvoice-login,.goodsure-login,.gpanel-login,.goodmac-login,.goodsupply-login,.goodqr-login,.auth-shell)>.goodos-login-shell__brand.goodos-login-shell__brand{background-color:#eaf2ff!important;background-image:linear-gradient(118deg,rgba(255,255,255,.04),rgba(255,255,255,.16)),url("/login/brand-hero.webp")!important;background-position:center!important;background-size:cover!important;background-blend-mode:screen,normal!important}
.goodos-login-shell.goodos-login-shell:is(.buyblack-login-shell,.gearhead-login,.goodads-login,.goodboost-login,.goodbuilder-login-shell,.goodcustoms-login,.gooddesigner-login,.goodeditor-login,.goodescrow-login,.goodfleet-login,.goodscan-login,.goodspeech-login,.goodswapz-login,.goodtrusts-login,.goodvoice-login,.goodsure-login,.gpanel-login,.goodmac-login,.goodsupply-login,.goodqr-login,.auth-shell)>.goodos-login-shell__brand.goodos-login-shell__brand>*{opacity:0!important;pointer-events:none!important}
.goodos-login-shell.goodos-login-shell:is(.buyblack-login-shell,.gearhead-login,.goodads-login,.goodboost-login,.goodbuilder-login-shell,.goodcustoms-login,.gooddesigner-login,.goodeditor-login,.goodescrow-login,.goodfleet-login,.goodscan-login,.goodspeech-login,.goodswapz-login,.goodtrusts-login,.goodvoice-login,.goodsure-login,.gpanel-login,.goodmac-login,.goodsupply-login,.goodqr-login,.auth-shell)>.goodos-login-shell__brand.goodos-login-shell__brand:before{z-index:2;inset:-12%;opacity:.46;mix-blend-mode:screen}
.goodos-login-shell.goodos-login-shell:is(.buyblack-login-shell,.gearhead-login,.goodads-login,.goodboost-login,.goodbuilder-login-shell,.goodcustoms-login,.gooddesigner-login,.goodeditor-login,.goodescrow-login,.goodfleet-login,.goodscan-login,.goodspeech-login,.goodswapz-login,.goodtrusts-login,.goodvoice-login,.goodsure-login,.gpanel-login,.goodmac-login,.goodsupply-login,.goodqr-login,.auth-shell)>.goodos-login-shell__brand.goodos-login-shell__brand:after{display:none}
.gearhead-login>.goodos-login-shell__brand:before{background:repeating-linear-gradient(102deg,transparent 0 11%,color-mix(in srgb,var(--goodos-login-brand-accent) 22%,transparent) 11.4% 11.8%,transparent 12.2% 23%);animation:goodos-gearhead-racing-line 4.8s linear infinite}
.goodos-login>.goodos-login-shell__brand:before{background:radial-gradient(circle at 50% 50%,color-mix(in srgb,var(--goodos-login-brand-accent) 30%,transparent),transparent 34%),linear-gradient(color-mix(in srgb,var(--goodos-login-brand-accent) 8%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--goodos-login-brand-accent) 8%,transparent) 1px,transparent 1px);background-size:auto,54px 54px,54px 54px;animation:goodos-core-boot-grid 8.2s ease-in-out infinite}
.goodads-login>.goodos-login-shell__brand:before{background:linear-gradient(90deg,transparent 0 18%,color-mix(in srgb,var(--goodos-login-brand-accent) 20%,transparent) 20% 22%,transparent 24% 48%,color-mix(in srgb,var(--goodos-login-brand-accent) 13%,transparent) 50% 52%,transparent 54%);background-size:210% 100%;animation:goodos-ads-campaign-track 7.6s ease-in-out infinite}
.goodboost-login>.goodos-login-shell__brand:before{background:repeating-linear-gradient(0deg,transparent 0 52px,color-mix(in srgb,var(--goodos-login-brand-accent) 18%,transparent) 53px 55px,transparent 56px 88px);animation:goodos-boost-rising-metrics 5.8s linear infinite}
.goodbuilder-login-shell>.goodos-login-shell__brand:before{background:linear-gradient(45deg,color-mix(in srgb,var(--goodos-login-brand-accent) 14%,transparent) 25%,transparent 25% 75%,color-mix(in srgb,var(--goodos-login-brand-accent) 14%,transparent) 75%),linear-gradient(-45deg,color-mix(in srgb,var(--goodos-login-brand-accent) 9%,transparent) 25%,transparent 25% 75%,color-mix(in srgb,var(--goodos-login-brand-accent) 9%,transparent) 75%);background-size:74px 74px;animation:goodos-builder-block-assembly 10s linear infinite}
.goodcustoms-login>.goodos-login-shell__brand:before{background:linear-gradient(118deg,transparent 20%,color-mix(in srgb,var(--goodos-login-brand-accent) 24%,transparent) 43%,rgba(255,255,255,.1) 50%,transparent 70%);background-size:230% 100%;animation:goodos-customs-paint-pass 9.4s ease-in-out infinite}
.gooddesigner-login>.goodos-login-shell__brand:before{background:conic-gradient(from 15deg at 76% 28%,transparent,color-mix(in srgb,var(--goodos-login-brand-accent) 28%,transparent),transparent 24%,color-mix(in srgb,#ec4899 18%,transparent),transparent 52%);animation:goodos-designer-prism-turn 16s linear infinite}
.goodeditor-login>.goodos-login-shell__brand:before{inset:0;background:linear-gradient(90deg,transparent 0 46%,color-mix(in srgb,var(--goodos-login-brand-accent) 48%,transparent) 49% 50%,transparent 53%),repeating-linear-gradient(90deg,transparent 0 46px,color-mix(in srgb,var(--goodos-login-brand-accent) 12%,transparent) 47px 48px);background-size:220% 100%,100% 22%;animation:goodos-editor-timeline-scrub 8.8s ease-in-out infinite}
.goodescrow-login>.goodos-login-shell__brand:before{background:radial-gradient(circle at 50% 50%,transparent 0 18%,color-mix(in srgb,var(--goodos-login-brand-accent) 32%,transparent) 18.5% 19%,transparent 19.5% 31%,color-mix(in srgb,var(--goodos-login-brand-accent) 18%,transparent) 31.5% 32%,transparent 32.5%);animation:goodos-escrow-vault-pulse 6.6s ease-in-out infinite}
.goodfleet-login>.goodos-login-shell__brand:before{background:radial-gradient(circle,color-mix(in srgb,var(--goodos-login-brand-accent) 42%,transparent) 0 3px,transparent 4px);background-size:88px 64px;animation:goodos-fleet-route-drift 12s linear infinite}
.goodspeech-login>.goodos-login-shell__brand:before{inset:12% -12%;background:repeating-linear-gradient(90deg,transparent 0 15px,color-mix(in srgb,var(--goodos-login-brand-accent) 28%,transparent) 16px 21px,transparent 22px 36px);-webkit-mask:linear-gradient(0deg,transparent 8%,#000 30% 70%,transparent 92%);mask:linear-gradient(0deg,transparent 8%,#000 30% 70%,transparent 92%);animation:goodos-speech-waveform-flow 5.2s linear infinite}
.goodswapz-login>.goodos-login-shell__brand:before{background:linear-gradient(135deg,transparent 30%,color-mix(in srgb,var(--goodos-login-brand-accent) 22%,transparent) 31% 34%,transparent 35% 64%,color-mix(in srgb,var(--goodos-login-brand-accent) 14%,transparent) 65% 68%,transparent 69%);background-size:180% 180%;animation:goodos-swapz-exchange-cross 7.2s ease-in-out infinite}
.goodtrusts-login>.goodos-login-shell__brand:before{background:radial-gradient(circle at 22% 28%,color-mix(in srgb,var(--goodos-login-brand-accent) 32%,transparent) 0 4px,transparent 5px),radial-gradient(circle at 72% 38%,color-mix(in srgb,var(--goodos-login-brand-accent) 26%,transparent) 0 5px,transparent 6px),radial-gradient(circle at 46% 74%,color-mix(in srgb,var(--goodos-login-brand-accent) 22%,transparent) 0 6px,transparent 7px);animation:goodos-trusts-network-bloom 6.4s ease-in-out infinite}
.goodvoice-login>.goodos-login-shell__brand:before{background:repeating-radial-gradient(circle at 58% 50%,transparent 0 46px,color-mix(in srgb,var(--goodos-login-brand-accent) 24%,transparent) 48px 50px,transparent 52px 84px);animation:goodos-voice-call-ripple 7s ease-out infinite}
.goodsure-login>.goodos-login-shell__brand:before{inset:0;background:linear-gradient(180deg,transparent 0 38%,color-mix(in srgb,var(--goodos-login-brand-accent) 32%,transparent) 48% 50%,transparent 60%);background-size:100% 220%;animation:goodos-sure-shield-scan 7.8s ease-in-out infinite}
.gpanel-login>.goodos-login-shell__brand:before{background:repeating-linear-gradient(90deg,transparent 0 52px,color-mix(in srgb,var(--goodos-login-brand-accent) 14%,transparent) 53px 54px),linear-gradient(180deg,color-mix(in srgb,var(--goodos-login-brand-accent) 16%,transparent),transparent 34%);background-size:100% 100%,100% 210%;animation:goodos-panel-data-rain 9s linear infinite}
.goodmac-login>.goodos-login-shell__brand:before{inset:8%;border:1px solid color-mix(in srgb,var(--goodos-login-brand-accent) 26%,transparent);border-radius:42px;background:linear-gradient(140deg,rgba(255,255,255,.1),transparent 38%);box-shadow:0 28px 80px color-mix(in srgb,var(--goodos-login-brand-accent) 12%,transparent);animation:goodos-mac-glass-float 8.6s ease-in-out infinite}
.goodsupply-login>.goodos-login-shell__brand:before{background:repeating-linear-gradient(90deg,transparent 0 72px,color-mix(in srgb,var(--goodos-login-brand-accent) 18%,transparent) 73px 76px,transparent 77px 142px);animation:goodos-supply-conveyor-flow 6.8s linear infinite}
@keyframes goodos-gearhead-racing-line{from{transform:translateX(-18%)}to{transform:translateX(18%)}}
@keyframes goodos-core-boot-grid{0%,100%{opacity:.34;background-size:auto,54px 54px,54px 54px}50%{opacity:.72;background-size:auto,62px 62px,62px 62px}}
@keyframes goodos-ads-campaign-track{0%,100%{background-position:-90% 0}50%{background-position:90% 0}}
@keyframes goodos-boost-rising-metrics{from{background-position:0 88px}to{background-position:0 0}}
@keyframes goodos-builder-block-assembly{from{background-position:0 0,0 0}to{background-position:74px 74px,-74px 74px}}
@keyframes goodos-customs-paint-pass{0%,100%{background-position:130% 0}50%{background-position:-60% 0}}
@keyframes goodos-designer-prism-turn{to{transform:rotate(1turn) scale(1.08)}}
@keyframes goodos-editor-timeline-scrub{0%,100%{background-position:-110% 0,0 0}50%{background-position:110% 0,0 0}}
@keyframes goodos-escrow-vault-pulse{0%,100%{transform:scale(.82);opacity:.3}50%{transform:scale(1.08);opacity:.72}}
@keyframes goodos-fleet-route-drift{from{background-position:0 0}to{background-position:176px 128px}}
@keyframes goodos-speech-waveform-flow{from{background-position:0 0}to{background-position:144px 0}}
@keyframes goodos-swapz-exchange-cross{0%,100%{background-position:0 0;transform:scale(1)}50%{background-position:100% 100%;transform:scale(1.08)}}
@keyframes goodos-trusts-network-bloom{0%,100%{transform:scale(.92);opacity:.32}50%{transform:scale(1.1);opacity:.76}}
@keyframes goodos-voice-call-ripple{0%{transform:scale(.62);opacity:.7}80%,100%{transform:scale(1.2);opacity:0}}
@keyframes goodos-sure-shield-scan{0%,100%{background-position:0 -120%}50%{background-position:0 120%}}
@keyframes goodos-panel-data-rain{from{background-position:0 0,0 -110%}to{background-position:0 0,0 110%}}
@keyframes goodos-mac-glass-float{0%,100%{transform:translateY(0) rotate(-.4deg)}50%{transform:translateY(-18px) rotate(.6deg)}}
@keyframes goodos-supply-conveyor-flow{from{background-position:0 0}to{background-position:284px 0}}
.goodos-login-shell>.goodos-login-shell__auth{display:flex!important;place-items:normal!important;min-height:0!important;padding:0!important;overflow:hidden!important;background:transparent!important;color:inherit!important}
.goodos-login-shell__auth>.goodos-login-widget{flex:1 1 auto}
.goodos-login-widget.goodos-login-widget{--goodos-login-accent:#f47a2a;--goodos-login-accent-ink:#111318;--goodos-login-panel:#0f1115;--goodos-login-card:#17191e;--goodos-login-surface:#101216;--goodos-login-tile:#1b1d22;--goodos-login-border:#343842;--goodos-login-text:#f8fafc;--goodos-login-muted:#969ca8;--goodos-login-soft:#a4a9b3;--goodos-login-control-height:52px;position:relative;display:flex!important;width:100%;min-width:0;height:100dvh;min-height:0;grid-template-columns:none!important;overflow:hidden;background:radial-gradient(circle at 80% 8%,color-mix(in srgb,var(--goodos-login-accent) 8%,transparent),transparent 22rem),var(--goodos-login-panel);color:var(--goodos-login-text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;box-sizing:border-box}
.goodos-login-widget *{box-sizing:border-box}
.goodos-login-widget__scroll{position:relative;display:flex;width:100%;min-width:0;min-height:100dvh;overflow-x:hidden;overflow-y:auto;padding:24px clamp(28px,5vw,80px) calc(24px + env(safe-area-inset-bottom))}
.goodos-login-widget__glow{pointer-events:none;position:fixed;inset:auto 0 0 50%;height:45vh;background:radial-gradient(circle at 96% 100%,color-mix(in srgb,var(--goodos-login-accent) 12%,transparent),transparent 58%)}
.goodos-login-widget__column{position:relative;display:flex;width:100%;max-width:640px;min-width:0;min-height:calc(100dvh - 48px);flex-direction:column;margin:0 auto}
.goodos-login-widget__header{display:flex;min-height:42px;flex:0 0 auto;align-items:center;justify-content:space-between;gap:18px}
.goodos-login-widget__home,.goodos-login-widget__theme{display:inline-flex;align-items:center;gap:8px;border:0;text-decoration:none;font:inherit}
.goodos-login-widget__home{color:#8f96a4;font-size:14px;font-weight:650}
.goodos-login-widget__home:hover{color:var(--goodos-login-accent)}
.goodos-login-widget__theme{min-height:42px;padding:0 14px;border:1px solid #dbe3ec;border-radius:12px;background:#0f172a;color:#e2e8f0;cursor:pointer;font-size:13px;font-weight:700;box-shadow:0 2px 5px rgba(15,23,42,.1)}
.goodos-login-widget__theme-mark{color:#f5b800;font-size:18px;line-height:1}
.goodos-login-widget__mobile-brand{display:none;margin:24px 0 0;color:var(--goodos-login-text)}
.goodos-login-widget__inner{display:flex;width:100%;min-width:0;flex:1 0 auto;align-items:center;padding:clamp(28px,6vh,54px) 0}
.goodos-login-widget__card{display:grid;width:100%;min-width:0;padding:clamp(30px,4vw,48px);border:1px solid #2c3038;border-radius:24px;background:var(--goodos-login-card);box-shadow:0 28px 70px rgba(0,0,0,.34)}
.goodos-login-widget__heading{min-width:0;min-height:138px;margin-bottom:30px}
.goodos-login-widget__eyebrow{display:block;margin-bottom:10px;color:var(--goodos-login-accent);font-size:14px;font-weight:800}
.goodos-login-widget__title{margin:0;color:var(--goodos-login-text);font-size:clamp(34px,3vw,42px);font-weight:650;letter-spacing:-.045em;line-height:1.08;overflow-wrap:anywhere}
.goodos-login-widget__subtitle{max-width:520px;margin:12px 0 0;color:var(--goodos-login-muted);font-size:16px;line-height:1.55}
.goodos-login-widget .goodos-login-widget__providers{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:12px!important;margin:0!important}
.goodos-login-widget__provider{position:relative;display:flex;min-width:0;height:var(--goodos-login-control-height);min-height:var(--goodos-login-control-height);align-items:center;justify-content:center;gap:12px;padding:8px 12px;border:1px solid var(--goodos-login-border);border-radius:12px;background:var(--goodos-login-tile);color:var(--goodos-login-soft);cursor:pointer;font:inherit;font-size:14px;font-weight:700;text-align:center}
.goodos-login-widget__provider:disabled{cursor:not-allowed;opacity:.52}
.goodos-login-widget__provider--goodos{color:var(--goodos-login-text)}
.goodos-login-widget__provider--goodos:hover{border-color:var(--goodos-login-accent);background:color-mix(in srgb,var(--goodos-login-tile) 84%,var(--goodos-login-accent))}
.goodos-login-widget__provider--passkey{grid-column:1/-1;border-color:color-mix(in srgb,var(--goodos-login-accent) 42%,var(--goodos-login-border));background:color-mix(in srgb,var(--goodos-login-tile) 91%,var(--goodos-login-accent));color:var(--goodos-login-text)}
.goodos-login-widget__provider--passkey:hover{border-color:var(--goodos-login-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--goodos-login-accent) 12%,transparent)}
.goodos-login-widget__provider-mark{display:grid;width:28px;height:28px;flex:0 0 28px;place-items:center;border:1px solid #e2e8f0;border-radius:8px;background:#fff;font-size:15px;font-weight:850}
.goodos-login-widget__provider-mark--google{color:#4285f4}
.goodos-login-widget__provider-mark--apple{color:#475569;font-size:12px}
.goodos-login-widget__provider-mark--goodos{border:0;background:transparent;color:var(--goodos-login-accent);font-size:22px}
.goodos-login-widget__provider-mark--passkey{border-color:color-mix(in srgb,var(--goodos-login-accent) 45%,#e2e8f0);color:var(--goodos-login-accent);font-size:18px}
.goodos-login-widget__microsoft{display:grid;grid-template-columns:repeat(2,7px);grid-template-rows:repeat(2,7px);gap:2px}
.goodos-login-widget__microsoft i{width:7px;height:7px}.goodos-login-widget__microsoft i:nth-child(1){background:#f25022}.goodos-login-widget__microsoft i:nth-child(2){background:#7fba00}.goodos-login-widget__microsoft i:nth-child(3){background:#00a4ef}.goodos-login-widget__microsoft i:nth-child(4){background:#ffb900}
.goodos-login-widget__divider{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:16px;margin:22px 0;color:#94a3b8;font-size:10px;font-weight:800;letter-spacing:.15em}
.goodos-login-widget__divider:before,.goodos-login-widget__divider:after{height:1px;background:var(--goodos-login-border);content:""}
.goodos-login-widget .goodos-login-widget__label{display:grid!important;min-width:0;gap:8px!important;margin:0 0 18px!important;color:#e5e7eb!important;font-size:14px!important;font-weight:750!important;line-height:1.5!important}
.goodos-login-widget__label-row{display:flex;align-items:center;justify-content:space-between;gap:14px}
.goodos-login-widget__recovery{border:0;background:transparent;color:var(--goodos-login-accent);cursor:pointer;font:inherit;font-size:12px;font-weight:750}
.goodos-login-widget__input-shell{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:8px;min-width:0;height:var(--goodos-login-control-height);min-height:var(--goodos-login-control-height);padding:0 15px;border:1px solid var(--goodos-login-border);border-radius:12px;background:var(--goodos-login-surface);color:#94a3b8;transition:border-color 160ms ease,box-shadow 160ms ease}
.goodos-login-widget__input-shell:focus-within{border-color:var(--goodos-login-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--goodos-login-accent) 18%,transparent)}
.goodos-login-widget .goodos-login-widget__input{appearance:none;width:100%!important;min-width:0!important;height:50px!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;outline:0!important;background:transparent!important;box-shadow:none!important;color:var(--goodos-login-text)!important;font:inherit;font-size:16px}
.goodos-login-widget__input::placeholder{color:#737986}
.goodos-login-widget__toggle{display:grid;width:34px;height:34px;place-items:center;border:0;border-radius:8px;background:transparent;color:#94a3b8;cursor:pointer;font:inherit;font-size:17px}
.goodos-login-widget__passkey-setup{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:12px;margin:-2px 0 18px;padding:14px 16px;border:1px solid color-mix(in srgb,var(--goodos-login-accent) 38%,var(--goodos-login-border));border-radius:12px;background:color-mix(in srgb,var(--goodos-login-surface) 92%,var(--goodos-login-accent));color:var(--goodos-login-text);cursor:pointer;transition:border-color 160ms ease,box-shadow 160ms ease,background 160ms ease}
.goodos-login-widget__passkey-setup:hover{border-color:var(--goodos-login-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--goodos-login-accent) 10%,transparent)}
.goodos-login-widget__passkey-setup input{width:18px;height:18px;margin:0;accent-color:var(--goodos-login-accent);cursor:pointer}
.goodos-login-widget__passkey-setup-copy{display:grid;gap:2px;min-width:0;font-size:14px;font-weight:800;line-height:1.35}
.goodos-login-widget__passkey-setup-copy small{color:var(--goodos-login-muted);font-size:12px;font-weight:600;line-height:1.4}
.goodos-login-widget__passkey-enroll{display:flex;width:100%;min-height:48px;align-items:center;justify-content:center;gap:9px;margin:-2px 0 18px;padding:0 16px;border:1px solid color-mix(in srgb,var(--goodos-login-accent) 48%,var(--goodos-login-border));border-radius:12px;background:color-mix(in srgb,var(--goodos-login-surface) 93%,var(--goodos-login-accent));color:var(--goodos-login-text);cursor:pointer;font:inherit;font-size:14px;font-weight:780}
.goodos-login-widget__passkey-enroll:hover{border-color:var(--goodos-login-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--goodos-login-accent) 12%,transparent)}
.goodos-login-widget__passkey-enroll:disabled{cursor:not-allowed;opacity:.58}
.goodos-login-widget__error{margin:0 0 18px;padding:14px 16px;border:1px solid #ef9a9a;border-radius:12px;background:#3a171a;color:#fecaca;font-size:14px;font-weight:650;line-height:1.5}
.goodos-login-widget .goodos-login-widget__submit{display:flex!important;width:100%!important;height:54px!important;min-height:54px!important;align-items:center!important;justify-content:center!important;gap:9px!important;margin-top:7px!important;padding:0 18px!important;border:0!important;border-radius:12px!important;background:var(--goodos-login-accent)!important;color:var(--goodos-login-accent-ink)!important;cursor:pointer;font:inherit;font-size:15px!important;font-weight:800!important;box-shadow:0 10px 24px color-mix(in srgb,var(--goodos-login-accent) 20%,transparent)!important}
.goodos-login-widget__submit:hover{filter:brightness(1.07);transform:translateY(-1px)}
.goodos-login-widget__submit:disabled{cursor:not-allowed;opacity:.58;transform:none}
.goodos-login-widget__access{margin:16px 0 0;color:#8f96a4;font-size:14px;text-align:center}
.goodos-login-widget__create{border:0;background:transparent;color:var(--goodos-login-accent);cursor:pointer;font:inherit;font-weight:750}
.goodos-login-widget__legal{flex:0 0 auto;width:100%;padding:8px 0 0;color:#7f8795;font-size:11px;line-height:1.6;text-align:center}
.goodos-login-widget__legal a{color:inherit;font-weight:700;text-decoration:none}
.goodos-login-widget.goodos-login-widget--light{--goodos-login-panel:#f4f7fb;--goodos-login-card:#fff;--goodos-login-surface:#fff;--goodos-login-tile:#fff;--goodos-login-border:#d7e0eb;--goodos-login-text:#0f172a;--goodos-login-muted:#64748b;--goodos-login-soft:#64748b;background:radial-gradient(circle at 82% 9%,color-mix(in srgb,var(--goodos-login-accent) 16%,transparent),transparent 24rem),linear-gradient(145deg,#fff 0%,#f5f8fc 52%,color-mix(in srgb,var(--goodos-login-accent) 8%,#f4f7fb) 100%)!important}
.goodos-login-widget.goodos-login-widget--light .goodos-login-widget__card{border-color:#d7e0eb;background:#fff!important;box-shadow:0 28px 70px rgba(15,23,42,.12)}
.goodos-login-widget.goodos-login-widget--light .goodos-login-widget__theme{border-color:#cbd5e1;background:#fff;color:#334155}
.goodos-login-widget.goodos-login-widget--light .goodos-login-widget__provider,.goodos-login-widget.goodos-login-widget--light .goodos-login-widget__input-shell{background:#fff!important}
.goodos-login-widget.goodos-login-widget--light .goodos-login-widget__label{color:#1e293b!important}.goodos-login-widget.goodos-login-widget--light .goodos-login-widget__error{background:#fff1f2;color:#be123c}
@media(max-width:1024px){.goodos-login-shell.goodos-login-shell{grid-template-columns:minmax(0,1fr)!important}.goodos-login-shell__brand{display:none}.goodos-login-shell__auth{grid-column:1}.goodos-login-widget__mobile-brand{display:block}.goodos-login-widget__scroll{padding-inline:32px}.goodos-login-widget__inner{padding:36px 0}}
@media(max-width:620px){.goodos-login-widget__scroll{padding:18px 18px calc(22px + env(safe-area-inset-bottom))}.goodos-login-widget__column{min-height:calc(100dvh - 40px)}.goodos-login-widget__header{min-height:40px}.goodos-login-widget__theme{min-height:40px;padding-inline:11px}.goodos-login-widget__mobile-brand{margin-top:18px}.goodos-login-widget__inner{align-items:flex-start;padding:28px 0}.goodos-login-widget__card{padding:24px;border-radius:20px}.goodos-login-widget__heading{margin-bottom:24px}.goodos-login-widget__title{font-size:clamp(30px,9vw,38px)}.goodos-login-widget__subtitle{font-size:14px}.goodos-login-widget__providers{grid-template-columns:1fr}.goodos-login-widget__provider{min-height:50px}.goodos-login-widget__divider{margin:20px 0}.goodos-login-widget__access{font-size:12px}}
@media(max-width:380px){.goodos-login-widget__scroll{padding-inline:12px}.goodos-login-widget__card{padding:20px 16px}.goodos-login-widget__home span,.goodos-login-widget__theme span:last-child{display:none}}
@media(max-height:760px) and (min-width:621px){.goodos-login-widget__inner{align-items:flex-start;padding:26px 0}.goodos-login-widget__card{padding:28px}.goodos-login-widget__heading{margin-bottom:22px}}
@media(prefers-reduced-motion:reduce){.goodos-login-shell__brand:before,.goodos-login-shell__brand:after{animation:none}.goodos-login-widget__submit{transition:none}}
`;

/**
 * Canonical two-half GoodOS login page. The application owns only the branded
 * left story; the shared login widget is always mounted in the right half.
 * Tablet and mobile layouts collapse to the authentication half automatically.
 */
export function GoodOSLoginShell({
  brandPanel,
  children,
  className,
  brandClassName,
  authClassName,
  style,
}) {
  if (!brandPanel) throw new Error("GoodOSLoginShell requires brandPanel.");
  if (!children) throw new Error("GoodOSLoginShell requires a login widget child.");

  const brandAccent =
    isValidElement(children) && typeof children.props?.accent === "string"
      ? children.props.accent
      : "#6555f5";
  const brandMotion =
    typeof className === "string" && className.trim()
      ? className.trim().split(/\s+/)[0].replace(/-login(?:-shell)?$/, "")
      : "accent-sweep-orbit";

  return createElement(
    "main",
    {
      className: classes("goodos-login-shell", className),
      style: { "--goodos-login-brand-accent": brandAccent, ...style },
      "data-goodos-login-shell": "",
      "data-goodos-login-shell-version": GOODOS_LOGIN_SHELL_VERSION,
      "data-goodos-login-brand-accent": brandAccent,
      "data-goodos-login-brand-motion": brandMotion,
      "data-goodbase-login": "",
    },
    createElement("style", { "data-goodos-login-shell-styles": "" }, loginWidgetCss),
    createElement(
      "section",
      {
        className: classes("goodos-login-shell__brand", brandClassName),
        "data-goodos-login-brand": "",
        "data-goodbase-login-brand": "",
      },
      brandPanel,
    ),
    createElement(
      "section",
      {
        className: classes("goodos-login-shell__auth", authClassName),
        "data-goodos-login-auth": "",
        "data-goodbase-login-auth": "",
      },
      children,
    ),
  );
}

function ProviderMark({ provider }) {
  if (provider === "microsoft") {
    return createElement(
      "span",
      { className: "goodos-login-widget__provider-mark", "aria-hidden": "true" },
      createElement(
        "span",
        { className: "goodos-login-widget__microsoft" },
        createElement("i"),
        createElement("i"),
        createElement("i"),
        createElement("i"),
      ),
    );
  }

  const label = provider === "google" ? "G" : provider === "apple" ? "●" : provider === "passkey" ? "◎" : "◇";
  return createElement(
    "span",
    {
      className: `goodos-login-widget__provider-mark goodos-login-widget__provider-mark--${provider}`,
      "aria-hidden": "true",
    },
    label,
  );
}

function ProviderButton({ provider, label, disabled, onClick, goodos = false, passkey = false }) {
  return createElement(
    "button",
    {
      type: "button",
      className: classes(
        "goodos-login-widget__provider",
        goodos && "goodos-login-widget__provider--goodos",
        passkey && "goodos-login-widget__provider--passkey",
      ),
      disabled,
      onClick,
    },
    createElement(ProviderMark, { provider }),
    createElement("span", null, label),
  );
}

/**
 * Canonical GoodOS login surface. Products supply identity copy, accent tokens,
 * and authentication callbacks; this widget owns all layout and responsive
 * behavior for the complete right side of every product login page.
 */
export function GoodOSLoginWidget({
  appName,
  subtitle,
  accent = "#f47a2a",
  accentInk = "#111318",
  email,
  password,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  onProviderSignIn,
  onGoodOSSignIn,
  passkeyAvailable,
  passkeyLoading = false,
  onPasskeySignIn,
  setupPasskeyAfterSignIn = false,
  onSetupPasskeyAfterSignInChange,
  passkeyEnrollmentAvailable = false,
  passkeyEnrollmentLoading = false,
  passkeyEnrollmentLabel = "Set up Touch ID on this Mac",
  onPasskeyEnroll,
  providerAvailability = {},
  onForgotPassword,
  onCreateAccount,
  loading = false,
  error = "",
  homeHref = "/",
  initialMode = "light",
  mobileBrand,
  emailPlaceholder = "you@domain.com",
  passwordPlaceholder = "Enter your GoodOS password",
  termsHref = "/terms",
  privacyHref = "/privacy",
  className,
  style,
}) {
  if (!appName) throw new Error("GoodOSLoginWidget requires appName.");
  const [mode, setMode] = useState(initialMode);
  const [showPassword, setShowPassword] = useState(false);
  const [nativePasskeyAvailable, setNativePasskeyAvailable] = useState(false);
  const loginId = `${String(appName).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-goodos-login`;
  const emailId = `${loginId}-username`;
  const passwordId = `${loginId}-password`;
  const isLight = mode === "light";
  const showPasskey = passkeyAvailable ?? nativePasskeyAvailable;
  const providerLabels = {
    google: "Sign in with Google",
    apple: "Sign in with Apple",
    microsoft: "Sign in with Microsoft",
  };

  const submit = (event) => {
    event.preventDefault();
    if (!loading) onSubmit?.(event);
  };

  useEffect(() => {
    setNativePasskeyAvailable(goodOSPasskeysSupported());
  }, []);

  const beginPasskeySignIn = () => {
    if (onPasskeySignIn) {
      onPasskeySignIn();
      return;
    }
    if (typeof window !== "undefined") {
      window.location.assign(goodOSPasskeyHandoffUrl(window.location.href));
    }
  };

  return createElement(
    "section",
    {
      className: classes(
        "goodos-login-widget",
        isLight && "goodos-login-widget--light",
        className,
      ),
      style: {
        "--goodos-login-accent": accent,
        "--goodos-login-accent-ink": accentInk,
        ...style,
      },
      "data-goodos-login-widget": "",
      "data-goodos-login-widget-version": GOODOS_LOGIN_WIDGET_VERSION,
      "data-goodbase-login": "",
    },
    createElement("style", { "data-goodos-login-widget-styles": "" }, loginWidgetCss),
    createElement("div", { className: "goodos-login-widget__glow", "aria-hidden": "true" }),
    createElement(
      "div",
      { className: "goodos-login-widget__scroll" },
      createElement(
        "div",
        { className: "goodos-login-widget__column" },
        createElement(
          "header",
          { className: "goodos-login-widget__header" },
          createElement(
            "a",
            { className: "goodos-login-widget__home", href: homeHref },
            createElement("span", { "aria-hidden": "true" }, "←"),
            createElement("span", null, "Home"),
          ),
          createElement(
            "button",
            {
              className: "goodos-login-widget__theme",
              type: "button",
              onClick: () => setMode(isLight ? "dark" : "light"),
              "aria-label": isLight ? "Switch to night mode" : "Switch to day mode",
            },
            createElement("span", { className: "goodos-login-widget__theme-mark", "aria-hidden": "true" }, isLight ? "☾" : "☼"),
            createElement("span", null, isLight ? "Night mode" : "Day mode"),
          ),
        ),
        mobileBrand && createElement("div", { className: "goodos-login-widget__mobile-brand" }, mobileBrand),
        createElement(
          "div",
          { className: "goodos-login-widget__inner" },
          createElement(
            "form",
            {
              id: loginId,
              name: loginId,
              method: "post",
              autoComplete: "on",
              className: "goodos-login-widget__card",
              onSubmit: submit,
              "data-goodbase-login-card": "",
            },
            createElement(
              "div",
              { className: "goodos-login-widget__heading" },
              createElement("small", { className: "goodos-login-widget__eyebrow" }, "Welcome back"),
              createElement("h1", { className: "goodos-login-widget__title" }, `Sign in to ${appName}`),
              createElement("p", { className: "goodos-login-widget__subtitle" }, subtitle),
            ),
            createElement(
              "div",
              { className: "goodos-login-widget__providers", "data-goodbase-login-providers": "", "aria-label": "Sign-in options" },
              showPasskey && createElement(ProviderButton, {
                provider: "passkey",
                label: passkeyLoading ? "Waiting for your passkey…" : "Use Touch ID or passkey",
                disabled: loading || passkeyLoading,
                passkey: true,
                onClick: beginPasskeySignIn,
              }),
              ...["google", "apple", "microsoft"].map((provider) =>
                createElement(ProviderButton, {
                  key: provider,
                  provider,
                  label: providerLabels[provider],
                  disabled: loading || providerAvailability[provider] === false,
                  onClick: () => onProviderSignIn?.(provider),
                }),
              ),
              createElement(ProviderButton, {
                provider: "goodos",
                label: "Continue with GoodOS",
                disabled: loading,
                goodos: true,
                onClick: onGoodOSSignIn,
              }),
            ),
            createElement("div", { className: "goodos-login-widget__divider" }, createElement("span", null, "OR USE EMAIL")),
            createElement(
              "label",
              { className: "goodos-login-widget__label", htmlFor: emailId, "data-goodbase-login-field": "" },
              "Email Address",
              createElement(
                "span",
                { className: "goodos-login-widget__input-shell" },
                createElement("span", { "aria-hidden": "true" }, "✉"),
                createElement("input", {
                  id: emailId,
                  name: "username",
                  className: "goodos-login-widget__input",
                  type: "email",
                  inputMode: "email",
                  autoComplete: "username",
                  autoCapitalize: "none",
                  spellCheck: false,
                  enterKeyHint: "next",
                  value: email,
                  onChange: (event) => onEmailChange?.(event.target.value, event),
                  placeholder: emailPlaceholder,
                  required: true,
                  disabled: loading,
                }),
              ),
            ),
            createElement(
              "label",
              { className: "goodos-login-widget__label", htmlFor: passwordId, "data-goodbase-login-field": "" },
              createElement(
                "span",
                { className: "goodos-login-widget__label-row" },
                createElement("span", null, "Password"),
                createElement("button", { className: "goodos-login-widget__recovery", type: "button", onClick: onForgotPassword }, "Forgot your password?"),
              ),
              createElement(
                "span",
                { className: "goodos-login-widget__input-shell" },
                createElement("span", { "aria-hidden": "true" }, "▣"),
                createElement("input", {
                  id: passwordId,
                  name: "password",
                  className: "goodos-login-widget__input",
                  type: showPassword ? "text" : "password",
                  autoComplete: "current-password",
                  enterKeyHint: "go",
                  value: password,
                  onChange: (event) => onPasswordChange?.(event.target.value, event),
                  placeholder: passwordPlaceholder,
                  required: true,
                  disabled: loading,
                }),
                createElement("button", {
                  className: "goodos-login-widget__toggle",
                  type: "button",
                  onClick: () => setShowPassword((value) => !value),
                  "aria-label": showPassword ? "Hide password" : "Show password",
                  "aria-pressed": showPassword,
                }, showPassword ? "◉" : "◎"),
              ),
            ),
            onSetupPasskeyAfterSignInChange && createElement(
              "label",
              { className: "goodos-login-widget__passkey-setup" },
              createElement("input", {
                type: "checkbox",
                checked: setupPasskeyAfterSignIn,
                disabled: loading,
                onChange: (event) => onSetupPasskeyAfterSignInChange?.(event.target.checked, event),
              }),
              createElement(
                "span",
                { className: "goodos-login-widget__passkey-setup-copy" },
                createElement("span", null, "Set up Touch ID after signing in"),
                createElement("small", null, "Verify your account once, then create the passkey immediately."),
              ),
            ),
            passkeyEnrollmentAvailable && createElement(
              "button",
              {
                className: "goodos-login-widget__passkey-enroll",
                type: "button",
                disabled: loading || passkeyEnrollmentLoading,
                onClick: onPasskeyEnroll,
              },
              createElement("span", { "aria-hidden": "true" }, "◎"),
              passkeyEnrollmentLoading ? "Setting up Touch ID…" : passkeyEnrollmentLabel,
            ),
            error && createElement("div", { className: "goodos-login-widget__error", role: "alert" }, error),
            createElement(
              "button",
              { className: "goodos-login-widget__submit", type: "submit", disabled: loading, "data-goodbase-login-submit": "" },
              loading ? "Signing in…" : "Sign in securely",
              !loading && createElement("span", { "aria-hidden": "true" }, "→"),
            ),
            createElement(
              "p",
              { className: "goodos-login-widget__access" },
              `New to ${appName}? `,
              createElement("button", { className: "goodos-login-widget__create", type: "button", onClick: onCreateAccount }, "Create account"),
            ),
          ),
        ),
        createElement(
          "footer",
          { className: "goodos-login-widget__legal" },
          "By signing in, you agree to the ",
          createElement("a", { href: termsHref }, "Terms of Service"),
          " and ",
          createElement("a", { href: privacyHref }, "Privacy Policy"),
          ".",
        ),
      ),
    ),
  );
}
