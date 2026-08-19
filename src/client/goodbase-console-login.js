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
    securityDescription: "Use the same GoodOS identity across GoodBase and every approved GoodOS application.",
  });
}

const mount = document.getElementById("goodbaseLoginWidget");
if (mount) createRoot(mount).render(React.createElement(GoodBaseConsoleLogin));
