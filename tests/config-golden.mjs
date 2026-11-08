// Regenerate with: bun tests/config-golden.mjs
// The fixtures are produced by the original TypeScript resolver, not Rust.
import { loadConfig } from "../src/index.ts";
import { parseStaticSigningIdentity } from "../src/map-uploader.ts";
import { writeFileSync } from "node:fs";
import { URL } from "node:url";

const seed = "01".repeat(32);
const cases = [
  ["defaults", {}],
  [
    "legacy",
    {
      SOURCE_MQTT_URL: "mqtts://broker:8883",
      SOURCE_NAME: "legacy",
      SOURCE_MQTT_USERNAME: "user",
      SOURCE_MQTT_PASSWORD: "pass",
      SOURCE_CLIENT_ID: "client",
      TOPIC_FILTER: "custom/#",
      SOURCE_REJECT_UNAUTHORIZED: "false",
    },
  ],
  [
    "legacy-name-precedence",
    { SOURCE_1_NAME: "first", SOURCE_NAME: "second", SOURCE_MQTT_URL: "" },
  ],
  [
    "numbered",
    {
      SOURCE_1_MQTT_URL: "wss://one/mqtt",
      SOURCE_1_NAME: "one",
      SOURCE_1_MQTT_USERNAME: "a",
      SOURCE_1_MQTT_PASSWORD: "b",
      SOURCE_1_CLIENT_ID: "explicit",
      SOURCE_1_TOPIC_FILTER: "one/#",
      SOURCE_2_MQTT_URL: "mqtt://two",
      SOURCE_2_TOPIC_FILTER: "two/#",
      SOURCE_MQTT_URL: "mqtt://ignored",
      SOURCE_MQTT_USERNAME: "ignored",
    },
  ],
  [
    "gap",
    { SOURCE_1_MQTT_URL: "mqtt://one", SOURCE_3_MQTT_URL: "mqtt://ignored" },
  ],
  [
    "missing-first",
    { SOURCE_2_MQTT_URL: "mqtt://ignored", SOURCE_MQTT_URL: "mqtt://legacy" },
  ],
  [
    "empty-first",
    {
      SOURCE_1_MQTT_URL: "",
      SOURCE_2_MQTT_URL: "mqtt://two",
      SOURCE_NAME: "ignored",
    },
  ],
  [
    "global-override",
    {
      MQTT_RECONNECT_PERIOD_MS: "999",
      MQTT_CONNECT_TIMEOUT_MS: "1001",
      SOURCE_REJECT_UNAUTHORIZED: "false",
      SOURCE_1_MQTT_URL: "mqtt://one",
      SOURCE_2_MQTT_URL: "mqtt://two",
      SOURCE_2_RECONNECT_PERIOD_MS: "250",
      SOURCE_2_CONNECT_TIMEOUT_MS: "300000",
      SOURCE_2_REJECT_UNAUTHORIZED: "true",
    },
  ],
  [
    "empty-override",
    {
      SOURCE_1_MQTT_URL: "mqtt://one",
      SOURCE_1_RECONNECT_PERIOD_MS: "",
      SOURCE_1_CONNECT_TIMEOUT_MS: "",
      SOURCE_1_REJECT_UNAUTHORIZED: "",
      MQTT_RECONNECT_PERIOD_MS: "350",
      MQTT_CONNECT_TIMEOUT_MS: "2000",
      SOURCE_REJECT_UNAUTHORIZED: "false",
    },
  ],
  [
    "invalid-override-does-not-inherit",
    {
      SOURCE_1_MQTT_URL: "mqtt://one",
      SOURCE_1_RECONNECT_PERIOD_MS: "oops",
      SOURCE_1_CONNECT_TIMEOUT_MS: "9999999",
      SOURCE_1_REJECT_UNAUTHORIZED: "garbage",
      MQTT_RECONNECT_PERIOD_MS: "750",
      MQTT_CONNECT_TIMEOUT_MS: "5000",
      SOURCE_REJECT_UNAUTHORIZED: "true",
    },
  ],
  [
    "bounds-min",
    {
      MQTT_RECONNECT_PERIOD_MS: "250",
      MQTT_CONNECT_TIMEOUT_MS: "1000",
      MESHCOREIO_MIN_REUPLOAD_SECONDS: "0",
      MESHCOREIO_REQUEST_TIMEOUT_MS: "1000",
      MESHCOREIO_MAX_QUEUED_UPLOADS: "1",
      MESHCOREIO_RETRIES_ALLOWED: "0",
    },
  ],
  [
    "bounds-max",
    {
      MQTT_RECONNECT_PERIOD_MS: "300000",
      MQTT_CONNECT_TIMEOUT_MS: "300000",
      MESHCOREIO_MIN_REUPLOAD_SECONDS: "86400",
      MESHCOREIO_REQUEST_TIMEOUT_MS: "120000",
      MESHCOREIO_MAX_QUEUED_UPLOADS: "10000",
      MESHCOREIO_RETRIES_ALLOWED: "100",
    },
  ],
  [
    "out-of-bounds",
    {
      MQTT_RECONNECT_PERIOD_MS: "249",
      MQTT_CONNECT_TIMEOUT_MS: "300001",
      MESHCOREIO_MIN_REUPLOAD_SECONDS: "-1",
      MESHCOREIO_REQUEST_TIMEOUT_MS: "120001",
      MESHCOREIO_MAX_QUEUED_UPLOADS: "0",
      MESHCOREIO_RETRIES_ALLOWED: "101",
    },
  ],
  [
    "numeric-formats",
    {
      MQTT_RECONNECT_PERIOD_MS: " 5e2 ",
      MQTT_CONNECT_TIMEOUT_MS: "0x7530",
      MESHCOREIO_MIN_REUPLOAD_SECONDS: "0b1010",
      MESHCOREIO_REQUEST_TIMEOUT_MS: "1e4",
      MESHCOREIO_MAX_QUEUED_UPLOADS: "+50",
      MESHCOREIO_RETRIES_ALLOWED: "3.0",
    },
  ],
  [
    "invalid-numeric",
    {
      MQTT_RECONNECT_PERIOD_MS: "NaN",
      MQTT_CONNECT_TIMEOUT_MS: "Infinity",
      MESHCOREIO_MIN_REUPLOAD_SECONDS: "1.5",
      MESHCOREIO_REQUEST_TIMEOUT_MS: "1_000",
      MESHCOREIO_MAX_QUEUED_UPLOADS: " ",
      MESHCOREIO_RETRIES_ALLOWED: "-5",
    },
  ],
  [
    "bool-formats",
    {
      MESHCOREIO_DRY_RUN: "YeS",
      SOURCE_REJECT_UNAUTHORIZED: "  true ",
      LOG_COLOR: "FALSE",
      TZ: "Europe/Stockholm",
    },
  ],
  ["invalid-time-zone", { TZ: "Not/A_Time_Zone", LOG_COLOR: "FALSE" }],
  [
    "upload-settings",
    {
      MESHCOREIO_API_URL: "https://example.test/api",
      MESHCOREIO_DRY_RUN: "on",
      MESHCOREIO_MIN_REUPLOAD_SECONDS: "42",
      MESHCOREIO_REQUEST_TIMEOUT_MS: "9999",
      MESHCOREIO_MAX_QUEUED_UPLOADS: "99",
      MESHCOREIO_RETRIES_ALLOWED: "5",
    },
  ],
  [
    "blank-settings",
    {
      MESHCOREIO_API_URL: "",
      MESHCOREIO_DRY_RUN: "",
      MESHCOREIO_PRIVATE_KEY: "  ",
      LOG_COLOR: "false",
      NO_COLOR: "",
      TZ: "",
    },
  ],
  ["signing-static", { MESHCOREIO_PRIVATE_KEY: `  ${seed.toUpperCase()}  ` }],
  ["signing-invalid", { MESHCOREIO_PRIVATE_KEY: "not-a-key" }],
  // compose.yaml.example env_file plus environment: LOG_COLOR=false.
  [
    "compose-env-file",
    {
      SOURCE_MQTT_URL: "mqtt://broker:1883",
      SOURCE_MQTT_USERNAME: "user",
      SOURCE_MQTT_PASSWORD: "pass",
      TOPIC_FILTER: "meshcore/#",
      LOG_COLOR: "false",
      TZ: "Europe/Stockholm",
    },
  ],
];

const fixtures = cases.map(([name, env]) => {
  let signingPublicKey = null;
  let signingError = null;
  try {
    signingPublicKey =
      parseStaticSigningIdentity(
        env.MESHCOREIO_PRIVATE_KEY,
      )?.publicKey.toString("hex") ?? null;
  } catch (error) {
    signingError = error.message;
  }
  return {
    name,
    env,
    resolved: loadConfig(env),
    signingPublicKey,
    signingError,
    logColor: env.NO_COLOR === undefined && env.LOG_COLOR !== "false",
    timeZone: (() => {
      const tz = env.TZ?.trim();
      if (!tz) return null;
      try {
        new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(new Date(0));
        return tz;
      } catch {
        return null;
      }
    })(),
  };
});
writeFileSync(
  new URL("./config-golden.json", import.meta.url),
  JSON.stringify(fixtures, null, 2) + "\n",
);
