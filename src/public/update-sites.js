"use strict";

const state = {
  sites: [],
  repositories: [],
  targets: [],
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function normalizeRepository(value) {
  return String(value || "")
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/goodos/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function isTemporaryGoodBaseRecoverySite(site) {
  return Boolean(
    !site?.appId &&
    site.name === "GoodBase Recovery" &&
    site.domain === "base.goodos.app" &&
    site.branch === "main" &&
    site.appPath === "/var/www/GoodBase" &&
    site.processManager === "pm2" &&
    site.processName === "goodbase-api-ha" &&
    normalizeRepository(site.repositoryUrl) === "preps103/goodbase"
  );
}

function authToken() {
  const keys = [
    "goodos_token",
    "goodos_access_token",
    "access_token",
    "auth_token",
    "token",
  ];

  for (const storage of [localStorage, sessionStorage]) {
    for (const key of keys) {
      const value = storage.getItem(key);
      if (value) return value;
    }
  }

  return null;
}

async function api(url, options = {}) {
  const token = authToken();
  const response = await fetch(url, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "Your GoodOS backend session is unavailable. Open Back to Console, sign in, then return to Update Sites."
      );
    }

    throw new Error(
      payload.message || `Request failed with HTTP ${response.status}`
    );
  }

  return payload;
}

function toast(message, isError = false) {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(node.timer);
  node.timer = setTimeout(() => {
    node.className = "toast";
  }, 5000);
}

function showAlert(message) {
  $("pageAlert").textContent = message;
  $("pageAlert").className = "alert show";
}

function clearAlert() {
  $("pageAlert").textContent = "";
  $("pageAlert").className = "alert";
}

function siteById(id) {
  return state.sites.find((site) => site.id === id) || null;
}

function targetByName(name) {
  return state.targets.find((target) => target.processName === name) || null;
}

function selectedSite() {
  return siteById($("siteSelector").value);
}

function selectedTarget() {
  return targetByName($("targetSelector").value);
}

function selectedRepository() {
  return $("repositorySelector").value === "__manual__"
    ? $("manualRepositoryInput").value.trim()
    : $("repositorySelector").value.trim();
}

function badge(status) {
  const value = String(status || "setup_required");
  const good = ["ready", "success", "no_change", "online"].includes(value);
  const bad = ["failed", "rolled_back", "errored"].includes(value);
  return `<span class="badge ${good ? "good" : bad ? "bad" : "warn"}">${escapeHtml(value.replaceAll("_", " "))}</span>`;
}

function uniqueRepositories() {
  const map = new Map();

  const add = (url, name, source) => {
    const key = normalizeRepository(url);
    if (!key || map.has(key)) return;
    map.set(key, {
      url,
      name: name || key,
      source,
    });
  };

  for (const repository of state.repositories) {
    add(
      repository.repositoryUrl || repository.sshUrl || repository.url,
      repository.nameWithOwner,
      "github"
    );
  }

  for (const target of state.targets) {
    add(target.repositoryUrl, normalizeRepository(target.repositoryUrl), "server");
  }

  for (const site of state.sites) {
    add(site.repositoryUrl, normalizeRepository(site.repositoryUrl), "configured");
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function fillSiteOptions() {
  const current = $("siteSelector").value;
  $("siteSelector").innerHTML = [
    '<option value="">Select a site or application</option>',
    ...state.sites.map(
      (site) =>
        `<option value="${escapeHtml(site.id)}">${escapeHtml(site.name)} — ${escapeHtml(site.domain || "No subdomain")}</option>`
    ),
  ].join("");

  if (state.sites.some((site) => site.id === current)) {
    $("siteSelector").value = current;
  }
}

function fillRepositoryOptions() {
  const current = $("repositorySelector").value;
  $("repositorySelector").innerHTML = [
    '<option value="">Select a GitHub repository</option>',
    ...uniqueRepositories().map(
      (repository) =>
        `<option value="${escapeHtml(repository.url)}">${escapeHtml(repository.name)}</option>`
    ),
    '<option value="__manual__">Enter repository manually…</option>',
  ].join("");

  if ([...$("repositorySelector").options].some((option) => option.value === current)) {
    $("repositorySelector").value = current;
  }
}

function fillTargetOptions() {
  const current = $("targetSelector").value;
  $("targetSelector").innerHTML = [
    '<option value="">Select a server application target</option>',
    ...state.targets.map(
      (target) =>
        `<option value="${escapeHtml(target.processName)}">${escapeHtml(target.processName)} — deploy ${escapeHtml(target.deploymentPath || target.appPath || "Unknown path")}${target.runtimePath && target.runtimePath !== (target.deploymentPath || target.appPath) ? ` — runs from ${escapeHtml(target.runtimePath)}` : ""}${target.repositoryUrl ? ` — ${escapeHtml(normalizeRepository(target.repositoryUrl))}` : ""}</option>`
    ),
  ].join("");

  if (state.targets.some((target) => target.processName === current)) {
    $("targetSelector").value = current;
  }
}

function matchTarget(site) {
  if (!site) return null;

  if (site.processName) {
    const exact = state.targets.find((target) => target.processName === site.processName);
    if (exact) return exact;
  }

  if (site.appPath) {
    const exact = state.targets.find((target) => target.appPath === site.appPath);
    if (exact) return exact;
  }

  const siteName = normalizeName(site.name);
  const domainName = normalizeName(String(site.domain || "").split(".")[0]);

  return (
    state.targets.find((target) => {
      const processName = normalizeName(target.processName);
      return (
        processName === siteName ||
        processName === domainName ||
        processName.includes(siteName) ||
        siteName.includes(processName)
      );
    }) || null
  );
}

function matchTargetByRepository(repositoryUrl) {
  const normalized = normalizeRepository(repositoryUrl);
  return (
    state.targets.find(
      (target) => normalizeRepository(target.repositoryUrl) === normalized
    ) || null
  );
}

function renderSites() {
  $("siteCount").textContent = state.sites.length;
  $("readyCount").textContent = state.sites.filter((site) => site.configuration?.ready).length;
  $("runningCount").textContent = state.sites.filter((site) => ["queued", "deploying"].includes(site.status)).length;
  $("failedCount").textContent = state.sites.filter(
    (site) =>
      site.configuration?.ready === false ||
      site.status === "failed" ||
      site.lastRunStatus === "rolled_back"
  ).length;

  $("sitesBody").innerHTML =
    state.sites
      .map((site) => {
        const configured = Boolean(
          site.repositoryUrl &&
            site.appPath &&
            (site.processManager === "none" || site.processName)
        );
        const running = ["queued", "deploying"].includes(site.status);
        const ready = site.configuration?.ready === true;
        const displayedStatus = running
          ? site.status
          : site.status === "failed"
            ? site.status
            : ready
              ? "ready"
              : "needs_attention";
        const configurationDetail = ready
          ? `${site.configuration.deploymentMode === "staged-release" ? "Staged release" : "Managed checkout"} · path and process aligned`
          : (site.configuration?.issues || []).join(" ");

        return `
          <tr>
            <td>
              <strong>${escapeHtml(site.name)}</strong>
              <div class="muted">${escapeHtml(site.domain || "No subdomain")}</div>
              <div class="mono">${escapeHtml(site.appPath || "Target not selected")}</div>
              <div class="muted">${escapeHtml(configurationDetail)}</div>
            </td>
            <td>
              <div class="mono">${escapeHtml(site.repositoryUrl || "Repository not selected")}</div>
              <div class="muted">Branch: ${escapeHtml(site.branch || "main")}</div>
            </td>
            <td>
              ${escapeHtml(site.processManager || "pm2")}
              <div class="muted">${escapeHtml(site.processName || "Process not selected")}</div>
            </td>
            <td>${badge(displayedStatus)}</td>
            <td>
              <div class="actions">
                <button class="btn js-select" type="button" data-site-id="${escapeHtml(site.id)}">Select</button>
                <button class="btn js-configure" type="button" data-site-id="${escapeHtml(site.id)}">Configure</button>
                <button class="btn js-test" type="button" data-site-id="${escapeHtml(site.id)}" ${configured ? "" : "disabled"}>Test</button>
                <button class="btn primary js-update" type="button" data-site-id="${escapeHtml(site.id)}" ${configured && ready && !running ? "" : "disabled"}>Update Site</button>
                ${site.lastRunId ? `<button class="btn js-logs" type="button" data-run-id="${escapeHtml(site.lastRunId)}">Logs</button>` : ""}
                ${running && site.lastRunId ? `<button class="btn js-recover-run" type="button" data-run-id="${escapeHtml(site.lastRunId)}">Recover Stale Run</button>` : ""}
                ${site.appId === "goodbase" ? `<button class="btn js-restart-goodbase" type="button" data-site-id="${escapeHtml(site.id)}">Restart Services</button>` : ""}
                ${isTemporaryGoodBaseRecoverySite(site) ? `<button class="btn js-remove-mapping" type="button" data-site-id="${escapeHtml(site.id)}">Remove Mapping</button>` : ""}
              </div>
            </td>
          </tr>
        `;
      })
      .join("") ||
    '<tr><td colspan="5" class="empty">No registered sites were returned.</td></tr>';
}

function selectSite(siteId) {
  const site = siteById(siteId);
  if (!site) return;

  $("siteSelector").value = site.id;
  $("branchInput").value = site.branch || "main";

  const target = matchTarget(site) || matchTargetByRepository(site.repositoryUrl);
  $("targetSelector").value = target?.processName || "";

  if (site.repositoryUrl) {
    const match = uniqueRepositories().find(
      (repository) =>
        normalizeRepository(repository.url) === normalizeRepository(site.repositoryUrl)
    );

    if (match) {
      $("repositorySelector").value = match.url;
    } else {
      $("repositorySelector").value = "__manual__";
      $("manualRepositoryInput").value = site.repositoryUrl;
    }
  } else if (target?.repositoryUrl) {
    $("repositorySelector").value = target.repositoryUrl;
  } else {
    $("repositorySelector").value = "";
  }

  $("manualRepositoryWrap").classList.toggle(
    "show",
    $("repositorySelector").value === "__manual__"
  );

  updateSummary();
}

function updateSummary() {
  const site = selectedSite();
  const target = selectedTarget();

  $("summarySite").textContent = site?.name || "None";
  $("summaryDomain").textContent = site?.domain || "None";
  $("summaryPath").textContent =
    target?.deploymentPath || target?.appPath || site?.appPath || "None";
  $("summaryProcess").textContent = target?.processName || site?.processName || "None";

  const valid = Boolean(
    site &&
      selectedRepository() &&
      (target ||
        (site.appPath &&
          (site.processManager === "none" || site.processName)))
  );

  $("saveMappingButton").disabled = !valid;
  $("testMappingButton").disabled = !valid;
  $("updateSelectedButton").disabled = !valid;
}

function mappingPayload() {
  const site = selectedSite();
  const target = selectedTarget();
  const repositoryUrl = selectedRepository();

  if (!site) throw new Error("Select the site or application.");
  if (!repositoryUrl) throw new Error("Select the GitHub repository.");

  const appPath = target?.deploymentPath || target?.appPath || site.appPath;
  const processManager = target?.processManager || site.processManager || "pm2";
  const processName =
    processManager === "none" ? "" : target?.processName || site.processName;

  if (!appPath) throw new Error("Select the server application target.");
  if (processManager !== "none" && !processName) {
    throw new Error("The selected target is missing its process name.");
  }

  return {
    name: site.name,
    domain: site.domain || "",
    repositoryUrl,
    branch: $("branchInput").value.trim() || "main",
    appPath,
    processManager,
    processName,
    healthUrl: site.healthUrl || (site.domain ? `https://${site.domain}` : ""),
    autoRollback: site.autoRollback !== false,
    installDependencies: site.installDependencies !== false,
    runBuild: site.runBuild !== false,
  };
}

async function saveMapping(silent = false) {
  const site = selectedSite();
  const body = mappingPayload();

  await api(`/api/update-sites/sites/${encodeURIComponent(site.id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

  await loadSites(site.id);

  if (!silent) toast("Site, repository, and server target mapping saved.");
}

async function testSelected() {
  try {
    const site = selectedSite();
    await saveMapping(true);
    const payload = await api(
      `/api/update-sites/sites/${encodeURIComponent(site.id)}/test`,
      { method: "POST", body: "{}" }
    );

    $("deploymentLog").textContent = (payload.checks || [])
      .map((check) => `${check.passed ? "PASS" : "FAIL"}: ${check.name} — ${check.detail}`)
      .join("\n");

    toast("Mapping test passed.");
  } catch (error) {
    $("deploymentLog").textContent = error.message;
    toast(error.message, true);
  }
}

async function queueUpdate(siteId) {
  const payload = await api(
    `/api/update-sites/sites/${encodeURIComponent(siteId)}/update`,
    { method: "POST", body: "{}" }
  );

  toast("Site update queued.");
  await loadSites(siteId);
  await viewRun(payload.runId);
}

async function recoverStaleRun(runId) {
  try {
    await api(`/api/update-sites/runs/${encodeURIComponent(runId)}/recover-stale`, {
      method: "POST",
      body: "{}",
    });
    toast("Stale deployment run recovered.");
    await loadWorkspace();
  } catch (error) {
    toast(error.message, true);
  }
}

async function restartGoodBase(siteId) {
  try {
    await api(
      `/api/update-sites/sites/${encodeURIComponent(siteId)}/restart-goodbase-services`,
      { method: "POST", body: "{}" }
    );
    toast("GoodBase service restart scheduled.");
  } catch (error) {
    toast(error.message, true);
  }
}

async function removeTemporaryMapping(siteId) {
  try {
    await api(`/api/update-sites/sites/${encodeURIComponent(siteId)}`, {
      method: "DELETE",
    });
    toast("Temporary deployment mapping removed.");
    await loadWorkspace();
  } catch (error) {
    toast(error.message, true);
  }
}

async function updateSelected() {
  try {
    const site = selectedSite();
    if (!site) throw new Error("Select a site or application.");

    const repository = normalizeRepository(selectedRepository());

    if (
      !confirm(
        `Update ${site.name} (${site.domain || "no subdomain"}) using ${repository}?`
      )
    ) {
      return;
    }

    await saveMapping(true);
    await queueUpdate(site.id);
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadSites(preserveSiteId = "") {
  const payload = await api("/api/update-sites/sites");
  state.sites = payload.sites || [];
  fillSiteOptions();
  renderSites();

  if (preserveSiteId) selectSite(preserveSiteId);
}

async function loadRepositories() {
  const payload = await api("/api/update-sites/repositories");
  state.repositories = payload.repositories || [];
  fillRepositoryOptions();
}

async function loadTargets() {
  const payload = await api("/api/update-sites/discover");
  state.targets = payload.processes || [];
  fillTargetOptions();
}

async function loadWorkspace() {
  clearAlert();
  $("workspaceStatus").textContent = "Loading…";
  $("workspaceStatus").className = "badge warn";

  const results = await Promise.allSettled([
    loadSites(),
    loadRepositories(),
    loadTargets(),
  ]);

  if (results[0].status === "rejected") {
    showAlert(results[0].reason.message);
    $("sitesBody").innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(results[0].reason.message)}</td></tr>`;
    $("workspaceStatus").textContent = "Authentication required";
    $("workspaceStatus").className = "badge bad";
    return;
  }

  const warnings = [];

  if (results[1].status === "rejected") {
    warnings.push(`Repositories: ${results[1].reason.message}`);
    state.repositories = [];
    fillRepositoryOptions();
  }

  if (results[2].status === "rejected") {
    warnings.push(`Server targets: ${results[2].reason.message}`);
    state.targets = [];
    fillTargetOptions();
  }

  if (warnings.length) {
    showAlert(`${warnings.join(" | ")}. Sites are still available and repositories can be entered manually.`);
    $("workspaceStatus").textContent = "Partially loaded";
    $("workspaceStatus").className = "badge warn";
  } else {
    $("workspaceStatus").textContent =
      `${state.sites.length} sites · ${uniqueRepositories().length} repositories · ${state.targets.length} server targets`;
    $("workspaceStatus").className = "badge good";
  }

  fillRepositoryOptions();
  fillTargetOptions();
  updateSummary();
}

async function viewRun(runId) {
  if (state.pollTimer) clearTimeout(state.pollTimer);

  const poll = async () => {
    try {
      const payload = await api(`/api/update-sites/runs/${encodeURIComponent(runId)}`);
      const run = payload.run || {};

      $("activeRunBadge").textContent =
        `${run.status || "unknown"} · ${String(runId).slice(-10)}`;

      $("deploymentLog").innerHTML =
        (payload.events || [])
          .map(
            (event) =>
              `<div class="log-line ${escapeHtml(event.level)}"><span class="muted">${escapeHtml(new Date(event.createdAt).toLocaleTimeString())}</span> [${escapeHtml(event.step)}] ${escapeHtml(event.message)}</div>`
          )
          .join("") || "Waiting for deployment worker…";

      $("deploymentLog").scrollTop = $("deploymentLog").scrollHeight;

      if (["queued", "running"].includes(run.status)) {
        state.pollTimer = setTimeout(poll, 2000);
      } else {
        await loadSites($("siteSelector").value);
      }
    } catch (error) {
      $("deploymentLog").textContent = error.message;
    }
  };

  await poll();
}

function openDialog(site = {}) {
  $("dialogTitle").textContent = site.id ? `Configure ${site.name}` : "Add Site";
  $("siteId").value = site.id || "";
  $("siteName").value = site.name || "";
  $("siteDomain").value = site.domain || "";
  $("siteRepository").value = site.repositoryUrl || "";
  $("siteBranch").value = site.branch || "main";
  $("sitePath").value = site.appPath || "";
  $("siteManager").value = site.processManager || "pm2";
  $("siteProcess").value = site.processName || "";
  $("siteHealth").value =
    site.healthUrl || (site.domain ? `https://${site.domain}` : "");
  $("siteRollback").checked = site.autoRollback !== false;
  $("siteInstall").checked = site.installDependencies !== false;
  $("siteBuild").checked = site.runBuild !== false;
  $("siteDialog").showModal();
}

async function saveDialog() {
  const id = $("siteId").value;
  const body = {
    name: $("siteName").value,
    domain: $("siteDomain").value,
    repositoryUrl: $("siteRepository").value,
    branch: $("siteBranch").value,
    appPath: $("sitePath").value,
    processManager: $("siteManager").value,
    processName: $("siteProcess").value,
    healthUrl: $("siteHealth").value,
    autoRollback: $("siteRollback").checked,
    installDependencies: $("siteInstall").checked,
    runBuild: $("siteBuild").checked,
  };

  try {
    await api(
      id
        ? `/api/update-sites/sites/${encodeURIComponent(id)}`
        : "/api/update-sites/sites",
      {
        method: id ? "PATCH" : "POST",
        body: JSON.stringify(body),
      }
    );

    $("siteDialog").close();
    toast("Site configuration saved.");
    await loadWorkspace();
    if (id) selectSite(id);
  } catch (error) {
    toast(error.message, true);
  }
}

async function testSite(siteId) {
  try {
    const payload = await api(
      `/api/update-sites/sites/${encodeURIComponent(siteId)}/test`,
      { method: "POST", body: "{}" }
    );

    $("deploymentLog").textContent = (payload.checks || [])
      .map((check) => `${check.passed ? "PASS" : "FAIL"}: ${check.name} — ${check.detail}`)
      .join("\n");

    toast("Site test passed.");
  } catch (error) {
    $("deploymentLog").textContent = error.message;
    toast(error.message, true);
  }
}

function attachEvents() {
  $("siteSelector").addEventListener("change", () => {
    if ($("siteSelector").value) selectSite($("siteSelector").value);
    else updateSummary();
  });

  $("repositorySelector").addEventListener("change", () => {
    $("manualRepositoryWrap").classList.toggle(
      "show",
      $("repositorySelector").value === "__manual__"
    );

    const target = matchTargetByRepository(selectedRepository());
    if (target) {
      $("targetSelector").value = target.processName;
      $("branchInput").value = target.branch || "main";
    }

    updateSummary();
  });

  $("manualRepositoryInput").addEventListener("input", updateSummary);

  $("targetSelector").addEventListener("change", () => {
    const target = selectedTarget();

    if (target?.repositoryUrl && !$("repositorySelector").value) {
      const repository = uniqueRepositories().find(
        (item) =>
          normalizeRepository(item.url) ===
          normalizeRepository(target.repositoryUrl)
      );
      if (repository) $("repositorySelector").value = repository.url;
    }

    if (target?.branch) $("branchInput").value = target.branch;
    updateSummary();
  });

  $("branchInput").addEventListener("input", updateSummary);

  $("saveMappingButton").addEventListener("click", () => {
    saveMapping().catch((error) => toast(error.message, true));
  });

  $("testMappingButton").addEventListener("click", testSelected);
  $("updateSelectedButton").addEventListener("click", updateSelected);
  $("refreshButton").addEventListener("click", loadWorkspace);
  $("refreshDiscoveryButton").addEventListener("click", loadWorkspace);
  $("addSiteButton").addEventListener("click", () => openDialog());
  $("saveSiteButton").addEventListener("click", saveDialog);

  $("sitesBody").addEventListener("click", (event) => {
    const selectButton = event.target.closest(".js-select");
    if (selectButton) {
      selectSite(selectButton.dataset.siteId);
      scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const configureButton = event.target.closest(".js-configure");
    if (configureButton) {
      openDialog(siteById(configureButton.dataset.siteId));
      return;
    }

    const testButton = event.target.closest(".js-test");
    if (testButton) {
      testSite(testButton.dataset.siteId);
      return;
    }

    const updateButton = event.target.closest(".js-update");
    if (updateButton) {
      const site = siteById(updateButton.dataset.siteId);
      if (
        site &&
        confirm(
          `Update ${site.name} from ${normalizeRepository(site.repositoryUrl)}?`
        )
      ) {
        queueUpdate(site.id).catch((error) => toast(error.message, true));
      }
      return;
    }

    const logsButton = event.target.closest(".js-logs");
    if (logsButton) {
      viewRun(logsButton.dataset.runId);
      return;
    }

    const recoverButton = event.target.closest(".js-recover-run");
    if (recoverButton) {
      recoverStaleRun(recoverButton.dataset.runId);
      return;
    }

    const restartButton = event.target.closest(".js-restart-goodbase");
    if (restartButton) {
      restartGoodBase(restartButton.dataset.siteId);
      return;
    }

    const removeButton = event.target.closest(".js-remove-mapping");
    if (removeButton) {
      removeTemporaryMapping(removeButton.dataset.siteId);
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  attachEvents();

  try {
    await loadWorkspace();
  } catch (error) {
    showAlert(error.message);
    $("workspaceStatus").textContent = "Failed to load";
    $("workspaceStatus").className = "badge bad";
  }
});
