"use strict";

const database = require("../src/config/database");
const deployment = require("../src/services/site-deployment.service");

const { pool, query } = database;
const APPLY = process.argv.includes("--apply");

async function loadSites() {
  const result = await query(`
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
      status
    FROM backend_deployment_sites
    WHERE status <> 'retired'
    ORDER BY name
  `);
  return result.rows;
}

async function main() {
  const canonical = deployment.canonicalDeploymentSites();
  if (canonical.length !== 17) {
    throw new Error(`Expected 17 canonical sites; found ${canonical.length}.`);
  }

  if (APPLY) {
    await deployment.reconcileCanonicalDeploymentSites();
  }

  const [sites, targets] = await Promise.all([
    loadSites(),
    deployment.discoverServerApps(),
  ]);
  const canonicalIds = new Set(canonical.map((site) => site.appId));
  const activeCanonicalSites = sites.filter((site) => canonicalIds.has(site.appId));
  const assessments = activeCanonicalSites.map((site) => ({
    appId: site.appId,
    name: site.name,
    domain: site.domain,
    repositoryUrl: site.repositoryUrl,
    appPath: site.appPath,
    processName: site.processName,
    ...deployment.assessSiteConfiguration(site, targets),
  }));

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "APPLY" : "CHECK_ONLY",
        expectedSites: canonical.length,
        mappedSites: activeCanonicalSites.length,
        readySites: assessments.filter((site) => site.ready).length,
        sites: assessments,
      },
      null,
      2
    )
  );

  if (activeCanonicalSites.length !== canonical.length) {
    throw new Error(
      `Canonical mapping count is ${activeCanonicalSites.length}; expected ${canonical.length}. Run with --apply.`
    );
  }

  const notReady = assessments.filter((site) => !site.ready);
  if (notReady.length) {
    throw new Error(
      `Deployment access or process alignment needs attention for: ${notReady
        .map((site) => `${site.name} (${site.issues.join(" ")})`)
        .join(", ")}`
    );
  }

  console.log(`PASS: All ${canonical.length} GoodApp deployment mappings are aligned.`);
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
