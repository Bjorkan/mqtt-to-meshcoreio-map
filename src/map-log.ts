import { recordDashboardLog } from "./dashboard/dashboard-state.js";

const MAX_LOG_BODY_CHARS = 500;
const MAX_LOG_VALUE_CHARS = 240;
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

function configuredTimeZone(): string | undefined {
  const timeZone = process.env.TZ?.trim();
  if (!timeZone) {
    return undefined;
  }

  try {
    new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return undefined;
  }
}

export function trimLogBody(value: string): string {
  return value.length > MAX_LOG_BODY_CHARS
    ? `${value.slice(0, MAX_LOG_BODY_CHARS)}...`
    : value;
}

export function sanitizeLogText(value: string, maxLength = MAX_LOG_VALUE_CHARS): string {
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
    timeZone: configuredTimeZone(),
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

export function logMapUpload(message: string): void {
  recordDashboardLog(message, "info");
  console.log(formatMapUploadLogLine(message));
}

export function warnMapUpload(message: string): void {
  recordDashboardLog(message, "warn");
  console.warn(formatMapUploadLogLine(message));
}
