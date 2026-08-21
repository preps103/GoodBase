"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const mode = process.argv.includes("--write") ? "write" : "check";
const goodbaseRoot = path.resolve(__dirname, "..");
const repositoriesRoot = path.resolve(
  process.env.GOODOS_REPOSITORIES_ROOT || path.join(goodbaseRoot, ".."),
);
const manifest = require(path.join(goodbaseRoot, "deploy", "application-paths.json"));
const sourceRoot = path.join(goodbaseRoot, "vendor", "goodos-sites-hosting");
const files = ["package.json", "README.md", "prepare-sites.mjs", "sites-worker.js"];
const applications = manifest.applications.filter((application) => application.status === "active");

function checksum(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const report = {
  discoveredApplications: applications.length,
  auditedApplications: 0,
  canonicalHostingSnapshots: 0,
  sitesProjects: 0,
  missingRepositories: [],
  missingProjects: [],
  projectDrift: [],
  drift: [],
  updated: [],
};

for (const application of applications) {
  const repositoryRoot = path.join(repositoriesRoot, application.localDirectory);
  if (!fs.existsSync(repositoryRoot)) {
    report.missingRepositories.push(application.localDirectory);
    continue;
  }

  report.auditedApplications += 1;
  const targetRoot = path.join(repositoryRoot, "vendor", "goodos-sites-hosting");
  let canonical = true;

  for (const fileName of files) {
    const source = path.join(sourceRoot, fileName);
    const target = path.join(targetRoot, fileName);
    const matches = fs.existsSync(target) && checksum(source) === checksum(target);
    if (matches) continue;
    canonical = false;
    if (mode === "write") {
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.copyFileSync(source, target);
      report.updated.push(`${application.id}:vendor/goodos-sites-hosting/${fileName}`);
      canonical = true;
    } else {
      report.drift.push(`${application.id}:vendor/goodos-sites-hosting/${fileName}`);
    }
  }

  if (canonical) report.canonicalHostingSnapshots += 1;

  const hostingPath = path.join(repositoryRoot, ".openai", "hosting.json");
  let hosting = {};
  try {
    hosting = JSON.parse(fs.readFileSync(hostingPath, "utf8"));
  } catch {
    report.missingProjects.push(`${application.id}:.openai/hosting.json`);
  }
  if (typeof hosting.project_id === "string" && hosting.project_id.length > 0) {
    report.sitesProjects += 1;
    if (hosting.project_id !== application.hostingProjectId) {
      report.projectDrift.push(
        `${application.id}: expected ${application.hostingProjectId}, found ${hosting.project_id}`,
      );
    }
  } else if (!report.missingProjects.includes(`${application.id}:.openai/hosting.json`)) {
    report.missingProjects.push(`${application.id}:project_id`);
  }
}

console.log("GoodOS Sites Hosting Audit");
console.log("--------------------------");
console.log(`Discovered applications: ${report.discoveredApplications}`);
console.log(`Audited applications: ${report.auditedApplications}`);
console.log(`Canonical hosting snapshots: ${report.canonicalHostingSnapshots}`);
console.log(`Sites projects: ${report.sitesProjects}`);
console.log(`Hosting drift: ${report.drift.length}`);
console.log(`Missing repositories: ${report.missingRepositories.length}`);
console.log(`Missing Sites projects: ${report.missingProjects.length}`);
console.log(`Sites project drift: ${report.projectDrift.length}`);

if (mode === "write" && report.updated.length > 0) {
  console.log(`Updated hosting files: ${report.updated.length}`);
}

const failed =
  report.auditedApplications !== report.discoveredApplications ||
  report.canonicalHostingSnapshots !== report.discoveredApplications ||
  report.sitesProjects !== report.discoveredApplications ||
  report.drift.length > 0 ||
  report.missingRepositories.length > 0 ||
  report.missingProjects.length > 0 ||
  report.projectDrift.length > 0;

if (failed) {
  if (report.drift.length) console.error(report.drift.join("\n"));
  if (report.missingRepositories.length) console.error(report.missingRepositories.join("\n"));
  if (report.missingProjects.length) console.error(report.missingProjects.join("\n"));
  if (report.projectDrift.length) console.error(report.projectDrift.join("\n"));
  process.exitCode = 1;
} else {
  console.log("PASS: Every active GoodOS application has the canonical Sites hosting contract.");
}
