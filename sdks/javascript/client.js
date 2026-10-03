"use strict";

class GoodbaseError extends Error { constructor(message,options={}){super(message);this.name="GoodbaseError";Object.assign(this,options);} }
class GoodbaseClient{
  constructor(options={}){this.baseUrl=(options.baseUrl||"https://base.goodos.app").replace(/\/$/,"");this.accessToken=options.accessToken||null;this.apiKey=options.apiKey||null;this.attestationToken=options.attestationToken||null;this.fetch=options.fetch||globalThis.fetch;if(!this.fetch)throw new Error("GoodbaseClient requires fetch.");}
  async request(path,options={}){const headers={Accept:"application/json","X-Request-ID":globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`,...options.headers};if(this.accessToken)headers.Authorization=`Bearer ${this.accessToken}`;if(this.apiKey)headers["X-Goodbase-API-Key"]=this.apiKey;if(this.attestationToken)headers["X-Goodbase-Attestation"]=this.attestationToken;if(options.body!==undefined)headers["Content-Type"]="application/json";const response=await this.fetch(`${this.baseUrl}${path}`,{method:options.method||"GET",headers,body:options.body===undefined?undefined:JSON.stringify(options.body),signal:options.signal});const text=await response.text(),payload=text?JSON.parse(text):{};if(!response.ok)throw new GoodbaseError(payload.message||`Goodbase request failed with ${response.status}`,{status:response.status,code:payload.code,requestId:response.headers.get("x-request-id")});return payload;}
  recordSession(appId,payload){return this.request("/api/goodbase/v1/product/telemetry/sessions",{method:"POST",body:{appId,...payload}});}
  captureCrash(appId,payload){return this.request("/api/goodbase/v1/product/telemetry/crashes",{method:"POST",body:{appId,platform:"web",...payload}});}
  recordTrace(appId,payload){return this.request("/api/goodbase/v1/product/telemetry/traces",{method:"POST",body:{appId,...payload}});}
  remoteConfig(appId,query=""){return this.request(`/api/goodbase/v1/product/config/${encodeURIComponent(appId)}${query?`?${query}`:""}`);}
  experimentAssignments(appId){return this.request(`/api/goodbase/v1/product/experiments/${encodeURIComponent(appId)}/assignments`);}
  registerPushToken(payload){return this.request("/api/goodbase/v1/growth/messaging/devices",{method:"POST",body:payload});}
  syncChanges(collectionId,cursor=0,limit=500){return this.request(`/api/goodbase/v1/production/sync/collections/${encodeURIComponent(collectionId)}/changes?cursor=${cursor}&limit=${limit}`);}
  syncMutations(collectionId,deviceId,mutations){return this.request(`/api/goodbase/v1/production/sync/collections/${encodeURIComponent(collectionId)}/mutations`,{method:"POST",body:{deviceId,mutations}});}
  async exchangeAttestation(appId,platform,assertion){const challenge=await this.request("/api/goodbase/v1/growth/attestation/challenge",{method:"POST",body:{appId,platform}});const exchange=await this.request("/api/goodbase/v1/growth/attestation/exchange",{method:"POST",body:{challengeId:challenge.challengeId,nonce:challenge.nonce,assertion}});this.attestationToken=exchange.attestationToken;return exchange;}
}
module.exports={GoodbaseClient,GoodbaseError};
