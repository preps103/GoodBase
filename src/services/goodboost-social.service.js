"use strict";
const crypto = require("crypto");
const database = require("../config/database");

const DEFINITIONS = [
  ["twitter","Twitter","X",true,true,true,"Follower comparison and confirmed follow/unfollow actions."],
  ["youtube","YouTube","YouTube",true,true,true,"Channel subscriptions and confirmed subscription removal."],
  ["instagram","Instagram","Instagram",false,false,false,"Professional-account audience insights through Meta authorization."],
  ["tiktok","TikTok","TikTok",false,false,false,"Profile and engagement statistics through approved TikTok scopes."],
  ["facebook","Facebook","Facebook",false,false,false,"Page audience insights through Meta authorization."],
  ["linkedin","LinkedIn","LinkedIn",false,false,false,"Profile and organization audience insights."],
  ["pinterest","Pinterest","Pinterest",true,true,false,"Follower, following, profile-visit, and organic analytics."],
  ["twitch","Twitch","Twitch",false,true,false,"Channel profile and followed-channel review."],
  ["reddit","Reddit","Reddit",false,false,false,"Community insights and approved subscription handoff."],
  ["threads","Threads","Threads",false,false,false,"Threads profile and engagement insights."],
  ["bluesky","Bluesky","Bluesky",true,true,true,"Follower comparison with AT Protocol follow/unfollow actions."],
  ["mastodon","Mastodon","Mastodon",true,true,true,"Federated follower management through the selected instance."],
].map(([key,platform,displayName,followerList,followingList,direct,description]) => ({
  key, platform, displayName, description,
  capabilities: { profileStats: true, followerList, followingList, follow: direct, unfollow: direct },
}));

function failure(message,statusCode=400,code="GOODBOOST_SOCIAL_INVALID") { const error=new Error(message); error.statusCode=statusCode; error.code=code; return error; }
function key(value) { return String(value||"").trim().toLowerCase().replace(/[^a-z0-9]/g,"_"); }
function definition(value) { const item=DEFINITIONS.find((entry)=>entry.key===key(value)||entry.platform.toLowerCase()===String(value||"").toLowerCase()); if(!item) throw failure("Unsupported social provider.",404,"GOODBOOST_PROVIDER_NOT_FOUND"); return item; }
function endpoint(provider,operation) { const raw=String(process.env[`GOODBOOST_${provider.key.toUpperCase()}_${operation}_URL`]||"").trim(); try { const url=new URL(raw); return url.protocol==="https:"?url:null; } catch { return null; } }
function providers() { return DEFINITIONS.map((item)=>{ const adapterToken=Boolean(String(process.env.GOODBOOST_PROVIDER_ADAPTER_TOKEN||"").trim()); const oauthReady=Boolean(endpoint(item,"AUTHORIZE")&&endpoint(item,"CALLBACK")&&adapterToken); const syncReady=Boolean(endpoint(item,"SYNC")&&adapterToken); const actionReady=Boolean(endpoint(item,"ACTION")&&adapterToken); return {...item,available:oauthReady,authorizationUrl:null,capabilities:{...item.capabilities,followerList:item.capabilities.followerList&&syncReady,followingList:item.capabilities.followingList&&syncReady,follow:item.capabilities.follow&&actionReady,unfollow:item.capabilities.unfollow&&actionReady}}; }); }

async function signState(userId,provider) {
  const secret=String(process.env.GOODBOOST_OAUTH_STATE_SECRET||process.env.JWT_SECRET||"");
  if(!secret) throw failure("OAuth state signing is not configured.",503,"GOODBOOST_OAUTH_STATE_NOT_CONFIGURED");
  const nonce=crypto.randomBytes(32).toString("base64url");
  const expiresAt=Date.now()+600000;
  await database.query("DELETE FROM goodboost_social_oauth_states WHERE expires_at<NOW() OR consumed_at IS NOT NULL");
  await database.query("INSERT INTO goodboost_social_oauth_states(nonce,user_id,platform,expires_at) VALUES($1,$2,$3,to_timestamp($4/1000.0))",[nonce,userId,provider.key,expiresAt]);
  const payload=Buffer.from(JSON.stringify({userId,provider:provider.key,nonce,expiresAt})).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256",secret).update(payload).digest("base64url")}`;
}
async function readState(value) {
  const secret=String(process.env.GOODBOOST_OAUTH_STATE_SECRET||process.env.JWT_SECRET||""); const [payload,signature]=String(value||"").split(".");
  if(!secret||!payload||!signature) throw failure("OAuth state is invalid.",400,"GOODBOOST_OAUTH_STATE_INVALID");
  const expected=crypto.createHmac("sha256",secret).update(payload).digest("base64url");
  if(signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) throw failure("OAuth state is invalid.",400,"GOODBOOST_OAUTH_STATE_INVALID");
  let parsed;
  try { parsed=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")); } catch { throw failure("OAuth state is invalid.",400,"GOODBOOST_OAUTH_STATE_INVALID"); }
  if(!parsed.nonce||parsed.expiresAt<Date.now()) throw failure("OAuth state expired.",400,"GOODBOOST_OAUTH_STATE_EXPIRED");
  const consumed=await database.query("UPDATE goodboost_social_oauth_states SET consumed_at=NOW() WHERE nonce=$1 AND user_id=$2 AND platform=$3 AND consumed_at IS NULL AND expires_at>NOW() RETURNING nonce",[parsed.nonce,parsed.userId,parsed.provider]);
  if(!consumed.rows[0]) throw failure("OAuth state was already used or expired.",400,"GOODBOOST_OAUTH_STATE_REPLAYED");
  return parsed;
}
async function adapter(provider,operation,payload,idempotencyKey) {
  const url=endpoint(provider,operation); const token=String(process.env.GOODBOOST_PROVIDER_ADAPTER_TOKEN||"").trim();
  if(!url||!token) throw failure(`${provider.displayName} ${operation.toLowerCase()} is not configured.`,503,"GOODBOOST_PROVIDER_NOT_CONFIGURED");
  const response=await fetch(url,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",...(idempotencyKey?{"Idempotency-Key":idempotencyKey}:{})},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});
  const body=await response.json().catch(()=>({})); if(!response.ok) throw failure(body.message||body.error||`Provider returned ${response.status}.`,response.status>=500?502:409,"GOODBOOST_PROVIDER_REJECTED"); return body;
}
async function authorizationUrl(userId,platform) { const provider=definition(platform); const ready=providers().find((item)=>item.key===provider.key); const url=endpoint(provider,"AUTHORIZE"); if(!ready?.available||!url) throw failure(`${provider.displayName} OAuth handoff is not fully configured.`,503,"GOODBOOST_PROVIDER_NOT_CONFIGURED"); url.searchParams.set("state",await signState(userId,provider)); url.searchParams.set("redirect_uri",`https://base.goodos.app/api/goodboost/social/callback/${provider.key}`); url.searchParams.set("return_to","https://boost.goodos.app/?social=connected"); return url.toString(); }

async function callback(platform,code,state) {
  const provider=definition(platform); const verified=await readState(state); if(verified.provider!==provider.key) throw failure("OAuth provider mismatch.",400,"GOODBOOST_OAUTH_PROVIDER_MISMATCH");
  const result=await adapter(provider,"CALLBACK",{code,state,redirectUri:`https://base.goodos.app/api/goodboost/social/callback/${provider.key}`}); const account=result.account||{};
  if(!account.id||!account.username||!result.tokenReference) throw failure("The provider callback did not return a complete account reference.",502,"GOODBOOST_PROVIDER_RESPONSE_INVALID");
  const stored=await database.query(`INSERT INTO goodboost_social_connections(user_id,platform,provider_account_id,username,display_name,avatar_url,capabilities,token_reference,follower_count,following_count,last_synced_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,NOW()) ON CONFLICT(user_id,platform,provider_account_id) DO UPDATE SET username=EXCLUDED.username,display_name=EXCLUDED.display_name,avatar_url=EXCLUDED.avatar_url,status='active',capabilities=EXCLUDED.capabilities,token_reference=EXCLUDED.token_reference,follower_count=EXCLUDED.follower_count,following_count=EXCLUDED.following_count,last_synced_at=NOW(),updated_at=NOW() RETURNING *`,[verified.userId,provider.key,String(account.id||""),String(account.username||""),account.displayName||null,account.avatarUrl||null,JSON.stringify(provider.capabilities),result.tokenReference||null,account.followers??null,account.following??null]); return stored.rows[0];
}
function publicConnection(row) { const provider=definition(row.platform); return {id:row.id,platform:provider.platform,username:row.username,displayName:row.display_name,avatarUrl:row.avatar_url,connectedAt:row.connected_at,status:row.status==="active"?"Active":row.status==="expired"?"Expired":"Needs Reconnect",lastSyncedAt:row.last_synced_at,followerCount:row.follower_count,followingCount:row.following_count,capabilities:row.capabilities||provider.capabilities}; }
async function connections(userId) { const result=await database.query("SELECT * FROM goodboost_social_connections WHERE user_id=$1 AND status<>'disconnected' ORDER BY connected_at DESC",[userId]); return result.rows.map(publicConnection); }
async function disconnect(userId,id) {
  const found=await database.query("SELECT * FROM goodboost_social_connections WHERE id=$1 AND user_id=$2 AND status<>'disconnected'",[id,userId]);
  const connection=found.rows[0]; if(!connection) throw failure("Connected account not found.",404,"GOODBOOST_CONNECTION_NOT_FOUND");
  const provider=definition(connection.platform);
  if(endpoint(provider,"REVOKE")) await adapter(provider,"REVOKE",{connectionId:id,tokenReference:connection.token_reference});
  await database.query("UPDATE goodboost_social_connections SET status='disconnected',token_reference=NULL,capabilities='{}'::jsonb,updated_at=NOW() WHERE id=$1 AND user_id=$2",[id,userId]);
  return {disconnected:true};
}

async function sync(userId,id) {
  const found=await database.query("SELECT * FROM goodboost_social_connections WHERE id=$1 AND user_id=$2 AND status='active'",[id,userId]); const connection=found.rows[0]; if(!connection) throw failure("Connected account not found.",404,"GOODBOOST_CONNECTION_NOT_FOUND"); const provider=definition(connection.platform);
  const result=await adapter(provider,"SYNC",{connectionId:id,tokenReference:connection.token_reference}); const account=result.account||{}; const client=await database.pool.connect();
  try { await client.query("BEGIN"); for(const item of (Array.isArray(result.relationships)?result.relationships:[]).slice(0,10000)) { const relationshipId=String(item.id||"").trim(); const username=String(item.username||"").trim(); const status=["not-following-back","mutual","fan","recently-unfollowed"].includes(item.status)?item.status:null; if(!relationshipId||!username||!status) continue; await client.query(`INSERT INTO goodboost_social_relationships(connection_id,provider_user_id,username,display_name,avatar_url,profile_url,status,follows_you,you_follow,verified,metadata,last_changed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) ON CONFLICT(connection_id,provider_user_id) DO UPDATE SET username=EXCLUDED.username,display_name=EXCLUDED.display_name,avatar_url=EXCLUDED.avatar_url,profile_url=EXCLUDED.profile_url,status=EXCLUDED.status,follows_you=EXCLUDED.follows_you,you_follow=EXCLUDED.you_follow,verified=EXCLUDED.verified,metadata=EXCLUDED.metadata,last_changed_at=EXCLUDED.last_changed_at,updated_at=NOW()`,[id,relationshipId,username,item.displayName||null,item.avatarUrl||null,item.profileUrl||null,status,Boolean(item.followsYou),Boolean(item.youFollow),Boolean(item.verified),JSON.stringify(item.metadata||{}),item.lastChangedAt||null]); }
    const updated=await client.query("UPDATE goodboost_social_connections SET follower_count=$1,following_count=$2,last_synced_at=NOW(),updated_at=NOW() WHERE id=$3 RETURNING *",[account.followers??connection.follower_count,account.following??connection.following_count,id]); await client.query("COMMIT"); return publicConnection(updated.rows[0]);
  } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
async function relationships(userId,accountId,status) {
  const found=await database.query("SELECT * FROM goodboost_social_connections WHERE id=$1 AND user_id=$2 AND status<>'disconnected'",[accountId,userId]); const connection=found.rows[0]; if(!connection) throw failure("Connected account not found.",404,"GOODBOOST_CONNECTION_NOT_FOUND"); const safe=["not-following-back","mutual","fan","recently-unfollowed"].includes(status)?status:"not-following-back";
  const [records,counts]=await Promise.all([database.query("SELECT * FROM goodboost_social_relationships WHERE connection_id=$1 AND status=$2 ORDER BY updated_at DESC LIMIT 500",[accountId,safe]),database.query("SELECT status,COUNT(*)::int AS count FROM goodboost_social_relationships WHERE connection_id=$1 GROUP BY status",[accountId])]); const totals=Object.fromEntries(counts.rows.map((row)=>[row.status,row.count])); const provider=definition(connection.platform);
  return {relationships:records.rows.map((row)=>({id:row.id,accountId:row.connection_id,platform:provider.platform,providerUserId:row.provider_user_id,username:row.username,displayName:row.display_name,avatarUrl:row.avatar_url,profileUrl:row.profile_url,status:row.status,followsYou:row.follows_you,youFollow:row.you_follow,verified:row.verified,lastChangedAt:row.last_changed_at})),summary:{followers:connection.follower_count||0,following:connection.following_count||0,mutual:totals.mutual||0,notFollowingBack:totals["not-following-back"]||0,fans:totals.fan||0,lastSyncedAt:connection.last_synced_at}};
}
function boundedProviderResponse(value) {
  if(!value||typeof value!=="object") return {};
  const allowed={};
  for(const field of ["id","status","message","providerRequestId"]) {
    if(typeof value[field]==="string") allowed[field]=value[field].slice(0,500);
  }
  return allowed;
}
async function action(userId,relationshipId,requestedAction,idempotencyKey,dailyLimit) {
  if(!["follow","unfollow"].includes(requestedAction)) throw failure("Unsupported relationship action."); if(!idempotencyKey) throw failure("Idempotency-Key is required.",400,"GOODBOOST_IDEMPOTENCY_REQUIRED");
  const found=await database.query(`SELECT r.*,c.platform,c.token_reference,c.capabilities FROM goodboost_social_relationships r JOIN goodboost_social_connections c ON c.id=r.connection_id WHERE r.id=$1 AND c.user_id=$2 AND c.status='active'`,[relationshipId,userId]); const row=found.rows[0]; if(!row) throw failure("Audience relationship not found.",404,"GOODBOOST_RELATIONSHIP_NOT_FOUND"); if(!row.capabilities?.[requestedAction]) throw failure("This provider requires review on its own platform.",409,"GOODBOOST_NATIVE_REVIEW_REQUIRED");
  const profile=await database.query("SELECT preferences_json FROM goodboost_profiles WHERE user_id=$1",[userId]); const configured=Number(profile.rows[0]?.preferences_json?.automationDailyLimit||dailyLimit||25); const limit=Math.min(200,Math.max(5,configured));
  const client=await database.pool.connect(); let actionId;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`${userId}:${requestedAction}:${new Date().toISOString().slice(0,10)}`]);
    const usage=await client.query("SELECT COUNT(*)::int AS count FROM goodboost_social_actions WHERE user_id=$1 AND action=$2 AND status IN ('processing','completed') AND created_at>=date_trunc('day',NOW())",[userId,requestedAction]);
    if(usage.rows[0].count>=limit) throw failure(`Daily ${requestedAction} limit reached.`,429,"GOODBOOST_DAILY_LIMIT_REACHED");
    const inserted=await client.query("INSERT INTO goodboost_social_actions(user_id,connection_id,relationship_id,action,idempotency_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING id",[userId,row.connection_id,relationshipId,requestedAction,idempotencyKey]);
    if(!inserted.rows[0]) throw failure("This action was already submitted.",409,"GOODBOOST_ACTION_DUPLICATE");
    actionId=inserted.rows[0].id;
    await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK").catch(()=>{}); throw error; } finally { client.release(); }
  const provider=definition(row.platform);
  try { const providerResponse=await adapter(provider,"ACTION",{action:requestedAction,providerUserId:row.provider_user_id,tokenReference:row.token_reference},idempotencyKey); await database.query("UPDATE goodboost_social_actions SET status='completed',provider_response=$1::jsonb,completed_at=NOW() WHERE id=$2",[JSON.stringify(boundedProviderResponse(providerResponse)),actionId]); const updated=await database.query("UPDATE goodboost_social_relationships SET status=$1,you_follow=$2,last_changed_at=NOW(),updated_at=NOW() WHERE id=$3 RETURNING *",[requestedAction==="unfollow"?"recently-unfollowed":"mutual",requestedAction==="follow",relationshipId]); return updated.rows[0]; } catch(error) { await database.query("UPDATE goodboost_social_actions SET status='failed',provider_response=$1::jsonb,completed_at=NOW() WHERE id=$2",[JSON.stringify({message:String(error.message||"Provider action failed").slice(0,500)}),actionId]); throw error; }
}
module.exports={providers,authorizationUrl,callback,connections,disconnect,sync,relationships,action};
