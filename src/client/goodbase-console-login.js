import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { GoodOSLoginWidget } from "../../vendor/goodos-topbar-widget/index.js";

const providerTypes = ["google", "apple", "microsoft"];

function providerAliases(type) {
  if (type === "microsoft") return ["microsoft", "azure", "azure_ad", "entra", "entra_id"];
  return [type];
}

function findProvider(providers, type) {
  const aliases = providerAliases(type);
  return providers.find((provider) => aliases.includes(String(provider.provider_type || "").toLowerCase()));
}

function installGoodBaseStory() {
  const brand = document.querySelector("[data-goodbase-login-brand], .login-story");
  if (!brand) return;

  brand.classList.add("goodbase-story-host");

  if (!document.getElementById("goodbase-login-story-css")) {
    const link = document.createElement("link");
    link.id = "goodbase-login-story-css";
    link.rel = "stylesheet";
    link.href = "/goodbase-login-story.css";
    document.head.appendChild(link);
  }

  brand.innerHTML = `
    <section class="goodbase-story" aria-label="GoodBase platform overview">
      <div class="goodbase-story__grid" aria-hidden="true"></div>
      <header class="goodbase-story__brand">
        <span class="goodbase-story__brand-mark">GB</span>
        <div><strong>GoodBase</strong><small>GoodOS infrastructure</small></div>
        <span class="goodbase-story__goodos">Core platform</span>
      </header>

      <div class="goodbase-story__body">
        <div class="goodbase-story__copy">
          <div class="goodbase-story__eyebrow">Platform control plane</div>
          <h1>One secure foundation. <span>Every GoodOS application connected.</span></h1>
          <p>Identity, application access, APIs, data services, and production operations all meet in GoodBase.</p>
          <div class="goodbase-story__proof-list">
            <span><i></i> Shared GoodOS authentication</span>
            <span><i></i> Application authorization and sessions</span>
            <span><i></i> Production data and service control</span>
          </div>
        </div>

        <div class="goodbase-network" aria-hidden="true">
          <div class="goodbase-network__halo"></div>
          <svg class="goodbase-network__lines" viewBox="0 0 420 420" preserveAspectRatio="none">
            <path class="goodbase-network__line goodbase-network__line--one" d="M210 210 C145 150, 105 120, 64 92" />
            <path class="goodbase-network__line goodbase-network__line--two" d="M210 210 C278 150, 320 118, 357 91" />
            <path class="goodbase-network__line goodbase-network__line--three" d="M210 210 C147 270, 105 306, 68 347" />
            <path class="goodbase-network__line goodbase-network__line--four" d="M210 210 C278 270, 319 306, 353 347" />
            <path class="goodbase-network__line goodbase-network__line--five" d="M210 210 C210 145, 210 88, 210 28" />
            <path class="goodbase-network__line goodbase-network__line--six" d="M210 210 C210 276, 210 332, 210 392" />
          </svg>

          <div class="goodbase-network__core">
            <div class="goodbase-network__core-ring"></div>
            <span class="goodbase-network__core-mark">GB</span>
            <strong>GoodBase</strong>
            <small>Auth · Data · APIs</small>
            <div class="goodbase-network__status"><i></i> Systems online</div>
          </div>

          <div class="goodbase-network__node goodbase-network__node--qr"><b>QR</b><div><strong>GoodQR</strong><small>Authorized</small></div></div>
          <div class="goodbase-network__node goodbase-network__node--scan"><b>3D</b><div><strong>GoodScan</strong><small>Authorized</small></div></div>
          <div class="goodbase-network__node goodbase-network__node--voice"><b>VO</b><div><strong>GoodVoice</strong><small>Authorized</small></div></div>
          <div class="goodbase-network__node goodbase-network__node--trust"><b>TR</b><div><strong>GoodTrusts</strong><small>Authorized</small></div></div>
          <div class="goodbase-network__node goodbase-network__node--boost"><b>BO</b><div><strong>GoodBoost</strong><small>Realtime connected</small></div></div>
          <div class="goodbase-network__node goodbase-network__node--fleet"><b>FL</b><div><strong>GoodFleet</strong><small>API connected</small></div></div>

          <span class="goodbase-network__pulse goodbase-network__pulse--one"></span>
          <span class="goodbase-network__pulse goodbase-network__pulse--two"></span>
          <span class="goodbase-network__pulse goodbase-network__pulse--three"></span>
        </div>
      </div>

      <footer class="goodbase-story__footer">
        <div><strong>Identity</strong><small>Shared sign-in</small></div>
        <div><strong>Authorization</strong><small>App access</small></div>
        <div><strong>Infrastructure</strong><small>Production core</small></div>
      </footer>
    </section>
  `;
}

async function api(path, options = {}) {
  const requestOptions = {
    ...options,
    cache: "no-store",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {}),
    },
  };

  let response;
  try {
    response = await fetch(path, requestOptions);
  } catch (networkError) {
    if (path !== "/api/auth/login") throw networkError;
    response = await fetch(new URL(path, window.location.origin), requestOptions);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.message || body.error || "GoodBase request failed.");
  }
  return body.data || body;
}

function accountUrl(mode) {
  const url = new URL("/auth/ui", window.location.origin);
  if (mode !== "login") url.searchParams.set("mode", mode);
  url.searchParams.set("redirect", `${window.location.origin}/`);
  return url.toString();
}

function GoodBaseConsoleLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    installGoodBaseStory();
  }, []);

  useEffect(() => {
    let active = true;
    api("/api/goodbase/v1/growth/auth/providers")
      .then((result) => {
        if (active) setProviders(Array.isArray(result.providers) ? result.providers : []);
      })
      .catch(() => {
        if (active) setProviders([]);
      });
    return () => { active = false; };
  }, []);

  const providerAvailability = useMemo(
    () => Object.fromEntries(providerTypes.map((type) => [type, findProvider(providers, type)?.available === true])),
    [providers],
  );

  const startProvider = (type) => {
    const provider = findProvider(providers, type);
    if (!provider || provider.available !== true) {
      setError(`${type.charAt(0).toUpperCase() + type.slice(1)} sign-in is not enabled in GoodBase yet.`);
      return;
    }
    const returnTo = encodeURIComponent(`${window.location.origin}/`);
    window.location.assign(`/api/oidc/start/${encodeURIComponent(provider.id)}?returnTo=${returnTo}`);
  };

  const submit = async () => {
    setError("");
    setLoading(true);
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      window.location.assign("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to sign in through GoodBase.");
      setLoading(false);
    }
  };

  return React.createElement(GoodOSLoginWidget, {
    appName: "GoodBase",
    subtitle: "Access your applications, infrastructure, users, and production workspace.",
    accent: "#38bdf8",
    accentInk: "#071e3d",
    email,
    password,
    onEmailChange: setEmail,
    onPasswordChange: setPassword,
    onSubmit: submit,
    onProviderSignIn: startProvider,
    onGoodOSSignIn: () => window.location.assign(accountUrl("login")),
    providerAvailability,
    onForgotPassword: () => window.location.assign(accountUrl("forgot")),
    onCreateAccount: () => window.location.assign(accountUrl("register")),
    loading,
    error,
    initialMode: "light",
    mobileBrand: React.createElement(
      "div",
      { className: "goodbase-mobile" },
      React.createElement("span", null, "GB"),
      React.createElement("b", null, "GoodBase", React.createElement("small", null, "Auth · data · APIs")),
    ),
  });
}

const mount = document.getElementById("goodbaseLoginWidget");
if (mount) createRoot(mount).render(React.createElement(GoodBaseConsoleLogin));
