import { randomUUID } from "node:crypto";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import { DashboardState, recordDashboardLog, setActiveDashboardState, type DashboardConfig } from "./dashboard/dashboard-state.js";
import { startDashboardServer, type DashboardServer } from "./dashboard/dashboard-server.js";
import {
  formatMapUploadLogLine,
  MeshcoreMapUploader,
  type MapUploaderConfig,
} from "./map-uploader.js";
import type { MapUploadWorkRequest } from "./map-types.js";

export interface RuntimeConfig {
  sourceUrl: string;
  sourceUser: string;
  sourcePass: string;
  sourceClientId: string;
  topicFilter: string;
  reconnectPeriodMs: number;
  connectTimeoutMs: number;
  rejectUnauthorized: boolean;
  dashboard: DashboardConfig;
  mapUploader: MapUploaderConfig;
}

export interface Runtime {
  client: MqttClient;
  dashboard?: DashboardServer;
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
    dashboard: {
      enabled: envBool(env.ENABLE_DASHBOARD, false),
      port: envIntInRange(env.DASHBOARD_PORT, 80, 1, 65535),
    },
    mapUploader: {
      enabled: true,
      apiUrl: env.MESHCOREIO_API_URL || "https://map.meshcore.io/api/v1/uploader/node",
      dryRun: envBool(env.MESHCOREIO_DRY_RUN, false),
      minReuploadIntervalSeconds: envIntInRange(env.MESHCOREIO_MIN_REUPLOAD_SECONDS, 3600, 0, 86400),
      requestTimeoutMs: envIntInRange(env.MESHCOREIO_REQUEST_TIMEOUT_MS, 10000, 1000, 120000),
      maxConcurrentUploads: envIntInRange(env.MESHCOREIO_WORKERS, 1, 1, 32),
      maxQueuedUploads: envIntInRange(env.MESHCOREIO_MAX_QUEUED_UPLOADS, 25, 0, 10000),
      retriesAllowed: envIntInRange(env.MESHCOREIO_RETRIES_ALLOWED, 3, 0, 100),
    },
  };
}

function log(message: string, source = "runtime"): void {
  recordDashboardLog(message, "info", source);
  console.log(formatMapUploadLogLine(message));
}

function warn(message: string, source = "runtime"): void {
  recordDashboardLog(message, "warn", source);
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

const DEMO_ADVERTS = [
  { nodeName: "DEMO-STOCKHOLM", lat: 59.3293, lon: 18.0686, type: "repeater" },
  { nodeName: "DEMO-OSLO", lat: 59.9139, lon: 10.7522, type: "room" },
  { nodeName: "DEMO-COPENHAGEN", lat: 55.6761, lon: 12.5683, type: "sensor" },
  { nodeName: "DEMO-BERLIN", lat: 52.52, lon: 13.405, type: "repeater" },
  { nodeName: "DEMO-AMSTERDAM", lat: 52.3676, lon: 4.9041, type: "room" },
] as const;

const DEMO_STATUSES = [
  { status: "rejected", detail: "Demo advert was rejected before Meshcore.io could handle it." },
  { status: "pending", detail: "Demo advert is waiting for Meshcore.io handling." },
  { status: "accepted", detail: "Demo advert was accepted by Meshcore.io." },
  { status: "pending", detail: "Demo advert is currently being handled by a worker." },
  { status: "accepted", detail: "Demo advert was accepted as a recent duplicate by Meshcore.io." },
] as const;

const DEMO_WORKERS = ["demo-worker-1", "demo-worker-2"];

function makeDemoJob(advert: typeof DEMO_ADVERTS[number], index: number, requestId: string): MapUploadWorkRequest {
  const nodePublicKey = `${String(index + 1).repeat(64)}`.slice(0, 64);
  return {
    requestId,
    retriesAllowed: 3,
    advertKey: `${nodePublicKey}:${Math.floor(Date.now() / 1000)}`,
    advertTimestamp: Math.floor(Date.now() / 1000),
    advertType: advert.type.toUpperCase(),
    nodeName: advert.nodeName,
    nodePublicKey,
    rawPacketHex: "deadbeef0102030405",
    observerId: `demo-observer-${index + 1}`,
    observerName: "DEMO-OBSERVER",
    radioParams: { freq: 869.5, bw: 125, sf: 9, cr: 5 },
    logContext: {
      advertLabel: `${advert.nodeName} (${nodePublicKey.slice(0, 6)})`,
      observerLabel: "DEMO-OBSERVER",
    },
  };
}

function startDashboardDemoAdverts(state: DashboardState): NodeJS.Timeout {
  const sharedIds = DEMO_ADVERTS.map(() => randomUUID());
  state.configureWorkers(DEMO_WORKERS);

  const queueJobs: Array<{ job: MapUploadWorkRequest; workerId: string; stage: number }> = [];

  let tick = 0;
  const publish = () => {
    // Advance existing queue jobs
    for (const item of queueJobs) {
      item.stage += 1;
    }

    // Remove fully finished jobs (stage 4+)
    while (queueJobs.length > 0 && queueJobs[0].stage >= 4) {
      queueJobs.shift();
    }

    // Add a new queue job each tick, reusing the same requestId as the map marker
    const advertIndex = tick % DEMO_ADVERTS.length;
    const advert = DEMO_ADVERTS[advertIndex];
    const requestId = sharedIds[advertIndex];
    const workerId = DEMO_WORKERS[tick % DEMO_WORKERS.length];
    const job = makeDemoJob(advert, advertIndex, requestId);

    state.queueStartedImmediately(job);
    state.workerUploading(workerId, job);
    queueJobs.push({ job, workerId, stage: 0 });

    // Process transitions for inflight jobs
    for (const item of queueJobs) {
      if (item.stage === 2) {
        state.queueHandled(item.job, '{"code":"NODES_INSERTED","message":"Demo upload accepted."}');
        state.workerCooldown(item.workerId, item.job);
      } else if (item.stage === 3) {
        state.workerIdle(item.workerId);
      }
    }

    // Map markers — run AFTER queue processing so they overwrite any advert deletions
    DEMO_ADVERTS.forEach((advertItem, index) => {
      const demoStatus = DEMO_STATUSES[(index + tick) % DEMO_STATUSES.length];
      state.recordDemoAdvertLocation({
        requestId: sharedIds[index],
        status: demoStatus.status,
        statusDetail: demoStatus.detail,
        nodeName: advertItem.nodeName,
        nodePublicKey: `${String(index + 1).repeat(64)}`.slice(0, 64),
        advertType: advertItem.type,
        observerId: `demo-observer-${index + 1}`,
        observerName: "DEMO-OBSERVER",
        lat: advertItem.lat,
        lon: advertItem.lon,
      });
    });

    tick += 1;
  };

  publish();
  return setInterval(publish, 4000);
}

export function startRuntime(
  config: RuntimeConfig,
  dependencies: RuntimeDependencies = {}
): Runtime {
  const dashboardConfig = config.dashboard ?? { enabled: false, port: 80 };
  const dashboardState = dashboardConfig.enabled ? new DashboardState() : undefined;
  setActiveDashboardState(dashboardState);
  const dashboard = dashboardState ? startDashboardServer(dashboardState, dashboardConfig.port) : undefined;
  if (dashboard) {
    log(`Dashboard enabled on port ${dashboardConfig.port}.`);
  }
  const demoAdverts = dashboardState && envBool(process.env.DASHBOARD_DEMO_ADVERTS, false)
    ? startDashboardDemoAdverts(dashboardState)
    : undefined;
  if (demoAdverts) {
    log("Dashboard demo adverts enabled.");
  }
  const uploader = dependencies.mapUploader ?? new MeshcoreMapUploader(config.mapUploader, { dashboardState });
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
    dashboardState?.setMqttSourceStatus("connected", `Connected to ${safeSourceUrl}.`);
    log(`Connected to MQTT source ${safeSourceUrl}.`, "mqtt-reader");
    client.subscribe(config.topicFilter, { qos: 0 }, (error) => {
      if (error) {
        if (!firstSubscribeAttemptSettled) {
          firstSubscribeAttemptSettled = true;
          rejectFirstSubscribeAttempt(error);
        }
        dashboardState?.setMqttSourceStatus("disconnected", `Subscribe failed: ${error.message}`);
        warn(`Failed to subscribe to ${config.topicFilter}: ${error.message}`, "mqtt-reader");
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
      log(`Subscribed to ${config.topicFilter}.`, "mqtt-reader");
    });
  });

  client.on("message", (topic, payload) => {
    ready
      .then(() => uploader.handleMqttMessage(topic, Buffer.from(payload)))
      .catch((error: Error) => {
        warn(`Map upload handling failed for ${topic}: ${error.message}`, "mqtt-reader");
      });
  });

  client.on("error", (error) => {
    const message = error.message || "Connection failed.";
    dashboardState?.setMqttSourceStatus("disconnected", message);
    warn(`MQTT source error: ${message}`, "mqtt-reader");
  });

  client.on("close", () => {
    dashboardState?.setMqttSourceStatus("disconnected", "MQTT source connection closed.");
  });

  client.on("offline", () => {
    dashboardState?.setMqttSourceStatus("disconnected", "MQTT source is offline.");
    warn("MQTT source is offline.", "mqtt-reader");
  });

  return {
    client,
    dashboard,
    sourceFirstSubscribeAttempt,
    sourceSubscribed,
    stop: async () => {
      await new Promise<void>((resolve) => {
        client.end(true, {}, () => resolve());
      });
      if (demoAdverts) {
        clearInterval(demoAdverts);
      }
      await dashboard?.close();
      setActiveDashboardState(undefined);
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
