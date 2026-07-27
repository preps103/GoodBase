"use strict";

const express = require("express");
const path = require("path");
const { spawn } = require("child_process");
const authRequired = require("../middleware/authRequired");
const database = require("../config/database");
const deployment = require("../services/site-deployment.service");

const router = express.Router();
const { pool, query } = database;
const STALE_DEPLOYMENT_AGE_MS = 15 * 1000;

function roleOf(request) {
  return String(
    request.user?.platformRole ||
    request.user?.platform_role ||
    request.auth?.decoded?.platformRole ||
    request.auth?.decoded?.platform_role ||
    ""
  ).toLowerCase();
}

function requireOwnerOrAdmin(request, response, next) {
  if (!["owner", "admin"].includes(roleOf(request))) {
    return response.status(403).json({
      success: false,
      code: "DEPLOYMENT_ADMIN_REQUIRED",
      message: "Owner or administrator access is required.",
    });
  }
  return next();
}

function errorResponse(response, error) {
  return response.status(error.statusCode || 500).json({
    success: false,
    code: error.code || "UPDATE_SITES_ERROR",
    message: error.message,
  });
}

async function audit(request, action, targetId, after = {}) {
  await query(
    `
      INSERT INTO backend_admin_audit_logs (
        id, actor, action, target_type, target_id, after_json,
        organization_id, project_id, environment_id, ip_address, user_agent
      )
      VALUES (
        $1,$2,$3,'deployment_site',$4,$5::jsonb,
        'org_goodos','proj_goodos_platform','env_goodos_production',$6,$7
      )
    `,
    [
      deployment.identifier("audit"),
      request.user?.email || "console-user",
      action,
      targetId,
      JSON.stringify(after || {}),
      request.headers["x-forwarded-for"] || request.socket?.remoteAddress || null,
      request.headers["user-agent"] || null,
    ]
  ).catch(() => {});
}

router.get("/health", (_request, response) => {
  return response.json({
    success: true,
    service: "GoodOS Update Sites Deployment Center",
    status: "ready",
    page: "https://base.goodos.app/update-sites",
    timestamp: new Date().toISOString(),
  });
});

router.use(authRequired);
router.use(requireOwnerOrAdmin);

router.get("/sites", async (_request, response) => {
  try {
    const result = await query(`
      SELECT
        site.id,
        site.app_id AS "appId",
        site.name,
        site.domain,
        site.repository_url AS "repositoryUrl",
        site.branch,
        site.app_path AS "appPath",
        site.process_manager AS "processManager",
        site.process_name AS "processName",
        site.health_url AS "healthUrl",
        site.status,
        site.auto_rollback AS "autoRollback",
        site.install_dependencies AS "installDependencies",
        site.run_build AS "runBuild",
        site.last_deployed_commit AS "lastDeployedCommit",
        site.last_deployed_at AS "lastDeployedAt",
        site.last_run_id AS "lastRunId",
        site.updated_at AS "updatedAt",
        recent.status AS "lastRunStatus",
        recent.created_at AS "lastRunCreatedAt",
        recent.completed_at AS "lastRunCompletedAt",
        recent.error_message AS "lastRunError"
      FROM backend_deployment_sites site
      LEFT JOIN LATERAL (
        SELECT status, created_at, completed_at, error_message
        FROM backend_deployment_runs
        WHERE site_id = site.id
        ORDER BY created_at DESC
        LIMIT 1
      ) recent ON TRUE
      ORDER BY site.name ASC
    `);

    return response.json({ success: true, sites: result.rows, total: result.rows.length });
  } catch (error) {
    return errorResponse(response, error);
  }
});

router.post("/sites", async (request, response) => {
  try {
    const input = deployment.validateSiteInput(request.body || {});
    const id = deployment.identifier("deploysite");
    const result = await query(
      `
        INSERT INTO backend_deployment_sites (
          id, app_id, name, domain, repository_url, branch, app_path,
          process_manager, process_name, health_url, status, auto_rollback,
          install_dependencies, run_build, organization_id, project_id,
          environment_id, created_by, metadata_json
        )
        VALUES (
          $1,NULLIF($2,''),$3,NULLIF($4,''),NULLIF($5,''),$6,NULLIF($7,''),
          $8,NULLIF($9,''),NULLIF($10,''),
          CASE WHEN NULLIF($5,'') IS NULL OR NULLIF($7,'') IS NULL THEN 'setup_required' ELSE 'ready' END,
          $11,$12,$13,'org_goodos','proj_goodos_platform','env_goodos_production',$14,
          '{"phase":19}'::jsonb
        )
        RETURNING *
      `,
      [
        id,
        String(request.body?.appId || request.body?.app_id || "").trim(),
        input.name,
        input.domain,
        input.repositoryUrl,
        input.branch,
        input.appPath,
        input.processManager,
        input.processName,
        input.healthUrl,
        input.autoRollback,
        input.installDependencies,
        input.runBuild,
        request.user?.id || null,
      ]
    );

    await audit(request, "deployment.site.create", id, result.rows[0]);
    return response.status(201).json({ success: true, site: result.rows[0] });
  } catch (error) {
    return errorResponse(response, error);
  }
});

router.patch("/sites/:siteId", async (request, response) => {
  try {
    const before = await deployment.loadSite(request.params.siteId);
    const input = deployment.validateSiteInput(
      {
        name: request.body?.name ?? before.name,
        domain: request.body?.domain ?? before.domain,
        repositoryUrl: request.body?.repositoryUrl ?? request.body?.repository_url ?? before.repositoryUrl,
        branch: request.body?.branch ?? before.branch,
        appPath: request.body?.appPath ?? request.body?.app_path ?? before.appPath,
        processManager: request.body?.processManager ?? request.body?.process_manager ?? before.processManager,
        processName: request.body?.processName ?? request.body?.process_name ?? before.processName,
        healthUrl: request.body?.healthUrl ?? request.body?.health_url ?? before.healthUrl,
        autoRollback: request.body?.autoRollback ?? request.body?.auto_rollback ?? before.autoRollback,
        installDependencies: request.body?.installDependencies ?? request.body?.install_dependencies ?? before.installDependencies,
        runBuild: request.body?.runBuild ?? request.body?.run_build ?? before.runBuild,
      }
    );

    const result = await query(
      `
        UPDATE backend_deployment_sites
        SET
          name = $2,
          domain = NULLIF($3,''),
          repository_url = NULLIF($4,''),
          branch = $5,
          app_path = NULLIF($6,''),
          process_manager = $7,
          process_name = NULLIF($8,''),
          health_url = NULLIF($9,''),
          auto_rollback = $10,
          install_dependencies = $11,
          run_build = $12,
          status = CASE
            WHEN NULLIF($4,'') IS NULL OR NULLIF($6,'') IS NULL THEN 'setup_required'
            ELSE 'ready'
          END,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        request.params.siteId,
        input.name,
        input.domain,
        input.repositoryUrl,
        input.branch,
        input.appPath,
        input.processManager,
        input.processName,
        input.healthUrl,
        input.autoRollback,
        input.installDependencies,
        input.runBuild,
      ]
    );

    await audit(request, "deployment.site.update", request.params.siteId, result.rows[0]);
    return response.json({ success: true, site: result.rows[0] });
  } catch (error) {
    return errorResponse(response, error);
  }
});

router.get("/discover", async (_request, response) => {
  try {
    const processes = await deployment.discoverServerApps();
    return response.json({ success: true, processes, total: processes.length });
  } catch (error) {
    return errorResponse(response, error);
  }
});


router.get("/repositories", async (_request, response) => {
  try {
    const repositories =
      await deployment
        .discoverGithubRepositories();

    return response.json({
      success: true,
      owner:
        process.env
          .GOODOS_GITHUB_OWNER ||
        "preps103",
      repositories,
      total:
        repositories.length,
    });
  } catch (error) {
    return errorResponse(
      response,
      error
    );
  }
});

router.post("/sites/:siteId/test", async (request, response) => {
  try {
    const site = await deployment.loadSite(request.params.siteId);
    const appPath = deployment.validateAppPath(site.appPath, { mustExist: true });
    const repositoryUrl = deployment.normalizeGithubRepository(site.repositoryUrl);
    const branch = deployment.validateBranch(site.branch);
    const checks = [];

    checks.push({ name: "Application directory", passed: true, detail: appPath });

    if (!require("fs").existsSync(path.join(appPath, ".git"))) {
      throw new Error("Application directory is not a Git repository.");
    }
    checks.push({ name: "Git repository", passed: true, detail: path.join(appPath, ".git") });

    const remote = (await deployment.runCommand("git", ["remote", "get-url", "origin"], { cwd: appPath, timeoutMs: 15000 })).stdout.trim();
    const comparable = (value) => String(value).replace(/^https:\/\/github\.com\//i, "").replace(/^git@github\.com:/i, "").replace(/\.git$/i, "").replace(/\/+$/g, "").toLowerCase();

    if (comparable(remote) !== comparable(repositoryUrl)) {
      throw new Error(`Configured repository does not match origin. Origin is ${remote}.`);
    }
    checks.push({ name: "GitHub repository", passed: true, detail: remote });

    await deployment.runCommand("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], { cwd: appPath, timeoutMs: 30000 });
    checks.push({ name: "Deployment branch", passed: true, detail: branch });

    const dirty = (await deployment.runCommand("git", ["status", "--porcelain=v1"], { cwd: appPath, timeoutMs: 15000 })).stdout.trim();
    checks.push({
      name: "Working tree",
      passed: !dirty,
      detail: dirty ? "Uncommitted changes must be resolved before updating." : "Clean",
    });

    if (site.processManager === "pm2") {
      const processes = await deployment.discoverServerApps();
      const found = processes.some((item) => item.processName === site.processName);
      checks.push({ name: "PM2 process", passed: found, detail: site.processName || "Not configured" });
    } else if (site.processManager === "systemd") {
      const result = await deployment.runCommand("systemctl", ["show", site.processName, "--property=LoadState", "--value"], { timeoutMs: 15000 });
      checks.push({ name: "systemd service", passed: result.stdout.trim() === "loaded", detail: site.processName });
    } else {
      checks.push({ name: "Process restart", passed: true, detail: "No restart configured" });
    }

    if (site.healthUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const health = await fetch(site.healthUrl, { signal: controller.signal, redirect: "manual" });
      clearTimeout(timer);
      checks.push({ name: "Health URL", passed: health.status >= 200 && health.status < 400, detail: `HTTP ${health.status}` });
    }

    const passed = checks.every((check) => check.passed);
    return response.status(passed ? 200 : 409).json({ success: passed, checks });
  } catch (error) {
    return errorResponse(response, error);
  }
});

router.post("/sites/:siteId/update", async (request, response) => {
  try {
    const site = await deployment.loadSite(request.params.siteId);
    deployment.validateAppPath(site.appPath, { mustExist: true });
    deployment.normalizeGithubRepository(site.repositoryUrl);
    deployment.validateBranch(site.branch);
    const manager = deployment.validateProcessManager(site.processManager);
    deployment.validateProcessName(site.processName, manager);
    deployment.validateHealthUrl(site.healthUrl || "");

    const active = await query(
      `
        SELECT id, status
        FROM backend_deployment_runs
        WHERE site_id = $1
          AND status IN ('queued','running')
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [site.id]
    );

    if (active.rows[0]) {
      return response.status(409).json({
        success: false,
        code: "DEPLOYMENT_ALREADY_RUNNING",
        message: "An update is already queued or running for this site.",
        run: active.rows[0],
      });
    }

    const runId = deployment.identifier("deployrun");
    await query(
      `
        INSERT INTO backend_deployment_runs (
          id, site_id, status, trigger_type, requested_by,
          organization_id, project_id, environment_id, summary_json
        )
        VALUES ($1,$2,'queued','manual',$3,$4,$5,$6,'{}'::jsonb)
      `,
      [
        runId,
        site.id,
        request.user?.id || null,
        site.organizationId || "org_goodos",
        site.projectId || "proj_goodos_platform",
        site.environmentId || "env_goodos_production",
      ]
    );

    await query(
      `UPDATE backend_deployment_sites SET last_run_id = $2, status = 'queued', updated_at = NOW() WHERE id = $1`,
      [site.id, runId]
    );

    await deployment.addEvent(runId, "queued", `Update requested by ${request.user?.email || "owner"}.`);

    const workerPath = path.join(process.cwd(), "scripts", "run-site-deployment.js");
    const child = spawn(process.execPath, [workerPath, runId], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();

    await audit(request, "deployment.site.update_requested", site.id, { runId });

    return response.status(202).json({
      success: true,
      runId,
      status: "queued",
      message: "Site update was queued.",
    });
  } catch (error) {
    return errorResponse(response, error);
  }
});

router.post("/runs/:runId/recover-stale", async (request, response) => {
  const runId = String(request.params.runId || "").trim();
  const lockClient = await pool.connect();
  let lockHeld = false;
  let lockKey = "";

  try {
    const runResult = await lockClient.query(
      `
        SELECT
          run.id,
          run.site_id AS "siteId",
          run.status,
          run.updated_at AS "updatedAt",
          site.name AS "siteName"
        FROM backend_deployment_runs run
        JOIN backend_deployment_sites site ON site.id = run.site_id
        WHERE run.id = $1
        LIMIT 1
      `,
      [runId]
    );
    const run = runResult.rows[0];
    if (!run) {
      return response.status(404).json({
        success: false,
        code: "DEPLOYMENT_RUN_NOT_FOUND",
        message: "Deployment run was not found.",
      });
    }

    if (!["queued", "running"].includes(run.status)) {
      return response.json({ success: true, recovered: false, run });
    }

    const ageMs = Date.now() - new Date(run.updatedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < STALE_DEPLOYMENT_AGE_MS) {
      return response.status(409).json({
        success: false,
        code: "DEPLOYMENT_RUN_NOT_STALE",
        message: "This deployment is still recent. Wait for it to finish before recovering it.",
      });
    }

    lockKey = `goodos-deployment:${run.siteId}`;
    const lockResult = await lockClient.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [lockKey]
    );
    lockHeld = lockResult.rows[0]?.locked === true;
    if (!lockHeld) {
      return response.status(409).json({
        success: false,
        code: "DEPLOYMENT_WORKER_ACTIVE",
        message: "The deployment worker is still active, so this run cannot be recovered yet.",
      });
    }

    await lockClient.query("BEGIN");
    await lockClient.query(
      `
        UPDATE backend_deployment_runs
        SET
          status = 'failed',
          completed_at = NOW(),
          error_message = 'Recovered after the deployment worker stopped reporting progress.',
          summary_json = COALESCE(summary_json, '{}'::jsonb) ||
            '{"staleRunRecovered":true}'::jsonb,
          updated_at = NOW()
        WHERE id = $1
          AND status IN ('queued','running')
      `,
      [run.id]
    );
    await lockClient.query(
      `
        UPDATE backend_deployment_sites
        SET status = 'ready', updated_at = NOW()
        WHERE id = $1
          AND last_run_id = $2
      `,
      [run.siteId, run.id]
    );
    await lockClient.query("COMMIT");

    await deployment.addEvent(
      run.id,
      "recovery",
      `Stale deployment recovered by ${request.user?.email || "owner"}.`,
      "warning"
    );
    await audit(request, "deployment.run.recover_stale", run.siteId, {
      runId: run.id,
      previousStatus: run.status,
    });

    return response.json({
      success: true,
      recovered: true,
      runId: run.id,
      siteId: run.siteId,
    });
  } catch (error) {
    await lockClient.query("ROLLBACK").catch(() => {});
    return errorResponse(response, error);
  } finally {
    if (lockHeld && lockKey) {
      await lockClient
        .query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey])
        .catch(() => {});
    }
    lockClient.release();
  }
});

router.post("/sites/:siteId/restart-goodbase-services", async (request, response) => {
  try {
    const site = await deployment.loadSite(request.params.siteId);
    const isCanonicalGoodBase =
      site.appId === "goodbase" &&
      site.name === "GoodBase" &&
      path.resolve(site.appPath || "") === "/var/www/GoodBase";

    if (!isCanonicalGoodBase) {
      return response.status(403).json({
        success: false,
        code: "GOODBASE_RESTART_TARGET_REQUIRED",
        message: "Only the canonical GoodBase production mapping can restart GoodBase services.",
      });
    }

    const workerPath = path.join(
      process.cwd(),
      "scripts",
      "restart-goodbase-services.js"
    );
    const child = spawn(process.execPath, [workerPath], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();

    await audit(request, "deployment.goodbase.restart_requested", site.id, {
      processes: ["goodbase-worker", "goodbase-api-ha", "goodbase-api"],
    });

    return response.status(202).json({
      success: true,
      status: "scheduled",
      message: "GoodBase service restart was scheduled.",
    });
  } catch (error) {
    return errorResponse(response, error);
  }
});

router.delete("/sites/:siteId", async (request, response) => {
  try {
    const site = await deployment.loadSite(request.params.siteId);
    if (site.appId) {
      return response.status(403).json({
        success: false,
        code: "REGISTERED_SITE_DELETE_BLOCKED",
        message: "Registered application mappings cannot be removed.",
      });
    }

    const active = await query(
      `
        SELECT id
        FROM backend_deployment_runs
        WHERE site_id = $1
          AND status IN ('queued','running')
        LIMIT 1
      `,
      [site.id]
    );
    if (active.rows[0]) {
      return response.status(409).json({
        success: false,
        code: "DEPLOYMENT_ALREADY_RUNNING",
        message: "Recover or finish the active deployment before removing this mapping.",
      });
    }

    await audit(request, "deployment.site.remove_temporary", site.id, {
      name: site.name,
      domain: site.domain,
      appPath: site.appPath,
    });
    await query("DELETE FROM backend_deployment_sites WHERE id = $1", [site.id]);
    return response.json({ success: true, removed: true, siteId: site.id });
  } catch (error) {
    return errorResponse(response, error);
  }
});

router.get("/runs", async (request, response) => {
  try {
    const siteId = String(request.query.siteId || "").trim();
    const params = [];
    let where = "";

    if (siteId) {
      params.push(siteId);
      where = "WHERE run.site_id = $1";
    }

    const result = await query(
      `
        SELECT
          run.id,
          run.site_id AS "siteId",
          site.name AS "siteName",
          site.domain,
          run.status,
          run.trigger_type AS "triggerType",
          run.previous_commit AS "previousCommit",
          run.target_commit AS "targetCommit",
          run.deployed_commit AS "deployedCommit",
          run.rollback_commit AS "rollbackCommit",
          run.started_at AS "startedAt",
          run.completed_at AS "completedAt",
          run.error_message AS "errorMessage",
          run.created_at AS "createdAt"
        FROM backend_deployment_runs run
        JOIN backend_deployment_sites site ON site.id = run.site_id
        ${where}
        ORDER BY run.created_at DESC
        LIMIT 100
      `,
      params
    );

    return response.json({ success: true, runs: result.rows });
  } catch (error) {
    return errorResponse(response, error);
  }
});

router.get("/runs/:runId", async (request, response) => {
  try {
    const run = await deployment.loadRun(request.params.runId);
    const events = await query(
      `
        SELECT id, level, step, message, metadata_json AS metadata, created_at AS "createdAt"
        FROM backend_deployment_events
        WHERE run_id = $1
        ORDER BY created_at ASC
        LIMIT 1000
      `,
      [run.id]
    );

    return response.json({ success: true, run, events: events.rows });
  } catch (error) {
    return errorResponse(response, error);
  }
});

module.exports = router;
