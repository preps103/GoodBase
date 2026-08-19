import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { GoodOSLoginWidget } from "../../vendor/goodos-topbar-widget/index.js";

const providerTypes = ["google", "apple", "microsoft"];

const goodBaseExperience = {
  appName: "GoodBase",
  subtitle: "Access your applications, infrastructure, users, and production workspace.",
  brandMark: "G",
  brandName: "GoodBase",
  kicker: "✦ Infrastructure, unified",
  headline: "Build and operate every GoodOS application with confidence.",
  story: "GoodBase brings authentication, data, storage, functions, and production operations into one secure platform.",
  benefits: [
    "Identity, users, and application access in one place",
    "Real-time visibility across production services",
    "Secure infrastructure built for the entire GoodOS ecosystem",
  ],
  cards: [
    ["◈", "Secure", "Identity + access"],
    ["⌁", "Real-time", "Platform insight"],
    ["✦", "One platform", "Complete operations"],
  ],
  securityDescription: "Use the same GoodOS identity across GoodBase and every approved GoodOS application.",
};

const gPanelExperience = {
  appName: "GPanel",
  subtitle: "Access your applications, deployments, domains, settings, and operations workspace.",
  brandMark: "P",
  brandName: "GPanel",
  kicker: "✦ Operations, unified",
  headline: "Control every GoodOS application from one secure panel.",
  story: "GPanel brings apps, domains, deployments, access, and operational health into one clear workspace.",
  benefits: [
    "Manage applications, domains, and deployments in one place",
    "Monitor status and activity across every connected service",
    "Control access with the shared GoodOS identity",
  ],
  cards: [
    ["▦", "Control", "Apps + domains"],
    ["⌁", "Visible", "Live operations"],
    ["✦", "Connected", "GoodOS ecosystem"],
  ],
  securityDescription: "Use the same GoodOS identity across GPanel and every approved GoodOS application.",
};

function currentExperience() {
  return ["gpanel.goodos.app", "panel.goodos.app"].includes(window.location.hostname)
    ? gPanelExperience
    : goodBaseExperience;
}

function applyStory(experience) {
  const story = document.querySelector(".login-story");
  if (!story) return;

  story.setAttribute("aria-label", `${experience.appName} platform`);
  const auth = document.querySelector(".login-auth");
  if (auth) auth.setAttribute("aria-label", `${experience.appName} sign in`);

  const mark = story.querySelector(".login-story-brand .logo");
  const name = story.querySelector(".login-story-brand span");
  const kicker = story.querySelector(".login-kicker");
  const headline = story.querySelector(".login-story-copy h1");
  const description = story.querySelector(".login-story-copy > p");
  if (mark) mark.textContent = experience.brandMark;
  if (name) name.textContent = experience.brandName;
  if (kicker) kicker.textContent = experience.kicker;
  if (headline) headline.textContent = experience.headline;
  if (description) description.textContent = experience.story;

  story.querySelectorAll(".login-benefit").forEach((item, index) => {
    const icon = item.querySelector("span");
    item.textContent = experience.benefits[index] || "";
    if (icon) item.prepend(icon);
  });

  story.querySelectorAll(".login-story-card").forEach((card, index) => {
    const [icon, title, detail] = experience.cards[index] || ["", "", ""];
    card.replaceChildren(
      document.createTextNode(icon),
      Object.assign(document.createElement("strong"), { textContent: title }),
      Object.assign(document.createElement("small"), { textContent: detail }),
    );
  });
}

function providerAliases(type) {
  if (type === "microsoft") return ["microsoft", "azure", "azure_ad", "entra", "entra_id"];
  return [type];
}

function findProvider(providers, type) {
  const aliases = providerAliases(type);
  return providers.find((provider) => aliases.includes(String(provider.provider_type || "").toLowerCase()));
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

function GoodBaseConsoleLogin() {
  const experience = currentExperience();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
      setError(`${type.charAt(0).toUpperCase() + type.slice(1)} sign-in is not enabled in ${experience.appName} yet.`);
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
      setError(reason instanceof Error ? reason.message : `Unable to sign in through ${experience.appName}.`);
      setLoading(false);
    }
  };

  return React.createElement(GoodOSLoginWidget, {
    appName: experience.appName,
    subtitle: experience.subtitle,
    accent: "#38bdf8",
    accentInk: "#071e3d",
    email,
    password,
    onEmailChange: setEmail,
    onPasswordChange: setPassword,
    onSubmit: submit,
    onProviderSignIn: startProvider,
    onGoodOSSignIn: () => {
      const returnTo = encodeURIComponent(`${window.location.origin}/`);
      window.location.assign(`https://goodos.app/?returnTo=${returnTo}`);
    },
    providerAvailability,
    onForgotPassword: () => window.location.assign("/auth/ui?mode=forgot"),
    onCreateAccount: () => window.location.assign("/register?returnTo=%2F"),
    loading,
    error,
    initialMode: "dark",
    emailPlaceholder: "you@company.com",
    securityTitle: "Authentication and account security are managed through GoodBase.",
    securityDescription: experience.securityDescription,
  });
}

const mount = document.getElementById("goodbaseLoginWidget");
if (mount) {
  applyStory(currentExperience());
  createRoot(mount).render(React.createElement(GoodBaseConsoleLogin));
}
