import { randomUUID } from "node:crypto";
import { Advert, BufferUtils, Packet } from "@liamcottle/meshcore.js";
import type { AdvertPostingQueue } from "../queue/advert-posting-queue.js";
import {
  OBSERVER_TTL_MS,
  SEEN_ADVERT_TTL_SECONDS,
  UPLOADABLE_ADVERT_TYPES,
  buildPacketCandidate,
  buildUploadParams,
  formatAdvertLabel,
  getTopicType,
  hasValidParams,
  parseJsonPayload,
  parseRadioParams,
  readObserverId,
  readString,
} from "../map-utils.js";
import { formatMapUploadLogLine } from "../map-log.js";
import type {
  AdvertLogContext,
  MapUploaderConfig,
  MapUploaderDependencies,
  ObserverState,
} from "../map-types.js";

const VALID_ADVERT_COOLDOWN_MS = 60 * 60 * 1000;

export class MqttBrokerAdvertReader {
  private readonly now: () => number;
  private readonly observers = new Map<string, ObserverState>();
  private readonly seenAdverts = new Map<string, number>();
  private readonly recentValidAdverts = new Map<string, number>();
  readonly ready: Promise<void>;

  constructor(
    private readonly config: MapUploaderConfig,
    private readonly queue: AdvertPostingQueue,
    dependencies: Pick<MapUploaderDependencies, "now"> = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.ready = Promise.resolve();
  }

  handleMqttMessage(topic: string, payload: Buffer, sourceName?: string): void {
    this.processMqttMessage(topic, payload, sourceName).catch((err: Error) => {
      console.error(formatMapUploadLogLine(`Failed: ${err.message}`));
    });
  }

  async processMqttMessage(
    topic: string,
    payload: Buffer,
    sourceName?: string,
  ): Promise<void> {
    await this.ready;

    if (!this.config.enabled) {
      return;
    }

    await this.cleanupState();

    const type = getTopicType(topic);
    if (type === "status") {
      await this.rememberStatus(topic, payload);
      return;
    }

    if (type !== "raw" && type !== "packets") {
      return;
    }

    const candidate = buildPacketCandidate(topic, payload, type);
    if (!candidate) {
      return;
    }

    await this.processPacket(candidate);
  }

  rememberSuccessfulAdvert(pubKey: string, timestamp: number): void {
    const previousTimestamp = this.seenAdverts.get(pubKey);
    if (previousTimestamp === undefined || timestamp > previousTimestamp) {
      this.seenAdverts.set(pubKey, timestamp);
    }
  }

  private async rememberStatus(topic: string, payload: Buffer): Promise<void> {
    const parsed = parseJsonPayload(payload);
    if (typeof parsed !== "object" || parsed === null) {
      return;
    }

    const data = parsed as Record<string, unknown>;

    const originId = readObserverId(data, topic);
    if (!originId) {
      return;
    }

    const parsedParams = parseRadioParams(data);
    if (!hasValidParams(parsedParams)) {
      return;
    }

    const state: ObserverState = {
      origin: readString(data.origin),
      originId,
      params: parsedParams,
      updatedAt: this.now(),
    };

    this.observers.set(originId, state);
  }

  private async processPacket(candidate: {
    rawPacket: Buffer;
    observerId?: string;
  }): Promise<void> {
    let packet: Packet;
    try {
      packet = Packet.fromBytes(candidate.rawPacket);
    } catch {
      return;
    }

    if (packet.payload_type_string !== "ADVERT") {
      return;
    }

    let advert: Advert;
    try {
      advert = Advert.fromBytes(packet.payload);
    } catch {
      return;
    }

    const pubKey = BufferUtils.bytesToHex(advert.publicKey).toLowerCase();
    const advertType = advert.parsed.type?.toUpperCase() ?? "UNKNOWN";
    const nodeName = advert.parsed.name ?? pubKey.slice(0, 8);
    const observer = candidate.observerId
      ? this.observers.get(candidate.observerId)
      : undefined;

    const advertKey = this.makeAdvertKey(pubKey, advert.timestamp);
    const requestId = randomUUID();

    if (!UPLOADABLE_ADVERT_TYPES.has(advertType)) {
      return;
    }

    if (!(await advert.isVerified())) {
      return;
    }

    const params = buildUploadParams(observer?.params ?? {});
    if (!hasValidParams(params)) {
      return;
    }

    const previousTimestamp = this.seenAdverts.get(pubKey);
    if (
      previousTimestamp !== undefined &&
      previousTimestamp >= advert.timestamp
    ) {
      return;
    }

    const previousValidAdvertAt = this.recentValidAdverts.get(pubKey);
    if (
      previousValidAdvertAt !== undefined &&
      this.now() - previousValidAdvertAt < VALID_ADVERT_COOLDOWN_MS
    ) {
      return;
    }

    if (
      previousTimestamp !== undefined &&
      advert.timestamp <
        previousTimestamp + this.config.minReuploadIntervalSeconds
    ) {
      return;
    }

    this.recentValidAdverts.set(pubKey, this.now());
    await this.queue.registerAdvert({
      requestId,
      retriesAllowed: this.config.retriesAllowed,
      advertKey,
      advertTimestamp: advert.timestamp,
      advertType,
      nodeName,
      nodePublicKey: pubKey,
      rawPacketHex: BufferUtils.bytesToHex(candidate.rawPacket),
      observerId: candidate.observerId,
      observerName: observer?.origin,
      radioParams: params,
      logContext: {
        advertLabel: formatAdvertLabel(nodeName, pubKey),
      },
    });
  }

  private makeAdvertKey(pubKey: string, timestamp: number): string {
    return `${pubKey}:${timestamp}`;
  }

  private async cleanupState(): Promise<void> {
    const now = this.now();

    for (const [observerId, observer] of this.observers) {
      if (now - observer.updatedAt > OBSERVER_TTL_MS) {
        this.observers.delete(observerId);
      }
    }

    const oldestAdvertTimestamp =
      Math.floor(now / 1000) - SEEN_ADVERT_TTL_SECONDS;
    for (const [pubKey, timestamp] of this.seenAdverts) {
      if (timestamp < oldestAdvertTimestamp) {
        this.seenAdverts.delete(pubKey);
      }
    }

    const oldestValidAdvert = now - VALID_ADVERT_COOLDOWN_MS;
    for (const [pubKey, heardAt] of this.recentValidAdverts) {
      if (heardAt < oldestValidAdvert) {
        this.recentValidAdverts.delete(pubKey);
      }
    }
  }
}
