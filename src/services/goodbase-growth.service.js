"use strict";

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const database = require("../config/database");
const env = require("../config/env");
const { decryptValue, getSecretValue } = require("./secret.service");

const CANONICAL_ORIGIN = "https://base.goodos.app";
const DEFAULT_SCOPE = Object.freeze({
  organizationId: "org_goodos",
  projectId: "proj_goodos_platform",
  environmentId: "env_goodos_production"
});

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function releaseCommit() {
  const value = String(process.env.GOODBASE_RELEASE_COMMIT || "0000000").trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(value) ? value : "0000000";
}

async function timedCheck(key, category, critical, operation, thresholdValue = null) {
  const started = process.hrtime.bigint();
  try {
    const result = await operation();
    return {
      key, category, critical,
      status: result.passed ? "passed" : "failed",
      latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
      observedValue: result.observedValue ?? null,
      thresholdValue,
      detail: result.detail || {}
    };
  } catch (error) {
    return {
      key, category, critical, status: "failed",
      latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
      observedValue: null, thresholdValue,
      detail: { error: String(error.message || error).slice(0, 300) }
    };
  }
}

async function httpBoundary(path, accepted) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${CANONICAL_ORIGIN}${path}`, {
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "Goodbase-Assurance/1.0" }
    });
    return {
      passed: accepted.includes(response.status),
      observedValue: response.status,
      detail: { path, statusCode: response.status }
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runAssuranceSuite({ suiteId = "assurance_daily_security", requestedBy = null, scope = DEFAULT_SCOPE } = {}) {
  const suite = await database.query(
    `SELECT * FROM goodbase_assurance_suites WHERE id=$1 AND enabled=TRUE`, [suiteId]
  );
  if (!suite.rows[0]) throw Object.assign(new Error("Assurance suite is unavailable."), { statusCode: 404 });
  const started = Date.now();
  const run = await database.query(
    `INSERT INTO goodbase_assurance_runs(organization_id,project_id,environment_id,suite_id,git_commit,status,target,requested_by)
     VALUES($1,$2,$3,$4,$5,'running',$6,$7) RETURNING *`,
    [scope.organizationId,scope.projectId,scope.environmentId,suiteId,releaseCommit(),CANONICAL_ORIGIN,requestedBy]
  );
  const checks = await Promise.all([
    timedCheck("liveness","reliability",true,()=>httpBoundary("/api/health/live",[200])),
    timedCheck("readiness","reliability",true,()=>httpBoundary("/api/health/ready",[200])),
    timedCheck("rest-auth-boundary","security",true,()=>httpBoundary("/rest/v1",[401,403])),
    timedCheck("graphql-auth-boundary","security",true,()=>httpBoundary("/graphql/v1",[401,403])),
    timedCheck("management-auth-boundary","security",true,()=>httpBoundary("/api/goodbase/v1/enterprise/overview",[401,403])),
    timedCheck("attestation-auth-boundary","security",true,()=>httpBoundary("/api/goodbase/v1/growth/attestation/policies",[401,403])),
    timedCheck("runtime-role-no-rls-bypass","security",true,async()=>{
      const result=await database.query(`SELECT COUNT(*)::int AS unsafe FROM pg_roles WHERE rolname IN('goodapp_backend_user','goodos_authenticated','goodos_anon') AND rolbypassrls=TRUE`);
      return {passed:Number(result.rows[0].unsafe)===0,observedValue:Number(result.rows[0].unsafe),detail:{unsafeRoles:Number(result.rows[0].unsafe)}};
    },0),
    timedCheck("tenant-force-rls","security",true,async()=>{
      const result=await database.query(`SELECT COUNT(*)::int AS missing FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('goodbase_assurance_runs','goodbase_attestation_policies','goodbase_messaging_devices') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`);
      return {passed:Number(result.rows[0].missing)===0,observedValue:Number(result.rows[0].missing),detail:{missingForceRls:Number(result.rows[0].missing)}};
    },0)
  ]);
  for (const check of checks) {
    await database.query(
      `INSERT INTO goodbase_assurance_checks(run_id,check_key,category,status,critical,latency_ms,observed_value,threshold_value,detail_json)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [run.rows[0].id,check.key,check.category,check.status,check.critical,check.latencyMs,check.observedValue,check.thresholdValue,JSON.stringify(check.detail)]
    );
  }
  const failures=checks.filter((item)=>item.critical&&item.status!=="passed").length;
  const status=failures===0?"passed":"failed";
  const completed=await database.query(
    `UPDATE goodbase_assurance_runs SET status=$2,completed_at=NOW(),duration_ms=$3,summary_json=$4::jsonb WHERE id=$1 RETURNING *`,
    [run.rows[0].id,status,Date.now()-started,JSON.stringify({checks:checks.length,criticalFailures:failures})]
  );
  return {run:completed.rows[0],checks};
}

async function providerSecret(reference) {
  if (!reference) return null;
  if (String(reference).startsWith("secret://")) return getSecretValue(reference);
  if (/^[A-Z][A-Z0-9_]{2,127}$/.test(String(reference))) return process.env[reference] || null;
  return null;
}

async function verifyExternalAssertion(policy, challenge, assertion) {
  if (policy.provider === "debug") {
    const secret = await providerSecret(policy.secret_ref);
    const supplied = String(assertion?.debugToken || "");
    if (!secret || !supplied || secret.length !== supplied.length || !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))) {
      throw Object.assign(new Error("Debug attestation was rejected."), { code: "ATTESTATION_REJECTED", statusCode: 401 });
    }
    return { deviceKey: String(assertion?.deviceKey || `debug:${challenge.id}`), detail: { verdict: "debug-valid" } };
  }
  const url = new URL(policy.provider_url);
  if (url.protocol !== "https:") throw new Error("Attestation provider must use HTTPS.");
  const secret = await providerSecret(policy.secret_ref);
  if (!secret) throw Object.assign(new Error("Attestation provider credential is unavailable."), { code: "ATTESTATION_PROVIDER_MISCONFIGURED" });
  const payload=JSON.stringify({provider:policy.provider,appId:policy.app_id,challengeId:challenge.id,assertion});
  const timestamp=String(Date.now());
  const signature=crypto.createHmac("sha256",secret).update(`${timestamp}.${payload}`).digest("hex");
  const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),10000);
  try {
    const response=await fetch(url,{method:"POST",signal:abort.signal,headers:{"Content-Type":"application/json","X-Goodbase-Timestamp":timestamp,"X-Goodbase-Signature":`sha256=${signature}`},body:payload});
    const body=await response.json().catch(()=>({}));
    if(!response.ok||body.valid!==true||!body.deviceKey)throw Object.assign(new Error("Device attestation was rejected."),{code:"ATTESTATION_REJECTED"});
    return {deviceKey:String(body.deviceKey),detail:{providerRequestId:body.requestId||null,verdict:body.verdict||"valid"}};
  } finally {clearTimeout(timeout);}
}

async function exchangeAttestation({ policy, challenge, assertion }) {
  if (!challenge || challenge.status !== "pending" || new Date(challenge.expires_at) <= new Date()) {
    throw Object.assign(new Error("Attestation challenge is invalid or expired."), { code: "ATTESTATION_CHALLENGE_INVALID", statusCode: 401 });
  }
  if (policy.provider === "debug" && env.nodeEnv === "production") {
    throw Object.assign(new Error("Debug attestation is disabled in production."), { code: "ATTESTATION_DEBUG_DISABLED", statusCode: 403 });
  }
  const verified=await verifyExternalAssertion(policy,challenge,assertion);
  const jti=crypto.randomUUID();const ttl=Number(policy.token_ttl_seconds||300);
  const token=jwt.sign({jti,aud:"goodbase-attestation",appId:policy.app_id,platform:policy.platform,deviceKeyHash:sha256(verified.deviceKey)},env.jwtSecret,{expiresIn:ttl,issuer:"https://base.goodos.app"});
  const client=await database.pool.connect();
  try {
    await client.query("BEGIN");
    const consumed=await client.query(`UPDATE goodbase_attestation_challenges SET status='consumed',verified_at=NOW(),consumed_at=NOW(),device_key_hash=$2 WHERE id=$1 AND status='pending' RETURNING id`,[challenge.id,sha256(verified.deviceKey)]);
    if(!consumed.rows[0])throw Object.assign(new Error("Attestation challenge was already consumed."),{code:"ATTESTATION_REPLAY",statusCode:409});
    await client.query(`INSERT INTO goodbase_attestation_tokens(jti,policy_id,challenge_id,device_key_hash,expires_at) VALUES($1,$2,$3,$4,NOW()+make_interval(secs=>$5))`,[jti,policy.id,challenge.id,sha256(verified.deviceKey),ttl]);
    await client.query("COMMIT");
  } catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  return {token,expiresIn:ttl,jti,detail:verified.detail};
}

async function validateAttestationToken(token,{appId=null}={}) {
  let decoded;
  try {decoded=jwt.verify(token,env.jwtSecret,{audience:"goodbase-attestation",issuer:"https://base.goodos.app"});}
  catch {throw Object.assign(new Error("Attestation token is invalid or expired."),{code:"ATTESTATION_TOKEN_INVALID",statusCode:401});}
  if(appId&&decoded.appId!==appId)throw Object.assign(new Error("Attestation token belongs to another application."),{code:"ATTESTATION_APP_MISMATCH",statusCode:403});
  const result=await database.query(`UPDATE goodbase_attestation_tokens SET last_seen_at=NOW() WHERE jti=$1 AND status='active' AND expires_at>NOW() RETURNING *`,[decoded.jti]);
  if(!result.rows[0])throw Object.assign(new Error("Attestation token was revoked or replayed after expiration."),{code:"ATTESTATION_TOKEN_REVOKED",statusCode:401});
  return {...decoded,record:result.rows[0]};
}

async function signedProviderRequest(provider, body) {
  if(provider.status!=="ready")throw Object.assign(new Error("Messaging provider is not ready."),{code:"MESSAGING_PROVIDER_UNAVAILABLE"});
  const secret=await providerSecret(provider.credential_ref);
  if(!secret)throw Object.assign(new Error("Messaging provider credential is unavailable."),{code:"MESSAGING_PROVIDER_MISCONFIGURED"});
  const url=new URL(provider.endpoint_url);if(url.protocol!=="https:")throw new Error("Messaging provider must use HTTPS.");
  const payload=JSON.stringify(body);const timestamp=String(Date.now());
  const signature=crypto.createHmac("sha256",secret).update(`${timestamp}.${payload}`).digest("hex");
  const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),15000);
  try{
    const response=await fetch(url,{method:"POST",signal:abort.signal,headers:{"Content-Type":"application/json","X-Goodbase-Timestamp":timestamp,"X-Goodbase-Signature":`sha256=${signature}`,"Idempotency-Key":body.idempotencyKey},body:payload});
    const result=await response.json().catch(()=>({}));if(!response.ok||result.accepted!==true)throw new Error(result.message||`Provider returned ${response.status}.`);return result;
  }finally{clearTimeout(timeout);}
}

async function verifyMessagingProvider(providerId) {
  const result=await database.query(`SELECT * FROM goodbase_messaging_providers WHERE id=$1`,[providerId]);
  const provider=result.rows[0];if(!provider)throw Object.assign(new Error("Messaging provider not found."),{statusCode:404});
  try{
    const response=await signedProviderRequest({...provider,status:"ready"},{idempotencyKey:`health:${provider.id}:${Date.now()}`,operation:"health"});
    await database.query(`UPDATE goodbase_messaging_providers SET status='ready',last_health_at=NOW(),last_health_json=$2::jsonb,updated_at=NOW() WHERE id=$1`,[provider.id,JSON.stringify(response)]);
    return {ready:true,response};
  }catch(error){await database.query(`UPDATE goodbase_messaging_providers SET status='misconfigured',last_health_at=NOW(),last_health_json=$2::jsonb,updated_at=NOW() WHERE id=$1`,[provider.id,JSON.stringify({errorCode:error.code||"HEALTH_FAILED"})]);throw error;}
}

async function verifyConsumerAuthProvider(provider) {
  if(!provider?.controller_url)throw Object.assign(new Error("Authentication provider controller is unavailable."),{code:"AUTH_PROVIDER_MISCONFIGURED"});
  const result=await signedProviderRequest({status:"ready",endpoint_url:provider.controller_url,credential_ref:provider.secret_ref},{idempotencyKey:`auth-health:${provider.id}:${Date.now()}`,operation:"health",providerType:provider.provider_type});
  return {ready:true,response:result};
}

async function dispatchMessaging(limit=50) {
  const due=await database.query(`SELECT * FROM goodbase_messaging_campaigns WHERE status='scheduled' AND ((timezone_mode='utc' AND COALESCE(scheduled_at,NOW())<=NOW()) OR (timezone_mode='device_local' AND COALESCE(scheduled_at,NOW())<=NOW()+INTERVAL '14 hours')) ORDER BY scheduled_at LIMIT 20 FOR UPDATE SKIP LOCKED`);
  for(const campaign of due.rows){
    const audience=campaign.audience_json||{};let segment={};
    if(campaign.audience_type==="segment"&&audience.segmentId){const found=await database.query(`SELECT rule_json FROM goodbase_messaging_segments WHERE id=$1 AND app_id=$2 AND status='active'`,[audience.segmentId,campaign.app_id]);segment=found.rows[0]?.rule_json||{};}
    await database.query(
      `INSERT INTO goodbase_messaging_deliveries(campaign_id,device_id,idempotency_key,payload_json,next_attempt_at)
       SELECT $1,device.id,$1||':'||device.id,$2::jsonb,CASE WHEN $13='device_local' THEN (($14::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(device.timezone,'UTC')) ELSE $14::timestamptz END FROM goodbase_messaging_devices device
       WHERE device.organization_id=$3 AND device.project_id=$4 AND device.environment_id=$5 AND device.app_id=$6 AND device.status='active'
         AND ($7='all'
           OR ($7='device' AND device.id::text=ANY($8::text[]))
           OR ($7='user' AND device.user_id::text=ANY($9::text[]))
           OR ($7='topic' AND EXISTS(SELECT 1 FROM goodbase_messaging_topic_members member WHERE member.device_id=device.id AND member.topic_id::text=$10))
           OR ($7='segment' AND (cardinality($11::text[])=0 OR device.platform=ANY($11::text[])) AND (cardinality($12::text[])=0 OR device.locale=ANY($12::text[]))))
         AND NOT EXISTS(SELECT 1 FROM goodbase_messaging_suppressions suppression WHERE suppression.app_id=device.app_id AND (suppression.user_id=device.user_id OR suppression.device_id=device.id) AND (suppression.expires_at IS NULL OR suppression.expires_at>NOW()))
       ON CONFLICT(device_id,idempotency_key) DO NOTHING`,
      [campaign.id,JSON.stringify(campaign.content_json),campaign.organization_id,campaign.project_id,campaign.environment_id,campaign.app_id,campaign.audience_type,
       Array.isArray(audience.deviceIds)?audience.deviceIds:[],Array.isArray(audience.userIds)?audience.userIds:[],String(audience.topicId||""),
       Array.isArray(segment.platforms)?segment.platforms:[],Array.isArray(segment.locales)?segment.locales:[],campaign.timezone_mode,campaign.scheduled_at]
    );
    await database.query(`UPDATE goodbase_messaging_campaigns SET status='dispatching' WHERE id=$1`,[campaign.id]);
  }
  const claimed=await database.query(
    `WITH candidates AS (SELECT id FROM goodbase_messaging_deliveries WHERE status IN('queued','failed') AND next_attempt_at<=NOW() AND attempts<5 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1),
     updated AS (UPDATE goodbase_messaging_deliveries d SET status='sending',attempts=attempts+1 FROM candidates c WHERE d.id=c.id RETURNING d.*)
     SELECT updated.*,device.encrypted_token,device.platform,provider.id AS provider_id,provider.provider_type,provider.status AS provider_status,provider.endpoint_url,provider.credential_ref
     FROM updated JOIN goodbase_messaging_devices device ON device.id=updated.device_id JOIN goodbase_messaging_providers provider ON provider.id=device.provider_id`,[Math.min(Math.max(Number(limit)||50,1),200)]);
  let accepted=0;
  for(const row of claimed.rows){
    try{
      const result=await signedProviderRequest({id:row.provider_id,provider_type:row.provider_type,status:row.provider_status,endpoint_url:row.endpoint_url,credential_ref:row.credential_ref},{idempotencyKey:row.idempotency_key,platform:row.platform,deviceToken:decryptValue(row.encrypted_token),payload:row.payload_json});
      await database.query(`UPDATE goodbase_messaging_deliveries SET status='accepted',provider_message_id=$2,accepted_at=NOW(),error_code=NULL,error_message=NULL WHERE id=$1`,[row.id,result.messageId||null]);accepted++;
    }catch(error){await database.query(`UPDATE goodbase_messaging_deliveries SET status='failed',error_code=$2,error_message=$3,next_attempt_at=NOW()+(LEAST(3600,POWER(2,attempts)*10)::text||' seconds')::interval WHERE id=$1`,[row.id,error.code||"PROVIDER_ERROR",String(error.message).slice(0,500)]);}
  }
  await database.query(`UPDATE goodbase_messaging_campaigns campaign SET status=CASE WHEN EXISTS(SELECT 1 FROM goodbase_messaging_deliveries delivery WHERE delivery.campaign_id=campaign.id AND delivery.status='failed') THEN 'failed' ELSE 'completed' END,completed_at=NOW() WHERE campaign.status='dispatching' AND EXISTS(SELECT 1 FROM goodbase_messaging_deliveries delivery WHERE delivery.campaign_id=campaign.id) AND NOT EXISTS(SELECT 1 FROM goodbase_messaging_deliveries delivery WHERE delivery.campaign_id=campaign.id AND delivery.status IN('queued','sending'))`);
  return {selected:claimed.rowCount,accepted};
}

async function dispatchSms(limit=25) {
  const claimed=await database.query(
    `WITH candidates AS (SELECT id FROM goodbase_sms_deliveries WHERE status IN('queued','failed') AND next_attempt_at<=NOW() AND attempts<5 AND expires_at>NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1),
     updated AS (UPDATE goodbase_sms_deliveries d SET status='sending',attempts=attempts+1 FROM candidates c WHERE d.id=c.id RETURNING d.*)
     SELECT updated.*,provider.status AS provider_status,provider.controller_url,provider.secret_ref FROM updated JOIN goodbase_consumer_auth_providers provider ON provider.id=updated.provider_id`,[Math.min(Math.max(Number(limit)||25,1),100)]);
  let delivered=0;
  for(const row of claimed.rows){
    try{
      const result=await signedProviderRequest({status:row.provider_status==="enabled"?"ready":row.provider_status,endpoint_url:row.controller_url,credential_ref:row.secret_ref},{idempotencyKey:row.id,purpose:row.purpose,...JSON.parse(decryptValue(row.encrypted_payload))});
      await database.query(`UPDATE goodbase_sms_deliveries SET status='delivered',provider_message_id=$2,completed_at=NOW(),error_code=NULL WHERE id=$1`,[row.id,result.messageId||null]);delivered++;
      if(row.fleet_notification_id){
        await database.query(`UPDATE fleet_customer_notification_deliveries SET status='delivered',provider_reference=$2,attempted_at=NOW(),delivered_at=NOW(),error_code=NULL,updated_at=NOW() WHERE notification_id=$1 AND channel='sms'`,[row.fleet_notification_id,result.messageId||null]);
      }
    }catch(error){
      await database.query(`UPDATE goodbase_sms_deliveries SET status='failed',error_code=$2,next_attempt_at=NOW()+(LEAST(600,POWER(2,attempts)*5)::text||' seconds')::interval WHERE id=$1`,[row.id,error.code||"SMS_PROVIDER_ERROR"]);
      if(row.fleet_notification_id){
        await database.query(`UPDATE fleet_customer_notification_deliveries SET status='failed',attempted_at=NOW(),error_code=$2,updated_at=NOW() WHERE notification_id=$1 AND channel='sms'`,[row.fleet_notification_id,error.code||"SMS_PROVIDER_ERROR"]);
      }
    }
  }
  return {selected:claimed.rowCount,delivered};
}

module.exports={CANONICAL_ORIGIN,DEFAULT_SCOPE,sha256,runAssuranceSuite,exchangeAttestation,validateAttestationToken,dispatchMessaging,dispatchSms,verifyMessagingProvider,verifyConsumerAuthProvider};
