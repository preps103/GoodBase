#!/usr/bin/env node
"use strict";

const database = require("../src/config/database");
const { preserveEvidence, validCommit } = require("./lib/goodbase-evidence");

const repository = process.env.GOODBASE_GITHUB_REPOSITORY || "preps103/GoodBase";
const commit = String(process.env.GOODBASE_RELEASE_COMMIT || "").toLowerCase();
const requiredRunId = process.env.GOODBASE_REQUIRED_CI_RUN_ID;
const assuranceRunId = process.env.GOODBASE_ASSURANCE_RUN_ID;
const sdkConformanceRunId = process.env.GOODBASE_SDK_CONFORMANCE_RUN_ID;
const token = process.env.GITHUB_TOKEN || "";

function requireValue(name, value) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function github(pathname) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "goodbase-release-verifier" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${repository}${pathname}`, {
    headers,
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`GitHub verification failed with HTTP ${response.status}.`);
  return response.json();
}

async function verifyRun(runId, expectedName, artifactPrefix) {
  if (!/^\d+$/.test(String(runId))) throw new Error(`${expectedName} run ID is invalid.`);
  const [run, artifactPage] = await Promise.all([
    github(`/actions/runs/${runId}`),
    github(`/actions/runs/${runId}/artifacts?per_page=100`)
  ]);
  const artifacts = (artifactPage.artifacts || []).filter((artifact) => !artifact.expired);
  if (run.name !== expectedName) throw new Error(`Run ${runId} is ${run.name}, not ${expectedName}.`);
  if (String(run.head_sha).toLowerCase() !== commit) throw new Error(`Run ${runId} does not match release ${commit}.`);
  if (run.status !== "completed" || run.conclusion !== "success") throw new Error(`Run ${runId} has not succeeded.`);
  if (!artifacts.some((artifact) => artifact.name.startsWith(artifactPrefix))) throw new Error(`Run ${runId} is missing retained ${artifactPrefix} evidence.`);
  return {
    runId: Number(run.id),
    workflow: run.name,
    url: run.html_url,
    conclusion: run.conclusion,
    completedAt: run.updated_at,
    artifacts: artifacts.map(({ id, name, size_in_bytes: sizeBytes, expired }) => ({ id, name, sizeBytes, expired }))
  };
}

async function main() {
  if (!validCommit(commit) || commit.length !== 40) throw new Error("GOODBASE_RELEASE_COMMIT must be the exact 40-character Git commit.");
  requireValue("GOODBASE_REQUIRED_CI_RUN_ID", requiredRunId);
  requireValue("GOODBASE_ASSURANCE_RUN_ID", assuranceRunId);
  requireValue("GOODBASE_SDK_CONFORMANCE_RUN_ID", sdkConformanceRunId);
  const runs = await Promise.all([
    verifyRun(requiredRunId, "Goodbase Required CI", "goodbase-required-ci-"),
    verifyRun(assuranceRunId, "Goodbase Assurance", "goodbase-release-evidence"),
    verifyRun(sdkConformanceRunId, "Goodbase SDK Conformance", "goodbase-sdk-conformance-")
  ]);
  const report = { schemaVersion: 1, verifiedAt: new Date().toISOString(), repository, releaseCommit: commit, status: "passed", runs };
  report.evidence = await preserveEvidence({ type: "ci", commit, status: "passed", report, database });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "error", message: error.message })}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await database.pool?.end?.().catch(() => {});
});
