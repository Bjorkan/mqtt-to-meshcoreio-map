import type {
  AdvertLogContext,
  MapApiResponseBody,
  ObserverState,
  PacketCandidate,
  RadioParams,
} from "./map-types.js";
import { sanitizeLogText, trimLogBody, warnMapUpload } from "./map-log.js";

const HEX_RE = /^[0-9a-f]+$/i;
const PUBLIC_KEY_HEX_RE = /^[0-9a-f]{64}$/i;
const MQTT_MESSAGE_TYPES = new Set(["status", "raw", "packets"]);
const MAX_MQTT_PAYLOAD_BYTES = 16 * 1024;
const MAX_PACKET_HEX_CHARS = 1024;

export const UPLOADABLE_ADVERT_TYPES = new Set(["REPEATER", "ROOM", "SENSOR"]);
export const OBSERVER_TTL_MS = 24 * 60 * 60 * 1000;
export const SEEN_ADVERT_TTL_SECONDS = 72 * 60 * 60;
export const DROP_LOG_SUPPRESS_MS = 60 * 1000;
export const UPLOAD_RETRY_DELAY_MS = 5 * 1000;

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

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isHexPublicKey(value: string): boolean {
  return PUBLIC_KEY_HEX_RE.test(value);
}

export function parseJsonPayload(payload: Buffer): unknown | null {
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

export function buildUploadParams(params: RadioParams): RadioParams {
  const uploadParams = buildParams(params);
  if (uploadParams.freq !== undefined) {
    uploadParams.freq = roundToDecimalPlaces(uploadParams.freq, 3);
  }

  return uploadParams;
}

export function parseRadioParams(data: Record<string, unknown>): RadioParams {
  const directParams = typeof data.params === "object" && data.params !== null
    ? data.params as Record<string, unknown>
    : data;

  const radioFromFields: RadioParams = {
    freq: toNumber(directParams.freq ?? directParams.frequency ?? directParams.radioFreq),
    cr: toNumber(directParams.cr ?? directParams.codingRate ?? directParams.radioCr),
    sf: toNumber(directParams.sf ?? directParams.spreadingFactor ?? directParams.radioSf),
    bw: toNumber(directParams.bw ?? directParams.bandwidth ?? directParams.radioBw),
  };

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

export function getTopicType(topic: string): string | undefined {
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

export function readObserverId(data: Record<string, unknown>, topic: string): string | undefined {
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

export function buildPacketCandidate(
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

export function hasCompleteParams(params: RadioParams): params is Required<RadioParams> {
  return [params.freq, params.bw, params.sf, params.cr].every(
    (value) => typeof value === "number" && Number.isFinite(value)
  );
}

export function hasValidParams(params: RadioParams): params is Required<RadioParams> {
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

function shortPublicKey(publicKeyHex: string): string {
  return publicKeyHex.slice(0, 6);
}

export function formatAdvertLabel(nodeName: string, publicKeyHex: string): string {
  return `${sanitizeLogText(nodeName, 80)} (${shortPublicKey(publicKeyHex)})`;
}

export function formatObserverLabel(observer: ObserverState | undefined, observerId: string | undefined): string {
  return observer?.origin ? sanitizeLogText(observer.origin, 80) : (observerId ? shortPublicKey(observerId) : "unknown observer");
}

export function parseMapApiResponse(text: string): MapApiResponseBody | undefined {
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

export function formatMapApiSuccessLog(context: AdvertLogContext, response: MapApiResponseBody | undefined, rawText: string): string {
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

export function isTerminalMapApiResponse(response: MapApiResponseBody | undefined): boolean {
  return typeof response?.code === "string"
    && (
      response.code === "NODES_INSERTED"
      || response.code.startsWith("ERR_ADVERT_")
      || response.code.startsWith("ERR_COORDS_")
    );
}

export function formatSeconds(seconds: number): string {
  return `${Math.max(0, Math.floor(seconds))}s`;
}

export function formatUploadFailureReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || /operation was aborted/i.test(error.message)) {
      return "operation aborted";
    }

    return trimLogBody(error.message || error.name);
  }

  return trimLogBody(String(error));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
}
