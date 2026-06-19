import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DashboardAdvertLocation,
  DashboardLogEntry,
  DashboardQueueItem,
  DashboardState,
  DashboardWorkerSnapshot,
} from "./dashboard-state.js";

const MAX_API_EVENTS = 100;
const DASHBOARD_POLL_INTERVAL_MS = 2000;
const DASHBOARD_ASSETS_DIR = fileURLToPath(new URL("./assets/node_types/", import.meta.url));
const NODE_TYPE_COLOR_PLACEHOLDER = "__NODE_TYPE_FILL__";

function readNodeTypeSvgTemplate(nodeType: 1 | 2 | 3 | 4): string {
  const template = readFileSync(path.join(DASHBOARD_ASSETS_DIR, `${nodeType}.svg`), "utf8").trim();
  const colorizedTemplate = template
    .split(".a{fill:#667b89}")
    .join(`.a{fill:${NODE_TYPE_COLOR_PLACEHOLDER}}`);
  if (colorizedTemplate === template) {
    throw new Error(`Dashboard node type SVG ${nodeType}.svg is missing the expected '.a{fill:#667b89}' style.`);
  }

  return colorizedTemplate;
}

const NODE_TYPE_SVG_TEMPLATES = {
  1: readNodeTypeSvgTemplate(1),
  2: readNodeTypeSvgTemplate(2),
  3: readNodeTypeSvgTemplate(3),
  4: readNodeTypeSvgTemplate(4),
} as const;

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MQTT to Meshcore.io Map Dashboard</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css">
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
      z-index: 1000;
    }
    h1, h2, h3 { margin: 0; }
    h1 { font-size: 19px; letter-spacing: 0; }
    h2 { font-size: 16px; margin-bottom: 12px; }
    h3 { font-size: 14px; margin-bottom: 8px; }
    .dashboard-error {
      margin: 0 16px 16px;
      padding: 10px 14px;
      border: 1px solid rgba(255, 107, 107, 0.55);
      border-radius: 8px;
      background: rgba(86, 20, 25, 0.55);
      color: var(--error);
    }
    .dashboard-error:empty { display: none; }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .section-head h2 { margin-bottom: 0; }
    main { display: grid; gap: 16px; padding: 16px; }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-width: 0;
    }
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
      grid-template-columns: repeat(3, minmax(0, 1fr));
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
      z-index: 2000;
    }
    .map-section.is-expanded {
      position: fixed;
      inset: 0;
      z-index: 2000;
      border-radius: 0;
      padding: 14px;
      display: flex;
      flex-direction: column;
      background: var(--panel);
    }
    .map-section:fullscreen .map, .map-section.is-expanded .map {
      flex: 1;
      height: calc(100vh - 96px);
      height: calc(100dvh - 96px);
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
    .leaflet-top, .leaflet-bottom { z-index: 900; }
    .leaflet-control-attribution {
      background: rgba(15, 21, 27, 0.82);
      color: var(--muted);
    }
    .leaflet-control-attribution a { color: var(--accent); }
    .meshcore-node-icon, .meshcore-cluster-icon { background: none; border: 0; }
    .meshcore-node-icon svg { width: 32px; height: 32px; display: block; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.45)); }
    .meshcore-cluster-icon {
      background-clip: padding-box;
      border-radius: 20px;
    }
    .meshcore-cluster-icon div {
      width: 30px;
      height: 30px;
      margin-left: 5px;
      margin-top: 5px;
      border-radius: 15px;
      display: grid;
      place-items: center;
      background-color: var(--cluster-color);
      color: #091015;
      font: 800 12px "Helvetica Neue", Arial, Helvetica, sans-serif;
    }
    .meshcore-cluster-icon.accepted {
      --cluster-color: var(--ok);
      background-color: rgba(97, 211, 148, 0.48);
    }
    .meshcore-cluster-icon.pending {
      --cluster-color: var(--warn);
      background-color: rgba(244, 201, 93, 0.48);
    }
    .meshcore-cluster-icon.rejected {
      --cluster-color: var(--error);
      background-color: rgba(255, 107, 107, 0.48);
    }
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
    .legend .rejected::before { background: var(--error); }
    .legend .pending::before { background: var(--warn); }
    .legend .accepted::before { background: var(--ok); }
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
      min-height: 58px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
    }
    .dialog-head h2 { line-height: 1.2; margin-bottom: 0; }
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
    #history-list { max-height: 360px; }
    @media (max-width: 940px) {
      .panels { grid-template-columns: 1fr; }
      .panels > section { height: 360px; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      header {
        align-items: flex-start;
        flex-direction: column;
      }
      main { padding: 12px; }
      section { padding: 12px; }
      .dashboard-error { margin: 0 12px 12px; }
      .stats { grid-template-columns: 1fr; }
      .map-tools { align-items: flex-start; }
      .map {
        height: min(420px, 52vh);
        min-height: 280px;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>MQTT to Meshcore.io Map Dashboard</h1>
    <div class="muted" id="updated">Waiting for data</div>
  </header>
  <div class="dashboard-error" id="dashboard-error" role="status" aria-live="polite"></div>
  <main>
    <div class="stats">
      <div class="stat"><strong id="stat-queue">0</strong><span>Queued to be pushed to Meshcore.io</span></div>
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
          <span class="pending">pending Meshcore.io response</span>
          <span class="accepted">accepted by Meshcore.io</span>
          <span class="rejected">rejected without Meshcore.io handling</span>
        </div>
      </div>
      <div class="map" id="map" aria-label="Advert flow locations from the last hour"></div>
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
  <script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
  <script>
    const POLL_INTERVAL_MS = ${DASHBOARD_POLL_INTERVAL_MS};
    const state = { dashboard: null, mapFirstRender: true, renderKeys: new Map(), pollTimer: null };
    const dialog = document.getElementById("detail-dialog");
    const detailTitle = document.getElementById("detail-title");
    const detailBody = document.getElementById("detail-body");
    const mapSection = document.getElementById("map-section");
    const fullscreenButton = document.getElementById("map-fullscreen");
    const errorBanner = document.getElementById("dashboard-error");
    const markerIconCache = new Map();
    const markerRecords = new Map();
    let leafletMap = null;
    let markerLayer = null;

    document.getElementById("detail-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });

    function setExpandedMap(expanded) {
      mapSection.classList.toggle("is-expanded", expanded);
      document.body.style.overflow = expanded ? "hidden" : "";
      fullscreenButton.textContent = expanded ? "Exit fullscreen" : "Fullscreen";
      setTimeout(() => leafletMap?.invalidateSize(), 100);
    }

    fullscreenButton.addEventListener("click", async () => {
      const cssExpanded = mapSection.classList.contains("is-expanded");
      if (cssExpanded) {
        setExpandedMap(false);
        return;
      }
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
        return;
      }
      if (mapSection.requestFullscreen) {
        try {
          await mapSection.requestFullscreen();
          return;
        } catch {
          setExpandedMap(true);
          return;
        }
      }
      setExpandedMap(true);
    });

    document.addEventListener("fullscreenchange", () => {
      fullscreenButton.textContent = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
      setTimeout(() => leafletMap?.invalidateSize(), 100);
    });

    function fingerprint(value) {
      return JSON.stringify(value ?? null);
    }

    function selectionTouches(element) {
      const selection = window.getSelection?.();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
      const anchor = selection.anchorNode;
      const focus = selection.focusNode;
      return Boolean(
        element &&
        ((anchor && element.contains(anchor)) || (focus && element.contains(focus)))
      );
    }

    function renderWhenChanged(key, value, element, render, signature = fingerprint(value)) {
      const nextKey = signature;
      if (state.renderKeys.get(key) === nextKey) return;
      if (selectionTouches(element)) return;
      render();
      state.renderKeys.set(key, nextKey);
    }

    function setTextIfChanged(id, value) {
      const element = document.getElementById(id);
      if (element && element.textContent !== value) element.textContent = value;
    }

    function setRefreshError(message) {
      if (errorBanner.textContent !== message) errorBanner.textContent = message;
    }

    function clearRefreshError() {
      if (errorBanner.textContent) errorBanner.textContent = "";
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
          if (item.job?.requestKey === requestId) return item;
        }
      }
      for (const advert of state.dashboard.map.advertsLastHour || []) {
        if (advert.requestKey === requestId) return advert;
      }
      return null;
    }

    function renderStats(snapshot) {
      setTextIfChanged("stat-queue", String((snapshot.queue.items || []).length));
      setTextIfChanged("stat-workers", String((snapshot.worker.workers || []).length));
      setTextIfChanged("stat-adverts", String((snapshot.map.advertsLastHour || []).length));
      setTextIfChanged("updated", "Updated " + formatTime(snapshot.generatedAt));
    }

    function renderMqttStatus(status) {
      const badge = document.getElementById("mqtt-status");
      const state = status?.state || "disconnected";
      if (badge.textContent !== state) badge.textContent = state;
      badge.title = "";
      badge.className = "status-badge " + (state === "connected" ? "connected" : "");
    }

    const STATUS_COLORS = { accepted: '#61d394', pending: '#f4c95d', rejected: '#ff6b6b' };

    // SVG icons are loaded from vendored files in this repository, adapted from meshcore-dev/map.meshcore.io (MIT licence).
    const NODE_TYPE_SVG_TEMPLATES = ${JSON.stringify(NODE_TYPE_SVG_TEMPLATES)};

    function tintNodeTypeSvg(template, color) {
      return String(template || "").replace(${JSON.stringify(NODE_TYPE_COLOR_PLACEHOLDER)}, color);
    }

    function markerStatus(status) {
      if (status === "rejected" || status === "accepted") return status;
      return "pending";
    }

    function advertNodeType(advertType) {
      const normalized = String(advertType || "").toUpperCase();
      if (normalized === "REPEATER") return 2;
      if (normalized === "ROOM") return 3;
      return 1;
    }

    function markerIcon(advert) {
      const nodeType = advertNodeType(advert.advertType);
      const status = markerStatus(advert.status);
      const cacheKey = nodeType + "|" + status;
      const cached = markerIconCache.get(cacheKey);
      if (cached) return cached;
      const color = STATUS_COLORS[status] || STATUS_COLORS.pending;
      const svgTemplate = NODE_TYPE_SVG_TEMPLATES[nodeType] || NODE_TYPE_SVG_TEMPLATES[1];
      const icon = L.divIcon({
        html: tintNodeTypeSvg(svgTemplate, color),
        className: "meshcore-node-icon meshcore-node-type-" + nodeType + " " + status,
        iconSize: [32, 32],
        iconAnchor: [17, 17],
        popupAnchor: [0, -16],
      });
      markerIconCache.set(cacheKey, icon);
      return icon;
    }

    function clusterStatus(cluster) {
      const statuses = cluster.getAllChildMarkers().map((marker) => marker.options.dashboardStatus);
      if (statuses.includes("rejected")) return "rejected";
      if (statuses.includes("pending")) return "pending";
      return "accepted";
    }

    function clusterIcon(cluster) {
      const count = cluster.getChildCount();
      const status = clusterStatus(cluster);
      return L.divIcon({
        html: "<div><span>" + count + "</span></div>",
        className: "meshcore-cluster-icon " + status,
        iconSize: L.point(40, 40),
      });
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
      markerLayer = window.L.markerClusterGroup
        ? L.markerClusterGroup({
            disableClusteringAtZoom: 12,
            chunkedLoading: true,
            iconCreateFunction: clusterIcon,
          }).addTo(leafletMap)
        : L.layerGroup().addTo(leafletMap);
    }

    function markerKey(advert) {
      const stableParts = [advert.requestKey || "", advert.nodeKey || "", advert.nodePublicKey || ""];
      if (stableParts.some(Boolean)) return stableParts.join("|");
      return [
        "fallback",
        advert.nodeName || "",
        advert.advertType || "",
        Number(advert.lat).toFixed(5),
        Number(advert.lon).toFixed(5),
      ].join("|");
    }

    function markerFingerprint(advert) {
      return fingerprint({
        requestKey: advert.requestKey,
        status: markerStatus(advert.status),
        statusDetail: advert.statusDetail,
        advertType: advert.advertType,
        nodeName: advert.nodeName,
        nodeKey: advert.nodeKey,
        nodePublicKey: advert.nodePublicKey,
        lat: advert.lat,
        lon: advert.lon,
      });
    }

    function markerTooltip(advert) {
      const name = escapeText(advert.nodeName || advert.nodeKey || "unknown");
      const request = escapeText(advert.requestKey || "no request");
      const detail = escapeText(advert.statusDetail || "");
      return '<strong>' + name + '</strong><br>request ' + request + '<br>' +
        escapeText(advert.status || "pending") + (detail ? '<br>' + detail : '') +
        '<br>' + advert.lat.toFixed(5) + ', ' + advert.lon.toFixed(5);
    }

    function updateMarker(marker, advert) {
      marker.options.dashboardAdvert = advert;
      marker.options.dashboardStatus = markerStatus(advert.status);
      marker.setLatLng([advert.lat, advert.lon]);
      marker.setIcon(markerIcon(advert));
      marker.options.title = advert.nodeName || advert.nodeKey || "unknown";
      if (marker.getTooltip()) {
        marker.setTooltipContent(markerTooltip(advert));
      } else {
        marker.bindTooltip(markerTooltip(advert), { permanent: false, direction: "top", opacity: 0.95 });
      }
    }

    function createMarker(advert) {
      const marker = L.marker([advert.lat, advert.lon], {
        icon: markerIcon(advert),
        title: advert.nodeName || advert.nodeKey || "unknown",
        dashboardStatus: markerStatus(advert.status),
        dashboardAdvert: advert,
        interactive: true,
      });
      marker.bindTooltip(markerTooltip(advert), { permanent: false, direction: "top", opacity: 0.95 });
      marker.on("click", () => {
        const current = marker.options.dashboardAdvert || advert;
        showDetail("Marker: " + (current.nodeName || current.nodeKey || "unknown"), resolveDetail(current.requestKey) || current);
      });
      marker.addTo(markerLayer);
      return marker;
    }

    function renderMap(adverts) {
      ensureMap();
      if (!leafletMap || !markerLayer) {
        document.getElementById("map").textContent = "Map library could not be loaded.";
        return;
      }

      const nextKeys = new Set();
      const bounds = [];
      for (const advert of adverts) {
        const key = markerKey(advert);
        const nextFingerprint = markerFingerprint(advert);
        const existing = markerRecords.get(key);
        nextKeys.add(key);
        bounds.push([advert.lat, advert.lon]);

        if (existing) {
          if (existing.fingerprint !== nextFingerprint) {
            updateMarker(existing.marker, advert);
            existing.fingerprint = nextFingerprint;
            markerLayer.refreshClusters?.(existing.marker);
          }
          continue;
        }

        markerRecords.set(key, {
          marker: createMarker(advert),
          fingerprint: nextFingerprint,
        });
      }

      for (const [key, record] of markerRecords) {
        if (!nextKeys.has(key)) {
          markerLayer.removeLayer(record.marker);
          markerRecords.delete(key);
        }
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
      const entries = (logs || []).slice(0, 100);
      const signature = entries.map((log) => [log.at, log.level, log.source, log.message].join("|")).join("\\n");
      renderWhenChanged("logs", entries, target, () => {
        target.innerHTML = entries.map((log) => '<div class="log ' + escapeText(log.level) + '"><span class="muted">' + formatTime(log.at) + ' ' + escapeText(log.source) + '</span> ' + escapeText(log.message) + '</div>').join("") || '<div class="muted">No dashboard events yet.</div>';
      }, signature);
    }

    function renderWorkers(workers) {
      const target = document.getElementById("workers");
      const items = workers || [];
      const signature = items.map((worker) => [
        worker.workerKey,
        worker.state,
        worker.currentJob?.requestKey || "",
        worker.currentJob?.nodeKey || "",
        worker.currentJob?.nodeName || "",
      ].join("|")).join("\\n");
      renderWhenChanged("workers", items, target, () => {
        target.innerHTML = (workers || []).map((worker, index) => {
          const job = worker.currentJob;
          const label = job ? escapeText(job.nodeName + " / " + job.requestKey + " / " + job.nodeKey) : "No active job";
          return '<button class="item" type="button" data-index="' + index + '"><div class="row"><strong>Worker ' + escapeText(worker.workerKey) + '</strong><span class="pill ' + pillClass(worker.state) + '">' + escapeText(worker.state) + '</span></div><div class="muted">' + label + '</div></button>';
        }).join("") || '<div class="muted">No workers configured.</div>';
        target.querySelectorAll("button").forEach((button) => {
          button.addEventListener("click", () => {
            const wrk = workers[Number(button.dataset.index)];
            showDetail("Worker " + wrk.workerKey, resolveDetail(wrk.currentJob?.requestKey) || wrk);
          });
        });
      }, signature);
    }

    function renderQueue(queue) {
      const target = document.getElementById("queue");
      const items = queue || [];
      const signature = items.map((item) => [
        item.state,
        item.job?.requestKey || "",
        item.job?.nodeKey || "",
        item.job?.nodeName || "",
        item.job?.advertType || "",
      ].join("|")).join("\\n");
      renderWhenChanged("queue", items, target, () => {
        target.innerHTML = (queue || []).map((item, index) => {
          const job = item.job;
          return '<button class="item" type="button" data-index="' + index + '"><div class="row"><strong>' + escapeText(job.nodeName) + '</strong><span class="pill ' + pillClass(item.state) + '">' + escapeText(item.state) + '</span></div><div class="muted">request ' + escapeText(job.requestKey) + ' / ' + escapeText(job.advertType) + ' ' + escapeText(job.nodeKey) + '</div></button>';
        }).join("") || '<div class="muted">Queue is empty.</div>';
        target.querySelectorAll("button").forEach((button) => {
          button.addEventListener("click", () => {
            const item = queue[Number(button.dataset.index)];
            showDetail(item.job?.nodeName || "Queue item", resolveDetail(item.job?.requestKey) || item);
          });
        });
      }, signature);
    }

    function renderHistory(history) {
      const target = document.getElementById("history-list");
      const items = history || [];
      const signature = items.map((item) => [
        item.updatedAt,
        item.state,
        item.responseSummary || "",
        item.job?.requestKey || "",
        item.job?.nodeKey || "",
      ].join("|")).join("\\n");
      renderWhenChanged("history", items, target, () => {
        if (!history || history.length === 0) {
          target.innerHTML = '<div class="muted" style="text-align:center;padding:20px">No completed adverts yet.</div>';
          return;
        }
        target.innerHTML = history.map((item, index) => {
          const job = item.job;
          const name = escapeText(job.nodeName || job.nodeKey || "unknown");
          const type = escapeText(job.advertType);
          const rid = escapeText(job.requestKey || "");
          const status = escapeText(item.state);
          const resp = item.responseSummary ? escapeText(item.responseSummary) : "";
          return '<button class="item" type="button" data-index="' + index + '">' +
            '<div class="row"><strong>' + name + '</strong><span class="pill ' + pillClass(item.state) + '">' + status + '</span></div>' +
            '<div class="row"><span class="muted">' + formatTime(item.updatedAt) + ' · ' + type + '</span><span class="pill">' + rid + '</span></div>' +
            (resp ? '<div class="row muted" style="margin-top:4px">Response: ' + resp + '</div>' : '') +
            '</button>';
        }).join("");
        target.querySelectorAll("button").forEach((button) => {
          button.addEventListener("click", () => {
            const item = history[Number(button.dataset.index)];
            showDetail(item.job?.nodeName || "History item", resolveDetail(item.job?.requestKey) || item);
          });
        });
      }, signature);
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
      clearRefreshError();
      renderStats(snapshot);
      renderMqttStatus(snapshot.reader.mqttSource);
      const adverts = snapshot.map.advertsLastHour || [];
      const mapSignature = adverts.map((advert) => markerKey(advert) + "|" + markerFingerprint(advert)).join("\\n");
      renderWhenChanged("map", adverts, document.getElementById("map"), () => renderMap(adverts), mapSignature);
      renderLogs(snapshot.reader.events || []);
      renderWorkers(snapshot.worker.workers || []);
      renderQueue(snapshot.queue.items || []);
      renderHistory(snapshot.queue.history || []);
    }

    function scheduleRefresh(delay) {
      window.clearTimeout(state.pollTimer);
      state.pollTimer = window.setTimeout(runRefreshLoop, delay);
    }

    async function runRefreshLoop() {
      try {
        await refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        document.getElementById("updated").textContent = "Update failed";
        setRefreshError("Live update failed: " + message + ". Retrying automatically.");
      } finally {
        scheduleRefresh(POLL_INTERVAL_MS);
      }
    }

    runRefreshLoop();
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

function shortNodeKey(value: string | undefined): string {
  return value ? value.slice(0, 8) : "unknown";
}

function shortRequestKey(value: string | undefined): string {
  return value ? value.slice(0, 8) : "no request";
}

function sanitizeEventMessage(value: string): string {
  return value
    .replace(/\b(?:mqtts?|wss?):\/\/\S+/gi, "[redacted-url]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[redacted-key]");
}

function summarizeMeshcoreResponse(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as { code?: unknown; message?: unknown; error?: unknown };
    const summary = parsed.code ?? parsed.message ?? parsed.error;
    return summary === undefined ? value.slice(0, 80) : String(summary).slice(0, 80);
  } catch {
    return value.slice(0, 80);
  }
}

function logPayload(log: DashboardLogEntry): unknown {
  return {
    at: log.at,
    level: log.level,
    message: sanitizeEventMessage(log.message),
    source: log.source,
  };
}

function jobPayload(item: DashboardQueueItem): unknown {
  return {
    requestKey: shortRequestKey(item.job.requestId),
    advertType: item.job.advertType,
    nodeName: item.job.nodeName,
    nodeKey: shortNodeKey(item.job.nodePublicKey),
    nodePublicKey: item.job.nodePublicKey,
    radioParams: item.job.radioParams,
  };
}

function queueItemPayload(item: DashboardQueueItem): unknown {
  return {
    state: item.state,
    updatedAt: item.updatedAt,
    responseSummary: summarizeMeshcoreResponse(item.responseFromMeshcoreIO),
    job: jobPayload(item),
  };
}

function workerPayload(worker: DashboardWorkerSnapshot): unknown {
  return {
    workerKey: shortRequestKey(worker.id),
    state: worker.state,
    currentJob: worker.currentJob
      ? {
          requestKey: shortRequestKey(worker.currentJob.requestId),
          nodeName: worker.currentJob.nodeName,
          nodeKey: shortNodeKey(worker.currentJob.nodePublicKey),
          nodePublicKey: worker.currentJob.nodePublicKey,
          radioParams: worker.currentJob.radioParams,
        }
      : undefined,
  };
}

function advertPayload(advert: DashboardAdvertLocation): unknown {
  return {
    requestKey: shortRequestKey(advert.requestId),
    status: advert.status,
    statusDetail: advert.statusDetail,
    advertType: advert.advertType,
    nodeName: advert.nodeName,
    nodeKey: shortNodeKey(advert.nodePublicKey),
    nodePublicKey: advert.nodePublicKey,
    lat: advert.lat,
    lon: advert.lon,
  };
}

function dashboardPayload(state: DashboardState): unknown {
  const snapshot = state.snapshot();
  return {
    generatedAt: snapshot.generatedAt,
    reader: {
      mqttSource: {
        state: snapshot.mqttSource.state,
      },
      events: snapshot.logs.slice(0, MAX_API_EVENTS).map(logPayload),
    },
    queue: {
      items: snapshot.queue.map(queueItemPayload),
      history: snapshot.queueHistory.slice(0, 100).map(queueItemPayload),
    },
    worker: {
      workers: snapshot.workers.map(workerPayload),
    },
    map: {
      advertsLastHour: snapshot.advertsLastHour.map(advertPayload),
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
