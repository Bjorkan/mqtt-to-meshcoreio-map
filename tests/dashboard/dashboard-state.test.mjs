import assert from "node:assert/strict";
import { test } from "node:test";

import { DashboardState } from "../../dist/dashboard/dashboard-state.js";

const BASE_TIME = Date.parse("2026-06-19T10:00:00.000Z");

function makeClock() {
  let current = BASE_TIME;
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
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
    observerId: overrides.observerId ?? "observer-1",
    observerName: overrides.observerName ?? "SE-STO-OBSERVER",
    radioParams: overrides.radioParams ?? { freq: 869.5, bw: 125, sf: 9, cr: 5 },
    logContext: overrides.logContext ?? {
      advertLabel: "SE-STO-TEST (aaaaaa)",
      observerLabel: "SE-STO-OBSERVER",
    },
  };
}

function recordLocation(state, job, overrides = {}) {
  state.recordAdvertLocation({
    requestId: job.requestId,
    nodeName: job.nodeName,
    nodePublicKey: job.nodePublicKey,
    advertType: job.advertType,
    advertTimestamp: job.advertTimestamp,
    observerId: job.observerId,
    observerName: job.observerName,
    lat: overrides.lat ?? 59.3293,
    lon: overrides.lon ?? 18.0686,
  });
}

test("queueHandled leaves advert visible as accepted while archiving queue item", () => {
  const clock = makeClock();
  const state = new DashboardState({ now: clock.now });
  const job = makeJob();

  recordLocation(state, job);
  state.queueAdded(job, 1);
  state.queueHandled(job, '{"code":"NODES_INSERTED"}');

  const snapshot = state.snapshot();
  assert.equal(snapshot.queue.length, 0);
  assert.equal(snapshot.queueHistory.length, 1);
  assert.equal(snapshot.queueHistory[0].state, "handled");
  assert.equal(snapshot.queueHistory[0].responseFromMeshcoreIO, '{"code":"NODES_INSERTED"}');

  assert.equal(snapshot.advertsLastHour.length, 1);
  assert.equal(snapshot.advertsLastHour[0].requestId, job.requestId);
  assert.equal(snapshot.advertsLastHour[0].status, "accepted");
  assert.equal(snapshot.advertsLastHour[0].responseFromMeshcoreIO, '{"code":"NODES_INSERTED"}');
});

test("queueDropped leaves advert visible as rejected while archiving queue item", () => {
  const clock = makeClock();
  const state = new DashboardState({ now: clock.now });
  const job = makeJob({ requestId: "request-dropped" });

  recordLocation(state, job);
  state.queueAdded(job, 1);
  state.queueDropped(job, "Upload queue is full.");

  const snapshot = state.snapshot();
  assert.equal(snapshot.queue.length, 0);
  assert.equal(snapshot.queueHistory.length, 1);
  assert.equal(snapshot.queueHistory[0].state, "dropped");
  assert.equal(snapshot.queueHistory[0].detail, "Upload queue is full.");

  assert.equal(snapshot.advertsLastHour.length, 1);
  assert.equal(snapshot.advertsLastHour[0].requestId, job.requestId);
  assert.equal(snapshot.advertsLastHour[0].status, "rejected");
  assert.equal(snapshot.advertsLastHour[0].statusDetail, "Upload queue is full.");
});

test("snapshot exposes one advert per node with green-yellow-red priority", () => {
  const clock = makeClock();
  const state = new DashboardState({ now: clock.now });
  const greenNodeKey = "b".repeat(64);
  const yellowNodeKey = "c".repeat(64);

  const greenAccepted = makeJob({ requestId: "green-accepted", nodePublicKey: greenNodeKey });
  recordLocation(state, greenAccepted);
  state.queueHandled(greenAccepted, '{"code":"NODES_INSERTED"}');

  clock.advance(1000);
  const greenPending = makeJob({ requestId: "green-pending", nodePublicKey: greenNodeKey });
  recordLocation(state, greenPending);

  clock.advance(1000);
  const greenRejected = makeJob({ requestId: "green-rejected", nodePublicKey: greenNodeKey });
  recordLocation(state, greenRejected);
  state.advertIgnored(greenRejected.requestId, "Rejected later.");

  clock.advance(1000);
  const yellowPending = makeJob({ requestId: "yellow-pending", nodePublicKey: yellowNodeKey });
  recordLocation(state, yellowPending);

  clock.advance(1000);
  const yellowRejected = makeJob({ requestId: "yellow-rejected", nodePublicKey: yellowNodeKey });
  recordLocation(state, yellowRejected);
  state.advertIgnored(yellowRejected.requestId, "Rejected later.");

  const snapshot = state.snapshot();
  const byNode = new Map(snapshot.advertsLastHour.map((advert) => [advert.nodePublicKey, advert]));

  assert.equal(snapshot.advertsLastHour.length, 2);
  assert.equal(byNode.get(greenNodeKey)?.requestId, greenAccepted.requestId);
  assert.equal(byNode.get(greenNodeKey)?.status, "accepted");
  assert.equal(byNode.get(yellowNodeKey)?.requestId, yellowPending.requestId);
  assert.equal(byNode.get(yellowNodeKey)?.status, "pending");
});

test("advert locations expire after the last-hour window", () => {
  const clock = makeClock();
  const state = new DashboardState({ now: clock.now });
  const job = makeJob();

  recordLocation(state, job);
  assert.equal(state.snapshot().advertsLastHour.length, 1);

  clock.advance(60 * 60 * 1000 + 1);
  assert.equal(state.snapshot().advertsLastHour.length, 0);
});

test("dashboard logs are capped at the newest 500 entries", () => {
  const clock = makeClock();
  const state = new DashboardState({ now: clock.now });

  for (let index = 1; index <= 505; index += 1) {
    state.recordDecision(`decision ${index}`);
  }

  const snapshot = state.snapshot();
  assert.equal(snapshot.logs.length, 500);
  assert.equal(snapshot.logs[0].message, "decision 505");
  assert.equal(snapshot.logs.at(-1).message, "decision 6");
});

test("worker states move through uploading, cooldown, and idle", () => {
  const clock = makeClock();
  const state = new DashboardState({ now: clock.now });
  const job = makeJob();

  state.configureWorkers(["worker-1"]);
  assert.equal(state.snapshot().workers[0].state, "idle");

  state.workerUploading("worker-1", job);
  assert.equal(state.snapshot().workers[0].state, "uploading");
  assert.equal(state.snapshot().queue[0].state, "active");

  state.workerCooldown("worker-1", job);
  assert.equal(state.snapshot().workers[0].state, "cooldown");

  state.workerIdle("worker-1");
  assert.equal(state.snapshot().workers[0].state, "idle");
  assert.equal(state.snapshot().workers[0].currentJob, undefined);
});
