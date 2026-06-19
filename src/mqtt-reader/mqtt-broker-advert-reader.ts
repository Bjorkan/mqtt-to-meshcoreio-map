import { randomUUID } from "node:crypto";
import { Advert, BufferUtils, Packet } from "@liamcottle/meshcore.js";
import type { AdvertPostingQueue } from "../queue/advert-posting-queue.js";
import {
  DROP_LOG_SUPPRESS_MS,
  OBSERVER_TTL_MS,
  SEEN_ADVERT_TTL_SECONDS,
  UPLOADABLE_ADVERT_TYPES,
  buildPacketCandidate,
  buildUploadParams,
  formatAdvertLabel,
  formatObserverLabel,
  formatSeconds,
  getTopicType,
  hasCompleteParams,
  hasValidParams,
  parseJsonPayload,
  parseRadioParams,
  readObserverId,
  readString,
} from "../map-utils.js";
import { formatMapUploadLogLine, logMapUpload, warnMapUpload } from "../map-log.js";
import type { AdvertLogContext, MapUploaderConfig, ObserverState } from "../map-types.js";
import type { DashboardState } from "../dashboard/dashboard-state.js";

export class MqttBrokerAdvertReader {
  private readonly now: () => number;
  private readonly observers = new Map<string, ObserverState>();
  private readonly seenAdverts = new Map<string, number>();
  private readonly recentDropLogs = new Map<string, number>();

  constructor(
    private readonly config: MapUploaderConfig,
    private readonly queue: AdvertPostingQueue,
    dependencies: { dashboardState?: DashboardState; now?: () => number } = {}
  ) {
    this.now = dependencies.now ?? Date.now;
    this.dashboardState = dependencies.dashboardState;
  }

  private readonly dashboardState?: DashboardState;

  handleMqttMessage(topic: string, payload: Buffer): void {
    this.processMqttMessage(topic, payload).catch((err: Error) => {
      console.error(formatMapUploadLogLine("Failed:"), err.message);
    });
  }

  async processMqttMessage(topic: string, payload: Buffer): Promise<void> {
    if (!this.config.enabled) {
      this.dashboardState?.recordDecision(`Map uploader disabled; ignoring MQTT message on ${topic}.`);
      return;
    }

    this.cleanupState();

    const type = getTopicType(topic);
    if (type === "status") {
      this.rememberStatus(topic, payload);
      return;
    }

    if (type !== "raw" && type !== "packets") {
      this.dashboardState?.recordDecision(`Topic ${topic} is not status/raw/packets. Ignoring.`);
      return;
    }

    const candidate = buildPacketCandidate(topic, payload, type);
    if (!candidate) {
      this.dashboardState?.recordDecision(`MQTT ${type} message on ${topic} did not contain an uploadable packet candidate.`);
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

  private rememberStatus(topic: string, payload: Buffer): void {
    const parsed = parseJsonPayload(payload);
    if (typeof parsed !== "object" || parsed === null) {
      warnMapUpload(`Status on ${topic} is not JSON. Dropping.`);
      return;
    }

    const data = parsed as Record<string, unknown>;
    const originId = readObserverId(data, topic);
    if (!originId) {
      warnMapUpload("Status is missing a valid observer ID; cannot store radio data.");
      return;
    }

    const parsedParams = parseRadioParams(data);
    const parsedComplete = hasCompleteParams(parsedParams);
    const parsedValid = hasValidParams(parsedParams);

    if (parsedComplete && !parsedValid) {
      warnMapUpload(`Invalid complete radio parameters for ${readString(data.origin) ?? originId}. Keeping the latest valid observer status.`);
      this.dashboardState?.recordDecision(`Status for ${readString(data.origin) ?? originId} had complete but invalid radio parameters; kept latest valid observer status.`, "warn");
      return;
    }

    if (!parsedValid) {
      this.dashboardState?.recordDecision(`Status for ${readString(data.origin) ?? originId} did not include complete valid radio parameters. Ignoring.`);
      return;
    }

    const state: ObserverState = {
      origin: readString(data.origin),
      originId,
      params: parsedParams,
      updatedAt: this.now(),
    };

    this.observers.set(originId, state);
    this.dashboardState?.recordDecision(`Stored observer status for ${formatObserverLabel(state, originId)} with freq ${parsedParams.freq} MHz, BW ${parsedParams.bw}, SF ${parsedParams.sf}, CR ${parsedParams.cr}.`);
  }

  private async processPacket(candidate: { rawPacket: Buffer; observerId?: string }): Promise<void> {
    let packet: Packet;
    try {
      packet = Packet.fromBytes(candidate.rawPacket);
    } catch (err) {
      this.dashboardState?.recordDecision(`Packet from ${candidate.observerId ?? "unknown observer"} could not be parsed. Dropping.`, "warn");
      return;
    }

    if (packet.payload_type_string !== "ADVERT") {
      this.dashboardState?.recordDecision(`Packet from ${candidate.observerId ?? "unknown observer"} has payload type ${packet.payload_type_string ?? "unknown"}, not ADVERT. Ignoring.`);
      return;
    }

    let advert: Advert;
    try {
      advert = Advert.fromBytes(packet.payload);
    } catch {
      warnMapUpload("ADVERT payload could not be parsed. Dropping.");
      this.dashboardState?.recordDecision("ADVERT payload could not be parsed. Dropping.", "warn");
      return;
    }

    const pubKey = BufferUtils.bytesToHex(advert.publicKey).toLowerCase();
    const advertType = advert.parsed.type?.toUpperCase() ?? "UNKNOWN";
    const nodeName = advert.parsed.name ?? pubKey.slice(0, 8);
    const observer = candidate.observerId ? this.observers.get(candidate.observerId) : undefined;
    const logContext: AdvertLogContext = {
      advertLabel: formatAdvertLabel(nodeName, pubKey),
      observerLabel: formatObserverLabel(observer, candidate.observerId),
    };

    const advertKey = this.makeAdvertKey(pubKey, advert.timestamp);
    const requestId = randomUUID();
    this.rememberAdvertLocation({
      requestId,
      advertType,
      nodeName,
      nodePublicKey: pubKey,
      advertTimestamp: advert.timestamp,
      observerId: candidate.observerId,
      observerName: observer?.origin,
      lat: advert.parsed.lat,
      lon: advert.parsed.lon,
    });
    this.dashboardState?.recordDecision(`Parsed ${advertType} advert for ${logContext.advertLabel} heard by ${logContext.observerLabel}.`);

    if (!UPLOADABLE_ADVERT_TYPES.has(advertType)) {
      this.logAdvertDrop(requestId, `type:${advertKey}:${advertType}`, `Advert for ${logContext.advertLabel} received by ${logContext.observerLabel} has type ${advertType}. Dropping.`);
      return;
    }

    if (!(await advert.isVerified())) {
      this.logAdvertDrop(requestId, `signature:${advertKey}`, `Advert for ${logContext.advertLabel} received by ${logContext.observerLabel} failed signature verification. Dropping.`, "warn");
      return;
    }

    const params = buildUploadParams(observer?.params ?? {});
    if (!hasValidParams(params)) {
      this.logAdvertDrop(requestId, `params:${advertKey}`, `Advert for ${logContext.advertLabel} received by ${logContext.observerLabel} is missing valid observer radio parameters. Dropping.`, "warn");
      return;
    }

    const previousTimestamp = this.seenAdverts.get(pubKey);
    if (previousTimestamp !== undefined) {
      if (previousTimestamp >= advert.timestamp) {
        this.logAdvertDrop(requestId, `replay:${advertKey}:${previousTimestamp}`, `Advert for ${logContext.advertLabel} received by ${logContext.observerLabel} was already heard at timestamp ${previousTimestamp}. Dropping.`);
        return;
      }

      if (advert.timestamp < previousTimestamp + this.config.minReuploadIntervalSeconds) {
        this.logAdvertDrop(requestId, `reupload:${advertKey}:${previousTimestamp}`, `Advert for ${logContext.advertLabel} received by ${logContext.observerLabel} is ${formatSeconds(advert.timestamp - previousTimestamp)} newer than the last upload; minimum reupload interval is ${formatSeconds(this.config.minReuploadIntervalSeconds)}. Dropping.`);
        return;
      }
    }

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
      logContext,
    });
  }

  private rememberAdvertLocation(input: {
    requestId: string;
    advertType: string;
    nodeName: string;
    nodePublicKey: string;
    advertTimestamp: number;
    observerId?: string;
    observerName?: string;
    lat: number | null;
    lon: number | null;
  }): void {
    if (input.lat === null || input.lon === null) {
      return;
    }

    const lat = input.lat / 1_000_000;
    const lon = input.lon / 1_000_000;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      this.dashboardState?.recordDecision(`Advert for ${input.nodeName} had out-of-range coordinates ${lat}, ${lon}. Not showing it on the dashboard map.`, "warn");
      return;
    }

    this.dashboardState?.recordAdvertLocation({
      ...input,
      lat,
      lon,
    });
  }

  private logAdvertDrop(requestId: string, dropKey: string, message: string, level: "log" | "warn" = "log"): void {
    this.dashboardState?.advertIgnored(requestId, message);

    const now = this.now();
    const lastLoggedAt = this.recentDropLogs.get(dropKey);
    if (lastLoggedAt !== undefined && now - lastLoggedAt < DROP_LOG_SUPPRESS_MS) {
      return;
    }

    this.recentDropLogs.set(dropKey, now);
    if (level === "warn") {
      warnMapUpload(message);
    } else {
      logMapUpload(message);
    }
  }

  private makeAdvertKey(pubKey: string, timestamp: number): string {
    return `${pubKey}:${timestamp}`;
  }

  private cleanupState(): void {
    const now = this.now();

    for (const [observerId, observer] of this.observers) {
      if (now - observer.updatedAt > OBSERVER_TTL_MS) {
        this.observers.delete(observerId);
      }
    }

    const oldestAdvertTimestamp = Math.floor(now / 1000) - SEEN_ADVERT_TTL_SECONDS;
    for (const [pubKey, timestamp] of this.seenAdverts) {
      if (timestamp < oldestAdvertTimestamp) {
        this.seenAdverts.delete(pubKey);
      }
    }

    const oldestDropLog = now - DROP_LOG_SUPPRESS_MS;
    for (const [dropKey, loggedAt] of this.recentDropLogs) {
      if (loggedAt < oldestDropLog) {
        this.recentDropLogs.delete(dropKey);
      }
    }
  }
}
