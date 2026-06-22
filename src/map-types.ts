import type { DashboardState } from "./dashboard/dashboard-state.js";
import type { ObserverStatusStore } from "./persistence-store.js";

export interface MapUploaderConfig {
  enabled: boolean;
  apiUrl: string;
  dryRun: boolean;
  minReuploadIntervalSeconds: number;
  requestTimeoutMs: number;
  maxConcurrentUploads: number;
  maxQueuedUploads: number;
  retriesAllowed: number;
}

export interface MapUploadSigningIdentity {
  publicKey: Buffer;
  privateSeed: Buffer;
}

export interface MapUploaderDependencies {
  dashboardState?: DashboardState;
  fetch?: typeof fetch;
  now?: () => number;
  observerStatusStore?: ObserverStatusStore;
  signingIdentity?: MapUploadSigningIdentity;
  workerDelay?: (ms: number) => Promise<void>;
}

export interface RadioParams {
  freq?: number;
  cr?: number;
  sf?: number;
  bw?: number;
}

export interface ObserverState {
  origin?: string;
  originId?: string;
  params: RadioParams;
  updatedAt: number;
}

export interface PacketCandidate {
  rawPacket: Buffer;
  observerId?: string;
}

export interface SignedRequest {
  data: string;
  signature: string;
  publicKey: string;
}

export type MapApiResponseCode =
  | "NODES_INSERTED"
  | "ERR_ADVERT_DUPLICATE"
  | "ERR_COORDS_MISSING"
  | string;

export interface MapApiResponseBody {
  code?: MapApiResponseCode;
  message?: string;
  error?: string;
}

export interface MqttSourceConfig {
  name: string;
  url: string;
  username: string;
  password: string;
  clientId: string;
  topicFilter: string;
  reconnectPeriodMs: number;
  connectTimeoutMs: number;
  rejectUnauthorized: boolean;
}

export interface AdvertLogContext {
  advertLabel: string;
  observerLabel: string;
  sourceName?: string;
}

export interface MapUploadWorkRequest {
  requestId: string;
  retriesAllowed: number;
  advertKey: string;
  advertTimestamp: number;
  advertType: string;
  nodeName: string;
  nodePublicKey: string;
  rawPacketHex: string;
  observerId?: string;
  observerName?: string;
  radioParams: RadioParams;
  logContext: AdvertLogContext;
}

export type PosterResult =
  | { status: "handled"; pubKey: string; timestamp: number; responseFromMeshcoreIO?: string }
  | { status: "retry"; error: unknown };
