import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { loadConfig, redactUrlCredentials, startRuntime } from "../../dist/index.js";

class FakeMqttClient extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.subscriptions = [];
    this.subscribeErrors = [];
    this.ended = false;
    this.endForce = undefined;
  }

  subscribe(topic, options, callback) {
    this.subscriptions.push({ topic, options });
    callback?.(this.subscribeErrors.shift() ?? null, [{ topic, qos: options?.qos ?? 0 }]);
  }

  end(force, _options, callback) {
    this.ended = true;
    this.endForce = force;
    callback?.();
  }

  connectNow() {
    this.emit("connect");
  }

  receive(topic, payload) {
    this.emit("message", topic, Buffer.from(payload));
  }

  goOffline() {
    this.emit("offline");
  }
}

function makeConfig(overrides = {}) {
  return {
    sourceUrl: "mqtt://source.local:1883",
    sourceUser: "source-user",
    sourcePass: "source-pass",
    sourceClientId: "source-client",
    topicFilter: "meshcore/#",
    reconnectPeriodMs: 10,
    connectTimeoutMs: 100,
    rejectUnauthorized: true,
    mapUploader: {
      enabled: true,
      apiUrl: "https://map.meshcore.io/api/v1/uploader/node",
      dryRun: false,
      minReuploadIntervalSeconds: 3600,
      requestTimeoutMs: 10000,
      maxConcurrentUploads: 2,
      maxQueuedUploads: 25,
      retriesAllowed: 3,
    },
    ...overrides,
  };
}

test("loads runtime configuration from environment with production defaults", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.sourceUrl, "mqtt://localhost:1883");
  assert.equal(defaults.sourceClientId, "mqtt-to-meshcoreio-map");
  assert.equal(defaults.topicFilter, "meshcore/#");
  assert.equal(defaults.mapUploader.enabled, true);
  assert.equal(defaults.mapUploader.apiUrl, "https://map.meshcore.io/api/v1/uploader/node");

  const configured = loadConfig({
    SOURCE_MQTT_URL: "mqtts://broker.example:8883",
    SOURCE_MQTT_USERNAME: "user",
    SOURCE_MQTT_PASSWORD: "pass",
    SOURCE_CLIENT_ID: "map-uploader",
    TOPIC_FILTER: "custom/#",
    SOURCE_REJECT_UNAUTHORIZED: "false",
    MESHCOREIO_API_URL: "https://map.example/api",
    MESHCOREIO_DRY_RUN: "true",
    MESHCOREIO_WORKERS: "4",
    MESHCOREIO_MAX_QUEUED_UPLOADS: "50",
    MESHCOREIO_RETRIES_ALLOWED: "5",
  });

  assert.equal(configured.sourceUrl, "mqtts://broker.example:8883");
  assert.equal(configured.sourceUser, "user");
  assert.equal(configured.sourcePass, "pass");
  assert.equal(configured.sourceClientId, "map-uploader");
  assert.equal(configured.topicFilter, "custom/#");
  assert.equal(configured.rejectUnauthorized, false);
  assert.equal(configured.mapUploader.apiUrl, "https://map.example/api");
  assert.equal(configured.mapUploader.dryRun, true);
  assert.equal(configured.mapUploader.maxConcurrentUploads, 4);
  assert.equal(configured.mapUploader.maxQueuedUploads, 50);
  assert.equal(configured.mapUploader.retriesAllowed, 5);
});

test("falls back for invalid numeric environment values", () => {
  const configured = loadConfig({
    MQTT_RECONNECT_PERIOD_MS: "-1",
    MQTT_CONNECT_TIMEOUT_MS: "0",
    MESHCOREIO_REQUEST_TIMEOUT_MS: "999999999",
    MESHCOREIO_WORKERS: "0",
    MESHCOREIO_MAX_QUEUED_UPLOADS: "-5",
    MESHCOREIO_RETRIES_ALLOWED: "101",
  });

  assert.equal(configured.reconnectPeriodMs, 5000);
  assert.equal(configured.connectTimeoutMs, 30000);
  assert.equal(configured.mapUploader.requestTimeoutMs, 10000);
  assert.equal(configured.mapUploader.maxConcurrentUploads, 1);
  assert.equal(configured.mapUploader.maxQueuedUploads, 25);
  assert.equal(configured.mapUploader.retriesAllowed, 3);
});

test("redacts credentials from source MQTT URLs before logging", () => {
  assert.equal(
    redactUrlCredentials("mqtts://user:secret@example.com:8883/path"),
    "mqtts://redacted:redacted@example.com:8883/path"
  );
  assert.equal(
    redactUrlCredentials("mqtt://token@example.com"),
    "mqtt://redacted@example.com"
  );
});

test("subscribes to the configured MQTT source filter", async () => {
  const clients = [];
  const runtime = startRuntime(makeConfig({ topicFilter: "meshcore/test/#" }), {
    connect(url, options) {
      const client = new FakeMqttClient(url, options);
      clients.push(client);
      return client;
    },
    mapUploader: {
      handleMqttMessage() {},
    },
  });

  const source = clients[0];
  source.connectNow();
  await runtime.sourceSubscribed;

  assert.deepEqual(source.subscriptions, [
    { topic: "meshcore/test/#", options: { qos: 0 } },
  ]);

  await runtime.stop();
  assert.equal(source.ended, true);
  assert.equal(source.endForce, true);
});

test("reports the first subscribe failure while allowing a later reconnect to subscribe", async () => {
  const clients = [];
  const runtime = startRuntime(makeConfig(), {
    connect(url, options) {
      const client = new FakeMqttClient(url, options);
      client.subscribeErrors.push(new Error("subscribe failed"));
      clients.push(client);
      return client;
    },
    mapUploader: {
      handleMqttMessage() {},
    },
  });

  const source = clients[0];
  source.connectNow();
  await assert.rejects(runtime.sourceFirstSubscribeAttempt, /subscribe failed/);

  source.connectNow();
  await runtime.sourceSubscribed;
  assert.equal(source.subscriptions.length, 2);

  await runtime.stop();
});

test("logs MQTT offline events", async () => {
  const clients = [];
  const runtime = startRuntime(makeConfig(), {
    connect(url, options) {
      const client = new FakeMqttClient(url, options);
      clients.push(client);
      return client;
    },
    mapUploader: {
      handleMqttMessage() {},
    },
  });

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => {
    warnings.push(args.join(" "));
  };

  try {
    clients[0].goOffline();
  } finally {
    console.warn = originalWarn;
    await runtime.stop();
  }

  assert.match(warnings.join("\n"), /MQTT source is offline/);
});

test("passes MQTT source messages to the map uploader", async () => {
  const seen = [];
  const clients = [];
  const runtime = startRuntime(makeConfig(), {
    connect(url, options) {
      const client = new FakeMqttClient(url, options);
      clients.push(client);
      return client;
    },
    mapUploader: {
      handleMqttMessage(topic, payload) {
        seen.push({ topic, payload: payload.toString() });
      },
    },
  });

  const source = clients[0];
  source.connectNow();
  await runtime.sourceSubscribed;
  source.receive("meshcore/STO/node/raw", "{\"data\":\"11\"}");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(seen, [
    { topic: "meshcore/STO/node/raw", payload: "{\"data\":\"11\"}" },
  ]);

  await runtime.stop();
});
