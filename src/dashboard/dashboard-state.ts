import type { MapUploadWorkRequest, RadioParams } from "../map-types.js";

const MAX_LOGS = 500;
const MAX_QUEUE_HISTORY = 200;
const ONE_HOUR_MS = 60 * 60 * 1000;

export type DashboardLogLevel = "info" | "warn" | "error";

export interface DashboardConfig {
  enabled: boolean;
  port: number;
}

export interface DashboardLogEntry {
  id: number;
  at: string;
  level: DashboardLogLevel;
  message: string;
  source: string;
}

export interface DashboardAdvertLocation {
  id: string;
  requestId: string;
  status: "pending" | "accepted" | "rejected";
  statusDetail?: string;
  at: string;
  updatedAt: string;
  nodeName: string;
  nodePublicKey: string;
  advertType: string;
  observerId?: string;
  observerName?: string;
  lat: number;
  lon: number;
  responseFromMeshcoreIO?: string;
}

export interface DashboardQueueItem {
  id: string;
  state: "queued" | "active" | "handled" | "dropped" | "retrying";
  position: number | null;
  updatedAt: string;
  job: DashboardJobSnapshot;
  workerId?: string;
  detail?: string;
  responseFromMeshcoreIO?: string;
}

export interface DashboardWorkerSnapshot {
  id: string;
  index: number;
  state: "idle" | "uploading" | "cooldown";
  updatedAt: string;
  currentJob?: DashboardJobSnapshot;
  detail?: string;
}

export interface DashboardMqttSourceStatus {
  state: "connected" | "disconnected";
  detail?: string;
  updatedAt: string;
}

export interface DashboardSnapshot {
  generatedAt: string;
  mqttSource: DashboardMqttSourceStatus;
  logs: DashboardLogEntry[];
  queue: DashboardQueueItem[];
  queueHistory: DashboardQueueItem[];
  workers: DashboardWorkerSnapshot[];
  advertsLastHour: DashboardAdvertLocation[];
}

interface DashboardJobSnapshot {
  requestId: string;
  retriesAllowed: number;
  advertKey: string;
  advertTimestamp: number;
  advertType: string;
  nodeName: string;
  nodePublicKey: string;
  observerId?: string;
  observerName?: string;
  radioParams: RadioParams;
  advertLabel: string;
  observerLabel: string;
}

const ADVERT_STATUS_PRIORITY: Record<DashboardAdvertLocation["status"], number> = {
  accepted: 3,
  pending: 2,
  rejected: 1,
};

let activeDashboardState: DashboardState | undefined;

export function setActiveDashboardState(state: DashboardState | undefined): void {
  activeDashboardState = state;
}

export function getActiveDashboardState(): DashboardState | undefined {
  return activeDashboardState;
}

export function recordDashboardLog(
  message: string,
  level: DashboardLogLevel,
  source = "map-upload"
): void {
  activeDashboardState?.recordLog(message, level, source);
}

function toJobSnapshot(job: MapUploadWorkRequest): DashboardJobSnapshot {
  return {
    requestId: job.requestId,
    retriesAllowed: job.retriesAllowed,
    advertKey: job.advertKey,
    advertTimestamp: job.advertTimestamp,
    advertType: job.advertType,
    nodeName: job.nodeName,
    nodePublicKey: job.nodePublicKey,
    observerId: job.observerId,
    observerName: job.observerName,
    radioParams: { ...job.radioParams },
    advertLabel: job.logContext.advertLabel,
    observerLabel: job.logContext.observerLabel,
  };
}

function isPreferredAdvertLocation(
  candidate: DashboardAdvertLocation,
  current: DashboardAdvertLocation
): boolean {
  const candidatePriority = ADVERT_STATUS_PRIORITY[candidate.status];
  const currentPriority = ADVERT_STATUS_PRIORITY[current.status];
  if (candidatePriority !== currentPriority) {
    return candidatePriority > currentPriority;
  }

  const updatedComparison = candidate.updatedAt.localeCompare(current.updatedAt);
  if (updatedComparison !== 0) {
    return updatedComparison > 0;
  }

  return candidate.at.localeCompare(current.at) > 0;
}

export interface DashboardStateOptions {
  now?: () => Date;
}

export class DashboardState {
  private nextLogId = 1;
  private readonly now: () => Date;
  private readonly logs: DashboardLogEntry[] = [];
  private readonly adverts = new Map<string, DashboardAdvertLocation>();
  private readonly queueItems = new Map<string, DashboardQueueItem>();
  private readonly queueHistory: DashboardQueueItem[] = [];
  private readonly workers = new Map<string, DashboardWorkerSnapshot>();
  private mqttSource: DashboardMqttSourceStatus;

  constructor(options: DashboardStateOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.mqttSource = {
      state: "disconnected",
      detail: "Not connected yet.",
      updatedAt: this.isoNow(),
    };
  }

  configureWorkers(workerIds: string[]): void {
    workerIds.forEach((workerId, index) => {
      if (!this.workers.has(workerId)) {
        this.workers.set(workerId, {
          id: workerId,
          index,
          state: "idle",
          updatedAt: this.isoNow(),
        });
      }
    });

    for (const id of this.workers.keys()) {
      if (!workerIds.includes(id)) {
        this.workers.delete(id);
      }
    }
  }

  recordLog(message: string, level: DashboardLogLevel = "info", source = "map-upload"): void {
    this.logs.push({
      id: this.nextLogId,
      at: this.isoNow(),
      level,
      message,
      source,
    });
    this.nextLogId += 1;

    while (this.logs.length > MAX_LOGS) {
      this.logs.shift();
    }
  }

  recordDecision(message: string, level: DashboardLogLevel = "info"): void {
    this.recordLog(message, level, "mqtt-reader");
  }

  setMqttSourceStatus(
    state: DashboardMqttSourceStatus["state"],
    detail?: string
  ): void {
    this.mqttSource = {
      state,
      detail,
      updatedAt: this.isoNow(),
    };
  }

  recordAdvertLocation(input: {
    requestId: string;
    nodeName: string;
    nodePublicKey: string;
    advertType: string;
    advertTimestamp: number;
    observerId?: string;
    observerName?: string;
    lat: number;
    lon: number;
  }): void {
    this.adverts.set(input.requestId, {
      id: input.requestId,
      requestId: input.requestId,
      status: "pending",
      statusDetail: "Advert heard by MQTT reader.",
      at: this.isoNow(),
      updatedAt: this.isoNow(),
      nodeName: input.nodeName,
      nodePublicKey: input.nodePublicKey,
      advertType: input.advertType,
      observerId: input.observerId,
      observerName: input.observerName,
      lat: input.lat,
      lon: input.lon,
    });
    this.cleanupAdvertLocations();
  }

  recordDemoAdvertLocation(input: {
    requestId: string;
    status: DashboardAdvertLocation["status"];
    statusDetail: string;
    nodeName: string;
    nodePublicKey: string;
    advertType: string;
    observerId?: string;
    observerName?: string;
    lat: number;
    lon: number;
  }): void {
    const existing = this.adverts.get(input.requestId);
    this.adverts.set(input.requestId, {
      id: input.requestId,
      requestId: input.requestId,
      status: input.status,
      statusDetail: input.statusDetail,
      at: existing?.at ?? this.isoNow(),
      updatedAt: this.isoNow(),
      nodeName: input.nodeName,
      nodePublicKey: input.nodePublicKey,
      advertType: input.advertType,
      observerId: input.observerId,
      observerName: input.observerName,
      lat: input.lat,
      lon: input.lon,
    });
    this.cleanupAdvertLocations();
  }

  queueStartedImmediately(job: MapUploadWorkRequest): void {
    this.upsertQueueItem(job, "active", null, undefined, "Started immediately.");
    this.updateAdvertStatus(job.requestId, "pending", "Started immediately.");
  }

  queueAdded(job: MapUploadWorkRequest, position: number): void {
    this.upsertQueueItem(job, "queued", position, undefined, `Waiting at queue position ${position}.`);
    this.updateAdvertStatus(job.requestId, "pending", `Waiting at queue position ${position}.`);
  }

  queueRetrying(job: MapUploadWorkRequest, reason: string): void {
    this.upsertQueueItem(job, "retrying", null, undefined, reason);
    this.updateAdvertStatus(job.requestId, "pending", `Retrying: ${reason}`);
  }

  queueDropped(job: MapUploadWorkRequest, reason: string): void {
    this.upsertQueueItem(job, "dropped", null, undefined, reason);
    this.updateAdvertStatus(job.requestId, "rejected", reason);
    this.archiveQueueItem(job.requestId);
  }

  queueHandled(job: MapUploadWorkRequest, responseFromMeshcoreIO?: string): void {
    this.upsertQueueItem(job, "handled", null, undefined, "Handled.", responseFromMeshcoreIO);
    this.updateAdvertStatus(job.requestId, "accepted", "MeshCore.io handled the upload request.", responseFromMeshcoreIO);
    this.archiveQueueItem(job.requestId);
  }

  queuePositionsChanged(jobs: MapUploadWorkRequest[]): void {
    jobs.forEach((job, index) => {
      const item = this.queueItems.get(job.requestId);
      if (item) {
        item.position = index + 1;
        item.state = "queued";
        item.updatedAt = this.isoNow();
      }
    });
  }

  advertIgnored(requestId: string, reason: string): void {
    this.updateAdvertStatus(requestId, "rejected", reason);
  }

  workerUploading(workerId: string, job: MapUploadWorkRequest): void {
    const existingWorker = this.workers.get(workerId);
    this.workers.set(workerId, {
      id: workerId,
      index: existingWorker?.index ?? 0,
      state: "uploading",
      updatedAt: this.isoNow(),
      currentJob: toJobSnapshot(job),
    });
    this.upsertQueueItem(job, "active", null, workerId, `Worker ${workerId} is uploading.`);
    this.updateAdvertStatus(job.requestId, "pending", `Worker ${workerId} is uploading.`);
  }

  workerCooldown(workerId: string, job: MapUploadWorkRequest): void {
    const existingWorker = this.workers.get(workerId);
    this.workers.set(workerId, {
      id: workerId,
      index: existingWorker?.index ?? 0,
      state: "cooldown",
      updatedAt: this.isoNow(),
      currentJob: toJobSnapshot(job),
      detail: "Waiting before draining the next queued upload.",
    });
  }

  workerIdle(workerId: string): void {
    const existingWorker = this.workers.get(workerId);
    this.workers.set(workerId, {
      id: workerId,
      index: existingWorker?.index ?? 0,
      state: "idle",
      updatedAt: this.isoNow(),
    });
  }

  snapshot(): DashboardSnapshot {
    this.cleanupAdvertLocations();
    return {
      generatedAt: this.isoNow(),
      mqttSource: { ...this.mqttSource },
      logs: [...this.logs].reverse(),
      queue: [...this.queueItems.values()]
        .filter((item) => item.state === "queued" || item.state === "active" || item.state === "retrying")
        .sort((a, b) => {
          if (a.state === "active" && b.state !== "active") return -1;
          if (b.state === "active" && a.state !== "active") return 1;
          return (a.position ?? 0) - (b.position ?? 0);
        }),
      queueHistory: [...this.queueHistory],
      workers: [...this.workers.values()].sort((a, b) => a.index - b.index),
      advertsLastHour: this.preferredAdvertLocations().sort((a, b) => a.at.localeCompare(b.at)),
    };
  }

  private upsertQueueItem(
    job: MapUploadWorkRequest,
    state: DashboardQueueItem["state"],
    position: number | null,
    workerId?: string,
    detail?: string,
    responseFromMeshcoreIO?: string
  ): void {
    this.queueItems.set(job.requestId, {
      id: job.requestId,
      state,
      position,
      updatedAt: this.isoNow(),
      job: toJobSnapshot(job),
      workerId,
      detail,
      responseFromMeshcoreIO,
    });
  }

  private archiveQueueItem(requestId: string): void {
    const item = this.queueItems.get(requestId);
    if (!item) {
      return;
    }

    this.queueItems.delete(requestId);
    this.queueHistory.unshift(item);
    while (this.queueHistory.length > MAX_QUEUE_HISTORY) {
      this.queueHistory.pop();
    }

  }

  private updateAdvertStatus(
    requestId: string,
    status: DashboardAdvertLocation["status"],
    statusDetail: string,
    responseFromMeshcoreIO?: string
  ): void {
    const advert = this.adverts.get(requestId);
    if (!advert) {
      return;
    }

    advert.status = status;
    advert.statusDetail = statusDetail;
    advert.responseFromMeshcoreIO = responseFromMeshcoreIO;
    advert.updatedAt = this.isoNow();
  }

  private preferredAdvertLocations(): DashboardAdvertLocation[] {
    const preferredByNode = new Map<string, DashboardAdvertLocation>();

    for (const advert of this.adverts.values()) {
      const existing = preferredByNode.get(advert.nodePublicKey);
      if (!existing || isPreferredAdvertLocation(advert, existing)) {
        preferredByNode.set(advert.nodePublicKey, advert);
      }
    }

    return [...preferredByNode.values()];
  }

  private cleanupAdvertLocations(): void {
    const oldest = this.now().getTime() - ONE_HOUR_MS;
    for (const [key, advert] of this.adverts) {
      if (Date.parse(advert.at) < oldest) {
        this.adverts.delete(key);
      }
    }
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}
