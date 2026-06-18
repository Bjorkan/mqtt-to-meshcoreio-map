import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import {
  formatMapUploadLogLine,
  MeshcoreMapUploader,
  type MapUploaderConfig,
} from "./map-uploader.js";

export interface RuntimeConfig {
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
  max: number
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    sourceUrl: env.SOURCE_MQTT_URL || "mqtt://localhost:1883",
    sourceUser: env.SOURCE_MQTT_USERNAME || "",
    sourcePass: env.SOURCE_MQTT_PASSWORD || "",
    sourceClientId: env.SOURCE_CLIENT_ID || "mqtt-to-meshcoreio-map",
    topicFilter: env.TOPIC_FILTER || "meshcore/#",
    reconnectPeriodMs: envIntInRange(env.MQTT_RECONNECT_PERIOD_MS, 5000, 250, 300000),
    connectTimeoutMs: envIntInRange(env.MQTT_CONNECT_TIMEOUT_MS, 30000, 1000, 300000),
    rejectUnauthorized: envBool(env.SOURCE_REJECT_UNAUTHORIZED, true),
    mapUploader: {
      enabled: true,
      apiUrl: env.MESHCOREIO_API_URL || "https://map.meshcore.io/api/v1/uploader/node",
      minReuploadIntervalSeconds: envIntInRange(env.MESHCOREIO_MIN_REUPLOAD_SECONDS, 3600, 0, 86400),
      requestTimeoutMs: envIntInRange(env.MESHCOREIO_REQUEST_TIMEOUT_MS, 10000, 1000, 120000),
      maxConcurrentUploads: envIntInRange(env.MESHCOREIO_MAX_CONCURRENT_UPLOADS, 2, 1, 32),
      maxQueuedUploads: envIntInRange(env.MESHCOREIO_MAX_QUEUED_UPLOADS, 25, 0, 10000),
      requireCompleteRadioParams: envBool(env.MESHCOREIO_REQUIRE_RADIO_PARAMS, true),
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

function buildMqttOptions(config: RuntimeConfig): IClientOptions {
  return {
    username: config.sourceUser || undefined,
    password: config.sourcePass || undefined,
    clientId: config.sourceClientId,
    reconnectPeriod: config.reconnectPeriodMs,
    connectTimeout: config.connectTimeoutMs,
    rejectUnauthorized: config.rejectUnauthorized,
    clean: true,
  };
}

export function startRuntime(
  config: RuntimeConfig,
  dependencies: RuntimeDependencies = {}
): Runtime {
  const uploader = dependencies.mapUploader ?? new MeshcoreMapUploader(config.mapUploader);
  const ready = Promise.resolve(uploader.ready).then(() => undefined);
  const connect = dependencies.connect ?? mqtt.connect;
  const client = connect(config.sourceUrl, buildMqttOptions(config));
  const safeSourceUrl = redactUrlCredentials(config.sourceUrl);

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

  client.on("connect", () => {
    log(`Connected to MQTT source ${safeSourceUrl}.`);
    client.subscribe(config.topicFilter, { qos: 0 }, (error) => {
      if (error) {
        if (!firstSubscribeAttemptSettled) {
          firstSubscribeAttemptSettled = true;
          rejectFirstSubscribeAttempt(error);
        }
        warn(`Failed to subscribe to ${config.topicFilter}: ${error.message}`);
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
      log(`Subscribed to ${config.topicFilter}.`);
    });
  });

  client.on("message", (topic, payload) => {
    ready
      .then(() => uploader.handleMqttMessage(topic, Buffer.from(payload)))
      .catch((error: Error) => {
        warn(`Map upload handling failed for ${topic}: ${error.message}`);
      });
  });

  client.on("error", (error) => {
    warn(`MQTT source error: ${error.message}`);
  });

  client.on("close", () => {
    warn("MQTT source connection closed.");
  });

  client.on("offline", () => {
    warn("MQTT source is offline.");
  });

  return {
    client,
    sourceFirstSubscribeAttempt,
    sourceSubscribed,
    stop: () => new Promise<void>((resolve) => {
      client.end(true, {}, () => resolve());
    }),
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
      log(`Received ${signal}; stopping MQTT source connection.`);
      runtime.stop()
        .then(() => {
          process.exit(0);
        })
        .catch((error: Error) => {
          console.error(formatMapUploadLogLine(`Shutdown failed: ${error.message}`));
          process.exit(1);
        });
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (error) {
    console.error(formatMapUploadLogLine(`Could not start service: ${(error as Error).message}`));
    process.exitCode = 1;
  }
}
