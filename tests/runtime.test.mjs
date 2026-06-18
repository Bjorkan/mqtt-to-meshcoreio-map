import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { loadConfig, startRuntime } from "../dist/index.js";

class FakeMqttClient extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.subscriptions = [];
    this.ended = false;
  }

  subscribe(topic, options, callback) {
    this.subscriptions.push({ topic, options });
    callback?.(null, [{ topic, qos: options?.qos ?? 0 }]);
  }

  end(_force, _options, callback) {
    this.ended = true;
    callback?.();
  }

  connectNow() {
    this.emit("connect");
  }

  receive(topic, payload) {
    this.emit("message", topic, Buffer.from(payload));
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
      minReuploadIntervalSeconds: 3600,
      requestTimeoutMs: 10000,
      retryCooldownMs: 300000,
      requireCompleteRadioParams: true,
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
  });

  assert.equal(configured.sourceUrl, "mqtts://broker.example:8883");
  assert.equal(configured.sourceUser, "user");
  assert.equal(configured.sourcePass, "pass");
  assert.equal(configured.sourceClientId, "map-uploader");
  assert.equal(configured.topicFilter, "custom/#");
  assert.equal(configured.rejectUnauthorized, false);
  assert.equal(configured.mapUploader.apiUrl, "https://map.example/api");
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
