(function initializeBackendAda() {
  "use strict";

  var WIDGET_VERSION = "4.0.0";
  var STORAGE_KEY = "goodos-accessibility-settings-v1";
  var DEFAULT_SETTINGS = {
    textScale: 100,
    highContrast: false,
    grayscale: false,
    reduceAnimations: false,
    highlightLinks: false,
    focusIndicators: true,
  };
  var ICONS = {
    accessibility: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="4" r="2"></circle><path d="M5 8h14M12 6v14M8 21l4-7 4 7M8 12l-3 5M16 12l3 5"></path></svg>',
    contrast: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 3v18a9 9 0 0 0 0-18z"></path></svg>',
    eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>',
    motion: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h10M2 12h13M6 16h8"></path><path d="m17 8 4 4-4 4"></path></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"></path><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"></path></svg>',
    focus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"></path><circle cx="12" cy="12" r="3"></circle></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>',
    reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><path d="M3 3v5h5"></path></svg>',
  };

  function readSettings() {
    try {
      var parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
      var textScale = [100, 112, 125].indexOf(parsed.textScale) >= 0 ? parsed.textScale : 100;
      return {
        textScale: textScale,
        highContrast: parsed.highContrast === true,
        grayscale: parsed.grayscale === true,
        reduceAnimations: parsed.reduceAnimations === true,
        highlightLinks: parsed.highlightLinks === true,
        focusIndicators: parsed.focusIndicators !== false,
      };
    } catch (_) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  var settings = readSettings();
  var root;
  var trigger;
  var panel;
  var widgetOptions;

  function firstDefined() {
    for (var index = 0; index < arguments.length; index += 1) {
      if (arguments[index] !== undefined && arguments[index] !== null && arguments[index] !== "") {
        return arguments[index];
      }
    }
    return undefined;
  }

  function widgetScript() {
    var scripts = document.querySelectorAll("script[src]");
    for (var index = scripts.length - 1; index >= 0; index -= 1) {
      if (/backend-ada\.js(?:[?#]|$)/.test(scripts[index].getAttribute("src") || "")) return scripts[index];
    }
    return null;
  }

  function normalizePlacement(value) {
    var placement = String(value || "bottom-right").toLowerCase();
    return ["bottom-right", "bottom-left", "top-right", "top-left"].indexOf(placement) >= 0
      ? placement
      : "bottom-right";
  }

  function readWidgetOptions(overrides) {
    var script = widgetScript();
    var scriptData = script ? script.dataset : {};
    var htmlData = document.documentElement.dataset;
    var bodyData = document.body ? document.body.dataset : {};
    var supplied = overrides || {};
    return {
      placement: normalizePlacement(firstDefined(
        supplied.placement,
        scriptData.goodosAdaPlacement,
        htmlData.goodosAdaPlacement,
        bodyData.goodosAdaPlacement,
      )),
      triggerRight: firstDefined(supplied.triggerRight, scriptData.goodosAdaTriggerRight),
      triggerBottom: firstDefined(supplied.triggerBottom, scriptData.goodosAdaTriggerBottom),
      panelRight: firstDefined(supplied.panelRight, scriptData.goodosAdaPanelRight),
      panelBottom: firstDefined(supplied.panelBottom, scriptData.goodosAdaPanelBottom),
      disabled: firstDefined(supplied.disabled, scriptData.goodosAdaDisabled, htmlData.goodosAdaDisabled, bodyData.goodosAdaDisabled) === true ||
        firstDefined(supplied.disabled, scriptData.goodosAdaDisabled, htmlData.goodosAdaDisabled, bodyData.goodosAdaDisabled) === "true",
    };
  }

  function applyWidgetOptions(options) {
    if (!root) return;
    root.dataset.goodosAdaPlacement = options.placement;
    [
      ["--backend-ada-trigger-right", options.triggerRight],
      ["--backend-ada-trigger-bottom", options.triggerBottom],
      ["--backend-ada-panel-right", options.panelRight],
      ["--backend-ada-panel-bottom", options.panelBottom],
    ].forEach(function (entry) {
      if (entry[1] === undefined) root.style.removeProperty(entry[0]);
      else root.style.setProperty(entry[0], entry[1]);
    });
  }

  function productName() {
    return (
      document.documentElement.getAttribute("data-goodos-app-name") ||
      document.body.getAttribute("data-goodos-app-name") ||
      "this application"
    );
  }

  function changedCount() {
    return Object.keys(DEFAULT_SETTINGS).filter(function (key) {
      return settings[key] !== DEFAULT_SETTINGS[key];
    }).length;
  }

  function applySettings(persist) {
    var html = document.documentElement;
    html.style.fontSize = settings.textScale + "%";
    html.classList.toggle("ada-high-contrast", settings.highContrast);
    html.classList.toggle("ada-grayscale", settings.grayscale);
    html.classList.toggle("ada-reduce-motion", settings.reduceAnimations);
    html.classList.toggle("ada-highlight-links", settings.highlightLinks);
    html.classList.toggle("ada-focus-indicators", settings.focusIndicators);
    if (persist !== false) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch (_) {}
    }
    renderState();
  }

  function settingRow(key, title, description, icon) {
    return '<button type="button" class="backend-ada-setting" data-ada-setting="' + key + '" aria-pressed="false">' +
      '<span class="backend-ada-setting-icon">' + icon + '</span>' +
      '<span class="backend-ada-setting-copy"><span class="backend-ada-setting-title">' + title + '</span>' +
      '<span class="backend-ada-setting-description">' + description + '</span></span>' +
      '<span class="backend-ada-switch" aria-hidden="true"><span></span></span></button>';
  }

  function build() {
    root = document.createElement("div");
    root.className = "backend-ada-root";
    root.setAttribute("data-goodos-ada-widget", "");
    root.setAttribute("data-goodos-ada-widget-version", WIDGET_VERSION);
    root.innerHTML =
      '<button type="button" class="backend-ada-trigger" title="Accessibility options" aria-label="Open accessibility options" aria-haspopup="dialog" aria-controls="backend-ada-panel" aria-expanded="false">' +
        ICONS.accessibility + '<span class="backend-ada-trigger-label">ADA</span><span class="backend-ada-active-count" hidden></span>' +
      '</button>' +
      '<section id="backend-ada-panel" class="backend-ada-panel" role="dialog" aria-modal="false" aria-labelledby="backend-ada-title" aria-describedby="backend-ada-description" hidden>' +
        '<header class="backend-ada-panel-header"><div class="backend-ada-panel-heading"><span class="backend-ada-heading-icon">' + ICONS.accessibility + '</span><span>' +
          '<span id="backend-ada-title" class="backend-ada-title">Accessibility</span><span id="backend-ada-description" class="backend-ada-subtitle"></span>' +
        '</span></div><button type="button" class="backend-ada-close" aria-label="Close accessibility options">' + ICONS.close + '</button></header>' +
        '<div class="backend-ada-panel-content"><section class="backend-ada-section"><div class="backend-ada-section-heading"><span>Text size</span><strong data-ada-scale-label>100%</strong></div>' +
          '<div class="backend-ada-text-sizes" role="group" aria-label="Text size"><button type="button" data-ada-scale="100">Default</button><button type="button" data-ada-scale="112">Large</button><button type="button" data-ada-scale="125">Larger</button></div></section>' +
          '<div class="backend-ada-settings">' +
            settingRow("highContrast", "High contrast", "Increase separation between text and surfaces", ICONS.contrast) +
            settingRow("grayscale", "Grayscale", "Remove decorative colors from the console", ICONS.eye) +
            settingRow("reduceAnimations", "Reduce motion", "Limit animations and movement effects", ICONS.motion) +
            settingRow("highlightLinks", "Highlight links", "Underline and outline interactive links", ICONS.link) +
            settingRow("focusIndicators", "Focus indicators", "Show stronger outlines during keyboard navigation", ICONS.focus) +
          '</div></div>' +
        '<footer class="backend-ada-panel-footer"><span>Changes are saved on this device.</span><button type="button" class="backend-ada-reset">' + ICONS.reset + 'Reset</button></footer>' +
      '</section>';
    document.body.appendChild(root);
    trigger = root.querySelector(".backend-ada-trigger");
    panel = root.querySelector(".backend-ada-panel");
    root.querySelector(".backend-ada-subtitle").textContent =
      "Adjust " + productName() + " to your needs";
  }

  function renderState() {
    if (!root) return;
    root.querySelector("[data-ada-scale-label]").textContent = settings.textScale + "%";
    root.querySelectorAll("[data-ada-scale]").forEach(function (button) {
      var active = Number(button.getAttribute("data-ada-scale")) === settings.textScale;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    root.querySelectorAll("[data-ada-setting]").forEach(function (button) {
      var active = Boolean(settings[button.getAttribute("data-ada-setting")]);
      button.classList.toggle("is-active", active);
      button.querySelector(".backend-ada-switch").classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    var count = changedCount();
    var badge = root.querySelector(".backend-ada-active-count");
    badge.hidden = count === 0;
    badge.textContent = count ? String(count) : "";
    badge.setAttribute("aria-label", count + " accessibility settings changed");
  }

  function setOpen(open, returnFocus) {
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    trigger.setAttribute("aria-label", open ? "Close accessibility options" : "Open accessibility options");
    if (open) {
      window.setTimeout(function () { root.querySelector(".backend-ada-close").focus(); }, 0);
    } else if (returnFocus) {
      trigger.focus();
    }
  }

  function wire() {
    trigger.addEventListener("click", function () { setOpen(panel.hidden, false); });
    root.querySelector(".backend-ada-close").addEventListener("click", function () { setOpen(false, true); });
    root.querySelector(".backend-ada-reset").addEventListener("click", function () {
      settings = Object.assign({}, DEFAULT_SETTINGS);
      applySettings(true);
    });
    root.querySelectorAll("[data-ada-scale]").forEach(function (button) {
      button.addEventListener("click", function () {
        settings.textScale = Number(button.getAttribute("data-ada-scale"));
        applySettings(true);
      });
    });
    root.querySelectorAll("[data-ada-setting]").forEach(function (button) {
      button.addEventListener("click", function () {
        var key = button.getAttribute("data-ada-setting");
        settings[key] = !settings[key];
        applySettings(true);
      });
    });
    document.addEventListener("mousedown", function (event) {
      if (!panel.hidden && !root.contains(event.target)) setOpen(false, false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !panel.hidden) setOpen(false, true);
    });
    window.addEventListener("storage", function (event) {
      if (event.key === STORAGE_KEY) {
        settings = readSettings();
        applySettings(false);
      }
    });
    window.addEventListener("goodos:accessibility:open", function () {
      setOpen(true, false);
    });
    window.addEventListener("goodos:accessibility:close", function () {
      setOpen(false, false);
    });
    window.addEventListener("goodos:accessibility:toggle", function () {
      setOpen(panel.hidden, false);
    });
  }

  function mount(overrides) {
    widgetOptions = readWidgetOptions(overrides);
    if (widgetOptions.disabled) return null;
    if (root || document.querySelector(".backend-ada-root")) {
      root = root || document.querySelector(".backend-ada-root");
      applyWidgetOptions(widgetOptions);
      return root;
    }
    build();
    applyWidgetOptions(widgetOptions);
    wire();
    applySettings(false);
    window.dispatchEvent(
      new CustomEvent("goodos:accessibility:ready", {
        detail: { version: WIDGET_VERSION, productName: productName(), placement: widgetOptions.placement },
      }),
    );
    return root;
  }

  function unmount() {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    trigger = null;
    panel = null;
  }

  function configure(overrides) {
    widgetOptions = readWidgetOptions(Object.assign({}, widgetOptions || {}, overrides || {}));
    if (widgetOptions.disabled) {
      unmount();
      return null;
    }
    return root ? (applyWidgetOptions(widgetOptions), root) : mount(widgetOptions);
  }

  window.GoodOSAdaWidget = Object.freeze({
    mount: mount,
    unmount: unmount,
    configure: configure,
    open: function () { window.dispatchEvent(new Event("goodos:accessibility:open")); },
    close: function () { window.dispatchEvent(new Event("goodos:accessibility:close")); },
    toggle: function () { window.dispatchEvent(new Event("goodos:accessibility:toggle")); },
    version: WIDGET_VERSION,
  });

  function start() {
    mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
