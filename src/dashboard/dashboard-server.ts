import http from "node:http";
import type { DashboardState } from "./dashboard-state.js";

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>mqtt-to-meshcoreio-map dashboard</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f151b;
      --panel: #151d24;
      --panel-2: #1b2630;
      --text: #edf4f8;
      --muted: #92a4b1;
      --line: #2c3a45;
      --ok: #61d394;
      --warn: #f4c95d;
      --error: #ff6b6b;
      --accent: #63b3ed;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 22px;
      border-bottom: 1px solid var(--line);
      background: #111922;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    h1, h2, h3 { margin: 0; }
    h1 { font-size: 19px; letter-spacing: 0; }
    h2 { font-size: 16px; margin-bottom: 12px; }
    h3 { font-size: 14px; margin-bottom: 8px; }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .section-head h2 { margin-bottom: 0; }
    main {
      display: grid;
      gap: 16px;
      padding: 16px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-width: 0;
    }
    .stack { display: grid; gap: 16px; }
    .panels {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.9fr) minmax(280px, 0.9fr);
      gap: 16px;
      align-items: stretch;
    }
    .panels > section {
      height: 420px;
      display: flex;
      flex-direction: column;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      grid-column: 1 / -1;
    }
    .stat {
      background: var(--panel-2);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }
    .stat strong { display: block; font-size: 23px; }
    .stat span { color: var(--muted); font-size: 12px; }
    .map-section:fullscreen {
      padding: 14px;
      background: var(--panel);
    }
    .map-section:fullscreen .map {
      height: calc(100vh - 96px);
      max-height: none;
    }
    .map-tools {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .map {
      width: 100%;
      height: min(560px, 58vh);
      min-height: 360px;
      background: #0b1117;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .leaflet-container {
      background: #0b1117;
      color: var(--text);
      font-family: inherit;
    }
    .leaflet-control-attribution {
      background: rgba(15, 21, 27, 0.82);
      color: var(--muted);
    }
    .leaflet-control-attribution a { color: var(--accent); }
    .legend {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 12px;
    }
    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .legend span::before {
      content: "";
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--accent);
      display: inline-block;
    }
    .legend .ignored::before { background: var(--error); }
    .legend .queued::before { background: var(--warn); }
    .legend .pushed::before { background: var(--ok); }
    .list {
      display: grid;
      gap: 8px;
      align-content: start;
      flex: 1;
      min-height: 0;
      overflow: auto;
    }
    button.item {
      width: 100%;
      text-align: left;
      color: inherit;
      background: var(--panel-2);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      cursor: pointer;
    }
    button.item:hover { border-color: var(--accent); }
    button.item:focus-visible, .close:focus-visible, .icon-button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }
    .row > strong, .row > span:first-child, .item .muted {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .muted { color: var(--muted); }
    .pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      flex: 0 0 auto;
    }
    .pill.ok { color: var(--ok); border-color: rgba(97, 211, 148, 0.5); }
    .pill.warn { color: var(--warn); border-color: rgba(244, 201, 93, 0.5); }
    .pill.error { color: var(--error); border-color: rgba(255, 107, 107, 0.5); }
    .status-badge {
      border-radius: 999px;
      border: 1px solid rgba(255, 107, 107, 0.55);
      color: var(--error);
      padding: 2px 9px;
      font-size: 12px;
      white-space: nowrap;
    }
    .status-badge.connected {
      border-color: rgba(97, 211, 148, 0.55);
      color: var(--ok);
    }
    .land { fill: #1f3441; stroke: #557084; stroke-width: 1.2; }
    .water-label, .place-label { fill: #6f8391; font-size: 12px; }
    .place-label { fill: #8fa2ae; font-size: 11px; }
    .logs {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      flex: 1;
      min-height: 0;
      overflow: auto;
    }
    .log {
      border-bottom: 1px solid rgba(44, 58, 69, 0.7);
      padding: 7px 0;
      overflow-wrap: anywhere;
    }
    .log.warn { color: var(--warn); }
    .log.error { color: var(--error); }
    dialog {
      width: min(880px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      overflow: auto;
      color: var(--text);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0;
    }
    dialog::backdrop { background: rgba(0, 0, 0, 0.65); }
    .dialog-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px;
      border-bottom: 1px solid var(--line);
    }
    .dialog-body { padding: 14px; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.45;
    }
    .close, .icon-button {
      background: var(--panel-2);
      color: var(--text);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
    }
    .icon-button:hover { border-color: var(--accent); }
    .history-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 4px;
    }
    #history-list {
      max-height: 360px;
    }
    @media (max-width: 940px) {
      .panels { grid-template-columns: 1fr; }
      .panels > section { height: 360px; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <header>
    <h1>mqtt-to-meshcoreio-map dashboard</h1>
    <div class="muted" id="updated">Waiting for data</div>
  </header>
  <main>
    <div class="stats">
      <div class="stat"><strong id="stat-logs">0</strong><span>dashboard events</span></div>
      <div class="stat"><strong id="stat-queue">0</strong><span>queued or active</span></div>
      <div class="stat"><strong id="stat-workers">0</strong><span>workers</span></div>
      <div class="stat"><strong id="stat-adverts">0</strong><span>adverts with coordinates, last hour</span></div>
    </div>
    <div class="panels">
      <section>
        <div class="section-head">
          <h2>Events</h2>
          <span class="status-badge" id="mqtt-status">disconnected</span>
        </div>
        <div class="logs" id="logs"></div>
      </section>
      <section>
        <h2>Queue</h2>
        <div class="list" id="queue"></div>
      </section>
      <section>
        <h2>Workers</h2>
        <div class="list" id="workers"></div>
      </section>
    </div>
    <section class="map-section" id="map-section">
      <div class="section-head">
        <h2>Advert Flow Map</h2>
        <button class="icon-button" id="map-fullscreen" type="button" title="Fullscreen map">Fullscreen</button>
      </div>
      <div class="map-tools">
        <div class="legend">
          <span class="ignored">ignored</span>
          <span class="queued">queued</span>
          <span class="pushed">pushed to MeshCore.io</span>
        </div>
      </div>
      <div class="map" id="map" role="img" aria-label="Advert flow locations from the last hour"></div>
    </section>
    <section>
      <div class="section-head">
        <h2>History</h2>
      </div>
      <div class="list" id="history-list"></div>
    </section>
  </main>
  <dialog id="detail-dialog">
    <div class="dialog-head">
      <h2 id="detail-title">Queue item</h2>
      <button class="close" id="detail-close" type="button">Close</button>
    </div>
    <div class="dialog-body">
      <pre id="detail-body"></pre>
    </div>
  </dialog>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const state = { dashboard: null, mapFirstRender: true };
    const dialog = document.getElementById("detail-dialog");
    const detailTitle = document.getElementById("detail-title");
    const detailBody = document.getElementById("detail-body");
    const mapSection = document.getElementById("map-section");
    const fullscreenButton = document.getElementById("map-fullscreen");
    let leafletMap = null;
    let markerLayer = null;
    document.getElementById("detail-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        dialog.close();
      }
    });
    fullscreenButton.addEventListener("click", async () => {
      if (!document.fullscreenElement && mapSection.requestFullscreen) {
        await mapSection.requestFullscreen();
      } else if (document.exitFullscreen) {
        await document.exitFullscreen();
      }
      setTimeout(() => leafletMap?.invalidateSize(), 100);
    });
    document.addEventListener("fullscreenchange", () => {
      fullscreenButton.textContent = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
      setTimeout(() => leafletMap?.invalidateSize(), 100);
    });

    function shortKey(value) {
      return value ? String(value).slice(0, 8) : "unknown";
    }

    function shortRequestId(value) {
      return value ? String(value).slice(0, 8) : "no request";
    }

    function formatTime(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
    }

    function pillClass(value) {
      if (value === "warn" || value === "queued" || value === "cooldown" || value === "retrying") return "warn";
      if (value === "error" || value === "dropped") return "error";
      return "ok";
    }

    function escapeText(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function resolveDetail(requestId) {
      if (!state.dashboard || !requestId) return null;
      for (const list of [state.dashboard.queue.items, state.dashboard.queue.history]) {
        for (const item of list || []) {
          if (item.job?.requestId === requestId) return item;
        }
      }
      for (const advert of state.dashboard.map.advertsLastHour || []) {
        if (advert.requestId === requestId) return advert;
      }
      return null;
    }

    function newestGeneratedAt(...payloads) {
      return payloads
        .map((payload) => payload?.generatedAt)
        .filter(Boolean)
        .sort()
        .at(-1);
    }

    function renderStats(snapshot) {
      const events = snapshot.reader.events || snapshot.reader.decisions || [];
      document.getElementById("stat-logs").textContent = events.length;
      document.getElementById("stat-queue").textContent = (snapshot.queue.items || []).length;
      document.getElementById("stat-workers").textContent = (snapshot.worker.workers || []).length;
      document.getElementById("stat-adverts").textContent = (snapshot.map.advertsLastHour || []).length;
      document.getElementById("updated").textContent = "Updated " + formatTime(newestGeneratedAt(snapshot.reader, snapshot.queue, snapshot.worker, snapshot.map));
    }

    function renderMqttStatus(status) {
      const badge = document.getElementById("mqtt-status");
      const state = status?.state || "disconnected";
      badge.textContent = state;
      badge.title = status?.detail || "";
      badge.className = "status-badge " + (state === "connected" ? "connected" : "");
    }

    function markerColor(status) {
      if (status === "ignored") return "#ff6b6b";
      if (status === "queued") return "#f4c95d";
      if (status === "pushed") return "#61d394";
      return "#63b3ed";
    }

    function ensureMap() {
      if (leafletMap || !window.L) return;
      leafletMap = L.map("map", {
        worldCopyJump: true,
        zoomControl: true,
        dragging: true,
        scrollWheelZoom: true,
        doubleClickZoom: true,
        boxZoom: true,
        keyboard: true,
        tap: true,
        touchZoom: true,
      }).setView([54, 12], 4);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(leafletMap);
      markerLayer = L.layerGroup().addTo(leafletMap);
    }

    function renderMap(adverts) {
      ensureMap();
      if (!leafletMap || !markerLayer) {
        document.getElementById("map").textContent = "Map library could not be loaded.";
        return;
      }

      markerLayer.clearLayers();
      const bounds = [];
      for (const advert of adverts) {
        const color = markerColor(advert.status);
        const name = escapeText(advert.nodeName || shortKey(advert.nodePublicKey));
        const request = escapeText(shortRequestId(advert.requestId));
        const detail = escapeText(advert.statusDetail || "");
        const marker = L.circleMarker([advert.lat, advert.lon], {
          radius: 7,
          color: "#ffffff",
          weight: 1.5,
          fillColor: color,
          fillOpacity: 0.92,
          interactive: true,
        });
        marker.bindTooltip(
          '<strong>' + name + '</strong><br>request ' + request + '<br>' +
          escapeText(advert.status || "heard") + (detail ? '<br>' + detail : '') +
          '<br>' + advert.lat.toFixed(5) + ', ' + advert.lon.toFixed(5),
          { permanent: false, direction: "top", opacity: 0.95 }
        );
        marker.on("click", () => {
          showDetail("Marker: " + (advert.nodeName || shortKey(advert.nodePublicKey)), resolveDetail(advert.requestId) || advert);
        });
        marker.addTo(markerLayer);
        bounds.push([advert.lat, advert.lon]);
      }

      if (bounds.length > 0 && state.mapFirstRender) {
        leafletMap.fitBounds(bounds, { padding: [38, 38], maxZoom: 13 });
        state.mapFirstRender = false;
      } else if (bounds.length === 0) {
        leafletMap.setView([54, 12], 4);
      }
      setTimeout(() => leafletMap.invalidateSize(), 0);
    }

    function renderLogs(logs) {
      const target = document.getElementById("logs");
      target.innerHTML = (logs || []).map((log) => '<div class="log ' + escapeText(log.level) + '"><span class="muted">' + formatTime(log.at) + ' ' + escapeText(log.source) + '</span> ' + escapeText(log.message) + '</div>').join("") || '<div class="muted">No dashboard events yet.</div>';
    }

    function renderWorkers(workers) {
      const target = document.getElementById("workers");
      target.innerHTML = workers.map((worker, index) => {
        const job = worker.currentJob;
        const label = job ? escapeText(job.nodeName + " / " + shortRequestId(job.requestId) + " / " + shortKey(job.nodePublicKey)) : "No active job";
        return '<button class="item" type="button" data-index="' + index + '"><div class="row"><strong>Worker ' + escapeText(shortRequestId(worker.id)) + '</strong><span class="pill ' + pillClass(worker.state) + '">' + escapeText(worker.state) + '</span></div><div class="muted">' + label + '</div></button>';
      }).join("") || '<div class="muted">No workers configured.</div>';
      target.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", () => {
          const wrk = workers[Number(button.dataset.index)];
          showDetail("Worker " + shortRequestId(wrk.id), resolveDetail(wrk.currentJob?.requestId) || wrk);
        });
      });
    }

    function renderQueue(queue) {
      const target = document.getElementById("queue");
      target.innerHTML = queue.map((item, index) => {
        const job = item.job;
        const position = item.position === null ? "active" : "#" + item.position;
        return '<button class="item" type="button" data-index="' + index + '"><div class="row"><strong>' + escapeText(job.nodeName) + '</strong><span class="pill ' + pillClass(item.state) + '">' + escapeText(item.state) + '</span></div><div class="muted">request ' + escapeText(shortRequestId(job.requestId)) + ' / ' + escapeText(job.advertType) + ' ' + escapeText(shortKey(job.nodePublicKey)) + ' / ' + escapeText(position) + '</div></button>';
      }).join("") || '<div class="muted">Queue is empty.</div>';
      target.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", () => {
          const item = queue[Number(button.dataset.index)];
          showDetail(item.job?.nodeName || "Queue item", resolveDetail(item.job?.requestId) || item);
        });
      });
    }

    function shortResponse(value) {
      if (!value) return "";
      try {
        const parsed = JSON.parse(value);
        return escapeText(parsed.code || parsed.message || parsed.error || value.slice(0, 60));
      } catch {
        return escapeText(value.slice(0, 60));
      }
    }

    function renderHistory(history) {
      const target = document.getElementById("history-list");
      if (!history || history.length === 0) {
        target.innerHTML = '<div class="muted" style="text-align:center;padding:20px">No completed adverts yet.</div>';
        return;
      }
      target.innerHTML = history.map((item, index) => {
        const job = item.job;
        const name = escapeText(job.nodeName || shortKey(job.nodePublicKey));
        const type = escapeText(job.advertType);
        const rid = escapeText(shortRequestId(job.requestId || ""));
        const status = escapeText(item.state);
        const resp = shortResponse(item.responseFromMeshcoreIO);
        return '<button class="item" type="button" data-index="' + index + '">' +
          '<div class="row"><strong>' + name + '</strong><span class="pill ' + pillClass(item.state) + '">' + status + '</span></div>' +
          '<div class="row"><span class="muted">' + formatTime(item.updatedAt) + ' · ' + type + '</span><span class="pill">' + rid + '</span></div>' +
          (resp ? '<div class="row muted" style="margin-top:4px">Response: ' + resp + '</div>' : '') +
          '</button>';
      }).join("");
      target.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", () => {
          const item = history[Number(button.dataset.index)];
          showDetail(item.job?.nodeName || "History item", resolveDetail(item.job?.requestId) || item);
        });
      });
    }

    function showDetail(title, value) {
      detailTitle.textContent = title;
      detailBody.textContent = JSON.stringify(value, null, 2);
      dialog.showModal();
    }

    async function refresh() {
      const response = await fetch("/api", { cache: "no-store" });
      if (!response.ok) throw new Error("Dashboard API returned " + response.status);
      const snapshot = await response.json();
      state.dashboard = snapshot;
      renderStats(snapshot);
      renderMqttStatus(snapshot.reader.mqttSource);
      renderMap(snapshot.map.advertsLastHour || []);
      renderLogs(snapshot.reader.events || snapshot.reader.decisions || []);
      renderWorkers(snapshot.worker.workers || []);
      renderQueue(snapshot.queue.items || []);
      renderHistory(snapshot.queue.history || []);
    }

    refresh().catch((error) => {
      document.getElementById("updated").textContent = error.message;
    });
    setInterval(() => refresh().catch((error) => {
      document.getElementById("updated").textContent = error.message;
    }), 2000);
  </script>
</body>
</html>`;

export interface DashboardServer {
  url?: string;
  close(): Promise<void>;
}

function writeJson(response: http.ServerResponse, value: unknown): void {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function dashboardPayload(state: DashboardState): unknown {
  const snapshot = state.snapshot();
  return {
    generatedAt: snapshot.generatedAt,
    reader: {
      generatedAt: snapshot.generatedAt,
      mqttSource: snapshot.mqttSource,
      events: snapshot.logs,
      decisions: snapshot.logs.filter((log) =>
        log.source === "mqtt-reader" && !log.message.startsWith("MQTT source error:")
      ),
    },
    queue: {
      generatedAt: snapshot.generatedAt,
      items: snapshot.queue,
      history: snapshot.queueHistory.slice(0, 100),
    },
    worker: {
      generatedAt: snapshot.generatedAt,
      workers: snapshot.workers,
    },
    map: {
      generatedAt: snapshot.generatedAt,
      advertsLastHour: snapshot.advertsLastHour,
    },
  };
}

export function startDashboardServer(state: DashboardState, port: number): DashboardServer {
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end("Method not allowed");
      return;
    }

    const path = new URL(request.url ?? "/", "http://dashboard.local").pathname;

    if (path === "/" || path === "/index.html") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(DASHBOARD_HTML);
      return;
    }

    if (path === "/api") {
      writeJson(response, dashboardPayload(state));
      return;
    }

    if (path === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok");
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  server.listen(port, "0.0.0.0");

  return {
    get url() {
      const address = server.address();
      if (!address || typeof address === "string") {
        return undefined;
      }

      return `http://127.0.0.1:${address.port}`;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
  };
}
