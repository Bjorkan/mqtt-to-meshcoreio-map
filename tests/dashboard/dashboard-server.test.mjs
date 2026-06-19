import assert from "node:assert/strict";
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

test("dashboard serves HTML at root and index", async () => {
  await withServer(async (url) => {
    for (const path of ["/", "/index.html"]) {
      const response = await fetch(`${url}${path}`);
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      assert.match(body, /mqtt-to-meshcoreio-map dashboard/);
    }
  });
});

test("dashboard API returns the expected payload shape", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/api`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.reader.mqttSource.state, "disconnected");
    assert.equal(body.reader.events.length, 3);
    assert.equal(body.reader.decisions.length, 1);
    assert.deepEqual(
      body.reader.events.map((event) => event.source),
      ["runtime", "map-upload", "mqtt-reader"]
    );
    assert.deepEqual(body.queue.items, []);
    assert.deepEqual(body.worker.workers, []);
    assert.deepEqual(body.map.advertsLastHour, []);
  });
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
