"use strict";

const assert=require("node:assert/strict");const fs=require("node:fs");const path=require("node:path");const test=require("node:test");
const root=path.resolve(__dirname,"..");const read=file=>fs.readFileSync(path.join(root,file),"utf8");
const migration=read("migrations/20260721_goodbase_phases26_30.sql");const routes=read("src/routes/goodbase-growth.routes.js");const service=read("src/services/goodbase-growth.service.js");const jobs=read("src/services/job.service.js");

test("Phase 26 stores reliability and security evidence and provides guarded load and chaos runners",()=>{
  for(const table of ["goodbase_assurance_suites","goodbase_assurance_runs","goodbase_assurance_checks","goodbase_capacity_baselines","goodbase_incident_exercises"])assert.match(migration,new RegExp(table));
  assert.match(service,/runtime-role-no-rls-bypass/);assert.match(service,/tenant-force-rls/);assert.match(read("scripts/goodbase-load.js"),/GOODBASE_PRODUCTION_LOAD_APPROVED/);assert.match(read("scripts/goodbase-chaos.js"),/GOODBASE_CHAOS_APPROVED/);assert.match(read(".github/workflows/goodbase-assurance.yml"),/gitleaks/);assert.match(read(".github/workflows/goodbase-assurance.yml"),/trivy/);assert.match(read(".github/workflows/goodbase-assurance.yml"),/npm sbom/);
});

test("Phase 27 publishes the handbook, starters, and controller-backed migration workflow",()=>{
  const handbook=read("docs/goodbase/README.md");for(const heading of ["Five-minute quickstart","Authentication","REST and GraphQL","Row-level security","App attestation and messaging","Self-hosting and hardening","Migration paths"])assert.match(handbook,new RegExp(heading));
  for(const starter of ["react","nextjs","flutter","swift","kotlin","multi-tenant"])assert.equal(fs.existsSync(path.join(root,"starters",starter,"README.md")),true);
  for(const source of ["starters/react/src/goodbase.js","starters/nextjs/app/api/session/route.js","starters/flutter/lib/goodbase_app.dart","starters/swift/GoodbaseApp.swift","starters/kotlin/GoodbaseApp.kt","starters/multi-tenant/tenant-context.js"])assert.equal(fs.existsSync(path.join(root,source)),true);
  assert.match(read("scripts/goodbase-import.js"),/firebase_auth/);assert.match(read("scripts/goodbase-import.js"),/supabase/);assert.match(routes,/IMPORT_CONTROLLER_UNAVAILABLE/);
});

test("Phase 28 completes guarded consumer auth without enabling unconfigured providers",()=>{
  assert.match(migration,/goodbase_consumer_auth_providers/);assert.match(migration,/goodbase_sms_deliveries/);assert.match(routes,/\/auth\/anonymous/);assert.match(routes,/\/auth\/phone\/start/);assert.match(routes,/account_upgrade/);assert.match(routes,/verifyConsumerAuthProvider/);assert.match(read("src/public/goodbase-auth.html"),/Sign in to GoodBase/);assert.match(read("src/public/goodbase-auth.html"),/Continue with GoodOS/);
  assert.match(migration,/auth_consumer_google/);assert.match(migration,/auth_consumer_apple/);assert.match(migration,/auth_consumer_passkey/);assert.match(migration,/misconfigured/);
});

test("Phase 29 exchanges one-time provider assertions for short-lived app-bound tokens",()=>{
  for(const table of ["goodbase_attestation_policies","goodbase_attestation_challenges","goodbase_attestation_tokens","goodbase_attestation_events"])assert.match(migration,new RegExp(table));
  assert.match(service,/aud:"goodbase-attestation"/);assert.match(service,/ATTESTATION_REPLAY/);assert.match(service,/Debug attestation is disabled in production/);assert.match(routes,/X-Goodbase-Attestation/);assert.match(read("sdks/swift/Sources/Goodbase/GoodbaseClient.swift"),/exchangeAttestation/);assert.match(read("sdks/dart/lib/goodbase.dart"),/exchangeAttestation/);assert.match(read("sdks/kotlin/src/main/kotlin/app/goodos/goodbase/GoodbaseClient.kt"),/exchangeAttestation/);
});

test("Phase 30 queues provider-backed messaging with audience and suppression controls",()=>{
  for(const table of ["goodbase_messaging_providers","goodbase_messaging_devices","goodbase_messaging_topics","goodbase_messaging_segments","goodbase_messaging_templates","goodbase_messaging_campaigns","goodbase_messaging_deliveries","goodbase_messaging_suppressions"])assert.match(migration,new RegExp(table));
  assert.match(service,/signedProviderRequest/);assert.match(service,/Idempotency-Key/);assert.match(service,/goodbase_messaging_topic_members/);assert.match(service,/goodbase_messaging_suppressions/);assert.match(routes,/Provider saved as misconfigured until its signed health check succeeds/);assert.match(jobs,/goodbase\.messaging\.dispatch/);
});

test("Phase 26-30 routes are mounted behind explicit public and authenticated boundaries",()=>{
  const index=read("src/routes/index.js");assert.match(index,/goodbaseGrowthRoutes\.publicRouter/);assert.match(index,/goodbaseGrowthRoutes\.authenticatedRouter/);assert.match(routes,/authenticatedRouter\.use\(authRequired,tenantContext\)/);assert.match(routes,/authenticatedRouter\.use\(dataPlaneAdminRequired\)/);assert.match(migration,/CREATE POLICY goodbase_tenant_isolation/);assert.match(migration,/CREATE POLICY goodbase_backend_service/);
});
