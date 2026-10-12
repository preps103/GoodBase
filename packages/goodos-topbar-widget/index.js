import {
  Fragment,
  cloneElement,
  createElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export const GOODOS_TOPBAR_WIDGET_VERSION = "4.19.0";
export const GOODOS_LOGIN_WIDGET_VERSION = "1.9.0";
export const GOODOS_LOGIN_SHELL_VERSION = "1.2.0";
export const GOODOS_AUTH_ORIGIN = "https://base.goodos.app";
export const GOODOS_PASSKEY_ORIGIN = "https://goodos.app";
export const GOODOS_APPEARANCE_STORAGE_KEY = "goodos_appearance_v1";
export const GOODOS_ACCESSIBILITY_STORAGE_KEY = "goodos_accessibility_v1";
const GOODOS_SUPPORT_BAR_STORAGE_KEY = "goodos_support_bar_v1";
const GOODOS_SUPPORT_VIEWPORT_MARGIN = 14;
const GOODOS_SUPPORT_EXPANDED_SIZE = { width: 208, height: 58 };
const GOODOS_SUPPORT_MINIMIZED_SIZE = { width: 56, height: 56 };

function supportViewportBounds() {
  if (typeof window === "undefined") return { left: 0, top: 0, width: 0, height: 0 };
  const viewport = window.visualViewport;
  return {
    left: viewport?.offsetLeft || 0,
    top: viewport?.offsetTop || 0,
    width: viewport?.width || window.innerWidth,
    height: viewport?.height || window.innerHeight,
  };
}

function clampSupportPosition(position, width, height) {
  const viewport = supportViewportBounds();
  const minX = viewport.left + GOODOS_SUPPORT_VIEWPORT_MARGIN;
  const minY = viewport.top + GOODOS_SUPPORT_VIEWPORT_MARGIN;
  const maxX = Math.max(minX, viewport.left + viewport.width - width - GOODOS_SUPPORT_VIEWPORT_MARGIN);
  const maxY = Math.max(minY, viewport.top + viewport.height - height - GOODOS_SUPPORT_VIEWPORT_MARGIN);
  return {
    x: Math.max(minX, Math.min(Number(position?.x) || minX, maxX)),
    y: Math.max(minY, Math.min(Number(position?.y) || minY, maxY)),
  };
}

export const GOODOS_COLOR_SCHEMES = [
  { id: "graphite-blue", name: "Graphite Blue", description: "Modern, sharp, and understated", colors: ["#07111f", "#2563eb", "#38bdf8"] },
  { id: "deep-ocean", name: "Deep Ocean", description: "Cool navy with clean cyan energy", colors: ["#042f3e", "#0891b2", "#22d3ee"] },
  { id: "evergreen", name: "Evergreen", description: "Confident green with natural depth", colors: ["#052e22", "#059669", "#84cc16"] },
  { id: "carbon-ember", name: "Carbon Ember", description: "Warm graphite with a bold orange edge", colors: ["#21140f", "#ea580c", "#f59e0b"] },
  { id: "purple-pulse", name: "Purple Pulse", description: "Expressive violet with electric energy", colors: ["#180d2a", "#7c3aed", "#d946ef"] },
];

function normalizeAppearance(value = {}) {
  const mode = value.mode === "dark" ? "dark" : "light";
  const scheme = GOODOS_COLOR_SCHEMES.some((item) => item.id === value.scheme)
    ? value.scheme
    : "graphite-blue";
  return { mode, scheme };
}

export function readGoodOSAppearance() {
  if (typeof window === "undefined") return { mode: "light", scheme: "graphite-blue" };
  try {
    const stored = JSON.parse(window.localStorage.getItem(GOODOS_APPEARANCE_STORAGE_KEY) || "null");
    if (stored) return normalizeAppearance(stored);
  } catch {}
  const legacy = window.localStorage.getItem("theme");
  const mode = legacy === "dark" || (!legacy && window.matchMedia?.("(prefers-color-scheme: dark)").matches)
    ? "dark"
    : "light";
  return { mode, scheme: "graphite-blue" };
}

export function applyGoodOSAppearance(value, { persist = true } = {}) {
  const appearance = normalizeAppearance(value);
  if (typeof document === "undefined") return appearance;
  const scheme = GOODOS_COLOR_SCHEMES.find((item) => item.id === appearance.scheme);
  const root = document.documentElement;
  root.classList.toggle("dark", appearance.mode === "dark");
  root.dataset.goodosMode = appearance.mode;
  root.dataset.goodosScheme = appearance.scheme;
  root.style.colorScheme = appearance.mode;
  root.style.setProperty("--goodos-accent", scheme.colors[1]);
  root.style.setProperty("--goodos-accent-strong", scheme.colors[2]);
  root.style.setProperty("--goodos-accent-depth", scheme.colors[0]);
  root.style.setProperty("--goodos-tone-1", scheme.colors[0]);
  root.style.setProperty("--goodos-tone-2", scheme.colors[1]);
  root.style.setProperty("--goodos-tone-3", scheme.colors[2]);
  root.style.setProperty("--goodos-accent-soft", `color-mix(in srgb, ${scheme.colors[1]} 14%, transparent)`);
  root.style.setProperty("--goodos-accent-medium", `color-mix(in srgb, ${scheme.colors[1]} 28%, transparent)`);
  root.style.setProperty("--color-indigo-400", scheme.colors[2]);
  root.style.setProperty("--color-indigo-500", scheme.colors[1]);
  root.style.setProperty("--color-indigo-600", scheme.colors[1]);
  root.style.setProperty("--color-indigo-700", scheme.colors[0]);
  if (persist && typeof window !== "undefined") {
    window.localStorage.setItem(GOODOS_APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
    window.localStorage.setItem("theme", appearance.mode);
  }
  window.dispatchEvent(new CustomEvent("goodos:appearance-change", { detail: appearance }));
  return appearance;
}

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

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value) {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function authenticationOptionsJSON(options) {
  return {
    ...options,
    challenge: decodeBase64Url(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((credential) => ({
      ...credential,
      id: decodeBase64Url(credential.id),
    })),
  };
}

function authenticationCredentialJSON(credential) {
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      authenticatorData: encodeBase64Url(credential.response.authenticatorData),
      clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
      signature: encodeBase64Url(credential.response.signature),
      userHandle: credential.response.userHandle
        ? encodeBase64Url(credential.response.userHandle)
        : undefined,
    },
  };
}

async function goodOSPasskeyRequest(path, options = {}) {
  const response = await fetch(`${GOODOS_AUTH_ORIGIN}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || payload.error || "GoodBase passkey sign-in failed.");
  }
  return payload.data || payload;
}

export async function authenticateWithGoodOSPasskey({ conditional = false, signal } = {}) {
  if (!goodOSPasskeysSupported()) {
    throw new Error("This browser cannot use a fingerprint or passkey.");
  }
  const ceremony = await goodOSPasskeyRequest(
    "/api/auth/passkeys/authentication/options",
    { method: "POST", body: "{}", signal },
  );
  const request = {
    publicKey: authenticationOptionsJSON(ceremony.options),
    signal,
  };
  if (conditional) request.mediation = "conditional";
  const credential = await navigator.credentials.get(request);
  if (!credential) throw new Error("No passkey was selected.");
  const verified = await goodOSPasskeyRequest(
    "/api/auth/passkeys/authentication/verify",
    {
      method: "POST",
      body: JSON.stringify({
        challengeId: ceremony.challengeId,
        response: authenticationCredentialJSON(credential),
      }),
      signal,
    },
  );
  if (verified.token) {
    try { localStorage.setItem("goodos_token", verified.token); } catch {}
  }
  return verified;
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
  const mountedAppearance =
    typeof document === "undefined"
      ? null
      : createPortal(
          createElement(UniversalAppearanceMenu, {
            appName: props.appName || "GoodOS",
          }),
          document.body,
        );
  const mountedSupport =
    typeof document === "undefined"
      ? null
      : createPortal(
          createElement(GoodOSFloatingSupportBar, {
            appName: props.appName || "GoodOS",
          }),
          document.body,
        );

  return createElement(
    Fragment,
    null,
    createElement("style", { "data-goodos-topbar-layout-styles": "" }, topbarCss),
    createElement("div", {
      className: "goodos-topbar-widget__spacer",
      "data-goodos-topbar-spacer": "",
      "data-goodos-topbar-widget-version": GOODOS_TOPBAR_WIDGET_VERSION,
      "aria-hidden": "true",
    }),
    mountedBar,
    mountedAppearance,
    mountedProfile,
    mountedSupport,
  );
}

function supportIcon(name) {
  const common = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" };
  if (name === "ada") return createElement("svg", common, createElement("circle", { cx: 10, cy: 4.5, r: 1.7 }), createElement("path", { d: "M10 7v5m0-3h5m-5 3-3 7m3-7 4 7m-8-5H3m12 2h4" }));
  if (name === "chat") return createElement("svg", common, createElement("path", { d: "M6 7h12a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9l-5 3v-5a3 3 0 0 1-1-2.2V10a3 3 0 0 1 3-3Z" }), createElement("path", { d: "M9 12h.01M13 12h.01M17 12h.01" }));
  if (name === "live") return createElement("svg", common, createElement("path", { d: "M4 14v-3a8 8 0 0 1 16 0v3" }), createElement("path", { d: "M4 13h3v6H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 1-2Zm16 0h-3v6h2a2 2 0 0 0 2-2v-2a2 2 0 0 0-1-2ZM17 19c0 1.1-.9 2-2 2h-3" }));
  if (name === "restore") return createElement("svg", common, createElement("circle", { cx: 7, cy: 8, r: 1 }), createElement("circle", { cx: 12, cy: 8, r: 1 }), createElement("circle", { cx: 17, cy: 8, r: 1 }), createElement("circle", { cx: 7, cy: 16, r: 1 }), createElement("circle", { cx: 12, cy: 16, r: 1 }), createElement("circle", { cx: 17, cy: 16, r: 1 }));
  return createElement("svg", common, createElement("rect", { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }), createElement("path", { d: "m4 7 8 6 8-6" }));
}

export function GoodOSFloatingSupportBar({ appName = "GoodOS" } = {}) {
  const [accessibilityOpen, setAccessibilityOpen] = useState(false);
  const [accessibilityTab, setAccessibilityTab] = useState("vision");
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const barRef = useRef(null);
  const dragRef = useRef(null);
  const [barState, setBarState] = useState(() => {
    if (typeof window === "undefined") return { minimized: false, position: null };
    try { return { minimized: false, position: null, ...JSON.parse(localStorage.getItem(GOODOS_SUPPORT_BAR_STORAGE_KEY) || "{}") }; } catch { return { minimized: false, position: null }; }
  });
  const defaults = {
    textSize: "default",
    lineHeight: 1.5,
    letterSpacing: 0,
    wordSpacing: 0,
    contrast: false,
    grayscale: false,
    invertColors: false,
    colorProfile: "none",
    reduceMotion: false,
    readableFont: false,
    underlineLinks: false,
    focusIndicators: true,
    oversizedPointer: false,
    speechAssistant: false,
    focusSpeaker: false,
    mouseSpotlight: false,
    concentrationMask: false,
    readingBar: false,
    magnifierLens: false,
  };
  const [accessibility, setAccessibility] = useState(() => {
    if (typeof window === "undefined") return defaults;
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(GOODOS_ACCESSIBILITY_STORAGE_KEY) || "{}") }; } catch { return defaults; }
  });
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.goodosTextSize = accessibility.textSize;
    root.style.setProperty("--goodos-ada-line-height", String(accessibility.lineHeight));
    root.style.setProperty("--goodos-ada-letter-spacing", `${accessibility.letterSpacing}px`);
    root.style.setProperty("--goodos-ada-word-spacing", `${accessibility.wordSpacing}px`);
    root.dataset.goodosHighContrast = String(accessibility.contrast);
    root.dataset.goodosGrayscale = String(accessibility.grayscale);
    root.dataset.goodosInvertColors = String(accessibility.invertColors);
    root.dataset.goodosColorProfile = accessibility.colorProfile;
    root.dataset.goodosReduceMotion = String(accessibility.reduceMotion);
    root.dataset.goodosReadableFont = String(accessibility.readableFont);
    root.dataset.goodosUnderlineLinks = String(accessibility.underlineLinks);
    root.dataset.goodosFocusIndicators = String(accessibility.focusIndicators);
    root.dataset.goodosOversizedPointer = String(accessibility.oversizedPointer);
    localStorage.setItem(GOODOS_ACCESSIBILITY_STORAGE_KEY, JSON.stringify(accessibility));
    window.dispatchEvent(new CustomEvent("goodos:accessibility-change", { detail: accessibility }));
  }, [accessibility]);
  useEffect(() => {
    if (!accessibility.mouseSpotlight && !accessibility.concentrationMask && !accessibility.readingBar && !accessibility.magnifierLens) return undefined;
    const trackPointer = (event) => setPointer({ x: event.clientX, y: event.clientY });
    window.addEventListener("pointermove", trackPointer, { passive: true });
    return () => window.removeEventListener("pointermove", trackPointer);
  }, [accessibility.mouseSpotlight, accessibility.concentrationMask, accessibility.readingBar, accessibility.magnifierLens]);
  useEffect(() => {
    if (!accessibility.focusSpeaker || !("speechSynthesis" in window)) return undefined;
    const speakFocused = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest(".goodos-accessibility,.goodos-support-bar")) return;
      const text = target.getAttribute("aria-label") || target.innerText?.trim();
      if (!text || text.length > 220) return;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    };
    document.addEventListener("focusin", speakFocused);
    return () => { document.removeEventListener("focusin", speakFocused); window.speechSynthesis.cancel(); };
  }, [accessibility.focusSpeaker]);
  useEffect(() => {
    if (!accessibility.speechAssistant || !("speechSynthesis" in window)) return undefined;
    let lastText = "";
    const speakHovered = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest(".goodos-accessibility,.goodos-support-bar")) return;
      const text = target.getAttribute("aria-label") || target.innerText?.trim();
      if (!text || text === lastText || text.length > 220) return;
      lastText = text;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    };
    document.addEventListener("mouseover", speakHovered);
    return () => { document.removeEventListener("mouseover", speakHovered); window.speechSynthesis.cancel(); };
  }, [accessibility.speechAssistant]);
  useEffect(() => {
    if (!accessibilityOpen) return undefined;
    const close = (event) => { if (event.key === "Escape") setAccessibilityOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [accessibilityOpen]);
  useEffect(() => {
    const keepVisible = () => setBarState((current) => {
      if (!current.position || !barRef.current) return current;
      const rect = barRef.current.getBoundingClientRect();
      const position = clampSupportPosition(current.position, rect.width, rect.height);
      if (position.x === current.position.x && position.y === current.position.y) return current;
      const next = { ...current, position };
      localStorage.setItem(GOODOS_SUPPORT_BAR_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    keepVisible();
    window.addEventListener("resize", keepVisible);
    window.visualViewport?.addEventListener("resize", keepVisible);
    window.visualViewport?.addEventListener("scroll", keepVisible);
    return () => {
      window.removeEventListener("resize", keepVisible);
      window.visualViewport?.removeEventListener("resize", keepVisible);
      window.visualViewport?.removeEventListener("scroll", keepVisible);
    };
  }, [barState.minimized]);
  const saveBarState = (next) => {
    setBarState(next);
    localStorage.setItem(GOODOS_SUPPORT_BAR_STORAGE_KEY, JSON.stringify(next));
  };
  const onPointerDown = (event) => {
    if (event.target.closest("a,button")) return;
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    setBarState((current) => ({ ...current, position: { x: rect.left, y: rect.top } }));
  };
  const onPointerMove = (event) => {
    const drag = dragRef.current;
    const rect = barRef.current?.getBoundingClientRect();
    if (!drag || drag.pointerId !== event.pointerId || !rect) return;
    setBarState((current) => ({ ...current, position: clampSupportPosition({ x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY }, rect.width, rect.height) }));
  };
  const onPointerUp = (event) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setBarState((current) => { localStorage.setItem(GOODOS_SUPPORT_BAR_STORAGE_KEY, JSON.stringify(current)); return current; });
  };
  const moveWithKeyboard = (event) => {
    if (!event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    const amount = event.shiftKey ? 24 : 8;
    const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
    const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
    saveBarState({ ...barState, position: clampSupportPosition({ x: rect.left + dx, y: rect.top + dy }, rect.width, rect.height) });
  };
  const updateAccessibility = (name, value) => setAccessibility((current) => ({ ...current, [name]: value }));
  const dispatch = (name, fallbackSelector, fallbackUrl) => {
    const localTrigger = fallbackSelector && document.querySelector(`${fallbackSelector}:not([data-goodos-support-action])`);
    if (localTrigger) {
      localTrigger.click();
      return;
    }
    const event = new CustomEvent(`goodos:open-${name}`, { detail: { appName }, cancelable: true });
    const handled = !window.dispatchEvent(event);
    if (!handled && fallbackUrl) window.open(fallbackUrl, "_blank", "noopener,noreferrer");
  };
  const actions = [
    { id: "ada", label: "Accessibility controls", onClick: () => setAccessibilityOpen((open) => !open) },
    { id: "chat", label: "Open assistant chat", onClick: () => dispatch("chat", '[data-goodos-chat-launcher]', "https://goodos.app/?support=chat") },
    { id: "live", label: "Open live support", onClick: () => dispatch("live-support", '[data-goodos-live-support]', "https://goodos.app/?support=live") },
    { id: "email", label: "Email support", href: "mailto:support@goodos.app" },
  ];
  const toggle = (id, label, description) => createElement("button", { type: "button", className: "goodos-accessibility__toggle", "aria-pressed": accessibility[id], onClick: () => updateAccessibility(id, !accessibility[id]) }, createElement("span", null, createElement("strong", null, label), createElement("small", null, description)), createElement("span", { "aria-hidden": "true" }, accessibility[id] ? "On" : "Off"));
  const choice = (id, value, label) => createElement("button", { type: "button", className: "goodos-accessibility__choice", "aria-pressed": accessibility[id] === value, onClick: () => updateAccessibility(id, value) }, label);
  const slider = (id, label, min, max, step, unit = "") => createElement("label", { className: "goodos-accessibility__slider" }, createElement("span", null, createElement("strong", null, label), createElement("output", null, `${accessibility[id]}${unit}`)), createElement("input", { type: "range", min, max, step, value: accessibility[id], onChange: (event) => updateAccessibility(id, Number(event.target.value)) }));
  const tabButton = (id, label) => createElement("button", { type: "button", role: "tab", "aria-selected": accessibilityTab === id, onClick: () => setAccessibilityTab(id) }, label);
  let accessibilityPanelContent;
  if (accessibilityTab === "vision") {
    accessibilityPanelContent = createElement(Fragment, null,
      createElement("fieldset", null,
        createElement("legend", null, "Visual filters"),
        createElement("div", { className: "goodos-accessibility__choices" },
          choice("contrast", false, "Standard"),
          choice("contrast", true, "High contrast"),
          toggle("grayscale", "Grayscale", "Remove decorative color from the application"),
          toggle("invertColors", "Invert colors", "Reverse the display palette for stronger separation"),
        ),
      ),
      createElement("fieldset", null,
        createElement("legend", null, "Color vision profiles"),
        createElement("div", { className: "goodos-accessibility__choices goodos-accessibility__choices--two" },
          choice("colorProfile", "none", "Standard"),
          choice("colorProfile", "protanopia", "Protanopia"),
          choice("colorProfile", "deuteranopia", "Deuteranopia"),
          choice("colorProfile", "tritanopia", "Tritanopia"),
        ),
      ),
    );
  } else if (accessibilityTab === "reading") {
    accessibilityPanelContent = createElement(Fragment, null,
      createElement("fieldset", null,
        createElement("legend", null, "Text size"),
        createElement("div", { className: "goodos-accessibility__sizes" }, ["default", "large", "larger"].map((size) => createElement("button", { key: size, type: "button", "aria-pressed": accessibility.textSize === size, onClick: () => updateAccessibility("textSize", size) }, size === "default" ? "100%" : size === "large" ? "112%" : "125%"))),
      ),
      slider("lineHeight", "Line height", 1.2, 2.2, .1, "×"),
      slider("letterSpacing", "Letter spacing", 0, 4, .5, "px"),
      slider("wordSpacing", "Word spacing", 0, 10, 1, "px"),
      toggle("readableFont", "Readable typeface", "Use a clearer, weighted font across the application"),
    );
  } else if (accessibilityTab === "browse") {
    accessibilityPanelContent = createElement(Fragment, null,
      toggle("speechAssistant", "Speech assistant", "Read interface text aloud when it is hovered"),
      toggle("focusSpeaker", "Focus speaker", "Announce controls as keyboard focus moves"),
      toggle("oversizedPointer", "Oversized pointer", "Use a larger, high-visibility cursor"),
      toggle("reduceMotion", "Reduce motion", "Stop nonessential animation and movement"),
      toggle("underlineLinks", "Highlight controls", "Underline links and outline interactive controls"),
      toggle("focusIndicators", "Focus indicators", "Show stronger outlines during keyboard navigation"),
    );
  } else {
    accessibilityPanelContent = createElement(Fragment, null,
      toggle("mouseSpotlight", "Mouse spotlight", "Create a visible halo around the pointer"),
      toggle("concentrationMask", "Concentration mask", "Shade content outside the current pointer area"),
      toggle("readingBar", "Visual reading bar", "Track the current line with a horizontal guide"),
      toggle("magnifierLens", "Magnifier lens", "Increase contrast around the pointer area"),
    );
  }
  return createElement(
    Fragment,
    null,
    createElement("style", { "data-goodos-support-styles": "" }, topbarCss),
    (accessibility.mouseSpotlight || accessibility.concentrationMask) && createElement("div", { className: "goodos-accessibility-effect goodos-accessibility-effect--spotlight", style: { "--goodos-pointer-x": `${pointer.x}px`, "--goodos-pointer-y": `${pointer.y}px`, "--goodos-mask-opacity": accessibility.concentrationMask ? ".76" : ".5", "--goodos-mask-radius": accessibility.concentrationMask ? "160px" : "95px" }, "aria-hidden": "true" }),
    accessibility.readingBar && createElement("div", { className: "goodos-accessibility-effect goodos-accessibility-effect--reading-bar", style: { top: `${pointer.y - 24}px` }, "aria-hidden": "true" }),
    accessibility.magnifierLens && createElement("div", { className: "goodos-accessibility-effect goodos-accessibility-effect--magnifier", style: { left: `${pointer.x - 72}px`, top: `${pointer.y - 72}px` }, "aria-hidden": "true" }),
    accessibilityOpen && createElement("section", { className: "goodos-accessibility", role: "dialog", "aria-modal": "false", "aria-label": `${appName} accessibility settings` },
      createElement("div", { className: "goodos-accessibility__header" }, createElement("div", null, createElement("strong", null, "Accessibility"), createElement("span", null, `Adjust ${appName} in real time.`)), createElement("button", { type: "button", onClick: () => setAccessibilityOpen(false), "aria-label": "Close accessibility settings" }, "×")),
      createElement("div", { className: "goodos-accessibility__tabs", role: "tablist", "aria-label": "Accessibility feature categories" }, tabButton("vision", "Vision"), tabButton("reading", "Reading"), tabButton("browse", "Browse"), tabButton("focus", "Focus")),
      createElement("div", { className: "goodos-accessibility__content" }, accessibilityPanelContent),
      createElement("div", { className: "goodos-accessibility__footer" }, createElement("span", null, "Changes are saved on this device."), createElement("button", { type: "button", className: "goodos-accessibility__reset", onClick: () => setAccessibility(defaults) }, "Reset"))
    ),
    createElement("nav", { ref: barRef, className: `goodos-support-bar${barState.minimized ? " goodos-support-bar--minimized" : ""}`, "data-goodos-support-bar": "", "aria-label": `${appName} support. Drag the empty edge to move, or use Alt plus arrow keys.`, tabIndex: 0, style: barState.position ? { left: `${barState.position.x}px`, top: `${barState.position.y}px`, right: "auto", bottom: "auto", transform: "none" } : undefined, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onKeyDown: moveWithKeyboard },
      barState.minimized
        ? createElement("button", { type: "button", className: "goodos-support-bar__action goodos-support-bar__restore", onClick: () => saveBarState({ ...barState, minimized: false, position: barState.position ? clampSupportPosition(barState.position, GOODOS_SUPPORT_EXPANDED_SIZE.width, GOODOS_SUPPORT_EXPANDED_SIZE.height) : null }), "aria-label": "Show support tools", title: "Show support tools" }, supportIcon("restore"))
        : createElement(Fragment, null,
          createElement("button", { type: "button", className: "goodos-support-bar__minimize", onClick: () => { setAccessibilityOpen(false); saveBarState({ ...barState, minimized: true, position: barState.position ? clampSupportPosition(barState.position, GOODOS_SUPPORT_MINIMIZED_SIZE.width, GOODOS_SUPPORT_MINIMIZED_SIZE.height) : null }); }, "aria-label": "Hide support tools", title: "Hide support tools" }, "−"),
          actions.map((action) => createElement(action.href ? "a" : "button", { key: action.id, className: "goodos-support-bar__action", "data-goodos-support-action": action.id, "aria-label": action.label, title: action.label, ...(action.href ? { href: action.href } : { type: "button", onClick: action.onClick }), ...(action.id === "ada" ? { "aria-expanded": accessibilityOpen } : {}) }, supportIcon(action.id), createElement("span", { className: "goodos-support-bar__label" }, action.label)))
        )
    )
  );
}

const topbarCss = String.raw`
:root{--goodos-topbar-height:72px;--goodos-topbar-gutter:24px;--goodos-topbar-control-size:44px;--goodos-topbar-icon-size:22px}
.goodos-topbar-widget__spacer{display:block;height:var(--goodos-topbar-height);flex:0 0 var(--goodos-topbar-height)}
.goodos-topbar[data-goodos-topbar]{position:fixed!important;z-index:2147483000!important;inset:0 0 auto!important;display:grid!important;grid-template-columns:auto minmax(180px,360px) minmax(0,1fr) auto!important;align-items:center!important;gap:16px!important;width:100%!important;min-height:var(--goodos-topbar-height)!important;padding:0 var(--goodos-topbar-gutter)!important;box-sizing:border-box!important;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)!important}
.goodos-topbar__identity{display:flex;min-width:0;align-items:center;gap:10px}.goodos-topbar__brand{display:flex;min-width:0;align-items:center;gap:10px;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;font-weight:750;white-space:nowrap}.goodos-topbar__brand-mark{display:grid;width:40px;height:40px;flex:0 0 40px;place-items:center;border-radius:12px}.goodos-topbar__workspace{max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.goodos-topbar__search{position:relative;display:flex;width:100%;max-width:360px;min-width:0;align-items:center;justify-self:start;transition:width 180ms ease,max-width 180ms ease,box-shadow 180ms ease}.goodos-topbar__search input{width:100%;min-width:0}.goodos-topbar__actions{display:flex;min-width:0;align-items:center;justify-content:flex-start;gap:8px;overflow:hidden}.goodos-topbar__controls{display:flex;align-items:center;justify-content:flex-end;gap:6px;white-space:nowrap}
.goodos-topbar [data-goodos-topbar-control]{display:inline-grid!important;width:var(--goodos-topbar-control-size)!important;min-width:var(--goodos-topbar-control-size)!important;height:var(--goodos-topbar-control-size)!important;min-height:var(--goodos-topbar-control-size)!important;place-items:center!important;padding:0!important;border-radius:12px!important;box-sizing:border-box!important}.goodos-topbar__actions>button,.goodos-topbar__actions>a{display:inline-flex!important;width:auto!important;min-width:var(--goodos-topbar-control-size)!important;min-height:var(--goodos-topbar-control-size)!important;align-items:center!important;justify-content:center!important;gap:7px!important;padding:0 12px!important;border-radius:12px!important;box-sizing:border-box!important;white-space:nowrap!important}
.goodos-topbar [data-goodos-topbar-control] svg,.goodos-topbar__actions>button svg,.goodos-topbar__actions>a svg{width:var(--goodos-topbar-icon-size)!important;height:var(--goodos-topbar-icon-size)!important;stroke-width:2!important}.goodos-topbar [data-goodos-topbar-control="account"] img{width:32px!important;height:32px!important;border-radius:50%!important;object-fit:cover!important}
@media(max-width:1120px){:root{--goodos-topbar-gutter:16px}.goodos-topbar[data-goodos-topbar]{grid-template-columns:auto minmax(160px,280px) minmax(0,1fr) auto!important;gap:10px!important}.goodos-topbar__workspace{display:none}}
@media(max-width:820px){.goodos-topbar[data-goodos-topbar]{grid-template-columns:auto var(--goodos-topbar-control-size) minmax(0,1fr) auto!important}.goodos-topbar__search{width:var(--goodos-topbar-control-size);height:var(--goodos-topbar-control-size);overflow:hidden;border-radius:12px;justify-self:end}.goodos-topbar__search input{width:0!important;min-width:0!important;padding-right:0!important;opacity:0!important;pointer-events:none!important}.goodos-topbar__search:focus-within{position:absolute;z-index:4;right:calc(var(--goodos-topbar-gutter) + 190px);width:min(340px,calc(100vw - 210px));max-width:none;height:var(--goodos-topbar-control-size);overflow:visible;box-shadow:0 12px 36px rgba(15,23,42,.18)}.goodos-topbar__search:focus-within input{width:100%!important;padding-right:12px!important;opacity:1!important;pointer-events:auto!important}.goodos-topbar__actions{gap:4px}}
@media(max-width:600px){:root{--goodos-topbar-height:64px;--goodos-topbar-gutter:10px;--goodos-topbar-control-size:42px}.goodos-topbar[data-goodos-topbar]{grid-template-columns:auto var(--goodos-topbar-control-size) minmax(0,1fr) auto!important;gap:4px!important}.goodos-topbar__brand>span:last-child{display:none}.goodos-topbar__brand-mark{width:40px;height:40px}.goodos-topbar__controls{gap:2px}.goodos-topbar__actions{overflow-x:auto;scrollbar-width:none}.goodos-topbar__actions::-webkit-scrollbar{display:none}.goodos-topbar__search:focus-within{right:calc(var(--goodos-topbar-gutter) + 136px);width:calc(100vw - 158px)}}
.goodos-support-bar{max-width:calc(100vw - 28px);box-sizing:border-box}
.goodos-support-bar{position:fixed;z-index:2147482999;right:max(18px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));display:flex;align-items:center;gap:6px;padding:6px;border:1px solid color-mix(in srgb,var(--goodos-tone-3,#38bdf8) 42%,rgba(255,255,255,.32));border-radius:20px;background:linear-gradient(135deg,color-mix(in srgb,var(--goodos-tone-1,#07111f) 18%,var(--goodos-tone-2,#2563eb)),var(--goodos-tone-2,#2563eb) 52%,var(--goodos-tone-3,#38bdf8));box-shadow:0 14px 32px color-mix(in srgb,var(--goodos-tone-1,#07111f) 32%,transparent),inset 0 1px rgba(255,255,255,.28);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;touch-action:none;user-select:none;cursor:grab;transition:background 180ms ease,border-color 180ms ease,box-shadow 180ms ease}.goodos-support-bar:active{cursor:grabbing}.goodos-support-bar:focus-visible{outline:3px solid color-mix(in srgb,var(--goodos-tone-3,#38bdf8) 72%,white);outline-offset:3px}.goodos-support-bar--minimized{gap:0;padding:5px;border-radius:17px}.goodos-support-bar__minimize{position:absolute;z-index:2;top:-9px;right:-9px;display:grid;width:22px;height:22px;place-items:center;padding:0;border:1px solid color-mix(in srgb,var(--goodos-tone-3,#38bdf8) 45%,#64748b);border-radius:50%;background:color-mix(in srgb,var(--goodos-tone-1,#07111f) 92%,#020617);color:#fff;cursor:pointer;font:700 16px/1 sans-serif;box-shadow:0 4px 10px rgba(2,6,23,.24)}.goodos-support-bar__action{position:relative;display:grid;width:44px;height:44px;flex:0 0 44px;place-items:center;padding:0;border:1px solid color-mix(in srgb,var(--goodos-tone-3,#38bdf8) 34%,#64748b);border-radius:14px;background:color-mix(in srgb,var(--goodos-tone-1,#07111f) 88%,#020617);color:#fff;text-decoration:none;cursor:pointer;box-shadow:inset 0 1px rgba(255,255,255,.08),0 5px 12px rgba(2,6,23,.22);transition:transform 150ms ease,border-color 150ms ease,background 150ms ease}.goodos-support-bar__action:hover{transform:translateY(-2px);border-color:var(--goodos-tone-3,#38bdf8);background:color-mix(in srgb,var(--goodos-tone-1,#07111f) 78%,var(--goodos-tone-2,#2563eb))}.goodos-support-bar__action:focus-visible{outline:3px solid color-mix(in srgb,var(--goodos-tone-3,#38bdf8) 70%,white);outline-offset:3px}.goodos-support-bar__action svg{width:22px;height:22px}.goodos-support-bar__label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
body:has(.goodos-support-bar) [data-goodos-ada-trigger]:not([data-goodos-support-action]),body:has(.goodos-support-bar) [data-goodos-chat-launcher]:not([data-goodos-support-action]),body:has(.goodos-support-bar) [data-goodos-live-support]:not([data-goodos-support-action]),body:has(.goodos-support-bar) .ada-control,body:has(.goodos-support-bar) .ada-button,body:has(.goodos-support-bar) button[aria-label*="accessibility" i]:not([data-goodos-support-action]),body:has(.goodos-support-bar) button[aria-label*="ADA" i]:not([data-goodos-support-action]){position:fixed!important;width:1px!important;height:1px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;clip-path:inset(50%)!important;white-space:nowrap!important;opacity:0!important;pointer-events:none!important}
.goodos-accessibility{position:fixed;z-index:2147483002;right:max(18px,env(safe-area-inset-right));bottom:100px;width:min(340px,calc(100vw - 24px));padding:16px;border:1px solid color-mix(in srgb,var(--goodos-tone-2,#2563eb) 35%,#cbd5e1);border-radius:20px;background:color-mix(in srgb,Canvas 96%,var(--goodos-tone-3,#38bdf8));color:CanvasText;box-shadow:0 22px 60px rgba(2,6,23,.26);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.goodos-accessibility__header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.goodos-accessibility__header strong,.goodos-accessibility__header span{display:block}.goodos-accessibility__header strong{font-size:18px}.goodos-accessibility__header span{margin-top:3px;font-size:13px;opacity:.7}.goodos-accessibility__header button{width:36px;height:36px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:11px;background:transparent;color:inherit;font-size:24px;cursor:pointer}.goodos-accessibility fieldset{margin:0 0 10px;padding:0;border:0}.goodos-accessibility legend{margin-bottom:7px;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.goodos-accessibility__sizes{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.goodos-accessibility__sizes button,.goodos-accessibility__toggle,.goodos-accessibility__reset{min-height:42px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:12px;background:color-mix(in srgb,Canvas 92%,var(--goodos-tone-2,#2563eb));color:inherit;font:inherit;cursor:pointer}.goodos-accessibility__sizes button[aria-pressed="true"],.goodos-accessibility__toggle[aria-pressed="true"]{border-color:var(--goodos-tone-2,#2563eb);box-shadow:inset 0 0 0 1px var(--goodos-tone-2,#2563eb);background:color-mix(in srgb,var(--goodos-tone-2,#2563eb) 14%,Canvas)}.goodos-accessibility__toggle{display:flex;width:100%;align-items:center;justify-content:space-between;margin-top:7px;padding:0 12px;text-align:left}.goodos-accessibility__toggle span:last-child{font-size:12px;font-weight:800;color:var(--goodos-tone-2,#2563eb)}.goodos-accessibility__reset{width:100%;margin-top:12px;padding:0 12px;font-weight:750}.goodos-accessibility button:focus-visible{outline:3px solid color-mix(in srgb,var(--goodos-tone-3,#38bdf8) 72%,white);outline-offset:2px}
.goodos-accessibility{display:flex;width:min(420px,calc(100vw - 24px));max-height:min(760px,calc(100dvh - 124px));padding:0;overflow:hidden;flex-direction:column}.goodos-accessibility__header{padding:16px 16px 0}.goodos-accessibility__tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:0 16px 14px;padding:4px;border-radius:13px;background:color-mix(in srgb,CanvasText 7%,Canvas)}.goodos-accessibility__tabs button,.goodos-accessibility__choice{min-height:38px;border:1px solid transparent;border-radius:10px;background:transparent;color:inherit;font:700 12px/1 sans-serif;cursor:pointer}.goodos-accessibility__tabs button[aria-selected="true"],.goodos-accessibility__choice[aria-pressed="true"]{border-color:color-mix(in srgb,var(--goodos-tone-2,#2563eb) 48%,transparent);background:color-mix(in srgb,var(--goodos-tone-2,#2563eb) 17%,Canvas);color:var(--goodos-tone-2,#2563eb)}.goodos-accessibility__content{min-height:0;padding:0 16px 16px;overflow-y:auto;overscroll-behavior:contain}.goodos-accessibility__content fieldset+fieldset{margin-top:18px}.goodos-accessibility__choices{display:grid;grid-template-columns:repeat(2,1fr);gap:7px}.goodos-accessibility__choices--two{grid-template-columns:repeat(2,1fr)}.goodos-accessibility__choices .goodos-accessibility__toggle{grid-column:1/-1}.goodos-accessibility__toggle{gap:12px;min-height:54px;padding:8px 12px}.goodos-accessibility__toggle span:first-child{min-width:0}.goodos-accessibility__toggle strong,.goodos-accessibility__toggle small{display:block}.goodos-accessibility__toggle strong{font-size:14px}.goodos-accessibility__toggle small{margin-top:3px;font-size:11px;font-weight:500;line-height:1.3;opacity:.68}.goodos-accessibility__slider{display:block;margin-top:8px;padding:12px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:12px;background:color-mix(in srgb,Canvas 92%,var(--goodos-tone-2,#2563eb))}.goodos-accessibility__slider>span{display:flex;align-items:center;justify-content:space-between;gap:12px}.goodos-accessibility__slider strong{font-size:13px}.goodos-accessibility__slider output{font-size:12px;font-weight:800;color:var(--goodos-tone-2,#2563eb)}.goodos-accessibility__slider input{width:100%;margin-top:10px;accent-color:var(--goodos-tone-2,#2563eb)}.goodos-accessibility__footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent)}.goodos-accessibility__footer>span{font-size:11px;opacity:.65}.goodos-accessibility__footer .goodos-accessibility__reset{width:auto;min-width:86px;margin:0}.goodos-accessibility-effect{position:fixed;z-index:2147482997;pointer-events:none}.goodos-accessibility-effect--spotlight{inset:0;background:radial-gradient(circle var(--goodos-mask-radius) at var(--goodos-pointer-x) var(--goodos-pointer-y),transparent 0,transparent 68%,rgba(2,6,23,var(--goodos-mask-opacity)) 100%)}.goodos-accessibility-effect--reading-bar{right:0;left:0;height:48px;border-top:2px solid var(--goodos-tone-3,#38bdf8);border-bottom:2px solid var(--goodos-tone-3,#38bdf8);background:color-mix(in srgb,var(--goodos-tone-3,#38bdf8) 10%,transparent)}.goodos-accessibility-effect--magnifier{width:144px;height:144px;border:4px solid color-mix(in srgb,var(--goodos-tone-3,#38bdf8) 80%,white);border-radius:50%;background:rgba(255,255,255,.08);box-shadow:0 18px 48px rgba(2,6,23,.28);backdrop-filter:contrast(1.5) saturate(1.2)}
html[data-goodos-grayscale="true"] body>*:not(.goodos-support-bar):not(.goodos-accessibility):not(.goodos-accessibility-effect){filter:grayscale(1)}html[data-goodos-invert-colors="true"] body>*:not(.goodos-support-bar):not(.goodos-accessibility):not(.goodos-accessibility-effect){filter:invert(1) hue-rotate(180deg)}html[data-goodos-color-profile="protanopia"] body>*:not(.goodos-support-bar):not(.goodos-accessibility):not(.goodos-accessibility-effect){filter:saturate(.65) sepia(.12)}html[data-goodos-color-profile="deuteranopia"] body>*:not(.goodos-support-bar):not(.goodos-accessibility):not(.goodos-accessibility-effect){filter:saturate(.62) hue-rotate(-8deg)}html[data-goodos-color-profile="tritanopia"] body>*:not(.goodos-support-bar):not(.goodos-accessibility):not(.goodos-accessibility-effect){filter:saturate(.7) hue-rotate(18deg)}html body{line-height:var(--goodos-ada-line-height,normal);letter-spacing:var(--goodos-ada-letter-spacing,normal);word-spacing:var(--goodos-ada-word-spacing,normal)}html[data-goodos-focus-indicators="true"] :focus-visible{outline:3px solid var(--goodos-tone-3,#38bdf8)!important;outline-offset:3px!important}html[data-goodos-oversized-pointer="true"],html[data-goodos-oversized-pointer="true"] *{cursor:crosshair!important}
html[data-goodos-text-size="large"]{font-size:112.5%!important}html[data-goodos-text-size="larger"]{font-size:125%!important}html[data-goodos-readable-font="true"] body,html[data-goodos-readable-font="true"] button,html[data-goodos-readable-font="true"] input,html[data-goodos-readable-font="true"] select,html[data-goodos-readable-font="true"] textarea{font-family:Arial,Verdana,sans-serif!important;letter-spacing:.02em!important}html[data-goodos-underline-links="true"] a{text-decoration:underline!important;text-decoration-thickness:2px!important;text-underline-offset:3px!important}html[data-goodos-high-contrast="true"]{filter:contrast(1.2)}html[data-goodos-reduce-motion="true"] *,html[data-goodos-reduce-motion="true"] *::before,html[data-goodos-reduce-motion="true"] *::after{scroll-behavior:auto!important;animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
@media(max-width:600px){.goodos-support-bar{right:50%;bottom:max(10px,env(safe-area-inset-bottom));transform:translateX(50%);gap:5px;padding:5px;border-radius:18px}.goodos-support-bar__action{width:42px;height:42px;flex-basis:42px;border-radius:13px}.goodos-support-bar__action svg{width:21px;height:21px}}
@media(max-width:600px){.goodos-accessibility{right:50%;bottom:76px;transform:translateX(50%)}}
@media(max-width:360px){.goodos-support-bar__action{width:40px;height:40px;flex-basis:40px}.goodos-support-bar__action svg{width:20px;height:20px}}
@media(prefers-reduced-motion:reduce){.goodos-support-bar,.goodos-support-bar__action{transition:none}.goodos-support-bar__action:hover{transform:none}}
`;

const appearanceCss = String.raw`
.goodos-appearance{position:fixed;z-index:2147483003;width:min(380px,calc(100vw - 16px));max-height:calc(100dvh - var(--goodos-appearance-top,72px) - 8px);overflow:auto;padding:16px;border:1px solid color-mix(in srgb,var(--goodos-tone-2) 38%,#cbd5e1);border-radius:18px;background:radial-gradient(circle at 95% 0,color-mix(in srgb,var(--goodos-tone-3) 14%,transparent),transparent 34%),radial-gradient(circle at 0 100%,color-mix(in srgb,var(--goodos-tone-2) 10%,transparent),transparent 38%),rgba(248,250,252,.98);color:#0f172a;box-shadow:0 18px 48px color-mix(in srgb,var(--goodos-tone-1) 28%,rgba(2,6,23,.24));font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.dark .goodos-appearance{background:radial-gradient(circle at 95% 0,color-mix(in srgb,var(--goodos-tone-3) 14%,transparent),transparent 34%),radial-gradient(circle at 0 100%,color-mix(in srgb,var(--goodos-tone-2) 12%,transparent),transparent 38%),rgba(17,24,39,.98);color:#f8fafc}.goodos-appearance__head{display:flex;align-items:start;justify-content:space-between;gap:12px}.goodos-appearance__eyebrow{margin:0;background:linear-gradient(90deg,var(--goodos-tone-2),var(--goodos-tone-3));background-clip:text;color:transparent;font-size:9px;font-weight:850;letter-spacing:.2em;text-transform:uppercase}.goodos-appearance h2{margin:5px 0 0;font-size:17px;letter-spacing:-.025em}.goodos-appearance__copy{margin:5px 0 0;color:#64748b;font-size:11px;line-height:1.4}.goodos-appearance__close{display:grid;width:30px;height:30px;flex:0 0 30px;place-items:center;border:1px solid color-mix(in srgb,var(--goodos-tone-2) 28%,#cbd5e1);border-radius:9px;background:color-mix(in srgb,var(--goodos-tone-2) 6%,transparent);color:inherit;cursor:pointer;font-size:18px}.goodos-appearance__label{margin:14px 0 7px;color:#64748b;font-size:9px;font-weight:850;letter-spacing:.17em;text-transform:uppercase}.goodos-appearance__modes{display:grid;grid-template-columns:1fr 1fr;gap:8px}.goodos-appearance__choice{display:flex;min-height:58px;align-items:center;gap:9px;padding:9px;border:1px solid #dbe3ee;border-radius:13px;background:linear-gradient(135deg,#fff,color-mix(in srgb,var(--goodos-tone-3) 5%,#fff));color:#0f172a;cursor:pointer;text-align:left}.dark .goodos-appearance__choice{border-color:#334155;background:linear-gradient(135deg,#1e293b,color-mix(in srgb,var(--goodos-tone-1) 20%,#1e293b));color:#f8fafc}.goodos-appearance__choice[aria-pressed=true]{border-color:var(--goodos-tone-2);background:linear-gradient(135deg,color-mix(in srgb,var(--goodos-tone-2) 15%,#fff),color-mix(in srgb,var(--goodos-tone-3) 12%,#fff));box-shadow:0 0 0 2px color-mix(in srgb,var(--goodos-tone-2) 15%,transparent)}.dark .goodos-appearance__choice[aria-pressed=true]{background:linear-gradient(135deg,color-mix(in srgb,var(--goodos-tone-1) 62%,#111827),color-mix(in srgb,var(--goodos-tone-2) 22%,#1e293b))}.goodos-appearance__choice-icon{display:grid;width:34px;height:34px;flex:0 0 34px;place-items:center;border-radius:10px;background:linear-gradient(145deg,color-mix(in srgb,var(--goodos-tone-3) 18%,#fff),color-mix(in srgb,var(--goodos-tone-2) 9%,#f1f5f9));font-size:18px}.goodos-appearance__choice strong,.goodos-appearance__choice small{display:block}.goodos-appearance__choice strong{font-size:13px}.goodos-appearance__choice small{margin-top:2px;color:#64748b;font-size:10px}.goodos-appearance__schemes{display:grid;gap:6px}.goodos-appearance__scheme{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;min-height:52px;padding:8px 10px;border:1px solid #dbe3ee;border-radius:13px;background:linear-gradient(115deg,color-mix(in srgb,var(--scheme-1) 5%,#fff),color-mix(in srgb,var(--scheme-2) 8%,#fff),color-mix(in srgb,var(--scheme-3) 7%,#fff));color:#0f172a;cursor:pointer;text-align:left;transition:transform 160ms ease,box-shadow 160ms ease,border-color 160ms ease}.dark .goodos-appearance__scheme{border-color:#334155;background:linear-gradient(115deg,color-mix(in srgb,var(--scheme-1) 28%,#1e293b),color-mix(in srgb,var(--scheme-2) 10%,#1e293b),color-mix(in srgb,var(--scheme-3) 8%,#1e293b));color:#f8fafc}.goodos-appearance__scheme:hover{transform:translateX(-2px);border-color:var(--scheme-2);box-shadow:0 8px 22px color-mix(in srgb,var(--scheme-2) 14%,transparent)}.goodos-appearance__scheme[aria-pressed=true]{border-color:var(--scheme-2);background:linear-gradient(115deg,color-mix(in srgb,var(--scheme-1) 12%,#fff),color-mix(in srgb,var(--scheme-2) 16%,#fff),color-mix(in srgb,var(--scheme-3) 14%,#fff));box-shadow:0 0 0 2px color-mix(in srgb,var(--scheme-2) 16%,transparent),0 9px 24px color-mix(in srgb,var(--scheme-2) 14%,transparent)}.dark .goodos-appearance__scheme[aria-pressed=true]{background:linear-gradient(115deg,color-mix(in srgb,var(--scheme-1) 48%,#172033),color-mix(in srgb,var(--scheme-2) 22%,#1e293b),color-mix(in srgb,var(--scheme-3) 16%,#1e293b))}.goodos-appearance__swatches{display:flex}.goodos-appearance__swatches i{width:26px;height:26px;margin-left:-6px;border:2px solid #fff;border-radius:50%;box-shadow:0 3px 9px rgba(2,6,23,.16)}.goodos-appearance__swatches i:first-child{margin-left:0}.goodos-appearance__scheme strong,.goodos-appearance__scheme small{display:block}.goodos-appearance__scheme strong{font-size:12px}.goodos-appearance__scheme small{margin-top:2px;color:#64748b;font-size:9px}.goodos-appearance__check{display:grid;width:24px;height:24px;place-items:center;border:1px solid color-mix(in srgb,var(--scheme-2) 30%,#cbd5e1);border-radius:50%;font-size:11px;font-weight:900}.goodos-appearance__scheme[aria-pressed=true] .goodos-appearance__check{border-color:var(--scheme-2);background:linear-gradient(135deg,var(--scheme-2),var(--scheme-3));color:#fff;box-shadow:0 4px 12px color-mix(in srgb,var(--scheme-2) 28%,transparent)}
@media(max-width:480px){.goodos-appearance{right:8px!important;left:8px!important;width:auto;max-height:calc(100dvh - var(--goodos-appearance-top,64px) - 8px)}.goodos-appearance__copy,.goodos-appearance__scheme small{display:none}}
html[data-goodos-scheme] .goodos-command-deck{--professional-accent:var(--goodos-accent);--professional-accent-bright:var(--goodos-accent-strong);--professional-accent-dark:var(--goodos-accent-depth);--professional-accent-soft:var(--goodos-accent-soft);--professional-accent-medium:var(--goodos-accent-medium);--professional-focus:var(--goodos-accent-soft);--mail-grade-violet:var(--goodos-accent);--mail-grade-violet-bright:var(--goodos-accent-strong);--mail-grade-violet-soft:var(--goodos-accent-soft);--gos-violet:var(--goodos-accent);--gos-violet-bright:var(--goodos-accent-strong);--gos-blue:var(--goodos-accent-strong);accent-color:var(--goodos-accent)}
html.dark[data-goodos-scheme] .goodos-command-deck{background:radial-gradient(circle at 78% -12%,color-mix(in srgb,var(--goodos-accent) 22%,transparent),transparent 34%),radial-gradient(circle at 4% 92%,color-mix(in srgb,var(--goodos-accent-strong) 10%,transparent),transparent 32%),linear-gradient(145deg,color-mix(in srgb,var(--goodos-accent-depth) 42%,#05070b) 0%,#090c12 50%,color-mix(in srgb,var(--goodos-accent-depth) 30%,#05070b) 100%)!important}
html:not(.dark)[data-goodos-scheme] .goodos-command-deck{background:radial-gradient(circle at 76% -10%,color-mix(in srgb,var(--goodos-accent-strong) 18%,transparent),transparent 34%),radial-gradient(circle at 5% 95%,color-mix(in srgb,var(--goodos-accent) 10%,transparent),transparent 32%),linear-gradient(145deg,color-mix(in srgb,var(--goodos-accent) 5%,#fff),#f8fafc 54%,color-mix(in srgb,var(--goodos-accent-strong) 7%,#fff))!important}
html[data-goodos-scheme] .goodos-command-header[data-goodos-topbar]{border-color:color-mix(in srgb,var(--goodos-tone-2) 34%,transparent)!important;background:linear-gradient(105deg,color-mix(in srgb,var(--goodos-tone-1) 24%,rgba(7,9,12,.97)),rgba(7,9,12,.96) 48%,color-mix(in srgb,var(--goodos-tone-2) 13%,rgba(7,9,12,.97)))!important}
html:not(.dark)[data-goodos-scheme] .goodos-command-header[data-goodos-topbar]{background:linear-gradient(105deg,color-mix(in srgb,var(--goodos-tone-3) 8%,rgba(255,255,255,.98)),rgba(255,255,255,.98) 48%,color-mix(in srgb,var(--goodos-tone-2) 6%,rgba(255,255,255,.98)))!important}
html[data-goodos-scheme] body .goodos-command-header [data-goodos-topbar-brand-mark].goodos-logo-mark{border-color:color-mix(in srgb,var(--goodos-accent-strong) 52%,white)!important;background:linear-gradient(145deg,var(--goodos-accent-strong),var(--goodos-accent))!important;color:#fff!important;box-shadow:0 10px 28px color-mix(in srgb,var(--goodos-accent) 28%,transparent),inset 0 1px rgba(255,255,255,.42)!important}
html[data-goodos-scheme] .goodos-command-sidebar{border-color:color-mix(in srgb,var(--goodos-tone-2) 22%,transparent)!important;background:radial-gradient(circle at 0 0,color-mix(in srgb,var(--goodos-tone-2) 16%,transparent),transparent 34%),linear-gradient(165deg,color-mix(in srgb,var(--goodos-tone-1) 38%,#090c12),#090c12 55%,color-mix(in srgb,var(--goodos-tone-2) 12%,#090c12))!important}
html:not(.dark)[data-goodos-scheme] .goodos-command-sidebar{background:radial-gradient(circle at 0 0,color-mix(in srgb,var(--goodos-tone-3) 13%,transparent),transparent 34%),linear-gradient(165deg,color-mix(in srgb,var(--goodos-tone-2) 8%,#fff),#fff 55%,color-mix(in srgb,var(--goodos-tone-3) 6%,#f8fafc))!important}
html[data-goodos-scheme] .goodos-command-sidebar nav button[class*="bg-indigo"],html[data-goodos-scheme] .goodos-sidebar-launcher,html[data-goodos-scheme] .goodos-command-toolbar button[aria-pressed="true"],html[data-goodos-scheme] .goodos-command-toolbar button[class*="bg-indigo-600"]{border-color:color-mix(in srgb,var(--goodos-tone-2) 40%,transparent)!important;background:linear-gradient(105deg,color-mix(in srgb,var(--goodos-tone-2) 18%,transparent),color-mix(in srgb,var(--goodos-tone-3) 9%,transparent))!important;box-shadow:inset 3px 0 var(--goodos-tone-2),0 8px 22px color-mix(in srgb,var(--goodos-tone-2) 9%,transparent)!important}
html[data-goodos-scheme] .goodos-topbar__control[data-goodos-topbar-control="theme"]{color:var(--goodos-accent-strong)!important;box-shadow:0 0 0 2px var(--goodos-accent-medium)!important}
html[data-goodos-scheme] #goodos-pricing{border-color:color-mix(in srgb,var(--goodos-tone-2) 42%,transparent)!important;background:radial-gradient(circle at 92% 8%,color-mix(in srgb,var(--goodos-tone-3) 18%,transparent),transparent 30%),radial-gradient(circle at 4% 92%,color-mix(in srgb,var(--goodos-tone-1) 14%,transparent),transparent 34%),linear-gradient(135deg,color-mix(in srgb,var(--goodos-tone-2) 12%,transparent),color-mix(in srgb,var(--goodos-tone-3) 7%,transparent))!important;box-shadow:0 22px 64px color-mix(in srgb,var(--goodos-tone-2) 13%,transparent),inset 0 1px color-mix(in srgb,var(--goodos-tone-3) 22%,transparent)!important}
html[data-goodos-scheme] #goodos-pricing button[aria-pressed="true"]{border-color:var(--goodos-tone-2)!important;background:radial-gradient(circle at 90% 5%,color-mix(in srgb,var(--goodos-tone-3) 22%,transparent),transparent 36%),linear-gradient(145deg,color-mix(in srgb,var(--goodos-tone-2) 18%,transparent),color-mix(in srgb,var(--goodos-tone-1) 8%,transparent))!important;box-shadow:0 0 0 2px var(--goodos-accent-soft),0 14px 30px color-mix(in srgb,var(--goodos-tone-2) 13%,transparent)!important}
html[data-goodos-scheme] .goodos-command-deck [class*="text-indigo-"]{color:var(--goodos-accent-strong)!important}
html[data-goodos-scheme] .goodos-command-deck [class*="border-indigo-"]{border-color:var(--goodos-accent)!important}
html[data-goodos-scheme] .goodos-command-deck [class*="bg-indigo-600"]{background-color:var(--goodos-accent)!important}
html[data-goodos-scheme] .goodos-command-deck :focus-visible{outline-color:var(--goodos-accent)!important;box-shadow:0 0 0 3px var(--goodos-accent-soft)!important}
html[data-goodos-scheme] button[aria-label*="accessibility" i]{border-color:color-mix(in srgb,var(--goodos-accent) 42%,transparent)!important;background:linear-gradient(135deg,var(--goodos-accent-strong),var(--goodos-accent-depth))!important;box-shadow:0 12px 30px color-mix(in srgb,var(--goodos-accent) 24%,transparent)!important}
html[data-goodos-scheme] .goodos-appearance{border-color:color-mix(in srgb,var(--goodos-accent) 46%,#cbd5e1);box-shadow:0 18px 48px color-mix(in srgb,var(--goodos-accent-depth) 34%,rgba(2,6,23,.24))}
/* Refined product-grade appearance surface and application materials. */
.goodos-appearance{width:min(420px,calc(100vw - 20px));padding:20px;border-radius:24px;border-color:color-mix(in srgb,var(--goodos-tone-2) 24%,#dbe3ee);background:linear-gradient(160deg,rgba(255,255,255,.985),color-mix(in srgb,var(--goodos-tone-3) 4%,rgba(248,250,252,.985)) 55%,color-mix(in srgb,var(--goodos-tone-2) 7%,rgba(255,255,255,.985)));box-shadow:0 28px 80px rgba(15,23,42,.2),0 8px 24px color-mix(in srgb,var(--goodos-tone-2) 12%,transparent),inset 0 1px rgba(255,255,255,.92);backdrop-filter:blur(24px) saturate(1.2)}
.dark .goodos-appearance{border-color:color-mix(in srgb,var(--goodos-tone-2) 30%,#334155);background:linear-gradient(160deg,rgba(15,23,42,.985),color-mix(in srgb,var(--goodos-tone-1) 20%,rgba(17,24,39,.985)) 55%,color-mix(in srgb,var(--goodos-tone-2) 10%,rgba(15,23,42,.985)));box-shadow:0 28px 80px rgba(0,0,0,.48),0 8px 28px color-mix(in srgb,var(--goodos-tone-2) 18%,transparent),inset 0 1px rgba(255,255,255,.08)}
.goodos-appearance::before{content:"";position:absolute;inset:0 18px auto;height:3px;border-radius:0 0 999px 999px;background:linear-gradient(90deg,transparent,var(--goodos-tone-2),var(--goodos-tone-3),transparent);opacity:.9}.goodos-appearance__head{position:relative;padding:2px 48px 15px 2px;border-bottom:1px solid color-mix(in srgb,var(--goodos-tone-2) 13%,#e2e8f0)}.dark .goodos-appearance__head{border-color:color-mix(in srgb,var(--goodos-tone-2) 18%,#334155)}.goodos-appearance__eyebrow{font-size:10px;letter-spacing:.24em}.goodos-appearance h2{margin-top:7px;font-size:20px;line-height:1.15;letter-spacing:-.035em}.goodos-appearance__copy{max-width:300px;margin-top:7px;font-size:11.5px;line-height:1.55}.goodos-appearance__close{position:absolute;top:0;right:0;width:34px;height:34px;border-radius:11px;transition:transform 160ms ease,background 160ms ease}.goodos-appearance__close:hover{transform:rotate(6deg);background:color-mix(in srgb,var(--goodos-tone-2) 12%,transparent)}.goodos-appearance__label{margin:17px 0 9px;font-size:9px;letter-spacing:.22em}.goodos-appearance__modes{gap:10px}.goodos-appearance__choice{min-height:66px;padding:11px;border-radius:16px;box-shadow:0 5px 15px rgba(15,23,42,.045);transition:transform 160ms ease,box-shadow 160ms ease,border-color 160ms ease}.goodos-appearance__choice:hover{transform:translateY(-2px);box-shadow:0 10px 24px color-mix(in srgb,var(--goodos-tone-2) 12%,rgba(15,23,42,.08))}.goodos-appearance__choice[aria-pressed=true]{box-shadow:0 0 0 2px color-mix(in srgb,var(--goodos-tone-2) 13%,transparent),0 12px 26px color-mix(in srgb,var(--goodos-tone-2) 13%,transparent)}.goodos-appearance__choice-icon{width:38px;height:38px;flex-basis:38px;border:1px solid color-mix(in srgb,var(--goodos-tone-2) 13%,#e2e8f0);border-radius:12px;box-shadow:inset 0 1px rgba(255,255,255,.8)}.goodos-appearance__choice strong{font-size:14px}.goodos-appearance__choice small{font-size:10.5px}.goodos-appearance__schemes{gap:8px}.goodos-appearance__scheme{position:relative;min-height:62px;padding:10px 12px 10px 14px;border-radius:16px;overflow:hidden;box-shadow:0 4px 14px rgba(15,23,42,.035)}.goodos-appearance__scheme::before{content:"";position:absolute;inset:9px auto 9px 0;width:3px;border-radius:0 4px 4px 0;background:linear-gradient(180deg,var(--scheme-3),var(--scheme-2),var(--scheme-1));opacity:.28;transition:opacity 160ms ease,width 160ms ease}.goodos-appearance__scheme:hover{transform:translateY(-2px);box-shadow:0 12px 28px color-mix(in srgb,var(--scheme-2) 15%,rgba(15,23,42,.08))}.goodos-appearance__scheme[aria-pressed=true]::before{width:5px;opacity:1}.goodos-appearance__scheme[aria-pressed=true]{box-shadow:0 0 0 2px color-mix(in srgb,var(--scheme-2) 13%,transparent),0 14px 30px color-mix(in srgb,var(--scheme-2) 17%,transparent)}.goodos-appearance__swatches{padding-left:2px}.goodos-appearance__swatches i{width:30px;height:30px;margin-left:-8px;border-width:2.5px;box-shadow:0 4px 12px rgba(15,23,42,.18)}.goodos-appearance__scheme strong{font-size:13px;letter-spacing:-.01em}.goodos-appearance__scheme small{margin-top:3px;font-size:9.5px}.goodos-appearance__check{width:27px;height:27px;border-color:color-mix(in srgb,var(--scheme-2) 22%,#cbd5e1);background:rgba(255,255,255,.32);box-shadow:inset 0 1px rgba(255,255,255,.6)}
html:not(.dark)[data-goodos-scheme] .goodos-command-deck{background:radial-gradient(circle at 72% 0,color-mix(in srgb,var(--goodos-tone-3) 10%,transparent),transparent 28%),linear-gradient(145deg,#f8fafc 0%,#fff 48%,color-mix(in srgb,var(--goodos-tone-2) 4%,#f8fafc) 100%)!important}.dark html[data-goodos-scheme] .goodos-command-deck,html.dark[data-goodos-scheme] .goodos-command-deck{background:radial-gradient(circle at 74% 0,color-mix(in srgb,var(--goodos-tone-3) 18%,transparent),transparent 30%),linear-gradient(145deg,color-mix(in srgb,var(--goodos-tone-1) 32%,#05070b),#090c12 52%,color-mix(in srgb,var(--goodos-tone-2) 10%,#05070b))!important}
html[data-goodos-scheme] #goodos-pricing{position:relative;overflow:hidden;border-color:color-mix(in srgb,var(--goodos-tone-2) 28%,transparent)!important;background:linear-gradient(145deg,color-mix(in srgb,var(--goodos-tone-1) 7%,transparent),color-mix(in srgb,var(--goodos-tone-3) 5%,transparent))!important;box-shadow:0 24px 70px rgba(15,23,42,.08),0 8px 28px color-mix(in srgb,var(--goodos-tone-2) 9%,transparent),inset 0 1px rgba(255,255,255,.75)!important}
html[data-goodos-scheme] #goodos-pricing::before{content:"";position:absolute;inset:0 0 auto;height:5px;background:linear-gradient(90deg,var(--goodos-tone-1),var(--goodos-tone-2) 48%,var(--goodos-tone-3));opacity:.9}
html[data-goodos-scheme] #goodos-pricing button[aria-pressed="true"]{transform:translateY(-3px);border-color:color-mix(in srgb,var(--goodos-tone-2) 65%,transparent)!important;background:linear-gradient(150deg,color-mix(in srgb,var(--goodos-tone-3) 13%,rgba(255,255,255,.75)),color-mix(in srgb,var(--goodos-tone-2) 9%,rgba(255,255,255,.55)))!important;box-shadow:0 18px 40px color-mix(in srgb,var(--goodos-tone-2) 15%,rgba(15,23,42,.1)),inset 0 1px rgba(255,255,255,.9)!important}
html.dark[data-goodos-scheme] #goodos-pricing button[aria-pressed="true"]{background:linear-gradient(150deg,color-mix(in srgb,var(--goodos-tone-1) 38%,#172033),color-mix(in srgb,var(--goodos-tone-2) 14%,#111827))!important;box-shadow:0 18px 42px color-mix(in srgb,var(--goodos-tone-2) 18%,rgba(0,0,0,.28)),inset 0 1px rgba(255,255,255,.08)!important}
@media(prefers-reduced-motion:no-preference){html[data-goodos-scheme] #goodos-pricing,html[data-goodos-scheme] .goodos-command-sidebar{background-size:140% 140%,130% 130%,100% 100%;animation:goodos-theme-breathe 14s ease-in-out infinite alternate}@keyframes goodos-theme-breathe{from{background-position:0 0,100% 100%,0 0}to{background-position:12% 7%,88% 92%,0 0}}}
`;

function UniversalAppearanceMenu({ appName }) {
  const [open, setOpen] = useState(false);
  const [appearance, setAppearance] = useState(() => readGoodOSAppearance());
  const [position, setPosition] = useState({ top: 72, right: 16 });

  useEffect(() => {
    applyGoodOSAppearance(appearance, { persist: false });
  }, []);

  useEffect(() => {
    const openFromTopbar = (event) => {
      const trigger = event.target?.closest?.('[data-goodos-topbar-control="theme"]');
      if (!trigger) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = trigger.getBoundingClientRect();
      setPosition({
        top: Math.round(rect.bottom + 8),
        right: Math.max(8, Math.round(window.innerWidth - rect.right)),
      });
      setOpen(true);
    };
    document.addEventListener("click", openFromTopbar, true);
    return () => document.removeEventListener("click", openFromTopbar, true);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => event.key === "Escape" && setOpen(false);
    const onPointer = (event) => {
      if (!event.target?.closest?.(".goodos-appearance") && !event.target?.closest?.('[data-goodos-topbar-control="theme"]')) setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);

  const choose = (next) => {
    const applied = applyGoodOSAppearance({ ...appearance, ...next });
    setAppearance(applied);
  };

  if (!open) return createElement("style", { "data-goodos-appearance-styles": "" }, appearanceCss);
  return createElement(
    Fragment,
    null,
    createElement("style", { "data-goodos-appearance-styles": "" }, appearanceCss),
    createElement(
      "section",
      { className: "goodos-appearance", role: "dialog", "aria-modal": "false", "aria-labelledby": "goodos-appearance-title", style: { top: position.top, right: position.right, "--goodos-appearance-top": `${position.top}px` } },
      createElement("div", { className: "goodos-appearance__head" },
        createElement("div", null,
          createElement("p", { className: "goodos-appearance__eyebrow" }, "Appearance"),
          createElement("h2", { id: "goodos-appearance-title" }, `Choose how ${appName} looks`),
          createElement("p", { className: "goodos-appearance__copy" }, "Your display and color choices apply across the complete application on this device."),
        ),
        createElement("button", { type: "button", className: "goodos-appearance__close", onClick: () => setOpen(false), "aria-label": "Close appearance settings" }, "×"),
      ),
      createElement("p", { className: "goodos-appearance__label" }, "Display mode"),
      createElement("div", { className: "goodos-appearance__modes" },
        [["light", "☀", "Day", "Bright workspace"], ["dark", "☾", "Night", "Low-light workspace"]].map(([id, icon, name, description]) =>
          createElement("button", { key: id, type: "button", className: "goodos-appearance__choice", "aria-pressed": appearance.mode === id, onClick: () => choose({ mode: id }) },
            createElement("span", { className: "goodos-appearance__choice-icon", "aria-hidden": "true" }, icon),
            createElement("span", null, createElement("strong", null, name), createElement("small", null, description)),
          )),
      ),
      createElement("p", { className: "goodos-appearance__label" }, "Accent colors"),
      createElement("div", { className: "goodos-appearance__schemes" },
        GOODOS_COLOR_SCHEMES.map((scheme) => createElement("button", { key: scheme.id, type: "button", className: "goodos-appearance__scheme", style: { "--scheme-1": scheme.colors[0], "--scheme-2": scheme.colors[1], "--scheme-3": scheme.colors[2] }, "aria-pressed": appearance.scheme === scheme.id, onClick: () => choose({ scheme: scheme.id }) },
          createElement("span", { className: "goodos-appearance__swatches", "aria-hidden": "true" }, scheme.colors.map((color) => createElement("i", { key: color, style: { background: color } }))),
          createElement("span", null, createElement("strong", null, scheme.name), createElement("small", null, scheme.description)),
          createElement("span", { className: "goodos-appearance__check", "aria-hidden": "true" }, appearance.scheme === scheme.id ? "✓" : ""),
        )),
      ),
    ),
  );
}

const profileMenuCss = String.raw`
.goodos-universal-profile{position:fixed;z-index:2147483002;top:21px;right:20px;width:34px;height:34px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e5e7eb}
.goodos-universal-profile__trigger{display:grid!important;width:34px!important;min-width:34px!important;max-width:34px!important;height:34px!important;min-height:34px!important;max-height:34px!important;aspect-ratio:1/1!important;padding:0!important;overflow:hidden!important;place-items:center;border:1.5px solid rgba(255,255,255,.9)!important;border-radius:50%!important;background:linear-gradient(135deg,#6366f1,#06b6d4);color:#fff;cursor:pointer;font:inherit;font-size:12px;font-weight:850;line-height:1;box-shadow:0 4px 14px rgba(15,23,42,.28)}
.goodos-universal-profile__trigger img{display:block!important;width:100%!important;min-width:100%!important;max-width:100%!important;height:100%!important;min-height:100%!important;max-height:100%!important;aspect-ratio:1/1!important;border-radius:50%!important;object-fit:cover!important;object-position:center!important}
.goodos-universal-profile__menu{position:absolute;top:42px;right:0;width:250px;padding:10px;border:1px solid rgba(148,163,184,.24);border-radius:16px;background:rgba(15,23,42,.98);box-shadow:0 24px 64px rgba(0,0,0,.38);backdrop-filter:blur(18px)}
.goodos-universal-profile__identity{display:block;padding:10px 10px 12px;border-bottom:1px solid rgba(148,163,184,.16)}
.goodos-universal-profile__identity strong,.goodos-universal-profile__identity span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.goodos-universal-profile__identity strong{font-size:14px}.goodos-universal-profile__identity span{margin-top:3px;color:#94a3b8;font-size:11px}
.goodos-universal-profile__signout{display:flex;width:100%;min-height:42px;align-items:center;gap:9px;margin-top:8px;padding:0 11px;border:0;border-radius:10px;background:transparent;color:#fca5a5;cursor:pointer;font:inherit;font-size:13px;font-weight:800;text-align:left}.goodos-universal-profile__signout:hover{background:rgba(239,68,68,.12)}.goodos-universal-profile__signout:disabled{cursor:wait;opacity:.6}
@media(max-width:620px){.goodos-universal-profile{top:15px;right:14px}.goodos-universal-profile__menu{top:42px;width:min(250px,calc(100vw - 28px))}}
`;

function UniversalProfileMenu({ appName }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

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
  const rawAvatarUrl = profile?.avatarUrl || profile?.avatar_url || profile?.picture || profile?.photoURL || null;
  const avatarUrl = rawAvatarUrl && !/^(?:https?:|data:|blob:)/i.test(rawAvatarUrl)
    ? `${GOODOS_AUTH_ORIGIN}${rawAvatarUrl.startsWith("/") ? "" : "/"}${rawAvatarUrl}`
    : rawAvatarUrl;

  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarUrl]);

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
    { className: "goodos-universal-profile", "data-goodos-profile-menu": "", "data-goodos-topbar-account-layout": "profile" },
    createElement("style", null, profileMenuCss),
    createElement(
      "button",
      { type: "button", className: "goodos-universal-profile__trigger", onClick: () => setOpen((value) => !value), "aria-label": `Open ${displayName} profile menu`, "aria-expanded": open, "data-goodos-topbar-control": "account" },
      avatarUrl && !avatarFailed ? createElement("img", {
        src: avatarUrl,
        alt: "",
        decoding: "async",
        referrerPolicy: "no-referrer",
        onLoad: () => setAvatarLoaded(true),
        onError: () => setAvatarFailed(true),
      }) : initials,
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
.goodos-login-widget__input-shell{display:grid;grid-template-columns:20px minmax(0,1fr) auto auto;align-items:center;gap:8px;min-width:0;height:var(--goodos-login-control-height);min-height:var(--goodos-login-control-height);padding:0 15px;border:1px solid var(--goodos-login-border);border-radius:12px;background:var(--goodos-login-surface);color:#94a3b8;transition:border-color 160ms ease,box-shadow 160ms ease}
.goodos-login-widget__input-shell:focus-within{border-color:var(--goodos-login-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--goodos-login-accent) 18%,transparent)}
.goodos-login-widget .goodos-login-widget__input{appearance:none;width:100%!important;min-width:0!important;height:50px!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;outline:0!important;background:transparent!important;box-shadow:none!important;color:var(--goodos-login-text)!important;font:inherit;font-size:16px}
.goodos-login-widget__input::placeholder{color:#737986}
.goodos-login-widget__toggle{display:grid;width:34px;height:34px;place-items:center;border:0;border-radius:8px;background:transparent;color:#94a3b8;cursor:pointer;font:inherit;font-size:17px}
.goodos-login-widget__passkey-trigger{display:grid;width:34px;height:34px;place-items:center;border:1px solid color-mix(in srgb,var(--goodos-login-accent) 45%,var(--goodos-login-border));border-radius:8px;background:color-mix(in srgb,var(--goodos-login-surface) 90%,var(--goodos-login-accent));color:var(--goodos-login-accent);cursor:pointer;font:inherit;font-size:19px;font-weight:800;line-height:1}
.goodos-login-widget__passkey-trigger:hover{border-color:var(--goodos-login-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--goodos-login-accent) 12%,transparent)}
.goodos-login-widget__passkey-trigger:disabled{cursor:not-allowed;opacity:.52}
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

function FingerprintMark({ size = 20 }) {
  return createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      "data-goodos-passkey-icon": "fingerprint",
    },
    createElement("path", { d: "M12 10a2 2 0 0 0-2 2c0 1-.2 2.4-.8 3.5" }),
    createElement("path", { d: "M14 13.1c0 2.2-.5 4.2-1.5 5.9" }),
    createElement("path", { d: "M16.8 15.4c.2-1.1.2-2.3.2-3.4a5 5 0 0 0-10 0c0 .6-.1 1.2-.2 1.8" }),
    createElement("path", { d: "M19.4 17a12 12 0 0 0 .6-5 8 8 0 0 0-16 0c0 1.3-.2 2.6-.7 3.8" }),
    createElement("path", { d: "M5 20a13 13 0 0 0 2-5.8" }),
    createElement("path", { d: "M8.9 21a10 10 0 0 0 2.4-6.7" }),
    createElement("path", { d: "M16.1 20.1a14 14 0 0 0 1-2.7" }),
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
  passkeyEnrollmentLabel = "Create a passkey on this device",
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
  const [nativePasskeyLoading, setNativePasskeyLoading] = useState(false);
  const [nativePasskeyError, setNativePasskeyError] = useState("");
  const conditionalPasskeyStarted = useRef(false);
  const conditionalPasskeyController = useRef(null);
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

  useEffect(() => {
    if (
      !showPasskey ||
      conditionalPasskeyStarted.current ||
      typeof PublicKeyCredential === "undefined" ||
      typeof PublicKeyCredential.isConditionalMediationAvailable !== "function"
    ) return undefined;
    conditionalPasskeyStarted.current = true;
    const controller = new AbortController();
    conditionalPasskeyController.current = controller;
    void PublicKeyCredential.isConditionalMediationAvailable()
      .then((available) => available
        ? authenticateWithGoodOSPasskey({ conditional: true, signal: controller.signal })
        : null)
      .then((authenticated) => {
        if (authenticated) window.location.reload();
      })
      .catch((reason) => {
        if (reason?.name !== "AbortError" && reason?.name !== "NotAllowedError") {
          console.warn("Conditional GoodOS passkey sign-in could not start.", reason);
        }
      });
    return () => controller.abort();
  }, [showPasskey]);

  const beginPasskeySignIn = async () => {
    conditionalPasskeyController.current?.abort();
    if (onPasskeySignIn) {
      onPasskeySignIn();
      return;
    }
    setNativePasskeyLoading(true);
    setNativePasskeyError("");
    try {
      await authenticateWithGoodOSPasskey();
      window.location.reload();
    } catch (reason) {
      if (reason?.name !== "AbortError" && reason?.name !== "NotAllowedError") {
        setNativePasskeyError(reason instanceof Error ? reason.message : "Fingerprint sign-in failed.");
      }
    } finally {
      setNativePasskeyLoading(false);
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
                  autoComplete: showPasskey ? "username webauthn" : "username",
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
                  autoComplete: showPasskey ? "current-password webauthn" : "current-password",
                  enterKeyHint: "go",
                  value: password,
                  onChange: (event) => onPasswordChange?.(event.target.value, event),
                  placeholder: passwordPlaceholder,
                  required: true,
                  disabled: loading,
                }),
                showPasskey && createElement(
                  "button",
                  {
                    className: "goodos-login-widget__passkey-trigger",
                    type: "button",
                    disabled: loading || passkeyLoading || nativePasskeyLoading,
                    onClick: () => void beginPasskeySignIn(),
                    "aria-label": passkeyLoading || nativePasskeyLoading
                      ? "Waiting for your device passkey"
                      : "Sign in with a passkey",
                    title: passkeyLoading || nativePasskeyLoading
                      ? "Waiting for your device passkey"
                      : "Sign in with a passkey",
                  },
                  createElement(FingerprintMark, { size: 20 }),
                ),
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
                createElement("span", null, "Create a passkey after signing in"),
                createElement("small", null, "Use Face ID, Touch ID, Windows Hello, a fingerprint, or your device PIN."),
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
              createElement(FingerprintMark, { size: 20 }),
              passkeyEnrollmentLoading ? "Creating passkey…" : passkeyEnrollmentLabel,
            ),
            (error || nativePasskeyError) && createElement("div", { className: "goodos-login-widget__error", role: "alert" }, error || nativePasskeyError),
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
