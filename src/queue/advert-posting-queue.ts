import type { MeshcoreioPoster } from "../meshcoreio-poster/meshcoreio-poster.js";
import { logMapUpload, warnMapUpload } from "../map-log.js";
import { UPLOAD_RETRY_DELAY_MS, delay, formatUploadFailureReason } from "../map-utils.js";
import type { MapUploadWorkRequest, MapUploaderConfig } from "../map-types.js";

interface UploadQueueJob extends MapUploadWorkRequest {
  resolve: () => void;
}

export interface AdvertPostingQueueDependencies {
  now?: () => number;
  workerDelay?: (ms: number) => Promise<void>;
}

export class AdvertPostingQueue {
  private readonly workerDelay: (ms: number) => Promise<void>;
  private readonly posters: MeshcoreioPoster[];
  private readonly queuedAdvertKeys = new Set<string>();
  private readonly nodeKeysInQueueOrFlight = new Set<string>();
  private readonly uploadQueue: UploadQueueJob[] = [];
  private activeUploads = 0;
  private nextPosterIndex = 0;

  constructor(
    private readonly config: MapUploaderConfig,
    poster: MeshcoreioPoster | MeshcoreioPoster[],
    private readonly onHandled: (pubKey: string, timestamp: number) => void,
    dependencies: AdvertPostingQueueDependencies = {}
  ) {
    this.workerDelay = dependencies.workerDelay ?? delay;
    this.posters = Array.isArray(poster) ? poster : [poster];
  }

  async registerAdvert(input: MapUploadWorkRequest): Promise<void> {
    const { advertKey, logContext, nodePublicKey } = input;

    if (input.retriesAllowed <= 0) {
      warnMapUpload(`No retries allowed for ${logContext.advertLabel}. Dropping queue request ${input.requestId}.`);
      return Promise.resolve();
    }

    if (this.queuedAdvertKeys.has(advertKey) || this.nodeKeysInQueueOrFlight.has(nodePublicKey)) {
      return;
    }

    if (this.activeUploads >= this.config.maxConcurrentUploads && this.uploadQueue.length >= this.config.maxQueuedUploads) {
      warnMapUpload(`Upload queue is full. Dropping advert for ${logContext.advertLabel}.`);
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
      this.startUploadJob(job);
      logMapUpload(`Advert from ${logContext.advertLabel} heard by ${logContext.observerLabel} registered to posting queue. Place in queue 0.`);
    } else {
      this.uploadQueue.push(job);
      logMapUpload(`Advert from ${logContext.advertLabel} heard by ${logContext.observerLabel} registered to posting queue. Place in queue ${this.uploadQueue.length}.`);
    }

    return done;
  }

  private startUploadJob(job: UploadQueueJob): void {
    this.activeUploads += 1;

    void (async () => {
      try {
        const result = await this.nextPoster().post(job);
        if (result.status === "handled") {
          this.onHandled(result.pubKey, result.timestamp);
          this.finishUploadJob(job);
        } else {
          this.retryOrDropUploadJob(job, result.error);
        }
      } finally {
        try {
          await this.workerDelay(UPLOAD_RETRY_DELAY_MS);
        } catch (delayError: unknown) {
          warnMapUpload(`Upload worker delay failed: ${formatUploadFailureReason(delayError)}.`);
        }
        this.activeUploads -= 1;
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
    this.requeueUploadJob(retryJob);
  }

  private requeueUploadJob(job: UploadQueueJob): void {
    if (job.retriesAllowed <= 0) {
      warnMapUpload(`No retries allowed for ${job.logContext.advertLabel}. Dropping queue request ${job.requestId}.`);
      this.finishUploadJob(job);
      return;
    }

    if (this.uploadQueue.length >= this.config.maxQueuedUploads) {
      warnMapUpload(`Upload queue is full. Dropping advert for ${job.logContext.advertLabel}.`);
      this.finishUploadJob(job);
      return;
    }

    this.uploadQueue.push(job);
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
    }
  }

  private nextPoster(): MeshcoreioPoster {
    const poster = this.posters[this.nextPosterIndex % this.posters.length];
    this.nextPosterIndex += 1;
    return poster;
  }
}
