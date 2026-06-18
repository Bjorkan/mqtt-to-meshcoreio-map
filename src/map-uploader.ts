import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Advert, BufferUtils, Packet } from "@liamcottle/meshcore.js";

export interface MapUploaderConfig {
  enabled: boolean;
  apiUrl: string;
  minReuploadIntervalSeconds: number;
  requestTimeoutMs: number;
  retryCooldownMs: number;
  globalRetryCooldownMs: number;
  maxConcurrentUploads: number;
  maxQueuedUploads: number;
  requireCompleteRadioParams: boolean;
}

export interface MapUploadSigningIdentity {
  publicKey: Buffer;
  privateSeed: Buffer;
}

export interface MapUploaderDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  signingIdentity?: MapUploadSigningIdentity;
}

interface RadioParams {
  freq?: number;
  cr?: number;
  sf?: number;
  bw?: number;
}

interface ObserverState {
  origin?: string;
  originId?: string;
  params: RadioParams;
  updatedAt: number;
}

interface PacketCandidate {
  rawPacket: Buffer;
  observerId?: string;
}

interface SignedRequest {
  data: string;
  signature: string;
  publicKey: string;
}

type MapApiResponseCode =
  | "NODES_INSERTED"
  | "ERR_ADVERT_DUPLICATE"
  | "ERR_COORDS_MISSING"
  | string;

interface MapApiResponseBody {
  code?: MapApiResponseCode;
  message?: string;
  error?: string;
}

interface AdvertLogContext {
  advertLabel: string;
  observerLabel: string;
}

const HEX_RE = /^[0-9a-f]+$/i;
const PUBLIC_KEY_HEX_RE = /^[0-9a-f]{64}$/i;
const MQTT_MESSAGE_TYPES = new Set(["status", "raw", "packets"]);
const UPLOADABLE_ADVERT_TYPES = new Set(["REPEATER", "ROOM", "SENSOR"]);
const MAX_MQTT_PAYLOAD_BYTES = 16 * 1024;
const MAX_PACKET_HEX_CHARS = 1024;
const MAX_LOG_BODY_CHARS = 500;
const MAX_LOG_VALUE_CHARS = 240;
const OBSERVER_TTL_MS = 24 * 60 * 60 * 1000;
const SEEN_ADVERT_TTL_SECONDS = 72 * 60 * 60;
const MAP_UPLOAD_LOG_COLOR = "\x1b[36m";
const RESET_LOG_COLOR = "\x1b[0m";
const MAP_LOG_COLORS = {
  muted: "\x1b[90m",
  mapUpload: "\x1b[32m",
  ok: "\x1b[32m",
  warn: "\x1b[33m",
  deny: "\x1b[31m",
  error: "\x1b[91m",
  publish: "\x1b[32m",
  topic: "\x1b[96m",
  url: "\x1b[94m",
  clientName: "\x1b[36m",
  nodeId: "\x1b[95m",
};

function normalizeHex(value: string): string {
  return value.trim().replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isHexPublicKey(value: string): boolean {
  return PUBLIC_KEY_HEX_RE.test(value);
}

function parseJsonPayload(payload: Buffer): unknown | null {
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
}

function parseRadioString(radio: string | undefined): RadioParams {
  if (!radio) {
    return {};
  }

  const commaSeparated = radio.match(
    /^\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*$/
  );
  if (commaSeparated) {
    return {
      freq: normalizeFrequencyToMHz(Number(commaSeparated[1])),
      bw: normalizeBandwidthToKHz(Number(commaSeparated[2])),
      sf: Number(commaSeparated[3]),
      cr: Number(commaSeparated[4]),
    };
  }

  const params: RadioParams = {};
  const freq = radio.match(/([0-9]+(?:\.[0-9]+)?)\s*MHz/i);
  const bw = radio.match(/\bBW\s*([0-9]+(?:\.[0-9]+)?)/i);
  const sf = radio.match(/\bSF\s*([0-9]+)/i);
  const cr = radio.match(/\bCR\s*([0-9]+)/i);

  if (freq) params.freq = Number(freq[1]);
  if (bw) params.bw = Number(bw[1]);
  if (sf) params.sf = Number(sf[1]);
  if (cr) params.cr = Number(cr[1]);

  return params;
}

function normalizeFrequencyToMHz(value: number): number {
  if (value > 10_000_000) {
    return value / 1_000_000;
  }

  if (value > 10_000) {
    return value / 1_000;
  }

  return value;
}

function normalizeBandwidthToKHz(value: number): number {
  return value > 1_000 ? value / 1_000 : value;
}

function roundToDecimalPlaces(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function buildUploadParams(params: RadioParams): RadioParams {
  const uploadParams = buildParams(params);
  if (uploadParams.freq !== undefined) {
    uploadParams.freq = roundToDecimalPlaces(uploadParams.freq, 3);
  }

  return uploadParams;
}

function parseRadioParams(data: Record<string, unknown>): RadioParams {
  const directParams = typeof data.params === "object" && data.params !== null
    ? data.params as Record<string, unknown>
    : data;

  const radioFromFields: RadioParams = {
    freq: toNumber(directParams.freq ?? directParams.frequency ?? directParams.radioFreq),
    cr: toNumber(directParams.cr ?? directParams.codingRate ?? directParams.radioCr),
    sf: toNumber(directParams.sf ?? directParams.spreadingFactor ?? directParams.radioSf),
    bw: toNumber(directParams.bw ?? directParams.bandwidth ?? directParams.radioBw),
  };

  // Observer firmware can report Hz/kHz/MHz. The map uploader sends MHz/kHz.
  if (radioFromFields.freq !== undefined) {
    radioFromFields.freq = normalizeFrequencyToMHz(radioFromFields.freq);
  }

  if (radioFromFields.bw !== undefined && radioFromFields.bw > 1_000) {
    radioFromFields.bw = normalizeBandwidthToKHz(radioFromFields.bw);
  }

  return {
    ...parseRadioString(readString(data.radio)),
    ...Object.fromEntries(
      Object.entries(radioFromFields).filter(([, value]) => value !== undefined)
    ),
  };
}

function getTopicType(topic: string): string | undefined {
  const parts = topic.split("/");
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (MQTT_MESSAGE_TYPES.has(parts[index])) {
      return parts[index];
    }
  }

  return undefined;
}

function findObserverIdInTopic(topic: string): string | undefined {
  return topic.split("/").find(isHexPublicKey);
}

function readObserverId(data: Record<string, unknown>, topic: string): string | undefined {
  const originId = readString(data.origin_id);
  if (originId) {
    if (isHexPublicKey(originId)) {
      return originId.toLowerCase();
    }

    warnMapUpload(`Ignoring invalid origin_id ${originId}`);
  }

  return findObserverIdInTopic(topic)?.toLowerCase();
}

function getPayloadHex(data: unknown, type: "raw" | "packets"): string | undefined {
  if (typeof data === "string") {
    return normalizeHex(data);
  }

  if (typeof data !== "object" || data === null) {
    return undefined;
  }

  const obj = data as Record<string, unknown>;
  const value = type === "packets"
    ? obj.raw ?? obj.packet ?? obj.payload ?? obj.data
    : obj.data ?? obj.raw ?? obj.packet ?? obj.payload;
  return typeof value === "string" ? normalizeHex(value) : undefined;
}

function isLikelyHexPacket(hex: string | undefined): hex is string {
  return Boolean(hex && hex.length >= 2 && hex.length % 2 === 0 && HEX_RE.test(hex));
}

function buildPacketCandidate(
  topic: string,
  payload: Buffer,
  type: "raw" | "packets"
): PacketCandidate | null {
  if (payload.length > MAX_MQTT_PAYLOAD_BYTES) {
    warnMapUpload("MQTT message is unreasonably large. Dropping.");
    return null;
  }

  const parsed = parseJsonPayload(payload);
  const hex = getPayloadHex(parsed ?? payload.toString("utf8"), type);
  if (!isLikelyHexPacket(hex)) {
    return null;
  }

  if (hex.length > MAX_PACKET_HEX_CHARS) {
    warnMapUpload("Packet hex is unreasonably long. Dropping.");
    return null;
  }

  const observerId = typeof parsed === "object" && parsed !== null
    ? readObserverId(parsed as Record<string, unknown>, topic)
    : findObserverIdInTopic(topic)?.toLowerCase();

  if (!observerId) {
    warnMapUpload("MQTT packet is missing a valid observer ID. Dropping.");
    return null;
  }

  return {
    rawPacket: Buffer.from(hex, "hex"),
    observerId,
  };
}

function buildParams(params: RadioParams): RadioParams {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && Number.isFinite(value))
  ) as RadioParams;
}

function hasCompleteParams(params: RadioParams): params is Required<RadioParams> {
  return [params.freq, params.bw, params.sf, params.cr].every(
    (value) => typeof value === "number" && Number.isFinite(value)
  );
}

function hasValidParams(params: RadioParams): params is Required<RadioParams> {
  return hasCompleteParams(params)
    && params.freq >= 100
    && params.freq <= 1000
    && params.bw > 0
    && params.bw <= 1000
    && params.sf >= 5
    && params.sf <= 12
    && params.cr >= 4
    && params.cr <= 8;
}

function trimLogBody(value: string): string {
  return value.length > MAX_LOG_BODY_CHARS
    ? `${value.slice(0, MAX_LOG_BODY_CHARS)}...`
    : value;
}

function sanitizeLogText(value: string, maxLength = MAX_LOG_VALUE_CHARS): string {
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(2, "0");
    return `\\x${code}`;
  });

  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}

function shouldColorizeLogs(): boolean {
  return process.env.NO_COLOR === undefined && process.env.LOG_COLOR !== "false";
}

function colorizeMapUploadPrefix(label: string): string {
  return shouldColorizeLogs()
    ? `[${MAP_UPLOAD_LOG_COLOR}${label}${RESET_LOG_COLOR}]`
    : `[${label}]`;
}

function mapUploadLogTime(date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function rawMapUploadLogPrefix(date = new Date()): string {
  return `[Map upload ${mapUploadLogTime(date)}]`;
}

export function formatMapUploadLogPrefix(date = new Date()): string {
  return colorizeMapUploadPrefix(`Map upload ${mapUploadLogTime(date)}`);
}

function colorizeMatches(message: string, pattern: RegExp, color: string): string {
  const ansiCodes: string[] = [];
  const protectedMessage = message.replace(/\x1b\[[0-9;]+m/g, (match) => {
    const token = `\uE000${String.fromCharCode(0xE100 + ansiCodes.length)}\uE001`;
    ansiCodes.push(match);
    return token;
  });
  const colorized = protectedMessage.replace(pattern, (match) => `${color}${match}${RESET_LOG_COLOR}`);
  return colorized.replace(/\uE000(.)\uE001/g, (_match, marker: string) => ansiCodes[marker.charCodeAt(0) - 0xE100] ?? "");
}

export function colorizeMapUploadLogLine(message: string): string {
  if (!shouldColorizeLogs()) {
    return message;
  }

  const prefixMatch = message.match(/^(\[([^\]]+)\]\s?)(.*)$/s);
  const prefix = prefixMatch
    ? `[${MAP_LOG_COLORS.mapUpload}${prefixMatch[2]}${RESET_LOG_COLOR}]${prefixMatch[1].endsWith(" ") ? " " : ""}`
    : "";
  let body = prefixMatch ? prefixMatch[3] : message;

  body = colorizeMatches(body, /<[^>]+>/g, MAP_LOG_COLORS.muted);
  body = colorizeMatches(body, /\b(?:failed|Failed|Could not)\b/gi, MAP_LOG_COLORS.error);
  body = colorizeMatches(body, /\b(?:Ignoring|Invalid|invalid|missing valid|blocking upload)\b/gi, MAP_LOG_COLORS.deny);
  body = colorizeMatches(body, /\b(?:Dropping|dropping|unreasonably|Already processing|recently updated|map coordinates missing|not JSON|could not be parsed)\b/gi, MAP_LOG_COLORS.warn);
  body = colorizeMatches(body, /\b(?:Sending to meshcore\.io|accepted)\b/gi, MAP_LOG_COLORS.ok);
  body = colorizeMatches(body, /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, MAP_LOG_COLORS.url);
  body = colorizeMatches(body, /\bmeshcore\/[^\s")]+/g, MAP_LOG_COLORS.topic);
  body = colorizeMatches(body, /\([A-Fa-f0-9]{6,8}\)|\b[A-Fa-f0-9]{6,8}\b/g, MAP_LOG_COLORS.nodeId);
  body = colorizeMatches(body, /\b[A-Z]{2}-[A-Z]{2,3}-[A-Z0-9-]+\b/g, MAP_LOG_COLORS.clientName);

  return `${prefix}${body}`;
}

export function formatMapUploadLogLine(message: string, date = new Date()): string {
  return colorizeMapUploadLogLine(`${rawMapUploadLogPrefix(date)} ${sanitizeLogText(message, MAX_LOG_BODY_CHARS)}`);
}

function logMapUpload(message: string): void {
  console.log(formatMapUploadLogLine(message));
}

function warnMapUpload(message: string): void {
  console.warn(formatMapUploadLogLine(message));
}

export function createMapUploadSigningIdentity(): MapUploadSigningIdentity {
  const privateSeed = randomBytes(32);
  return {
    privateSeed,
    publicKey: Buffer.from(ed25519.getPublicKey(privateSeed)),
  };
}

function shortPublicKey(publicKeyHex: string): string {
  return publicKeyHex.slice(0, 6);
}

function formatAdvertLabel(nodeName: string, publicKeyHex: string): string {
  return `${sanitizeLogText(nodeName, 80)} (${shortPublicKey(publicKeyHex)})`;
}

function formatObserverLabel(observer: ObserverState | undefined, observerId: string | undefined): string {
  return observer?.origin ? sanitizeLogText(observer.origin, 80) : (observerId ? shortPublicKey(observerId) : "unknown observer");
}

function parseMapApiResponse(text: string): MapApiResponseBody | undefined {
  if (!text.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? parsed as MapApiResponseBody
      : undefined;
  } catch {
    return undefined;
  }
}

function formatMapApiSuccessLog(context: AdvertLogContext, response: MapApiResponseBody | undefined, rawText: string): string {
  if (response?.code === "ERR_ADVERT_DUPLICATE") {
    return `Meshcore.io accepted advert for ${context.advertLabel} but dropped it because it was updated recently.`;
  }

  if (response?.code === "NODES_INSERTED") {
    return `Meshcore.io accepted advert for ${context.advertLabel}.`;
  }

  if (response?.code === "ERR_COORDS_MISSING") {
    return `Meshcore.io accepted advert for ${context.advertLabel} but dropped it because map coordinates are missing.`;
  }

  const detail = response?.message ?? response?.error ?? rawText;
  return `Meshcore.io accepted advert for ${context.advertLabel}${detail ? `: ${detail}` : "."}`;
}

export class MeshcoreMapUploader {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly publicKey: Buffer;
  private readonly publicKeyHex: string;
  private readonly privateSeed: Buffer;
  private readonly inFlightAdverts = new Set<string>();
  private readonly reservedAdvertTimestamps = new Map<string, number>();
  private readonly lastAttemptByAdvert = new Map<string, number>();
  private readonly seenAdverts = new Map<string, number>();
  private readonly observers = new Map<string, ObserverState>();
  private readonly uploadQueue: Array<() => void> = [];
  private activeUploads = 0;
  private lastGlobalFailureAt = 0;
  readonly ready: Promise<void>;

  constructor(
    private readonly config: MapUploaderConfig,
    dependencies: MapUploaderDependencies = {}
  ) {
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    const signingIdentity = dependencies.signingIdentity ?? createMapUploadSigningIdentity();
    this.publicKey = Buffer.from(signingIdentity.publicKey);
    this.privateSeed = Buffer.from(signingIdentity.privateSeed);
    this.publicKeyHex = this.publicKey.toString("hex");
    this.ready = Promise.resolve();

    logMapUpload(`Using ephemeral MeshCore.io upload public key ${this.publicKeyHex}.`);
  }

  handleMqttMessage(topic: string, payload: Buffer): void {
    this.processMqttMessage(topic, payload).catch((err: Error) => {
      console.error(formatMapUploadLogLine("Failed:"), err.message);
    });
  }

  async processMqttMessage(topic: string, payload: Buffer): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    this.cleanupState();

    const type = getTopicType(topic);
    if (type === "status") {
      this.rememberStatus(topic, payload);
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
      return;
    }

    if (!parsedValid) {
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

  private async processPacket(candidate: PacketCandidate): Promise<void> {
    let packet: Packet;
    try {
      packet = Packet.fromBytes(candidate.rawPacket);
    } catch (err) {
      return;
    }

    if (packet.payload_type_string !== "ADVERT") {
      return;
    }

    let advert: Advert;
    try {
      advert = Advert.fromBytes(packet.payload);
    } catch {
      warnMapUpload("ADVERT payload could not be parsed. Dropping.");
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

    if (!UPLOADABLE_ADVERT_TYPES.has(advertType)) {
      return;
    }

    const advertKey = this.makeAdvertKey(pubKey, advert.timestamp);
    const previousTimestamp = this.seenAdverts.get(pubKey);
    if (previousTimestamp !== undefined) {
      if (previousTimestamp >= advert.timestamp) {
        return;
      }

      if (advert.timestamp < previousTimestamp + this.config.minReuploadIntervalSeconds) {
        return;
      }
    }

    await this.withUploadSlot(
      logContext,
      () => this.processUploadableAdvert({
        advert,
        advertKey,
        candidate,
        logContext,
        observer,
        pubKey,
      })
    );
  }

  private async processUploadableAdvert(input: {
    advert: Advert;
    advertKey: string;
    candidate: PacketCandidate;
    logContext: AdvertLogContext;
    observer: ObserverState | undefined;
    pubKey: string;
  }): Promise<void> {
    const { advert, advertKey, candidate, logContext, observer, pubKey } = input;

    if (!(await advert.isVerified())) {
      return;
    }

    if (this.inFlightAdverts.has(advertKey)) {
      logMapUpload(`Advert for ${logContext.advertLabel} received by ${logContext.observerLabel}. Already processing. Dropping.`);
      return;
    }

    this.inFlightAdverts.add(advertKey);
    try {
      const params = buildUploadParams(observer?.params ?? {});
      if (this.config.requireCompleteRadioParams && !hasValidParams(params)) {
        return;
      }

      const now = this.now();
      if (this.isGlobalRetryCoolingDown(now)) {
        return;
      }

      if (this.isAdvertTimestampBlocked(pubKey, advert.timestamp)) {
        return;
      }

      const lastAttempt = this.lastAttemptByAdvert.get(advertKey);
      if (lastAttempt !== undefined && now - lastAttempt < this.config.retryCooldownMs) {
        return;
      }

      if (!this.reserveAdvertTimestamp(pubKey, advert.timestamp)) {
        return;
      }
      this.lastAttemptByAdvert.set(advertKey, now);

      try {
        const data = {
          params,
          links: [`meshcore://${BufferUtils.bytesToHex(candidate.rawPacket)}`],
        };

        const requestData = await this.signData(data);
        logMapUpload(`Advert for ${logContext.advertLabel} received by ${logContext.observerLabel}. Sending to meshcore.io.`);

        let response: Response;
        try {
          response = await this.postWithTimeout(requestData);
        } catch (error) {
          this.recordGlobalFailure();
          throw error;
        }

        if (!response.ok) {
          this.recordGlobalFailure();
          const responseText = trimLogBody(await response.text().catch(() => ""));
          throw new Error(`meshcore.io responded ${response.status} for ${logContext.advertLabel}: ${responseText}`);
        }

        const responseText = trimLogBody(await response.text().catch(() => ""));
        const mapResponse = parseMapApiResponse(responseText);
        logMapUpload(formatMapApiSuccessLog(logContext, mapResponse, responseText));
        this.rememberSuccessfulAdvert(pubKey, advert.timestamp);
      } finally {
        this.releaseAdvertTimestampReservation(pubKey, advert.timestamp);
      }
    } finally {
      this.inFlightAdverts.delete(advertKey);
    }
  }

  private reserveAdvertTimestamp(pubKey: string, timestamp: number): boolean {
    if (this.isAdvertTimestampBlocked(pubKey, timestamp)) {
      return false;
    }

    const reservedTimestamp = this.reservedAdvertTimestamps.get(pubKey);
    if (reservedTimestamp !== undefined) {
      if (reservedTimestamp >= timestamp) {
        return false;
      }

      if (timestamp < reservedTimestamp + this.config.minReuploadIntervalSeconds) {
        return false;
      }
    }

    this.reservedAdvertTimestamps.set(pubKey, timestamp);
    return true;
  }

  private releaseAdvertTimestampReservation(pubKey: string, timestamp: number): void {
    if (this.reservedAdvertTimestamps.get(pubKey) === timestamp) {
      this.reservedAdvertTimestamps.delete(pubKey);
    }
  }

  private isAdvertTimestampBlocked(pubKey: string, timestamp: number): boolean {
    const previousTimestamp = this.seenAdverts.get(pubKey);
    if (previousTimestamp === undefined) {
      return false;
    }

    return previousTimestamp >= timestamp
      || timestamp < previousTimestamp + this.config.minReuploadIntervalSeconds;
  }

  private rememberSuccessfulAdvert(pubKey: string, timestamp: number): void {
    const previousTimestamp = this.seenAdverts.get(pubKey);
    if (previousTimestamp === undefined || timestamp > previousTimestamp) {
      this.seenAdverts.set(pubKey, timestamp);
    }
  }

  private async withUploadSlot(context: AdvertLogContext, task: () => Promise<void>): Promise<void> {
    if (this.activeUploads >= this.config.maxConcurrentUploads && this.uploadQueue.length >= this.config.maxQueuedUploads) {
      warnMapUpload(`Upload queue is full. Dropping advert for ${context.advertLabel}.`);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const run = () => {
        this.activeUploads += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.activeUploads -= 1;
            this.uploadQueue.shift()?.();
          });
      };

      if (this.activeUploads < this.config.maxConcurrentUploads) {
        run();
      } else {
        this.uploadQueue.push(run);
      }
    });
  }

  private isGlobalRetryCoolingDown(now = this.now()): boolean {
    return this.config.globalRetryCooldownMs > 0
      && this.lastGlobalFailureAt > 0
      && now - this.lastGlobalFailureAt < this.config.globalRetryCooldownMs;
  }

  private recordGlobalFailure(): void {
    this.lastGlobalFailureAt = this.now();
  }

  private async signData(data: unknown): Promise<SignedRequest> {
    await this.ready;

    const json = JSON.stringify(data);
    const hashHex = createHash("sha256").update(json).digest("hex");
    const signature = Buffer.from(ed25519.sign(Buffer.from(hashHex, "hex"), this.privateSeed)).toString("hex");

    return {
      data: json,
      signature,
      publicKey: this.publicKeyHex,
    };
  }

  private async postWithTimeout(body: SignedRequest): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      return await this.fetchImpl(this.config.apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
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

    const oldestAttempt = now - Math.max(this.config.retryCooldownMs * 2, 60_000);
    for (const [advertKey, attemptedAt] of this.lastAttemptByAdvert) {
      if (attemptedAt < oldestAttempt) {
        this.lastAttemptByAdvert.delete(advertKey);
      }
    }
  }
}
