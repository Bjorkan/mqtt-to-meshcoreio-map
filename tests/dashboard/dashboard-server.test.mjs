import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";

import { startDashboardServer } from "../../dist/dashboard/dashboard-server.js";
import { DashboardState } from "../../dist/dashboard/dashboard-state.js";

async function withServer(run) {
  const state = new DashboardState({
    now: () => new Date("2026-06-19T10:00:00.000Z"),
  });
  state.recordDecision("accepted advert");
  state.recordLog("queued upload", "info", "map-upload");
  state.recordLog("runtime started", "info", "runtime");
  const server = startDashboardServer(state, 0);
  await new Promise((resolve) => setImmediate(resolve));

  try {
    assert.ok(server.url);
    await run(server.url);
  } finally {
    await server.close();
  }
}

function makeJob(overrides = {}) {
  const requestId = overrides.requestId ?? "request-1";
  const nodePublicKey = overrides.nodePublicKey ?? "a".repeat(64);
  return {
    requestId,
    retriesAllowed: overrides.retriesAllowed ?? 3,
    advertKey: overrides.advertKey ?? `${nodePublicKey}:1800000000`,
    advertTimestamp: overrides.advertTimestamp ?? 1_800_000_000,
    advertType: overrides.advertType ?? "REPEATER",
    nodeName: overrides.nodeName ?? "SE-STO-TEST",
    nodePublicKey,
    rawPacketHex: overrides.rawPacketHex ?? "deadbeef",
    observerId: overrides.observerId ?? "observer-1",
    observerName: overrides.observerName ?? "SE-STO-OBSERVER",
    radioParams: overrides.radioParams ?? { freq: 869.5, bw: 125, sf: 9, cr: 5 },
    logContext: overrides.logContext ?? {
      advertLabel: "SE-STO-TEST (aaaaaa)",
      observerLabel: "SE-STO-OBSERVER",
    },
  };
}

test("dashboard serves HTML at root and index", async () => {
  await withServer(async (url) => {
    for (const path of ["/", "/index.html"]) {
      const response = await fetch(`${url}${path}`);
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      assert.match(body, /MQTT to Meshcore\.io Map Dashboard/);
      assert.match(body, /leaflet\.markercluster@1\.5\.3/);
      assert.match(body, /disableClusteringAtZoom: 12/);
      assert.match(body, /chunkedLoading: true/);
      assert.match(body, /function advertNodeType/);
      assert.match(body, /normalized === "REPEATER"\) return 2/);
      assert.match(body, /normalized === "ROOM"\) return 3/);
      assert.match(body, /meshcore-cluster-icon/);
      assert.match(body, /meshcore-node-icon/);
      // Vendored SVG icons loaded from local repository assets
      assert.match(body, /NODE_TYPE_SVG_TEMPLATES/);
      assert.match(body, /function nodeTypeSvg/);
      // Templates for all three node types include the fill placeholder for runtime tinting
      assert.ok(body.split('__NODE_TYPE_FILL__').length - 1 >= 3, 'all three node type templates have fill placeholder');
      // Map markers use the official map's update-recent green filter over the official base icon colour.
      assert.match(body, /saturate\(5\) hue-rotate\(260deg\)/);
      assert.match(body, /#667b89/);
      assert.doesNotMatch(body, /function clusterStatus/);
      assert.doesNotMatch(body, /function markerStatus/);
      assert.doesNotMatch(body, /STATUS_COLORS/);
      // Old CSS-dot approach must not be present
      assert.doesNotMatch(body, /meshcore-node-dot/);
      assert.match(body, /\.leaflet-top, \.leaflet-bottom \{ z-index: 900; \}/);
      assert.match(body, /--ok: #61d394/);
      assert.match(body, /--warn: #f4c95d/);
      assert.match(body, /--error: #ff6b6b/);
      assert.match(body, /class="dashboard-error" id="dashboard-error" role="status" aria-live="polite"/);
      assert.match(body, /const POLL_INTERVAL_MS = 5000;/);
      assert.match(body, /const DASHBOARD_TIME_ZONE = /);
      assert.match(body, /<div class="panels">[\s\S]*<h2>Queue<\/h2>[\s\S]*<h2>Workers<\/h2>[\s\S]*<h2>History<\/h2>[\s\S]*<\/div>[\s\S]*<section class="map-section"/);
      assert.doesNotMatch(body, /#history-list \{ max-height:/);
      assert.match(body, /function setExpandedMap/);
      assert.match(body, /mapSection\.classList\.toggle\("is-expanded"/);
      assert.match(body, /100dvh/);
      assert.match(body, /if \(advert\.nodePublicKey\) return "public-key\|" \+ advert\.nodePublicKey;/);
      assert.match(body, /if \(advert\.nodeKey\) return "node-key\|" \+ advert\.nodeKey;/);
      assert.match(body, /Number\(advert\.lat\)\.toFixed\(5\)/);
      assert.match(body, /Number\(advert\.lon\)\.toFixed\(5\)/);
      assert.match(body, /marker\.bindTooltip/);
      assert.match(body, /showDetail\("Marker: "/);
      assert.match(body, /function scheduleRefresh\(delay\)/);
      assert.match(body, /window\.setTimeout\(runRefreshLoop, delay\)/);
      assert.match(body, /renderWhenChanged\("map", adverts, document\.getElementById\("map"\), \(\) => renderMap\(adverts\), mapSignature\)/);
      assert.match(body, /Live update failed: /);
      assert.doesNotMatch(body, />Events</);
      assert.doesNotMatch(body, /id="logs"/);
      assert.doesNotMatch(body, /id="mqtt-status"/);
      assert.doesNotMatch(body, /renderLogs/);
      assert.doesNotMatch(body, /function markerColor/);
      assert.doesNotMatch(body, /NODE_TYPE_SVGS/);
      assert.doesNotMatch(body, /role="img"/);
      assert.doesNotMatch(body, /tabindex="0"/);
      assert.doesNotMatch(body, /marker\.bindPopup/);
      assert.doesNotMatch(body, /setInterval\(/);
      assert.doesNotMatch(body, /table\.node-info/);
    }
  });
});

test("dashboard inline script is syntactically valid and keeps escaped newlines", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/`);
    const body = await response.text();
    const scriptMatches = [...body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)];
    const inlineScript = scriptMatches.at(-1)?.[1];

    assert.ok(inlineScript);
    assert.match(inlineScript, /\.join\("\\n"\)/);
    assert.doesNotThrow(() => new vm.Script(inlineScript));
  });
});

test("dashboard API returns the expected payload shape", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/api`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.reader, undefined);
    assert.deepEqual(body.queue.items, []);
    assert.deepEqual(body.worker.workers, []);
    assert.deepEqual(body.map.advertsLast24Hours, []);
  });
});

test("dashboard API exposes only render-safe fields", async () => {
  const state = new DashboardState({
    now: () => new Date("2026-06-19T10:00:00.000Z"),
  });
  const job = makeJob();
  state.recordLog(`Using key ${job.nodePublicKey} from mqtt://broker.local:1883`, "info", "runtime");
  state.configureWorkers(["worker-1"]);
  state.recordAdvertLocation({
    requestId: job.requestId,
    nodeName: job.nodeName,
    nodePublicKey: job.nodePublicKey,
    advertType: job.advertType,
    advertTimestamp: job.advertTimestamp,
    radioParams: job.radioParams,
    observerId: job.observerId,
    observerName: job.observerName,
    lat: 59.3293,
    lon: 18.0686,
  });
  state.queueAdded(job, 1);
  state.workerUploading("worker-1", job);
  state.queueHandled(job, '{"code":"NODES_INSERTED","message":"accepted"}');

  const server = startDashboardServer(state, 0);
  await new Promise((resolve) => setImmediate(resolve));

  try {
    const response = await fetch(`${server.url}/api`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.reader, undefined);
    assert.equal(body.queue.history[0].job.requestKey, "request-");
    assert.equal(body.queue.history[0].job.requestId, undefined);
    assert.equal(body.queue.history[0].job.nodeKey, "aaaaaaaa");
    assert.equal(body.queue.history[0].job.nodePublicKey, job.nodePublicKey);
    assert.deepEqual(body.queue.history[0].job.radioParams, { freq: 869.5, bw: 125, sf: 9, cr: 5 });
    assert.equal(body.queue.history[0].responseSummary, "NODES_INSERTED");
    assert.equal(body.map.advertsLast24Hours[0].requestKey, "request-");
    assert.equal(body.map.advertsLast24Hours[0].requestId, undefined);
    assert.equal(body.map.advertsLast24Hours[0].advertType, "REPEATER");
    assert.equal(body.map.advertsLast24Hours[0].nodeKey, "aaaaaaaa");
    assert.equal(body.map.advertsLast24Hours[0].nodePublicKey, job.nodePublicKey);
    assert.equal(body.map.advertsLast24Hours[0].radioParams, undefined);
    assert.equal(body.worker.workers[0].workerKey, "worker-1");
    assert.equal(body.worker.workers[0].id, undefined);
    assert.equal(body.worker.workers[0].currentJob.requestKey, "request-");
    assert.equal(body.worker.workers[0].currentJob.requestId, undefined);
    assert.equal(body.worker.workers[0].currentJob.nodeKey, "aaaaaaaa");
    assert.equal(body.worker.workers[0].currentJob.nodePublicKey, job.nodePublicKey);
    assert.deepEqual(body.worker.workers[0].currentJob.radioParams, { freq: 869.5, bw: 125, sf: 9, cr: 5 });
    assert.equal(body.queue.history[0].id, undefined);
    assert.equal(body.queue.history[0].position, undefined);
    assert.equal(body.queue.history[0].workerId, undefined);
    assert.equal(body.map.advertsLast24Hours[0].id, undefined);
    assert.equal(body.worker.workers[0].updatedAt, undefined);
    assert.equal(serialized.includes("deadbeef"), false);
    assert.equal(serialized.includes("rawPacketHex"), false);
    assert.equal(serialized.includes("advertKey"), false);
    assert.equal(serialized.includes("retriesAllowed"), false);
    assert.equal(serialized.includes("observer"), false);
    assert.equal(serialized.includes("broker.local"), false);
    assert.equal(serialized.includes("mqtt://"), false);
    assert.equal(serialized.includes("Using key"), false);
  } finally {
    await server.close();
  }
});

test("dashboard map API exposes only NODES_INSERTED adverts", async () => {
  const state = new DashboardState({
    now: () => new Date("2026-06-19T10:00:00.000Z"),
  });
  const inserted = makeJob({
    requestId: "inserted-1",
    nodeName: "SE-STO-INSERTED",
    nodePublicKey: "b".repeat(64),
  });
  const duplicate = makeJob({
    requestId: "duplicate-1",
    nodeName: "SE-STO-DUPLICATE",
    nodePublicKey: "c".repeat(64),
  });
  const pending = makeJob({
    requestId: "pending-1",
    nodeName: "SE-STO-PENDING",
    nodePublicKey: "d".repeat(64),
  });

  for (const [job, lat] of [[inserted, 59.3293], [duplicate, 60.1282], [pending, 57.7089]]) {
    state.recordAdvertLocation({
      requestId: job.requestId,
      nodeName: job.nodeName,
      nodePublicKey: job.nodePublicKey,
      advertType: job.advertType,
      advertTimestamp: job.advertTimestamp,
      observerId: job.observerId,
      observerName: job.observerName,
      lat,
      lon: 18.0686,
    });
  }
  state.queueHandled(inserted, '{"code":"NODES_INSERTED","message":"accepted"}');
  state.queueHandled(duplicate, '{"code":"ERR_ADVERT_DUPLICATE","error":"Advert recently processed, ignoring"}');

  const server = startDashboardServer(state, 0);
  await new Promise((resolve) => setImmediate(resolve));

  try {
    const response = await fetch(`${server.url}/api`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(
      body.map.advertsLast24Hours.map((advert) => advert.nodeName),
      ["SE-STO-INSERTED"]
    );
  } finally {
    await server.close();
  }
});

test("dashboard map API keeps only the latest NODES_INSERTED advert per public key", async () => {
  const state = new DashboardState({
    now: () => new Date("2026-06-19T10:00:00.000Z"),
  });
  const nodePublicKey = "e".repeat(64);
  const older = makeJob({
    requestId: "older-inserted",
    nodeName: "SE-STO-OLDER",
    nodePublicKey,
  });
  const newer = makeJob({
    requestId: "newer-inserted",
    nodeName: "SE-STO-NEWER",
    nodePublicKey,
  });

  state.recordAdvertLocation({
    requestId: older.requestId,
    nodeName: older.nodeName,
    nodePublicKey: older.nodePublicKey,
    advertType: older.advertType,
    advertTimestamp: older.advertTimestamp,
    observerId: older.observerId,
    observerName: older.observerName,
    lat: 59.3293,
    lon: 18.0686,
  });
  state.queueHandled(older, '{"code":"NODES_INSERTED","message":"accepted"}');

  state.recordAdvertLocation({
    requestId: newer.requestId,
    nodeName: newer.nodeName,
    nodePublicKey: newer.nodePublicKey,
    advertType: newer.advertType,
    advertTimestamp: newer.advertTimestamp + 60,
    observerId: newer.observerId,
    observerName: newer.observerName,
    lat: 60.1282,
    lon: 18.6435,
  });
  state.queueHandled(newer, '{"code":"NODES_INSERTED","message":"accepted"}');

  const server = startDashboardServer(state, 0);
  await new Promise((resolve) => setImmediate(resolve));

  try {
    const response = await fetch(`${server.url}/api`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.map.advertsLast24Hours, [
      {
        requestKey: "newer-in",
        status: "accepted",
        statusDetail: "MeshCore.io handled the upload request.",
        advertType: "REPEATER",
        nodeName: "SE-STO-NEWER",
        nodeKey: "eeeeeeee",
        nodePublicKey,
        lat: 60.1282,
        lon: 18.6435,
      },
    ]);
  } finally {
    await server.close();
  }
});

test("dashboard health check returns ok", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  });
});

test("dashboard rejects non-GET requests", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/api`, { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  });
});

test("dashboard returns 404 for unknown paths", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/missing`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not found");
  });
});
