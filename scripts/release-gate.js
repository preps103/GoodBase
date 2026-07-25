"use strict";

const crypto =
  require("crypto");

const fs =
  require("fs");

const os =
  require("os");

const path =
  require("path");

const {
  spawnSync,
} =
  require("child_process");

const database =
  require("../src/config/database");

const {
  query,
} =
  database;

const APP_DIR =
  "/var/www/GoodBase";

const FRONTEND_DIR =
  "/home/mgoodlo3/GoodOS";

const RELEASE_ROOT =
  "/var/lib/goodos/releases";

function run(
  command,
  args,
  options = {}
) {
  const result =
    spawnSync(
      command,
      args,
      {
        encoding:
          "utf8",
        timeout:
          options.timeout ||
          30000,
        ...options,
      }
    );

  if (
    result.error ||
    result.status !== 0
  ) {
    const message =
      String(
        result.stderr ||
        result.stdout ||
        result.error?.message ||
        `${command} failed`
      )
      .trim();

    throw new Error(message);
  }

  return String(
    result.stdout || ""
  ).trim();
}

function sha256File(
  filePath
) {
  if (
    !filePath ||
    !fs.existsSync(filePath)
  ) {
    return null;
  }

  return crypto
    .createHash("sha256")
    .update(
      fs.readFileSync(
        filePath
      )
    )
    .digest("hex");
}

function gitInfo(
  repository
) {
  const statusOutput =
    run(
      "git",
      [
        "-C",
        repository,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]
    );

  const statusLines =
    statusOutput
      ? statusOutput
          .split("\n")
          .filter(Boolean)
      : [];

  return {
    path:
      repository,

    branch:
      run(
        "git",
        [
          "-C",
          repository,
          "branch",
          "--show-current",
        ]
      ),

    commit:
      run(
        "git",
        [
          "-C",
          repository,
          "rev-parse",
          "HEAD",
        ]
      ),

    dirtyCount:
      statusLines.length,

    changedFiles:
      statusLines
        .map(
          line =>
            line.slice(3)
        )
        .slice(0, 500),
  };
}

function pm2State() {
  const processes =
    JSON.parse(
      run(
        "pm2",
        ["jlist"],
        {
          timeout:
            15000,
        }
      )
    );

  return [
    "goodapp-backend",
    "goodapp-worker-v3",
    "goodos",
  ].map(name => {
    const process =
      processes.find(
        item =>
          item.name === name
      );

    return {
      name,
      status:
        process?.pm2_env?.status ||
        "missing",
      pid:
        process?.pid ||
        null,
      restarts:
        process?.pm2_env
          ?.restart_time ??
        null,
      unstableRestarts:
        process?.pm2_env
          ?.unstable_restarts ??
        null,
    };
  });
}

async function operationsState(
  organizationId
) {
  const result =
    await query(
      `
        SELECT DISTINCT ON (
          check_key
        )
          check_key
            AS "checkKey",
          status,
          message,
          checked_at
            AS "checkedAt"

        FROM backend_operations_checks

        WHERE organization_id =
              $1

          AND checked_at >=
              NOW() -
              INTERVAL '30 minutes'

        ORDER BY
          check_key,
          checked_at DESC
      `,
      [
        organizationId,
      ]
    );

  return result.rows;
}

async function latestBackup() {
  const result =
    await query(
      `
        SELECT MAX(completed_at)
                 AS "completedAt"

        FROM (
          SELECT
            COALESCE(
              verified_at,
              created_at
            ) AS completed_at

          FROM backend_database_backups

          WHERE status =
                'completed'

          UNION ALL

          SELECT
            COALESCE(
              completed_at,
              created_at
            ) AS completed_at

          FROM backend_backup_inventory

          WHERE status =
                'completed'
        ) completed_backups
      `
    );

  return result.rows[0]
    ?.completedAt ||
    null;
}

function identifier(
  prefix
) {
  return (
    `${prefix}_` +
    crypto.randomUUID()
      .replaceAll("-", "")
  );
}

async function createBaseline() {
  const releaseId =
    String(
      process.env
        .GOODOS_RELEASE_ID ||
      ""
    ).trim();

  const versionLabel =
    String(
      process.env
        .GOODOS_RELEASE_VERSION ||
      ""
    ).trim();

  const rollbackPath =
    String(
      process.env
        .GOODOS_RELEASE_ROLLBACK_PATH ||
      ""
    ).trim();

  if (
    !releaseId ||
    !versionLabel ||
    !rollbackPath
  ) {
    throw new Error(
      "Baseline release environment is incomplete."
    );
  }

  if (
    !fs.existsSync(
      rollbackPath
    )
  ) {
    throw new Error(
      "Baseline rollback path does not exist."
    );
  }

  const policyResult =
    await query(
      `
        SELECT
          policy.organization_id
            AS "organizationId",

          membership.user_id
            AS "ownerId"

        FROM backend_release_policies
             AS policy

        JOIN backend_organization_memberships
             AS membership
          ON membership.organization_id =
             policy.organization_id

        JOIN users
          ON users.id =
             membership.user_id

        WHERE membership.status =
              'active'

          AND users.status =
              'active'

          AND users.platform_role =
              'owner'

        ORDER BY membership.created_at ASC

        LIMIT 1
      `
    );

  const identity =
    policyResult.rows[0];

  if (!identity) {
    throw new Error(
      "Release owner and organization could not be resolved."
    );
  }

  const tenantResult =
    await query(
      `
        SELECT
          project.id
            AS "projectId",

          environment.id
            AS "environmentId"

        FROM backend_projects
             AS project

        JOIN backend_project_environments
             AS environment
          ON environment.project_id =
             project.id

        WHERE project.organization_id =
              $1

          AND environment.type =
              'production'

          AND environment.status =
              'active'

        ORDER BY
          project.created_at ASC,
          environment.created_at ASC

        LIMIT 1
      `,
      [
        identity.organizationId,
      ]
    );

  const tenant =
    tenantResult.rows[0];

  if (
    !tenant?.projectId ||
    !tenant?.environmentId
  ) {
    throw new Error(
      "Release tenant context is incomplete."
    );
  }

  const backend =
    gitInfo(APP_DIR);

  const frontend =
    gitInfo(FRONTEND_DIR);

  const operations =
    await operationsState(
      identity.organizationId
    );

  const latestBackupAt =
    await latestBackup();

  const processes =
    pm2State();

  run(
    "nginx",
    ["-t"],
    {
      timeout:
        15000,
    }
  );

  const releaseDirectory =
    path.join(
      RELEASE_ROOT,
      releaseId
    );

  fs.mkdirSync(
    releaseDirectory,
    {
      recursive: true,
      mode:
        0o700,
    }
  );

  const manifestPath =
    path.join(
      releaseDirectory,
      "manifest.json"
    );

  const manifest = {
    releaseId,
    versionLabel,
    releaseType:
      "baseline",
    capturedAt:
      new Date()
        .toISOString(),
    host:
      os.hostname(),
    runtime: {
      node:
        process.version,
      platform:
        process.platform,
      architecture:
        process.arch,
    },
    backend,
    frontend,
    sourceSnapshots: {
      backendSha256:
        process.env
          .GOODOS_BACKEND_SOURCE_SHA ||
        null,
      frontendSha256:
        process.env
          .GOODOS_FRONTEND_SOURCE_SHA ||
        null,
    },
    database: {
      backupSha256:
        process.env
          .GOODOS_DATABASE_BACKUP_SHA ||
        null,
      schemaSha256:
        process.env
          .GOODOS_SCHEMA_SHA ||
        null,
    },
    processState: {
      pm2SnapshotSha256:
        process.env
          .GOODOS_PM2_SHA ||
        null,
      processes,
    },
    nginx: {
      configurationValid:
        true,
      snapshotSha256:
        process.env
          .GOODOS_NGINX_SHA ||
        null,
    },
    operations,
    latestBackupAt,
    rollbackPath,
  };

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      manifest,
      null,
      2
    ) + "\n",
    {
      mode:
        0o600,
    }
  );

  const manifestSha =
    sha256File(
      manifestPath
    );

  await query(
    `
      INSERT INTO backend_releases (
        id,
        organization_id,
        project_id,
        environment_id,
        version_label,
        release_type,
        status,
        approval_status,
        backend_commit,
        frontend_commit,
        backend_branch,
        frontend_branch,
        backend_dirty_count,
        frontend_dirty_count,
        backend_source_sha256,
        frontend_source_sha256,
        database_backup_sha256,
        schema_sha256,
        manifest_sha256,
        rollback_path,
        manifest_path,
        created_by,
        approved_by,
        approved_at,
        deployed_at,
        metadata_json
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        'baseline',
        'deployed',
        'baseline',
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19,
        $19,
        NOW(),
        NOW(),
        $20::jsonb
      )
      ON CONFLICT (id)
      DO NOTHING
    `,
    [
      releaseId,
      identity.organizationId,
      tenant.projectId,
      tenant.environmentId,
      versionLabel,
      backend.commit,
      frontend.commit,
      backend.branch,
      frontend.branch,
      backend.dirtyCount,
      frontend.dirtyCount,
      manifest.sourceSnapshots
        .backendSha256,
      manifest.sourceSnapshots
        .frontendSha256,
      manifest.database
        .backupSha256,
      manifest.database
        .schemaSha256,
      manifestSha,
      rollbackPath,
      manifestPath,
      identity.ownerId,
      JSON.stringify({
        dirtyProductionBaseline:
          true,
        futureStandardReleasesRequireCleanGit:
          true,
      }),
    ]
  );

  await query(
    `
      INSERT INTO backend_release_deployments (
        id,
        release_id,
        organization_id,
        project_id,
        environment_id,
        status,
        completed_at,
        backend_pid_after,
        health_evidence_json,
        rollback_path,
        created_by
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        'succeeded',
        NOW(),
        $6,
        $7::jsonb,
        $8,
        $9
      )
    `,
    [
      identifier(
        "deployment"
      ),
      releaseId,
      identity.organizationId,
      tenant.projectId,
      tenant.environmentId,
      processes.find(
        item =>
          item.name ===
          "goodapp-backend"
      )?.pid ||
        null,
      JSON.stringify({
        operations,
        processes,
        nginxConfigurationValid:
          true,
      }),
      rollbackPath,
      identity.ownerId,
    ]
  );

  const migrationDirectory =
    path.join(
      APP_DIR,
      "migrations"
    );

  if (
    fs.existsSync(
      migrationDirectory
    )
  ) {
    const files =
      fs.readdirSync(
        migrationDirectory
      )
      .filter(
        file =>
          file.endsWith(".sql")
      )
      .sort();

    for (const fileName of files) {
      const fullPath =
        path.join(
          migrationDirectory,
          fileName
        );

      await query(
        `
          INSERT INTO backend_migration_ledger (
            id,
            organization_id,
            project_id,
            environment_id,
            release_id,
            file_name,
            checksum_sha256,
            status,
            metadata_json
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            'observed',
            jsonb_build_object(
              'baselineInventory',
              true
            )
          )
          ON CONFLICT (
            organization_id,
            file_name
          )
          DO UPDATE SET
            checksum_sha256 =
              EXCLUDED.checksum_sha256,
            release_id =
              EXCLUDED.release_id,
            updated_at =
              NOW()
        `,
        [
          identifier(
            "migration"
          ),
          identity.organizationId,
          tenant.projectId,
          tenant.environmentId,
          releaseId,
          fileName,
          sha256File(
            fullPath
          ),
        ]
      );
    }
  }

  await query(
    `
      INSERT INTO audit_logs (
        user_id,
        action,
        entity_type,
        entity_id,
        metadata
      )
      VALUES (
        $1,
        'release.phase8.baseline_recorded',
        'release',
        $2,
        $3::jsonb
      )
    `,
    [
      identity.ownerId,
      releaseId,
      JSON.stringify({
        versionLabel,
        backendCommit:
          backend.commit,
        frontendCommit:
          frontend.commit,
        backendDirtyCount:
          backend.dirtyCount,
        frontendDirtyCount:
          frontend.dirtyCount,
        manifestSha256:
          manifestSha,
        rollbackPath,
      }),
    ]
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        action:
          "baseline",
        releaseId,
        versionLabel,
        manifestPath,
        manifestSha256:
          manifestSha,
        backendDirtyCount:
          backend.dirtyCount,
        frontendDirtyCount:
          frontend.dirtyCount,
      },
      null,
      2
    )
  );
}

async function preflight(
  releaseId
) {
  if (!releaseId) {
    throw new Error(
      "Release ID is required."
    );
  }

  const result =
    await query(
      `
        SELECT
          release.id,
          release.organization_id
            AS "organizationId",
          release.project_id
            AS "projectId",
          release.environment_id
            AS "environmentId",
          release.change_request_id
            AS "changeRequestId",
          release.version_label
            AS "versionLabel",
          release.release_type
            AS "releaseType",
          release.status,
          release.approval_status
            AS "approvalStatus",
          release.backend_commit
            AS "backendCommit",
          release.frontend_commit
            AS "frontendCommit",
          release.rollback_path
            AS "rollbackPath",
          release.manifest_path
            AS "manifestPath",
          change_request.status
            AS "changeRequestStatus",
          policy.approval_required
            AS "approvalRequired",
          policy.operations_health_required
            AS "operationsHealthRequired",
          policy.fresh_backup_required
            AS "freshBackupRequired",
          policy.backup_max_age_hours
            AS "backupMaxAgeHours",
          policy.clean_git_required
            AS "cleanGitRequired",
          policy.dirty_baseline_allowed
            AS "dirtyBaselineAllowed",
          policy.source_snapshot_required
            AS "sourceSnapshotRequired",
          policy.schema_snapshot_required
            AS "schemaSnapshotRequired",
          policy.rollback_path_required
            AS "rollbackPathRequired"

        FROM backend_releases
             AS release

        JOIN backend_release_policies
             AS policy
          ON policy.organization_id =
             release.organization_id

        LEFT JOIN backend_change_requests
                  AS change_request
          ON change_request.id =
             release.change_request_id

        WHERE release.id =
              $1

        LIMIT 1
      `,
      [
        releaseId,
      ]
    );

  const release =
    result.rows[0];

  if (!release) {
    throw new Error(
      "Release was not found."
    );
  }

  const failures = [];

  const isBaseline =
    release.releaseType ===
    "baseline";

  if (!isBaseline) {
    if (
      release.approvalRequired &&
      (
        release.status !==
          "approved" ||
        release.approvalStatus !==
          "approved"
      )
    ) {
      failures.push(
        "Release is not approved."
      );
    }

    if (
      release.changeRequestId &&
      release.changeRequestStatus !==
        "approved"
    ) {
      failures.push(
        "Change request is not approved."
      );
    }
  }

  if (
    release.rollbackPathRequired &&
    (
      !release.rollbackPath ||
      !fs.existsSync(
        release.rollbackPath
      )
    )
  ) {
    failures.push(
      "Rollback package is missing."
    );
  }

  if (
    !release.manifestPath ||
    !fs.existsSync(
      release.manifestPath
    )
  ) {
    failures.push(
      "Release manifest is missing."
    );
  }

  const backend =
    gitInfo(APP_DIR);

  const frontend =
    gitInfo(FRONTEND_DIR);

  if (
    release.cleanGitRequired &&
    !isBaseline
  ) {
    if (
      backend.dirtyCount !== 0 ||
      frontend.dirtyCount !== 0
    ) {
      failures.push(
        "Future standard releases require clean backend and frontend Git working trees."
      );
    }

    if (
      release.backendCommit &&
      backend.commit !==
        release.backendCommit
    ) {
      failures.push(
        "Backend commit no longer matches the release record."
      );
    }

    if (
      release.frontendCommit &&
      frontend.commit !==
        release.frontendCommit
    ) {
      failures.push(
        "Frontend commit no longer matches the release record."
      );
    }
  }

  const operations =
    await operationsState(
      release.organizationId
    );

  if (
    release.operationsHealthRequired
  ) {
    if (
      operations.length !== 7
    ) {
      failures.push(
        "Seven fresh operations checks are required."
      );
    }

    const unhealthy =
      operations.filter(
        check =>
          check.status !==
          "healthy"
      );

    if (
      unhealthy.length > 0
    ) {
      failures.push(
        "Operations checks are not fully healthy."
      );
    }
  }

  const completedAt =
    await latestBackup();

  let backupAgeHours =
    null;

  if (completedAt) {
    backupAgeHours =
      (
        Date.now() -
        new Date(
          completedAt
        ).getTime()
      ) /
      3600000;
  }

  if (
    release.freshBackupRequired &&
    (
      backupAgeHours === null ||
      backupAgeHours >
        Number(
          release.backupMaxAgeHours
        )
    )
  ) {
    failures.push(
      "A fresh verified backup is required."
    );
  }

  let processes = [];

  try {
    processes =
      pm2State();

    const offline =
      processes.filter(
        item =>
          item.status !==
          "online"
      );

    if (
      offline.length > 0
    ) {
      failures.push(
        "Required PM2 processes are not online."
      );
    }
  } catch (error) {
    failures.push(
      `PM2 verification failed: ${error.message}`
    );
  }

  try {
    run(
      "nginx",
      ["-t"],
      {
        timeout:
          15000,
      }
    );
  } catch (error) {
    failures.push(
      `Nginx verification failed: ${error.message}`
    );
  }

  const evidence = {
    success:
      failures.length === 0,
    releaseId:
      release.id,
    versionLabel:
      release.versionLabel,
    releaseType:
      release.releaseType,
    status:
      release.status,
    approvalStatus:
      release.approvalStatus,
    backend,
    frontend,
    operations,
    latestBackupAt:
      completedAt,
    backupAgeHours,
    processes,
    rollbackPath:
      release.rollbackPath,
    manifestPath:
      release.manifestPath,
    failures,
    checkedAt:
      new Date()
        .toISOString(),
  };

  console.log(
    JSON.stringify(
      evidence,
      null,
      2
    )
  );

  if (
    failures.length > 0
  ) {
    process.exitCode = 2;
  }
}

async function main() {
  const [
    command,
    argument,
  ] =
    process.argv.slice(2);

  if (
    command ===
    "baseline"
  ) {
    await createBaseline();
    return;
  }

  if (
    command ===
    "preflight"
  ) {
    await preflight(
      argument
    );
    return;
  }

  throw new Error(
    "Usage: goodos-release-gate baseline | preflight <release-id>"
  );
}

main()
  .catch(error => {
    console.error(
      `GOODOS RELEASE GATE ERROR: ${error.message}`
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    if (
      database.pool &&
      typeof database.pool.end ===
        "function"
    ) {
      await database.pool.end();
    }
  });
