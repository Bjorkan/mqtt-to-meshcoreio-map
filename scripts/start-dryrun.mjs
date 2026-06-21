import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  getActiveDashboardState,
} from "../dist/dashboard/dashboard-state.js";
import { fetchSuggestedRadioPresets } from "../dist/suggested-radio-presets.js";

class MockMqttClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    process.nextTick(() => this.emit("offline"));
  }
  subscribe() {}
  end(force, opts, cb) {
    if (typeof opts === "function") { cb = opts; }
    else if (typeof cb !== "function") { cb = () => {}; }
    cb();
  }
}

process.env.ENABLE_DASHBOARD = "true";
process.env.DASHBOARD_PORT = process.env.DASHBOARD_PORT || "6543";
process.env.DASHBOARD_DEMO_ADVERTS = "false";
process.env.MESHCOREIO_DRY_RUN = "true";
process.env.TURSO_PATH = process.env.TURSO_PATH || "/tmp/mqtt-test-dryrun.turso";
process.env.MESHCOREIO_MIN_REUPLOAD_SECONDS = "0";

// Fetch suggested radio presets from the API
const resp = await fetch("https://api.meshcore.nz/api/v1/config");
const configData = await resp.json();
const presets = configData.config.suggested_radio_settings.entries;
console.error(`Loaded ${presets.length} suggested radio presets`);

// Simple preset matching — same logic as matchPresetTitle in suggested-radio-presets.ts
function findPresetTitle(radioParams) {
  if (!presets || radioParams.freq === undefined || radioParams.bw === undefined || radioParams.sf === undefined) {
    return undefined;
  }
  const freq = Math.round(radioParams.freq * 1000) / 1000;
  const bw = radioParams.bw;
  const sf = radioParams.sf;
  for (const entry of presets) {
    const entryFreq = Math.round(parseFloat(entry.frequency) * 1000) / 1000;
    const entryBw = parseFloat(entry.bandwidth);
    const entrySf = parseInt(entry.spreading_factor, 10);
    if (Math.abs(entryFreq - freq) < 0.001 && Math.abs(entryBw - bw) < 0.01 && entrySf === sf) {
      return entry.title;
    }
  }
  return undefined;
}

// Import and start runtime
const { startRuntime, loadConfig } = await import("../dist/index.js");

const config = loadConfig();
const runtime = startRuntime(config, {
  connect: () => new MockMqttClient(),
});

const state = getActiveDashboardState();
await state?.ready;

// Await the module-level preset fetch (started by startRuntime).
// Subsequent calls share the same promise — only one HTTP request per boot.
await fetchSuggestedRadioPresets();

// --- Demo data setup ---
const DEMO_ADVERTS = [
  { nodeName: "DEMO-STOCKHOLM", lat: 59.3293, lon: 18.0686, type: "repeater" },
  { nodeName: "DEMO-OSLO", lat: 59.9139, lon: 10.7522, type: "room" },
  { nodeName: "DEMO-COPENHAGEN", lat: 55.6761, lon: 12.5683, type: "sensor" },
  { nodeName: "DEMO-BERLIN", lat: 52.52, lon: 13.405, type: "repeater" },
  { nodeName: "DEMO-AMSTERDAM", lat: 52.3676, lon: 4.9041, type: "room" },
];

// First 3 nodes (0,1,2) get params matching EU suggested presets
// Last 2 nodes (3,4) use default params that don't match any preset
const RADIO_PARAMS = [
  { freq: 869.618, bw: 62.5, sf: 8, cr: 8 },   // matches "EU/UK (Narrow)" / "Switzerland"
  { freq: 869.618, bw: 62.5, sf: 7, cr: 5 },    // matches "Netherlands"
  { freq: 869.432, bw: 62.5, sf: 7, cr: 5 },    // matches "Czech Republic (Narrow)"
  { freq: 869.5, bw: 125, sf: 9, cr: 5 },        // default — no preset match
  { freq: 869.5, bw: 125, sf: 9, cr: 5 },        // default — no preset match
];

function presetLabel(index) {
  const title = findPresetTitle(RADIO_PARAMS[index]);
  return title || "(none)";
}

const DEMO_STATUSES = [
  { status: "rejected", detail: "Demo advert was rejected before Meshcore.io could handle it." },
  { status: "pending", detail: "Demo advert is waiting for Meshcore.io handling." },
  { status: "accepted", detail: "Demo advert was accepted by Meshcore.io." },
  { status: "pending", detail: "Demo advert is currently being handled by a worker." },
  { status: "accepted", detail: "Demo advert was accepted as a recent duplicate by Meshcore.io." },
];

const DEMO_MOVEMENT_RADIUS = 0.3;
const DEMO_WORKER_COUNT = 2;

function demoPosition(baseLat, baseLon, index, tick) {
  const angle = tick * 0.3 + index * 1.2;
  const radius = DEMO_MOVEMENT_RADIUS + index * 0.08;
  return {
    lat: baseLat + Math.sin(angle) * radius,
    lon: baseLon + Math.sin(angle + 1.5) * radius,
  };
}

const sharedIds = DEMO_ADVERTS.map(() => randomUUID());
const workerIds = Array.from({ length: DEMO_WORKER_COUNT }, () => randomUUID());
state.configureWorkers(workerIds);

const queueJobs = [];
let tick = 0;

function makeJob(advert, index, requestId) {
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
    radioParams: { ...RADIO_PARAMS[index] },
    logContext: {
      advertLabel: `${advert.nodeName} (${nodePublicKey.slice(0, 6)})`,
      observerLabel: "DEMO-OBSERVER",
    },
  };
}

function publish() {
  for (const item of queueJobs) {
    item.stage += 1;
  }

  while (queueJobs.length > 0 && queueJobs[0].stage >= 4) {
    queueJobs.shift();
  }

  const advertIndex = tick % DEMO_ADVERTS.length;
  const advert = DEMO_ADVERTS[advertIndex];
  const requestId = sharedIds[advertIndex];
  const workerId = workerIds[tick % workerIds.length];
  const job = makeJob(advert, advertIndex, requestId);

  state.queueStartedImmediately(job);
  state.workerUploading(workerId, job);
  queueJobs.push({ job, workerId, stage: 0 });

  for (const item of queueJobs) {
    if (item.stage === 2) {
      state.queueHandled(item.job, '{"code":"NODES_INSERTED","message":"Demo upload accepted."}');
      state.workerCooldown(item.workerId, item.job);
    } else if (item.stage === 3) {
      state.workerIdle(item.workerId);
    }
  }

  DEMO_ADVERTS.forEach((advertItem, index) => {
    const demoStatus = DEMO_STATUSES[(index + tick) % DEMO_STATUSES.length];
    const position = demoPosition(advertItem.lat, advertItem.lon, index, tick);
    const pTitle = findPresetTitle(RADIO_PARAMS[index]);
    state.recordDemoAdvertLocation({
      requestId: sharedIds[index],
      status: demoStatus.status,
      statusDetail: demoStatus.detail,
      nodeName: advertItem.nodeName,
      nodePublicKey: `${String(index + 1).repeat(64)}`.slice(0, 64),
      advertType: advertItem.type.toUpperCase(),
      observerId: `demo-observer-${index + 1}`,
      observerName: "DEMO-OBSERVER",
      lat: position.lat,
      lon: position.lon,
      presetTitle: pTitle,
    });
  });

  tick += 1;
}

publish();
const interval = setInterval(publish, 4000);

// Log which nodes use suggested presets
console.log("\n  Demo nodes:");
DEMO_ADVERTS.forEach((ad, i) => {
  const label = presetLabel(i);
  const match = label !== "(none)" ? `✅ ${label}` : "❌ (no preset match)";
  console.log(`    ${ad.nodeName}: ${match}`);
});

console.log(`\n  Dashboard: http://localhost:${config.dashboard.port}`);
console.log("  Dry-run: true, demo adverts active (custom radio params).");
console.log("  MQTT: mocked (no broker needed)\n");

const stop = () => {
  clearInterval(interval);
  runtime.stop().then(() => process.exit(0)).catch(() => process.exit(1));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
