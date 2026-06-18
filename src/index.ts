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
    reconnectPeriodMs: envInt(env.MQTT_RECONNECT_PERIOD_MS, 5000),
    connectTimeoutMs: envInt(env.MQTT_CONNECT_TIMEOUT_MS, 30000),
    rejectUnauthorized: envBool(env.SOURCE_REJECT_UNAUTHORIZED, true),
    mapUploader: {
      enabled: true,
      apiUrl: env.MESHCOREIO_API_URL || "https://map.meshcore.io/api/v1/uploader/node",
      minReuploadIntervalSeconds: envInt(env.MESHCOREIO_MIN_REUPLOAD_SECONDS, 3600),
      requestTimeoutMs: envInt(env.MESHCOREIO_REQUEST_TIMEOUT_MS, 10000),
      retryCooldownMs: envInt(env.MESHCOREIO_RETRY_COOLDOWN_MS, 300000),
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

  let resolveSubscribed!: () => void;
  let rejectSubscribed!: (error: Error) => void;
  const sourceSubscribed = new Promise<void>((resolve, reject) => {
    resolveSubscribed = resolve;
    rejectSubscribed = reject;
  });

  client.on("connect", () => {
    log(`Connected to MQTT source ${config.sourceUrl}.`);
    client.subscribe(config.topicFilter, { qos: 0 }, (error) => {
      if (error) {
        rejectSubscribed(error);
        warn(`Failed to subscribe to ${config.topicFilter}: ${error.message}`);
        return;
      }

      resolveSubscribed();
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

  return {
    client,
    sourceSubscribed,
    stop: () => new Promise<void>((resolve) => {
      client.end(false, {}, () => resolve());
    }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const config = loadConfig();
    startRuntime(config);
  } catch (error) {
    console.error(formatMapUploadLogLine(`Could not start service: ${(error as Error).message}`));
    process.exitCode = 1;
  }
}
