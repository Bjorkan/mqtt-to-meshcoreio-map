import type { MeshcoreioPoster } from "../meshcoreio-poster/meshcoreio-poster.js";
import { warnMapUpload } from "../map-log.js";
import {
  UPLOAD_PACE_DELAY_MS,
  delay,
  formatUploadFailureReason,
} from "../map-utils.js";
import type { MapUploadWorkRequest, MapUploaderConfig } from "../map-types.js";

interface UploadQueueJob extends MapUploadWorkRequest {
  resolve: () => void;
  attempts: number;
}

export interface AdvertPostingQueueDependencies {
  uploadDelay?: (ms: number) => Promise<void>;
}

export class AdvertPostingQueue {
  private readonly poster: MeshcoreioPoster;
  private readonly uploadDelay: (ms: number) => Promise<void>;
  private readonly queuedAdvertKeys = new Set<string>();
  private readonly nodeKeysInQueueOrFlight = new Set<string>();
  private readonly uploadQueue: UploadQueueJob[] = [];
  private draining = false;

  constructor(
    private readonly config: MapUploaderConfig,
    poster: MeshcoreioPoster,
    private readonly onHandled: (pubKey: string, timestamp: number) => void,
    dependencies: AdvertPostingQueueDependencies = {},
  ) {
    this.poster = poster;
    this.uploadDelay = dependencies.uploadDelay ?? delay;
  }

  async registerAdvert(input: MapUploadWorkRequest): Promise<void> {
    const { advertKey, logContext, nodePublicKey } = input;

    if (input.retriesAllowed <= 0) {
      return;
    }

    if (
      this.queuedAdvertKeys.has(advertKey) ||
      this.nodeKeysInQueueOrFlight.has(nodePublicKey)
    ) {
      return;
    }

    if (this.uploadQueue.length >= this.config.maxQueuedUploads) {
      warnMapUpload(
        `Upload queue is full. Dropping advert for ${logContext.advertLabel}.`,
      );
      return Promise.resolve();
    }

    let resolveJob!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });

    this.queuedAdvertKeys.add(advertKey);
    this.nodeKeysInQueueOrFlight.add(nodePublicKey);
    this.uploadQueue.push({
      ...input,
      attempts: 0,
      resolve: resolveJob,
    });
    this.scheduleDrain();

    return done;
  }

  private scheduleDrain(): void {
    if (this.draining) {
      return;
    }

    this.draining = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.uploadQueue.length > 0) {
        const job = this.uploadQueue.shift();
        if (!job) {
          break;
        }

        await this.processJob(job);

        if (this.uploadQueue.length > 0) {
          try {
            await this.uploadDelay(UPLOAD_PACE_DELAY_MS);
          } catch (delayError: unknown) {
            warnMapUpload(
              `Upload delay failed: ${formatUploadFailureReason(delayError)}.`,
            );
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async processJob(job: UploadQueueJob): Promise<void> {
    try {
      job.attempts += 1;
      const result = await this.poster.post(job);
      if (result.status === "handled") {
        this.onHandled(result.pubKey, result.timestamp);
        this.finishUploadJob(job);
      } else {
        this.retryOrDropUploadJob(job, result.error);
      }
    } catch (error: unknown) {
      this.retryOrDropUploadJob(job, error);
    }
  }

  private retryOrDropUploadJob(job: UploadQueueJob, error: unknown): void {
    const reason = formatUploadFailureReason(error);
    const retryJob: UploadQueueJob = {
      ...job,
      retriesAllowed: job.retriesAllowed - 1,
    };

    if (retryJob.retriesAllowed <= 0) {
      warnMapUpload(
        `Advert ${job.logContext.advertLabel} dropped after ${job.attempts} attempt${job.attempts === 1 ? "" : "s"}: ${reason}.`,
      );
      this.finishUploadJob(job);
      return;
    }

    if (this.uploadQueue.length >= this.config.maxQueuedUploads) {
      warnMapUpload(
        `Upload queue is full. Dropping advert for ${job.logContext.advertLabel}.`,
      );
      this.finishUploadJob(job);
      return;
    }

    this.uploadQueue.push(retryJob);
  }

  private finishUploadJob(job: UploadQueueJob): void {
    this.queuedAdvertKeys.delete(job.advertKey);
    this.nodeKeysInQueueOrFlight.delete(job.nodePublicKey);
    job.resolve();
  }
}
