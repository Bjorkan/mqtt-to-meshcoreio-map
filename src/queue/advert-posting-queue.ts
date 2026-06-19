import { randomUUID } from "node:crypto";
import type { MeshcoreioPoster } from "../meshcoreio-poster/meshcoreio-poster.js";
import { logMapUpload, warnMapUpload } from "../map-log.js";
import { UPLOAD_RETRY_DELAY_MS, delay, formatUploadFailureReason } from "../map-utils.js";
import type { MapUploadWorkRequest, MapUploaderConfig } from "../map-types.js";
import type { DashboardState } from "../dashboard/dashboard-state.js";

interface UploadQueueJob extends MapUploadWorkRequest {
  resolve: () => void;
}

export interface AdvertPostingQueueDependencies {
  dashboardState?: DashboardState;
  now?: () => number;
  workerDelay?: (ms: number) => Promise<void>;
}

export class AdvertPostingQueue {
  private readonly workerDelay: (ms: number) => Promise<void>;
  private readonly posters: MeshcoreioPoster[];
  private readonly queuedAdvertKeys = new Set<string>();
  private readonly nodeKeysInQueueOrFlight = new Set<string>();
  private readonly uploadQueue: UploadQueueJob[] = [];
  private readonly workerIds: string[];
  private activeUploads = 0;
  private nextPosterIndex = 0;
  private readonly dashboardState?: DashboardState;

  constructor(
    private readonly config: MapUploaderConfig,
    poster: MeshcoreioPoster | MeshcoreioPoster[],
    private readonly onHandled: (pubKey: string, timestamp: number) => void,
    dependencies: AdvertPostingQueueDependencies = {}
  ) {
    this.workerDelay = dependencies.workerDelay ?? delay;
    this.posters = Array.isArray(poster) ? poster : [poster];
    this.workerIds = this.posters.map(() => randomUUID());
    this.dashboardState = dependencies.dashboardState;
    this.dashboardState?.configureWorkers(this.workerIds);
  }

  async registerAdvert(input: MapUploadWorkRequest): Promise<void> {
    const { advertKey, logContext, nodePublicKey } = input;

    if (input.retriesAllowed <= 0) {
      warnMapUpload(`No retries allowed for ${logContext.advertLabel}. Dropping queue request ${input.requestId}.`);
      this.dashboardState?.recordDecision(`No retries allowed for ${logContext.advertLabel}; dropping queue request ${input.requestId}.`, "warn");
      this.dashboardState?.advertIgnored(input.requestId, "No retries allowed.");
      return Promise.resolve();
    }

    if (this.queuedAdvertKeys.has(advertKey) || this.nodeKeysInQueueOrFlight.has(nodePublicKey)) {
      this.dashboardState?.recordDecision(`Advert for ${logContext.advertLabel} is already queued or in flight. Dropping duplicate queue request ${input.requestId}.`);
      this.dashboardState?.advertIgnored(input.requestId, "Advert is already queued or in flight.");
      return;
    }

    if (this.activeUploads >= this.config.maxConcurrentUploads && this.uploadQueue.length >= this.config.maxQueuedUploads) {
      warnMapUpload(`Upload queue is full. Dropping advert for ${logContext.advertLabel}.`);
      this.dashboardState?.queueDropped(input, "Upload queue is full.");
      return Promise.resolve();
    }

    let resolveJob!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });

    const job: UploadQueueJob = {
      ...input,
      resolve: resolveJob,
    };

    this.queuedAdvertKeys.add(advertKey);
    this.nodeKeysInQueueOrFlight.add(nodePublicKey);
    if (this.activeUploads < this.config.maxConcurrentUploads) {
      this.dashboardState?.queueStartedImmediately(job);
      this.startUploadJob(job);
      logMapUpload(`Advert from ${logContext.advertLabel} heard by ${logContext.observerLabel} registered to posting queue. Place in queue 0.`);
    } else {
      this.uploadQueue.push(job);
      this.dashboardState?.queueAdded(job, this.uploadQueue.length);
      logMapUpload(`Advert from ${logContext.advertLabel} heard by ${logContext.observerLabel} registered to posting queue. Place in queue ${this.uploadQueue.length}.`);
    }

    return done;
  }

  private startUploadJob(job: UploadQueueJob): void {
    this.activeUploads += 1;
    const { poster, workerId } = this.nextPoster();
    this.dashboardState?.workerUploading(workerId, job);

    void (async () => {
      try {
        const result = await poster.post(job);
        if (result.status === "handled") {
          this.onHandled(result.pubKey, result.timestamp);
          this.dashboardState?.queueHandled(job);
          this.finishUploadJob(job);
        } else {
          this.retryOrDropUploadJob(job, result.error);
        }
      } finally {
        try {
          this.dashboardState?.workerCooldown(workerId, job);
          await this.workerDelay(UPLOAD_RETRY_DELAY_MS);
        } catch (delayError: unknown) {
          warnMapUpload(`Upload worker delay failed: ${formatUploadFailureReason(delayError)}.`);
        }
        this.activeUploads -= 1;
        this.dashboardState?.workerIdle(workerId);
        this.drainUploadQueue();
      }
    })();
  }

  private retryOrDropUploadJob(job: UploadQueueJob, error: unknown): void {
    const reason = formatUploadFailureReason(error);
    const retryJob: UploadQueueJob = {
      ...job,
      retriesAllowed: job.retriesAllowed - 1,
    };

    warnMapUpload(`Upload failed for ${job.logContext.advertLabel}: ${reason}. Going to the back of the queue, ${retryJob.retriesAllowed} retries allowed.`);
    this.dashboardState?.queueRetrying(retryJob, reason);
    this.requeueUploadJob(retryJob);
  }

  private requeueUploadJob(job: UploadQueueJob): void {
    if (job.retriesAllowed <= 0) {
      warnMapUpload(`No retries allowed for ${job.logContext.advertLabel}. Dropping queue request ${job.requestId}.`);
      this.dashboardState?.queueDropped(job, "No retries allowed.");
      this.finishUploadJob(job);
      return;
    }

    if (this.uploadQueue.length >= this.config.maxQueuedUploads) {
      warnMapUpload(`Upload queue is full. Dropping advert for ${job.logContext.advertLabel}.`);
      this.dashboardState?.queueDropped(job, "Upload queue is full.");
      this.finishUploadJob(job);
      return;
    }

    this.uploadQueue.push(job);
    this.dashboardState?.queueAdded(job, this.uploadQueue.length);
  }

  private finishUploadJob(job: UploadQueueJob): void {
    this.queuedAdvertKeys.delete(job.advertKey);
    this.nodeKeysInQueueOrFlight.delete(job.nodePublicKey);
    job.resolve();
  }

  private drainUploadQueue(): void {
    while (this.activeUploads < this.config.maxConcurrentUploads) {
      const job = this.uploadQueue.shift();
      if (!job) {
        return;
      }

      this.startUploadJob(job);
      this.dashboardState?.queuePositionsChanged(this.uploadQueue);
    }
  }

  private nextPoster(): { poster: MeshcoreioPoster; workerId: string } {
    const workerIndex = this.nextPosterIndex % this.posters.length;
    const workerId = this.workerIds[workerIndex];
    const poster = this.posters[workerIndex];
    this.nextPosterIndex += 1;
    return { poster, workerId };
  }
}
