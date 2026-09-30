"use strict";

const nodes = {
  form: document.querySelector("#auth-form"),
  loginOnly: document.querySelector("#login-only"),
  providers: document.querySelector("#providers"),
  goodos: document.querySelector("#goodos-sso"),
  emailField: document.querySelector("#email-field"),
  passwordField: document.querySelector("#password-field"),
  confirmField: document.querySelector("#confirm-field"),
  email: document.querySelector("#email"),
  password: document.querySelector("#password"),
  passkey: document.querySelector("#passkey"),
  passwordToggle: document.querySelector("#password-toggle"),
  confirmPassword: document.querySelector("#confirm-password"),
  confirmPasswordToggle: document.querySelector("#confirm-password-toggle"),
  nameFields: document.querySelector("#name-fields"),
  firstName: document.querySelector("#first-name"),
  lastName: document.querySelector("#last-name"),
  forgot: document.querySelector("#forgot"),
  submit: document.querySelector("#submit"),
  back: document.querySelector("#back"),
  create: document.querySelector("#create"),
  createLink: document.querySelector("#create-link"),
  kicker: document.querySelector("#kicker"),
  title: document.querySelector("#title"),
  subtitle: document.querySelector("#subtitle"),
  error: document.querySelector("#error"),
  notice: document.querySelector("#notice"),
  passwordLabel: document.querySelector("#password-label")
};

function setPasswordVisibility(input, button, visible, label = "password") {
  input.type = visible ? "text" : "password";
  button.textContent = visible ? "Hide" : "Show";
  button.setAttribute("aria-label", `${visible ? "Hide" : "Show"} ${label}`);
  button.setAttribute("aria-pressed", String(visible));
}

nodes.passwordToggle.addEventListener("click", () => {
  setPasswordVisibility(
    nodes.password,
    nodes.passwordToggle,
    nodes.password.type === "password"
  );
});

nodes.confirmPasswordToggle.addEventListener("click", () => {
  setPasswordVisibility(
    nodes.confirmPassword,
    nodes.confirmPasswordToggle,
    nodes.confirmPassword.type === "password",
    "confirmation password"
  );
});

const query = new URLSearchParams(location.search);
const resetToken = query.get("reset_token") || "";
const redirectTarget = query.get("redirect") || query.get("returnTo") || "/console";
let passkeyAbortController = null;
let mode = resetToken
  ? "reset"
  : location.pathname === "/register"
    ? "register"
    : query.get("mode") === "forgot"
      ? "forgot"
      : "login";

function safeRedirect(value) {
  try {
    const url = new URL(value, location.origin);
    const goodOSHost = url.hostname === "goodos.app" || url.hostname.endsWith(".goodos.app");
    return (url.origin === location.origin || (url.protocol === "https:" && goodOSHost)) ? url.href : "/console";
  } catch {
    return "/console";
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", "Accept": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(body.message || body.error || "GoodBase request failed.");
  return body.data || body;
}

function setMessage(kind, message) {
  nodes.error.classList.toggle("hidden", kind !== "error" || !message);
  nodes.notice.classList.toggle("hidden", kind !== "notice" || !message);
  nodes.error.textContent = kind === "error" ? message : "";
  nodes.notice.textContent = kind === "notice" ? message : "";
}

function setBusy(busy) {
  for (const button of document.querySelectorAll("button")) button.disabled = busy || button.dataset.unavailable === "true";
}

function passkeysSupported() {
  return window.isSecureContext === true &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.get === "function";
}

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  const decoded = atob(padded);
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
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
    allowCredentials: (options.allowCredentials || []).map(credential => ({
      ...credential,
      id: decodeBase64Url(credential.id)
    }))
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
        : undefined
    }
  };
}

async function authenticateWithPasskey({ conditional = false } = {}) {
  if (!passkeysSupported()) throw new Error("This browser cannot use a fingerprint or passkey.");

  if (passkeyAbortController) passkeyAbortController.abort();
  const controller = new AbortController();
  passkeyAbortController = controller;

  try {
    const ceremony = await api("/api/auth/passkeys/authentication/options", {
      method: "POST",
      body: "{}"
    });
    const request = {
      publicKey: authenticationOptionsJSON(ceremony.options),
      signal: controller.signal
    };
    if (conditional) request.mediation = "conditional";
    const credential = await navigator.credentials.get(request);
    if (!credential) throw new Error("No passkey was selected.");
    await api("/api/auth/passkeys/authentication/verify", {
      method: "POST",
      body: JSON.stringify({
        challengeId: ceremony.challengeId,
        response: authenticationCredentialJSON(credential)
      })
    });
    location.assign(safeRedirect(redirectTarget));
  } finally {
    if (passkeyAbortController === controller) passkeyAbortController = null;
  }
}

function ignoredPasskeyError(error) {
  return error?.name === "AbortError" || error?.name === "NotAllowedError";
}

async function startConditionalPasskey() {
  if (
    mode !== "login" ||
    !passkeysSupported() ||
    typeof PublicKeyCredential.isConditionalMediationAvailable !== "function" ||
    !(await PublicKeyCredential.isConditionalMediationAvailable())
  ) return;

  try {
    await authenticateWithPasskey({ conditional: true });
  } catch (error) {
    if (!ignoredPasskeyError(error)) console.warn("Conditional passkey sign-in could not start.", error);
  }
}

function renderMode() {
  const login = mode === "login";
  const forgot = mode === "forgot";
  nodes.loginOnly.classList.toggle("hidden", !login);
  nodes.passwordField.classList.toggle("hidden", forgot);
  nodes.confirmField.classList.toggle("hidden", mode !== "reset");
  nodes.emailField.classList.toggle("hidden", mode === "reset");
  nodes.back.classList.toggle("hidden", login);
  nodes.create.classList.toggle("hidden", !login);
  nodes.nameFields.classList.toggle("hidden", mode !== "register");
  nodes.forgot.classList.toggle("hidden", !login);
  nodes.confirmPassword.required = mode === "reset";
  nodes.firstName.required = mode === "register";
  nodes.lastName.required = mode === "register";
  nodes.password.required = !forgot;
  nodes.email.required = mode !== "reset";
  nodes.email.autocomplete = login ? "username webauthn" : "email";
  nodes.password.autocomplete = mode === "reset" ? "new-password" : login ? "current-password webauthn" : "new-password";
  nodes.passkey.classList.toggle("hidden", !login || !passkeysSupported());
  nodes.passwordLabel.textContent = mode === "reset" ? "New password" : "Password";
  nodes.kicker.textContent = login ? "Welcome back" : mode === "register" ? "Join GoodOS" : "Account recovery";
  nodes.title.textContent = forgot ? "Reset your password" : mode === "reset" ? "Choose a new password" : mode === "register" ? "Create your GoodOS account" : "Sign in to GoodBase";
  nodes.subtitle.textContent = forgot
    ? "Enter your GoodOS account email and we will send secure reset instructions."
    : mode === "reset"
      ? "Create a strong new password for your GoodOS account."
      : mode === "register"
        ? "Create one secure identity for every GoodOS application assigned to you."
        : "Access your GoodOS applications with one secure identity.";
  nodes.submit.textContent = forgot ? "Send reset instructions" : mode === "reset" ? "Reset password" : mode === "register" ? "Create account →" : "Sign in securely →";
}

function providerMark(type) {
  if (type === "microsoft") {
    return '<span class="goodbase-login-provider-mark goodbase-login-provider-mark--microsoft" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
  }
  if (type === "google") return '<span class="goodbase-login-provider-mark goodbase-login-provider-mark--google" aria-hidden="true">G</span>';
  if (type === "apple") return '<span class="goodbase-login-provider-mark" aria-hidden="true">●</span>';
  return '<span class="goodbase-login-provider-mark" aria-hidden="true">◇</span>';
}

async function loadProviders() {
  const required = ["google", "apple", "microsoft"];
  let providers = [];
  try {
    const result = await api("/api/goodbase/v1/growth/auth/providers", { method: "GET" });
    providers = Array.isArray(result.providers) ? result.providers : [];
  } catch {
    providers = [];
  }
  for (const type of required) {
    const provider = providers.find(item => item.provider_type === type);
    const label = type[0].toUpperCase() + type.slice(1);
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-goodbase-login-provider", "");
    button.innerHTML = `${providerMark(type)}<span>Sign in with ${label}</span>`;
    button.disabled = !provider?.available;
    button.dataset.unavailable = String(!provider?.available);
    button.title = provider?.available ? `Sign in with ${label}` : `${label} sign-in is not currently enabled in GoodBase`;
    if (provider?.available) {
      button.addEventListener("click", () => {
        const returnTo = safeRedirect(redirectTarget);
        location.assign(`/api/oidc/start/${encodeURIComponent(provider.id)}?returnTo=${encodeURIComponent(returnTo)}`);
      });
    }
    nodes.providers.insertBefore(button, nodes.goodos);
  }
}

nodes.goodos.addEventListener("click", () => {
  const returnTo = safeRedirect(redirectTarget);
  location.assign(`https://goodos.app/?returnTo=${encodeURIComponent(returnTo)}`);
});

nodes.passkey.addEventListener("click", async () => {
  setMessage("", "");
  setBusy(true);
  try {
    await authenticateWithPasskey();
  } catch (error) {
    if (!ignoredPasskeyError(error)) {
      setMessage("error", error instanceof Error ? error.message : "Fingerprint sign-in failed.");
    }
  } finally {
    setBusy(false);
  }
});

nodes.forgot.addEventListener("click", () => {
  mode = "forgot";
  setMessage("", "");
  renderMode();
});

nodes.back.addEventListener("click", () => {
  mode = "login";
  setMessage("", "");
  renderMode();
});

nodes.createLink.href = `/register?returnTo=${encodeURIComponent(safeRedirect(redirectTarget))}`;

nodes.form.addEventListener("submit", async event => {
  event.preventDefault();
  setMessage("", "");
  setBusy(true);
  try {
    if (mode === "forgot") {
      const result = await api("/api/auth/password-reset/request", {
        method: "POST",
        body: JSON.stringify({ email: nodes.email.value, returnTo: `${location.origin}/auth/ui` })
      });
      setMessage("notice", result.message || "If an active account exists, reset instructions have been sent.");
      return;
    }
    if (mode === "reset") {
      if (nodes.password.value !== nodes.confirmPassword.value) throw new Error("The passwords do not match.");
      if (nodes.password.value.length < 12) throw new Error("Use at least 12 characters with uppercase, lowercase, a number, and a symbol.");
      await api("/api/auth/password-reset/complete", {
        method: "POST",
        body: JSON.stringify({ token: resetToken, password: nodes.password.value })
      });
      mode = "login";
      history.replaceState({}, "", "/auth/ui");
      nodes.password.value = "";
      nodes.confirmPassword.value = "";
      renderMode();
      setMessage("notice", "Password reset complete. Sign in with your new password.");
      return;
    }
    if (mode === "register") {
      if (nodes.password.value.length < 12) throw new Error("Use at least 12 characters with uppercase, lowercase, a number, and a symbol.");
      const result = await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          firstName: nodes.firstName.value,
          lastName: nodes.lastName.value,
          email: nodes.email.value,
          password: nodes.password.value,
          confirmPassword: nodes.password.value
        })
      });
      setMessage("notice", result.message || "Account created. Check your email to verify your account before signing in.");
      return;
    }
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: nodes.email.value, password: nodes.password.value })
    });
    location.assign(safeRedirect(redirectTarget));
  } catch (error) {
    setMessage("error", error instanceof Error ? error.message : "Unable to sign in through GoodBase.");
  } finally {
    setBusy(false);
  }
});

renderMode();
loadProviders();
void startConditionalPasskey();
