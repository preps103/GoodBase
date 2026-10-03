export * from "./telemetry";
export declare class GoodbaseError extends Error { status?: number; code?: string; requestId?: string; }
export declare class GoodbaseClient {
  constructor(options?: {baseUrl?: string; accessToken?: string; attestationToken?: string; fetch?: typeof fetch});
  accessToken: string | null; attestationToken: string | null;
  request(path: string, options?: {method?: string; headers?: Record<string,string>; body?: unknown; signal?: AbortSignal}): Promise<any>;
  recordSession(appId: string, payload: Record<string,unknown>): Promise<any>;
  captureCrash(appId: string, payload: Record<string,unknown>): Promise<any>;
  recordTrace(appId: string, payload: Record<string,unknown>): Promise<any>;
  remoteConfig(appId: string, query?: string): Promise<any>;
  experimentAssignments(appId: string): Promise<any>;
  registerPushToken(payload: Record<string,unknown>): Promise<any>;
  syncChanges(collectionId: string, cursor?: number, limit?: number): Promise<any>;
  syncMutations(collectionId: string, deviceId: string, mutations: unknown[]): Promise<any>;
  exchangeAttestation(appId: string, platform: string, assertion: Record<string,unknown>): Promise<any>;
}
export interface GoodSpeechAudioResult { audio: ArrayBuffer; contentType: string; requestId?: string | null; voiceId?: string | null; watermark?: string | null; }
export declare class GoodSpeechClient {
  constructor(options?: {client?: GoodbaseClient; baseUrl?: string; accessToken?: string; attestationToken?: string; fetch?: typeof fetch});
  health(): Promise<any>; capabilities(): Promise<any>; usage(): Promise<any>; voices(): Promise<any>; agents(): Promise<any>;
  analytics(agentId?: string): Promise<any>;
  createDesignedVoice(payload: Record<string,unknown>): Promise<any>;
  createAgent(payload: Record<string,unknown>): Promise<any>;
  startAgentSession(agentId: string, payload?: Record<string,unknown>): Promise<any>;
  sendAgentTurn(sessionId: string, payload: Record<string,unknown>): Promise<any>;
  interruptAgentSession(sessionId: string): Promise<any>;
  completeAgentSession(sessionId: string, payload?: Record<string,unknown>): Promise<any>;
  listWebhooks(): Promise<any>;
  createWebhook(payload: {endpointUrl: string; events: string[]; description?: string}): Promise<any>;
  testWebhook(webhookId: string): Promise<any>;
  deleteWebhook(webhookId: string): Promise<any>;
  privacySettings(): Promise<any>;
  updatePrivacySettings(payload: {zeroRetention?: boolean; generationRetentionDays?: 0 | 7 | 30 | 90 | 365; agentRetentionDays?: 0 | 7 | 30 | 90 | 365; residencyRegion?: "us-west"; modelTrainingEnabled?: false}): Promise<any>;
  purgeRetainedContent(): Promise<any>;
  qualitySummary(): Promise<any>;
  synthesize(payload: Record<string,unknown>, options?: {signal?: AbortSignal}): Promise<GoodSpeechAudioResult>;
  stream(payload: Record<string,unknown>, options?: {signal?: AbortSignal}): Promise<Response>;
  generateVoiceSpeech(voiceId: string, text: string, options?: {signal?: AbortSignal}): Promise<GoodSpeechAudioResult>;
}
export declare function verifyGoodSpeechWebhook(input: {payload: string | Uint8Array; signature: string; timestamp: string | number; secret: string; toleranceSeconds?: number; now?: number}): boolean;
export function createGoodbaseReactBindings(React: unknown, client: GoodbaseTelemetryClient): Record<string, unknown>;
export function createGoodbaseServerClient(createClient: Function, request: Request, options?: {baseUrl?: string}): unknown;
import type { GoodbaseTelemetryClient } from "./telemetry";
