import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import {
  formatMapUploadLogLine,
  MeshcoreMapUploader,
  parseStaticSigningIdentity,
  type MapUploaderConfig,
} from "./map-uploader.js";
import type { MqttSourceConfig } from "./map-types.js";

export interface RuntimeConfig {
  sources: MqttSourceConfig[];
  sourceUrl: string;
  sourceUser: string;
  sourcePass: string;
  sourceClientId: string;
  topicFilter: string;
  reconnectPeriodMs: number;
  connectTimeoutMs: number;
  rejectUnauthorized: boolean;
  mapUploader: MapUploaderConfig;
}

export interface Runtime {
  client: MqttClient;
  clients: MqttClient[];
  sourceFirstSubscribeAttempt: Promise<void>;
  sourceSubscribed: Promise<void>;
  stop(): Promise<void>;
}

export interface RuntimeDependencies {
  connect?: typeof mqtt.connect;
  mapUploader?: {
    ready?: Promise<void>;
    handleMqttMessage(topic: string, payload: Buffer): void | Promise<void>;
  };
}

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envIntInRange(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = envInt(value, fallback);
  if (parsed < min || parsed > max) {
    return fallback;
  }

  return parsed;
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function loadMqttSources(env: NodeJS.ProcessEnv): MqttSourceConfig[] {
  const sources: MqttSourceConfig[] = [];

  // Scan for numbered source configs (SOURCE_1_MQTT_URL, SOURCE_2_MQTT_URL, ...)
  let index = 1;
  while (env[`SOURCE_${index}_MQTT_URL`] !== undefined) {
    const url = env[`SOURCE_${index}_MQTT_URL`]!;
    sources.push({
      name: env[`SOURCE_${index}_NAME`] || url,
      url,
      username: env[`SOURCE_${index}_MQTT_USERNAME`] || "",
      password: env[`SOURCE_${index}_MQTT_PASSWORD`] || "",
      clientId:
        env[`SOURCE_${index}_CLIENT_ID`] || `mqtt-to-meshcoreio-map-${index}`,
      topicFilter: env[`SOURCE_${index}_TOPIC_FILTER`] || "meshcore/#",
      reconnectPeriodMs: envIntInRange(
        env[`SOURCE_${index}_RECONNECT_PERIOD_MS`] ||
          env.MQTT_RECONNECT_PERIOD_MS,
        5000,
        250,
        300000,
      ),
      connectTimeoutMs: envIntInRange(
        env[`SOURCE_${index}_CONNECT_TIMEOUT_MS`] ||
          env.MQTT_CONNECT_TIMEOUT_MS,
        30000,
        1000,
        300000,
      ),
      rejectUnauthorized: envBool(
        env[`SOURCE_${index}_REJECT_UNAUTHORIZED`] ||
          env.SOURCE_REJECT_UNAUTHORIZED,
        true,
      ),
    });
    index++;
  }

  // Fall back to legacy single-source config (treated as source 1)
  if (sources.length === 0) {
    const url = env.SOURCE_MQTT_URL || "mqtt://localhost:1883";
    sources.push({
      name: env.SOURCE_1_NAME || env.SOURCE_NAME || url,
      url,
      username: env.SOURCE_MQTT_USERNAME || "",
      password: env.SOURCE_MQTT_PASSWORD || "",
      clientId: env.SOURCE_CLIENT_ID || "mqtt-to-meshcoreio-map",
      topicFilter: env.TOPIC_FILTER || "meshcore/#",
      reconnectPeriodMs: envIntInRange(
        env.MQTT_RECONNECT_PERIOD_MS,
        5000,
        250,
        300000,
      ),
      connectTimeoutMs: envIntInRange(
        env.MQTT_CONNECT_TIMEOUT_MS,
        30000,
        1000,
        300000,
      ),
      rejectUnauthorized: envBool(env.SOURCE_REJECT_UNAUTHORIZED, true),
    });
  }

  return sources;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const sources = loadMqttSources(env);
  const firstSource = sources[0];
  return {
    sources,
    sourceUrl: firstSource.url,
    sourceUser: firstSource.username,
    sourcePass: firstSource.password,
    sourceClientId: firstSource.clientId,
    topicFilter: firstSource.topicFilter,
    reconnectPeriodMs: firstSource.reconnectPeriodMs,
    connectTimeoutMs: firstSource.connectTimeoutMs,
    rejectUnauthorized: firstSource.rejectUnauthorized,
    mapUploader: {
      enabled: true,
      apiUrl:
        env.MESHCOREIO_API_URL ||
        "https://map.meshcore.io/api/v1/uploader/node",
      dryRun: envBool(env.MESHCOREIO_DRY_RUN, false),
      minReuploadIntervalSeconds: envIntInRange(
        env.MESHCOREIO_MIN_REUPLOAD_SECONDS,
        3600,
        0,
        86400,
      ),
      requestTimeoutMs: envIntInRange(
        env.MESHCOREIO_REQUEST_TIMEOUT_MS,
        10000,
        1000,
        120000,
      ),
      maxQueuedUploads: envIntInRange(
        env.MESHCOREIO_MAX_QUEUED_UPLOADS,
        25,
        1,
        10000,
      ),
      retriesAllowed: envIntInRange(env.MESHCOREIO_RETRIES_ALLOWED, 3, 0, 100),
    },
  };
}

function log(message: string): void {
  console.log(formatMapUploadLogLine(message));
}

function warn(message: string): void {
  console.warn(formatMapUploadLogLine(message));
}

export function redactUrlCredentials(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) {
      url.username = "redacted";
    }
    if (url.password) {
      url.password = "redacted";
    }
    return url.toString();
  } catch {
    return value.replace(/\/\/[^/@\s]+@/, "//redacted@");
  }
}

function buildMqttOptions(source: MqttSourceConfig): IClientOptions {
  return {
    username: source.username || undefined,
    password: source.password || undefined,
    clientId: source.clientId,
    reconnectPeriod: source.reconnectPeriodMs,
    connectTimeout: source.connectTimeoutMs,
    rejectUnauthorized: source.rejectUnauthorized,
    clean: true,
  };
}

export function startRuntime(
  config: RuntimeConfig,
  dependencies: RuntimeDependencies = {},
): Runtime {
  const staticSigningIdentity = dependencies.mapUploader
    ? undefined
    : parseStaticSigningIdentity(process.env.MESHCOREIO_PRIVATE_KEY);
  if (staticSigningIdentity) {
    log(
      `Using MeshCore.io upload public key ${staticSigningIdentity.publicKey.toString("hex")} from MESHCOREIO_PRIVATE_KEY.`,
    );
  }
  if (config.mapUploader.retriesAllowed === 0) {
    warn(
      "MESHCOREIO_RETRIES_ALLOWED is 0; every upload request will be dropped before posting.",
    );
  }
  const uploader =
    dependencies.mapUploader ??
    new MeshcoreMapUploader(config.mapUploader, {
      signingIdentity: staticSigningIdentity,
    });
  const ready = (uploader.ready ?? Promise.resolve()).then(() => undefined);
  ready.catch((error: Error) => {
    warn(`Runtime dependencies failed to initialize: ${error.message}.`);
  });
  const connect = dependencies.connect ?? mqtt.connect;
  const clients: MqttClient[] = [];

  let resolveSubscribed!: () => void;
  let subscribedResolved = false;
  let firstSubscribeAttemptSettled = false;
  let resolveFirstSubscribeAttempt!: () => void;
  let rejectFirstSubscribeAttempt!: (error: Error) => void;
  const sourceFirstSubscribeAttempt = new Promise<void>((resolve, reject) => {
    resolveFirstSubscribeAttempt = resolve;
    rejectFirstSubscribeAttempt = reject;
  });
  const sourceSubscribed = new Promise<void>((resolve) => {
    resolveSubscribed = resolve;
  });

  for (const source of config.sources) {
    const client = connect(source.url, buildMqttOptions(source));
    clients.push(client);
    const safeUrl = redactUrlCredentials(source.url);
    const sourceName = source.name;

    client.on("connect", () => {
      log(`[${sourceName}] Connected to MQTT source ${safeUrl}.`);
      client.subscribe(source.topicFilter, { qos: 0 }, (error) => {
        if (error) {
          if (!firstSubscribeAttemptSettled) {
            firstSubscribeAttemptSettled = true;
            rejectFirstSubscribeAttempt(error);
          }
          warn(
            `[${sourceName}] Failed to subscribe to ${source.topicFilter}: ${error.message}`,
          );
          return;
        }

        if (!firstSubscribeAttemptSettled) {
          firstSubscribeAttemptSettled = true;
          resolveFirstSubscribeAttempt();
        }
        if (!subscribedResolved) {
          subscribedResolved = true;
          resolveSubscribed();
        }
        log(`[${sourceName}] Subscribed to ${source.topicFilter}.`);
      });
    });

    client.on("message", (topic, payload) => {
      ready
        .then(() => uploader.handleMqttMessage(topic, Buffer.from(payload)))
        .catch((error: Error) => {
          warn(
            `[${sourceName}] Map upload handling failed for ${topic}: ${error.message}`,
          );
        });
    });

    client.on("error", (error) => {
      const message = error.message || "Connection failed.";
      warn(`[${sourceName}] MQTT source error: ${message}`);
    });

    client.on("offline", () => {
      warn(`[${sourceName}] MQTT source is offline.`);
    });
  }

  return {
    client: clients[0],
    clients,
    sourceFirstSubscribeAttempt,
    sourceSubscribed,
    stop: async () => {
      await Promise.all(
        clients.map(
          (c) =>
            new Promise<void>((resolve) => {
              c.end(true, {}, () => resolve());
            }),
        ),
      );
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const config = loadConfig();
    const runtime = startRuntime(config);
    let stopping = false;
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) {
        return;
      }

      stopping = true;
      const sourceCount = config.sources.length;
      log(
        `Received ${signal}; stopping ${sourceCount} MQTT source connection${sourceCount !== 1 ? "s" : ""}.`,
      );
      runtime
        .stop()
        .then(() => {
          process.exit(0);
        })
        .catch((error: Error) => {
          console.error(
            formatMapUploadLogLine(`Shutdown failed: ${error.message}`),
          );
          process.exit(1);
        });
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (error) {
    console.error(
      formatMapUploadLogLine(
        `Could not start service: ${(error as Error).message}`,
      ),
    );
    process.exitCode = 1;
  }
}
