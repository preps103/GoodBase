"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const database = require("../config/database");

const { pool, query } = database;
const BACKUP_ROOT = "/var/backups/goodos-site-updates";
const NPM_CACHE_ROOT = path.join(BACKUP_ROOT, "npm-cache");
const GOODBASE_PM2_PROCESSES = [
  "goodbase-api",
  "goodbase-api-ha",
  "goodbase-worker",
];
const ALLOWED_ROOTS = ["/home", "/var/www", "/opt"];
const MAX_OUTPUT = 12000;
const PM2_HOME = path.resolve(
  process.env.GOODOS_PM2_HOME ||
  "/home/mgoodlo3/.pm2"
);
const PM2_CONTROL_COMMAND = "/usr/local/sbin/goodos-pm2-control";

function identifier(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function cleanText(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function safeJson(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try { return JSON.parse(value); } catch {}
  }
  return fallback;
}

function statusError(statusCode, message, code = "DEPLOYMENT_ERROR") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeGithubRepository(value, { allowLocalTest = false } = {}) {
  const input = cleanText(value, 1000);

  if (allowLocalTest && input.startsWith("file://")) {
    return input;
  }

  let match = input.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  if (!match) {
    match = input.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  }

  if (!match) {
    throw statusError(
      400,
      "Repository must be a GitHub HTTPS URL or git@github.com SSH URL.",
      "INVALID_GITHUB_REPOSITORY"
    );
  }

  return `git@github.com:${match[1]}/${match[2]}.git`;
}

function comparableRepository(value) {
  const input = cleanText(value, 1000)
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
  return input;
}

function validateBranch(value) {
  const branch = cleanText(value || "main", 160);
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/")) {
    throw statusError(400, "Branch name is invalid.", "INVALID_BRANCH");
  }
  return branch;
}

function validateProcessManager(value) {
  const manager = cleanText(value || "pm2", 20).toLowerCase();
  if (!["pm2", "systemd", "none"].includes(manager)) {
    throw statusError(400, "Process manager must be pm2, systemd, or none.", "INVALID_PROCESS_MANAGER");
  }
  return manager;
}

function validateProcessName(value, manager) {
  const name = cleanText(value, 160);
  if (manager === "none") return "";
  if (!name || !/^[A-Za-z0-9_.@:-]+$/.test(name)) {
    throw statusError(400, "A valid process or service name is required.", "INVALID_PROCESS_NAME");
  }
  return name;
}

function validateAppPath(value, { mustExist = false } = {}) {
  const input = cleanText(value, 1000);
  if (!input || !path.isAbsolute(input)) {
    throw statusError(400, "Application path must be an absolute server path.", "INVALID_APP_PATH");
  }

  const resolved = path.resolve(input);
  const allowed = ALLOWED_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw statusError(400, "Application path must be under /home, /var/www, or /opt.", "APP_PATH_NOT_ALLOWED");
  }

  if (mustExist && (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())) {
    throw statusError(400, "Application directory does not exist.", "APP_PATH_NOT_FOUND");
  }

  if (mustExist) {
    const real = fs.realpathSync(resolved);
    const realAllowed = ALLOWED_ROOTS.some((root) => real === root || real.startsWith(`${root}${path.sep}`));
    if (!realAllowed) {
      throw statusError(400, "Resolved application path is outside the permitted roots.", "APP_PATH_NOT_ALLOWED");
    }
    return real;
  }

  return resolved;
}

function validateHealthUrl(value) {
  const input = cleanText(value, 1000);
  if (!input) return "";
  let url;
  try {
    url = new URL(input);
  } catch {
    throw statusError(400, "Health URL is invalid.", "INVALID_HEALTH_URL");
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw statusError(400, "Health URL must use HTTP or HTTPS.", "INVALID_HEALTH_URL");
  }
  return url.toString();
}

function validateSiteInput(input = {}, { partial = false } = {}) {
  const output = {};

  if (!partial || input.name !== undefined) {
    output.name = cleanText(input.name, 200);
    if (!output.name) throw statusError(400, "Site name is required.", "SITE_NAME_REQUIRED");
  }

  if (!partial || input.domain !== undefined) {
    output.domain = cleanText(input.domain, 300);
  }

  if (!partial || input.repositoryUrl !== undefined || input.repository_url !== undefined) {
    const raw = input.repositoryUrl ?? input.repository_url ?? "";
    output.repositoryUrl = raw ? normalizeGithubRepository(raw) : "";
  }

  if (!partial || input.branch !== undefined) {
    output.branch = validateBranch(input.branch || "main");
  }

  if (!partial || input.appPath !== undefined || input.app_path !== undefined) {
    const raw = input.appPath ?? input.app_path ?? "";
    output.appPath = raw ? validateAppPath(raw) : "";
  }

  if (!partial || input.processManager !== undefined || input.process_manager !== undefined) {
    output.processManager = validateProcessManager(input.processManager ?? input.process_manager ?? "pm2");
  }

  const manager = output.processManager || validateProcessManager(input.processManager ?? input.process_manager ?? "pm2");
  if (!partial || input.processName !== undefined || input.process_name !== undefined || output.processManager !== undefined) {
    output.processName = validateProcessName(input.processName ?? input.process_name ?? "", manager);
  }

  if (!partial || input.healthUrl !== undefined || input.health_url !== undefined) {
    output.healthUrl = validateHealthUrl(input.healthUrl ?? input.health_url ?? "");
  }

  if (!partial || input.autoRollback !== undefined || input.auto_rollback !== undefined) {
    output.autoRollback = (input.autoRollback ?? input.auto_rollback) !== false;
  }

  if (!partial || input.installDependencies !== undefined || input.install_dependencies !== undefined) {
    output.installDependencies = (input.installDependencies ?? input.install_dependencies) !== false;
  }

  if (!partial || input.runBuild !== undefined || input.run_build !== undefined) {
    output.runBuild = (input.runBuild ?? input.run_build) !== false;
  }

  return output;
}

async function addEvent(runId, step, message, level = "info", metadata = {}) {
  await query(
    `
      INSERT INTO backend_deployment_events (
        id, run_id, level, step, message, metadata_json
      )
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    `,
    [
      identifier("deployevent"),
      runId,
      cleanText(level, 20) || "info",
      cleanText(step, 100) || "deployment",
      cleanText(message, MAX_OUTPUT),
      JSON.stringify(metadata || {}),
    ]
  );
}

function commandLabel(command, args) {
  return [command, ...(args || [])].join(" ");
}

function runCommand(command, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 20 * 60 * 1000,
    onOutput = () => {},
    allowExitCodes = [0],
    maxOutput = MAX_OUTPUT,
  } = options;

  const outputLimit = Math.max(
    1024,
    Math.min(
      Number(maxOutput) || MAX_OUTPUT,
      5 * 1024 * 1024
    )
  );

  const commandArgs =
    command === "git" && cwd
      ? [
          "-c",
          `safe.directory=${path.resolve(cwd)}`,
          ...(args || []),
        ]
      : (args || []);

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    const capture = (kind) => (chunk) => {
      const text = String(chunk);
      if (kind === "stdout") {
        stdout = (stdout + text).slice(-outputLimit);
      } else {
        stderr = (stderr + text).slice(-outputLimit);
      }
      onOutput(kind, text);
    };

    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const result = { code, signal, stdout, stderr };
      if (allowExitCodes.includes(code)) return resolve(result);

      const error = new Error(
        `${commandLabel(command, args)} failed with exit code ${code}${stderr ? `: ${stderr.trim().slice(-2000)}` : ""}`
      );
      error.commandResult = result;
      reject(error);
    });
  });
}

async function commandWithEvents(runId, step, command, args, options = {}) {
  await addEvent(runId, step, `$ ${commandLabel(command, args)}`, "info");

  let buffer = "";
  let flushTimer = null;

  const flush = async () => {
    if (!buffer.trim()) return;
    const chunk = buffer;
    buffer = "";
    await addEvent(runId, step, chunk.trim(), "log").catch(() => {});
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await flush();
    }, 350);
  };

  try {
    const result = await runCommand(command, args, {
      ...options,
      onOutput: (_kind, text) => {
        buffer = (buffer + text).slice(-MAX_OUTPUT);
        scheduleFlush();
      },
    });
    if (flushTimer) clearTimeout(flushTimer);
    await flush();
    return result;
  } catch (error) {
    if (flushTimer) clearTimeout(flushTimer);
    await flush();
    throw error;
  }
}

async function loadSite(siteId) {
  const result = await query(
    `
      SELECT
        id,
        app_id AS "appId",
        name,
        domain,
        repository_url AS "repositoryUrl",
        branch,
        app_path AS "appPath",
        process_manager AS "processManager",
        process_name AS "processName",
        health_url AS "healthUrl",
        status,
        auto_rollback AS "autoRollback",
        install_dependencies AS "installDependencies",
        run_build AS "runBuild",
        last_deployed_commit AS "lastDeployedCommit",
        last_deployed_at AS "lastDeployedAt",
        last_run_id AS "lastRunId",
        metadata_json AS metadata,
        organization_id AS "organizationId",
        project_id AS "projectId",
        environment_id AS "environmentId"
      FROM backend_deployment_sites
      WHERE id = $1
      LIMIT 1
    `,
    [siteId]
  );

  if (!result.rows[0]) throw statusError(404, "Deployment site was not found.", "SITE_NOT_FOUND");
  return result.rows[0];
}

async function loadRun(runId) {
  const result = await query(
    `
      SELECT
        id,
        site_id AS "siteId",
        status,
        trigger_type AS "triggerType",
        requested_by AS "requestedBy",
        previous_commit AS "previousCommit",
        target_commit AS "targetCommit",
        deployed_commit AS "deployedCommit",
        rollback_commit AS "rollbackCommit",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        error_message AS "errorMessage",
        summary_json AS summary
      FROM backend_deployment_runs
      WHERE id = $1
      LIMIT 1
    `,
    [runId]
  );

  if (!result.rows[0]) throw statusError(404, "Deployment run was not found.", "RUN_NOT_FOUND");
  return result.rows[0];
}

async function packageInfo(appPath) {
  const packagePath = path.join(appPath, "package.json");
  if (!fs.existsSync(packagePath)) {
    return { exists: false, scripts: {}, packageManager: null };
  }

  const parsed = JSON.parse(await fsp.readFile(packagePath, "utf8"));
  let packageManager = "npm";
  if (fs.existsSync(path.join(appPath, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (fs.existsSync(path.join(appPath, "yarn.lock"))) packageManager = "yarn";

  return {
    exists: true,
    scripts: parsed.scripts || {},
    packageManager,
    hasPackageLock: fs.existsSync(path.join(appPath, "package-lock.json")),
  };
}

async function installDependencies(runId, site, appPath) {
  if (!site.installDependencies) {
    await addEvent(runId, "dependencies", "Dependency installation is disabled for this site.");
    return;
  }

  const info = await packageInfo(appPath);
  if (!info.exists) {
    await addEvent(runId, "dependencies", "No package.json found; dependency installation skipped.");
    return;
  }

  if (info.packageManager === "pnpm") {
    await commandWithEvents(runId, "dependencies", "corepack", ["pnpm", "install", "--frozen-lockfile"], { cwd: appPath });
    return;
  }

  if (info.packageManager === "yarn") {
    await commandWithEvents(runId, "dependencies", "corepack", ["yarn", "install", "--immutable"], {
      cwd: appPath,
    }).catch(async () => {
      await commandWithEvents(runId, "dependencies", "corepack", ["yarn", "install", "--frozen-lockfile"], { cwd: appPath });
    });
    return;
  }

  const args = info.hasPackageLock
    ? ["ci", "--no-audit", "--no-fund"]
    : ["install", "--no-audit", "--no-fund"];

  await fsp.mkdir(NPM_CACHE_ROOT, { recursive: true, mode: 0o700 });
  await commandWithEvents(runId, "dependencies", "npm", args, {
    cwd: appPath,
    env: { NPM_CONFIG_CACHE: NPM_CACHE_ROOT },
  });
}

async function buildApplication(runId, site, appPath) {
  if (!site.runBuild) {
    await addEvent(runId, "build", "Build is disabled for this site.");
    return;
  }

  const info = await packageInfo(appPath);
  if (!info.exists || !info.scripts.build) {
    await addEvent(runId, "build", "No build script found; build skipped.");
    return;
  }

  if (info.packageManager === "pnpm") {
    await commandWithEvents(runId, "build", "corepack", ["pnpm", "run", "build"], { cwd: appPath });
  } else if (info.packageManager === "yarn") {
    await commandWithEvents(runId, "build", "corepack", ["yarn", "build"], { cwd: appPath });
  } else {
    await fsp.mkdir(NPM_CACHE_ROOT, { recursive: true, mode: 0o700 });
    await commandWithEvents(runId, "build", "npm", ["run", "build"], {
      cwd: appPath,
      env: { NPM_CONFIG_CACHE: NPM_CACHE_ROOT },
    });
  }
}

function pm2ProcessNamesForSite(site) {
  const configured = validateProcessName(site.processName, "pm2");
  const isGoodBase =
    cleanText(site.name, 200) === "GoodBase" &&
    path.resolve(site.appPath || "") === "/var/www/GoodBase";

  return isGoodBase ? [...GOODBASE_PM2_PROCESSES] : [configured];
}

async function restartApplication(runId, site) {
  if (site.processManager === "none") {
    await addEvent(runId, "restart", "No process restart is required for this site.");
    return;
  }

  if (site.processManager === "pm2") {
    const processNames = pm2ProcessNamesForSite(site);
    for (const processName of processNames) {
      await commandWithEvents(
        runId,
        "restart",
        "sudo",
        ["-n", PM2_CONTROL_COMMAND, "restart", processName],
        {
        timeoutMs: 2 * 60 * 1000,
        }
      );
    }
    await commandWithEvents(
      runId,
      "restart",
      "sudo",
      ["-n", PM2_CONTROL_COMMAND, "save"],
      { timeoutMs: 2 * 60 * 1000 }
    );
    return;
  }

  const name = validateProcessName(site.processName, site.processManager);
  await commandWithEvents(runId, "restart", "systemctl", ["restart", name], { timeoutMs: 2 * 60 * 1000 });
  await commandWithEvents(runId, "restart", "systemctl", ["is-active", "--quiet", name], { timeoutMs: 60 * 1000 });
}

async function verifyHealth(runId, site) {
  const healthUrl = validateHealthUrl(site.healthUrl || "");
  if (!healthUrl) {
    await addEvent(runId, "health", "No health URL configured; health verification skipped.", "warning");
    return { skipped: true };
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(`${healthUrl}${healthUrl.includes("?") ? "&" : "?"}deployment_check=${Date.now()}`, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "GoodOS-Update-Sites/1.0" },
      });
      clearTimeout(timer);

      if (response.status >= 200 && response.status < 400) {
        await addEvent(runId, "health", `Health check passed with HTTP ${response.status}.`);
        return { status: response.status };
      }

      lastError = new Error(`Health check returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Health check failed: ${lastError?.message || "unknown error"}`);
}

async function updateRun(runId, fields = {}) {
  const pairs = [];
  const values = [runId];
  let index = 2;

  const map = {
    status: "status",
    previousCommit: "previous_commit",
    targetCommit: "target_commit",
    deployedCommit: "deployed_commit",
    rollbackCommit: "rollback_commit",
    errorMessage: "error_message",
    summary: "summary_json",
    startedAt: "started_at",
    completedAt: "completed_at",
  };

  for (const [key, column] of Object.entries(map)) {
    if (fields[key] === undefined) continue;
    pairs.push(`${column} = $${index}${key === "summary" ? "::jsonb" : ""}`);
    values.push(key === "summary" ? JSON.stringify(fields[key] || {}) : fields[key]);
    index += 1;
  }

  pairs.push("updated_at = NOW()");
  await query(`UPDATE backend_deployment_runs SET ${pairs.join(", ")} WHERE id = $1`, values);
}

async function updateSiteAfterRun(siteId, runId, fields = {}) {
  await query(
    `
      UPDATE backend_deployment_sites
      SET
        status = $3,
        last_run_id = $2,
        last_deployed_commit = COALESCE($4, last_deployed_commit),
        last_deployed_at = CASE WHEN $4 IS NULL THEN last_deployed_at ELSE NOW() END,
        updated_at = NOW()
      WHERE id = $1
    `,
    [siteId, runId, fields.status || "ready", fields.deployedCommit || null]
  );
}

async function performRollback(runId, site, appPath, previousCommit) {
  await addEvent(runId, "rollback", `Rolling back to ${previousCommit}.`, "warning");
  await commandWithEvents(runId, "rollback", "git", ["reset", "--hard", previousCommit], { cwd: appPath });
  await installDependencies(runId, site, appPath);
  await buildApplication(runId, site, appPath);
  await restartApplication(runId, site);
  await verifyHealth(runId, site);
  await addEvent(runId, "rollback", `Rollback to ${previousCommit} completed.`, "warning");
}

async function executeDeployment(runId) {
  const run = await loadRun(runId);
  const site = await loadSite(run.siteId);
  const appPath = validateAppPath(site.appPath, { mustExist: true });
  const metadata = safeJson(site.metadata, {});
  const allowLocalTest = process.env.GOODOS_DEPLOYMENT_ALLOW_LOCAL_TEST === "1" && metadata.testMode === true;
  const configuredRepository = normalizeGithubRepository(site.repositoryUrl, { allowLocalTest });
  const branch = validateBranch(site.branch);
  const manager = validateProcessManager(site.processManager);
  validateProcessName(site.processName, manager);

  const lockClient = await pool.connect();
  const lockKey = `goodos-deployment:${site.id}`;
  let lockHeld = false;
  let previousCommit = null;
  let targetCommit = null;

  try {
    const lockResult = await lockClient.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [lockKey]
    );
    lockHeld = lockResult.rows[0]?.locked === true;

    if (!lockHeld) {
      throw statusError(409, "Another deployment for this site is already running.", "DEPLOYMENT_ALREADY_RUNNING");
    }

    await updateRun(runId, { status: "running", startedAt: new Date() });
    await updateSiteAfterRun(site.id, runId, { status: "deploying" });
    await addEvent(runId, "preflight", `Starting update for ${site.name}.`);

    if (!fs.existsSync(path.join(appPath, ".git"))) {
      throw new Error("Application directory is not a Git repository.");
    }

    const remoteResult = await commandWithEvents(runId, "preflight", "git", ["remote", "get-url", "origin"], { cwd: appPath });
    const actualRepository = remoteResult.stdout.trim();

    const repositoryMatches = allowLocalTest
      ? actualRepository === configuredRepository
      : comparableRepository(actualRepository) === comparableRepository(configuredRepository);

    if (!repositoryMatches) {
      throw new Error(`Configured repository does not match origin. Configured: ${configuredRepository}; origin: ${actualRepository}`);
    }

    const currentBranch = (
      await commandWithEvents(runId, "preflight", "git", ["branch", "--show-current"], { cwd: appPath })
    ).stdout.trim();

    if (currentBranch !== branch) {
      throw new Error(`Application is on branch ${currentBranch || "(detached)"}, but this site is configured for ${branch}.`);
    }

    const dirtyResult = await commandWithEvents(runId, "preflight", "git", ["status", "--porcelain=v1"], { cwd: appPath });
    if (dirtyResult.stdout.trim()) {
      throw new Error("Application working tree has uncommitted changes. Deployment stopped without modifying them.");
    }

    previousCommit = (
      await commandWithEvents(runId, "preflight", "git", ["rev-parse", "HEAD"], { cwd: appPath })
    ).stdout.trim();

    await commandWithEvents(runId, "fetch", "git", ["fetch", "--prune", "origin", branch], { cwd: appPath });
    targetCommit = (
      await commandWithEvents(runId, "fetch", "git", ["rev-parse", `origin/${branch}`], { cwd: appPath })
    ).stdout.trim();

    await updateRun(runId, { previousCommit, targetCommit });

    if (previousCommit === targetCommit) {
      await addEvent(runId, "complete", "Site is already current. No deployment was required.");
      await updateRun(runId, {
        status: "no_change",
        deployedCommit: previousCommit,
        completedAt: new Date(),
        summary: { noChange: true },
      });
      await updateSiteAfterRun(site.id, runId, { status: "ready", deployedCommit: previousCommit });
      return { status: "no_change", previousCommit, targetCommit };
    }

    await commandWithEvents(
      runId,
      "preflight",
      "git",
      ["merge-base", "--is-ancestor", previousCommit, targetCommit],
      { cwd: appPath }
    );

    const backupDir = path.join(BACKUP_ROOT, runId);
    await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(
      path.join(backupDir, "deployment.json"),
      JSON.stringify(
        {
          runId,
          siteId: site.id,
          siteName: site.name,
          appPath,
          repositoryUrl: configuredRepository,
          branch,
          previousCommit,
          targetCommit,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    await addEvent(runId, "backup", `Rollback metadata saved to ${backupDir}.`);

    await commandWithEvents(runId, "checkout", "git", ["checkout", branch], { cwd: appPath });
    await commandWithEvents(runId, "checkout", "git", ["merge", "--ff-only", `origin/${branch}`], { cwd: appPath });

    await installDependencies(runId, site, appPath);
    await buildApplication(runId, site, appPath);
    await restartApplication(runId, site);
    await verifyHealth(runId, site);

    const deployedCommit = (
      await commandWithEvents(runId, "complete", "git", ["rev-parse", "HEAD"], { cwd: appPath })
    ).stdout.trim();

    await updateRun(runId, {
      status: "success",
      deployedCommit,
      completedAt: new Date(),
      summary: {
        appPath,
        branch,
        processManager: site.processManager,
        processName: site.processName,
        healthUrl: site.healthUrl || null,
      },
    });
    await updateSiteAfterRun(site.id, runId, { status: "ready", deployedCommit });
    await addEvent(runId, "complete", `Deployment completed at ${deployedCommit}.`);

    return { status: "success", previousCommit, targetCommit, deployedCommit };
  } catch (error) {
    await addEvent(runId, "error", error.message, "error").catch(() => {});

    let rollbackSucceeded = false;
    let rollbackError = null;

    if (site.autoRollback && previousCommit) {
      try {
        await performRollback(runId, site, appPath, previousCommit);
        rollbackSucceeded = true;
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
        await addEvent(runId, "rollback", `Rollback failed: ${rollbackFailure.message}`, "error").catch(() => {});
      }
    }

    const status = rollbackSucceeded ? "rolled_back" : "failed";
    const message = rollbackError
      ? `${error.message}; rollback failed: ${rollbackError.message}`
      : error.message;

    await updateRun(runId, {
      status,
      rollbackCommit: rollbackSucceeded ? previousCommit : null,
      errorMessage: message,
      completedAt: new Date(),
      summary: { rollbackSucceeded },
    }).catch(() => {});
    await updateSiteAfterRun(site.id, runId, {
      status: rollbackSucceeded ? "ready" : "failed",
      deployedCommit: rollbackSucceeded ? previousCommit : null,
    }).catch(() => {});

    if (!rollbackSucceeded) throw error;
    return { status, previousCommit, targetCommit, error: error.message };
  } finally {
    if (lockHeld) {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => {});
    }
    lockClient.release();
  }
}

async function discoverServerApps() {
  let result;
  try {
    result = await runCommand(
      "pm2",
      ["jlist"],
      {
        timeoutMs: 60000,
        maxOutput: 5 * 1024 * 1024,
        env: { PM2_HOME },
      }
    );
  } catch {
    try {
      result = await runCommand(
        "sudo",
        ["-n", PM2_CONTROL_COMMAND, "discover"],
        {
          timeoutMs: 60000,
          maxOutput: 5 * 1024 * 1024,
        }
      );
    } catch {
      throw statusError(
        503,
        "PM2 application discovery is unavailable. Verify the deployment control helper and permissions.",
        "PM2_DISCOVERY_UNAVAILABLE"
      );
    }
  }

  const rawOutput = String(
    result.stdout || ""
  ).trim();

  let jsonPayload = rawOutput;

  const arrayStart =
    rawOutput.indexOf("[{");

  const arrayEnd =
    rawOutput.lastIndexOf("}]");

  if (
    arrayStart >= 0 &&
    arrayEnd >= arrayStart
  ) {
    jsonPayload =
      rawOutput.slice(
        arrayStart,
        arrayEnd + 2
      );
  } else if (
    rawOutput.includes("[]")
  ) {
    jsonPayload = "[]";
  }

  let rows;

  try {
    rows = JSON.parse(
      jsonPayload ||
      "[]"
    );
  } catch (parseError) {
    throw statusError(
      502,
      `PM2 application discovery returned malformed JSON: ${parseError.message}`,
      "PM2_DISCOVERY_INVALID_JSON"
    );
  }

  if (!Array.isArray(rows)) {
    throw statusError(
      502,
      "PM2 application discovery did not return an array.",
      "PM2_DISCOVERY_INVALID_PAYLOAD"
    );
  }

  const discovered = [];

  for (const item of rows) {
    const cwd = item.pm2_env?.pm_cwd || null;
    let repositoryUrl = null;
    let branch = null;

    if (cwd && fs.existsSync(path.join(cwd, ".git"))) {
      try {
        repositoryUrl = (await runCommand("git", ["remote", "get-url", "origin"], { cwd, timeoutMs: 15000 })).stdout.trim();
      } catch {}
      try {
        branch = (await runCommand("git", ["branch", "--show-current"], { cwd, timeoutMs: 15000 })).stdout.trim();
      } catch {}
    }

    discovered.push({
      processName: item.name,
      status: item.pm2_env?.status || "unknown",
      appPath: cwd,
      repositoryUrl,
      branch: branch || "main",
      processManager: "pm2",
      pid: item.pid || null,
      port: item.pm2_env?.env?.PORT || item.pm2_env?.PORT || null,
    });
  }

  return discovered.sort((a, b) => String(a.processName).localeCompare(String(b.processName)));
}


async function discoverGithubRepositories() {
  const owner = String(
    process.env.GOODOS_GITHUB_OWNER ||
    "preps103"
  ).trim();

  try {
    const result = await runCommand(
      "gh",
      [
        "repo",
        "list",
        owner,
        "--limit",
        "250",
        "--json",
        "nameWithOwner,sshUrl,url,isPrivate",
      ],
      {
        timeoutMs: 60000,
      }
    );

    const rows = JSON.parse(
      result.stdout ||
      "[]"
    );

    return rows
      .map((row) => ({
        nameWithOwner:
          row.nameWithOwner,
        repositoryUrl:
          row.sshUrl ||
          row.url,
        htmlUrl:
          row.url ||
          null,
        private:
          Boolean(
            row.isPrivate
          ),
        source:
          "github",
      }))
      .filter(
        (row) =>
          row.nameWithOwner &&
          row.repositoryUrl
      )
      .sort((a, b) =>
        String(
          a.nameWithOwner
        ).localeCompare(
          String(
            b.nameWithOwner
          )
        )
      );
  } catch (githubError) {
    const processes =
      await discoverServerApps();

    const repositories =
      new Map();

    for (const process of processes) {
      if (!process.repositoryUrl) {
        continue;
      }

      const key =
        comparableRepository(
          process.repositoryUrl
        );

      if (
        key &&
        !repositories.has(key)
      ) {
        repositories.set(
          key,
          {
            nameWithOwner:
              key,
            repositoryUrl:
              process.repositoryUrl,
            htmlUrl:
              null,
            private:
              true,
            source:
              "server-fallback",
          }
        );
      }
    }

    const fallback =
      [...repositories.values()]
        .sort((a, b) =>
          String(
            a.nameWithOwner
          ).localeCompare(
            String(
              b.nameWithOwner
            )
          )
        );

    if (!fallback.length) {
      throw statusError(
        503,
        `GitHub repository discovery failed: ${githubError.message}`,
        "GITHUB_REPOSITORY_DISCOVERY_FAILED"
      );
    }

    return fallback;
  }
}

module.exports = {
  identifier,
  validateSiteInput,
  normalizeGithubRepository,
  validateAppPath,
  validateBranch,
  validateProcessManager,
  validateProcessName,
  validateHealthUrl,
  loadSite,
  loadRun,
  addEvent,
  executeDeployment,
  discoverServerApps,
  discoverGithubRepositories,
  runCommand,
  pm2ProcessNamesForSite,
};
