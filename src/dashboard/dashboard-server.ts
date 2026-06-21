import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DashboardAdvertLocation,
  DashboardQueueItem,
  DashboardState,
  DashboardWorkerSnapshot,
} from "./dashboard-state.js";

const DASHBOARD_POLL_INTERVAL_MS = 5000;
const DASHBOARD_ASSETS_DIR = fileURLToPath(new URL("./assets/node_types/", import.meta.url));
const NODE_TYPE_COLOR_PLACEHOLDER = "__NODE_TYPE_FILL__";

function configuredTimeZone(): string | undefined {
  const timeZone = process.env.TZ?.trim();
  if (!timeZone) {
    return undefined;
  }

  try {
    new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return undefined;
  }
}

function readNodeTypeSvgTemplate(nodeType: 1 | 2 | 3): string {
  const template = readFileSync(path.join(DASHBOARD_ASSETS_DIR, `${nodeType}.svg`), "utf8").trim();
  const colorizedTemplate = template.replace(/\.a\{fill:[^}]+\}/, `.a{fill:${NODE_TYPE_COLOR_PLACEHOLDER}}`);
  if (colorizedTemplate === template) {
    throw new Error(`Dashboard node type SVG ${nodeType}.svg is missing a '.a{fill:...}' style rule.`);
  }

  return colorizedTemplate;
}

const NODE_TYPE_SVG_TEMPLATES = {
  1: readNodeTypeSvgTemplate(1),
  2: readNodeTypeSvgTemplate(2),
  3: readNodeTypeSvgTemplate(3),
} as const;

const MAP_ICON_COLOR = "#61d394";

function fillSvgTemplate(template: string, color: string): string {
  return template.replace(new RegExp(NODE_TYPE_COLOR_PLACEHOLDER, "g"), color);
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

const NODE_TYPE_ICON_DATA_URLS = {
  1: svgToDataUrl(fillSvgTemplate(NODE_TYPE_SVG_TEMPLATES[1], MAP_ICON_COLOR)),
  2: svgToDataUrl(fillSvgTemplate(NODE_TYPE_SVG_TEMPLATES[2], MAP_ICON_COLOR)),
  3: svgToDataUrl(fillSvgTemplate(NODE_TYPE_SVG_TEMPLATES[3], MAP_ICON_COLOR)),
};

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MQTT to Meshcore.io Map Dashboard</title>
  <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.5.0/dist/maplibre-gl.css">
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
      grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.9fr) minmax(280px, 0.9fr);
      gap: 16px;
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
    .map {
      width: 100%;
      height: min(560px, 58vh);
      min-height: 360px;
      background: #0b1117;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .maplibregl-map {
      background: #0b1117;
      color: var(--text);
      font-family: inherit;
    }
    .maplibregl-ctrl-top-right, .maplibregl-ctrl-bottom-right, .maplibregl-ctrl-bottom-left { z-index: 900; }
    .maplibregl-ctrl-attrib {
      background: rgba(15, 21, 27, 0.82);
      color: var(--muted);
    }
    .maplibregl-ctrl-attrib a { color: var(--accent); }
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
    .maplibregl-popup.meshcore-popup .maplibregl-popup-content {
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
      font-family: inherit;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
    .maplibregl-popup.meshcore-popup .maplibregl-popup-tip {
      border-top-color: var(--panel);
      border-bottom-color: var(--panel);
    }
    .maplibregl-popup.meshcore-popup .maplibregl-popup-close-button {
      color: var(--muted);
      font-size: 18px;
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
      <div class="stat"><strong id="stat-adverts">0</strong><span>accepted adverts with coordinates, last 24h</span></div>
    </div>
    <div class="panels">
      <section>
        <h2>Queue</h2>
        <div class="list" id="queue"></div>
      </section>
      <section>
        <h2>Workers</h2>
        <div class="list" id="workers"></div>
      </section>
      <section>
        <div class="section-head">
          <h2>History</h2>
        </div>
        <div class="list" id="history-list"></div>
      </section>
    </div>
    <section class="map-section" id="map-section">
      <div class="section-head">
        <h2>Advert accepted by Meshcore.io</h2>
        <button class="icon-button" id="map-fullscreen" type="button" title="Fullscreen map">Fullscreen</button>
      </div>
      <div class="map" id="map" aria-label="Accepted advert locations from the last 24 hours"></div>
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
  <script src="https://unpkg.com/maplibre-gl@5.5.0/dist/maplibre-gl.js"></script>
  <script>
    const POLL_INTERVAL_MS = ${DASHBOARD_POLL_INTERVAL_MS};
    const DASHBOARD_TIME_ZONE = ${JSON.stringify(configuredTimeZone())};
    const state = { dashboard: null, mapFirstRender: true, renderKeys: new Map(), pollTimer: null };
    const dialog = document.getElementById("detail-dialog");
    const detailTitle = document.getElementById("detail-title");
    const detailBody = document.getElementById("detail-body");
    const mapSection = document.getElementById("map-section");
    const fullscreenButton = document.getElementById("map-fullscreen");
    const errorBanner = document.getElementById("dashboard-error");
    const markerRecords = new Map();
    const MAP_ADVERT_SOURCE_ID = "meshcore-adverts";
    const MAP_ADVERT_LAYER_ID = "meshcore-advert-icons";
    const MAP_ADVERT_DOT_LAYER_ID = "meshcore-advert-dots";
    const MAP_ADVERT_HIT_LAYER_ID = "meshcore-advert-hit-area";
    const MAP_TERRAIN_SOURCE_ID = "meshcore-terrain";
    const MAP_HILLSHADE_SOURCE_ID = "meshcore-hillshade";
    const MAP_HILLSHADE_LAYER_ID = "meshcore-hillshade";
    const MAP_ICON_COLOR = "#61d394";
    let latestMapAdverts = [];
    let maplibreMap = null;
    let mapLayersReady = false;
    let mapLayerSetupPromise = null;
    let terrainControlAdded = false;
    let currentPopup = null;
    let mapStyleLoaded = false;
    let pendingRender = null;

    document.getElementById("detail-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });

    function setExpandedMap(expanded) {
      mapSection.classList.toggle("is-expanded", expanded);
      document.body.style.overflow = expanded ? "hidden" : "";
      fullscreenButton.textContent = expanded ? "Exit fullscreen" : "Fullscreen";
      setTimeout(() => maplibreMap?.resize(), 100);
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
      setTimeout(() => maplibreMap?.resize(), 100);
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
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], {
        timeZone: DASHBOARD_TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
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
      for (const advert of state.dashboard.map.advertsLast24Hours || []) {
        if (advert.requestKey === requestId) return advert;
      }
      return null;
    }

    function renderStats(snapshot) {
      setTextIfChanged("stat-queue", String((snapshot.queue.items || []).length));
      setTextIfChanged("stat-workers", String((snapshot.worker.workers || []).length));
      setTextIfChanged("stat-adverts", String((snapshot.map.advertsLast24Hours || []).length));
      setTextIfChanged("updated", "Updated " + formatTime(snapshot.generatedAt));
    }

    // SVG icons are loaded from vendored files in this repository, adapted from meshcore-dev/map.meshcore.io (MIT licence).
    const NODE_TYPE_SVG_TEMPLATES = ${JSON.stringify(NODE_TYPE_SVG_TEMPLATES)};
    const NODE_TYPE_ICON_DATA_URLS = ${JSON.stringify(NODE_TYPE_ICON_DATA_URLS)};

    function advertNodeType(advertType) {
      const normalized = String(advertType || "").toUpperCase();
      if (normalized === "REPEATER") return 2;
      if (normalized === "ROOM") return 3;
      return 1;
    }

    function ensureMap() {
      if (maplibreMap || !window.maplibregl) return;
      maplibreMap = new maplibregl.Map({
        container: "map",
        center: [12, 54],
        zoom: 4,
        maxPitch: 85,
        maxZoom: 18,
        renderWorldCopies: true,
        style: "https://tiles.openfreemap.org/styles/liberty",
      });
      maplibreMap.addControl(new maplibregl.NavigationControl({
        visualizePitch: true,
        showZoom: true,
        showCompass: true,
      }), "top-right");
      maplibreMap.once("style.load", () => {
        mapStyleLoaded = true;
        void renderMap(latestMapAdverts);
      });
      maplibreMap.once("load", () => {
        ensure3DMapStyle();
      });
    }

    function ensure3DMapStyle() {
      if (!maplibreMap || !maplibreMap.isStyleLoaded()) return;
      if (!maplibreMap.getSource(MAP_TERRAIN_SOURCE_ID)) {
        maplibreMap.addSource(MAP_TERRAIN_SOURCE_ID, {
          type: "raster-dem",
          url: "https://tiles.mapterhorn.com/tilejson.json",
        });
      }
      if (!maplibreMap.getSource(MAP_HILLSHADE_SOURCE_ID)) {
        maplibreMap.addSource(MAP_HILLSHADE_SOURCE_ID, {
          type: "raster-dem",
          url: "https://tiles.mapterhorn.com/tilejson.json",
        });
      }
      if (!maplibreMap.getLayer(MAP_HILLSHADE_LAYER_ID)) {
        const hillshadeBeforeLayer = maplibreMap.getLayer("building") ? "building" : undefined;
        maplibreMap.addLayer({
          id: MAP_HILLSHADE_LAYER_ID,
          type: "hillshade",
          source: MAP_HILLSHADE_SOURCE_ID,
          layout: { visibility: "visible" },
          paint: {
            "hillshade-shadow-color": "#473B24",
            "hillshade-highlight-color": "#f3ead8",
            "hillshade-accent-color": "#6f7f8e",
          },
        }, hillshadeBeforeLayer);
      }
      if (maplibreMap.getLayer("building-3d")) {
        maplibreMap.setLayerZoomRange("building-3d", 13, 24);
        maplibreMap.setPaintProperty("building-3d", "fill-extrusion-height", [
          "to-number",
          ["coalesce", ["get", "render_height"], ["get", "height"]],
          12,
        ]);
        maplibreMap.setPaintProperty("building-3d", "fill-extrusion-base", [
          "to-number",
          ["coalesce", ["get", "render_min_height"], ["get", "min_height"]],
          0,
        ]);
        maplibreMap.setPaintProperty("building-3d", "fill-extrusion-opacity", 0.72);
      }
      maplibreMap.setTerrain({
        source: MAP_TERRAIN_SOURCE_ID,
        exaggeration: 1.25,
      });
      if (!terrainControlAdded) {
        maplibreMap.addControl(new maplibregl.TerrainControl({
          source: MAP_TERRAIN_SOURCE_ID,
          exaggeration: 1.25,
        }), "top-right");
        terrainControlAdded = true;
      }
      maplibreMap.setSky({});
    }

    function markerKey(advert) {
      if (advert.nodePublicKey) return "public-key|" + advert.nodePublicKey;
      if (advert.nodeKey) return "node-key|" + advert.nodeKey;
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

    function mapImageId(nodeType) {
      return "meshcore-node-type-" + nodeType;
    }

    const iconCache = {};
    for (let i = 1; i <= 3; i++) {
      const img = new Image();
      img.src = NODE_TYPE_ICON_DATA_URLS[i];
      iconCache[i] = img;
    }

    async function loadMapIcons() {
      await Promise.all([1, 2, 3].map((nodeType) => {
        const id = mapImageId(nodeType);
        if (maplibreMap.hasImage(id)) return;
        const img = iconCache[nodeType];
        if (img.complete && img.naturalWidth > 0) {
          maplibreMap.addImage(id, img, { pixelRatio: 2 });
          return;
        }
        return new Promise((resolve, reject) => {
          img.onload = () => { maplibreMap.addImage(id, img, { pixelRatio: 2 }); resolve(); };
          img.onerror = reject;
        });
      }));
    }

    function markerFeature(advert) {
      const key = markerKey(advert);
      const nodeType = advertNodeType(advert.advertType);
      markerRecords.set(key, advert);
      return {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [advert.lon, advert.lat],
        },
        properties: {
          key,
          requestKey: advert.requestKey || "",
          title: advert.nodeName || advert.nodeKey || "unknown",
          icon: mapImageId(nodeType),
          tooltip: markerTooltip(advert),
        },
      };
    }

    async function ensureMapLayers() {
      if (!maplibreMap || !mapStyleLoaded) return false;
      if (mapLayersReady) return true;
      if (mapLayerSetupPromise) return mapLayerSetupPromise;

      mapLayerSetupPromise = (async () => {
        await loadMapIcons();
        if (!maplibreMap.getSource(MAP_ADVERT_SOURCE_ID)) {
          maplibreMap.addSource(MAP_ADVERT_SOURCE_ID, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
        }
        if (!maplibreMap.getLayer(MAP_ADVERT_HIT_LAYER_ID)) {
          maplibreMap.addLayer({
            id: MAP_ADVERT_HIT_LAYER_ID,
            type: "circle",
            source: MAP_ADVERT_SOURCE_ID,
            paint: {
              "circle-radius": 24,
              "circle-color": MAP_ICON_COLOR,
              "circle-opacity": 0.01,
            },
          });
        }
        if (!maplibreMap.getLayer(MAP_ADVERT_DOT_LAYER_ID)) {
          maplibreMap.addLayer({
            id: MAP_ADVERT_DOT_LAYER_ID,
            type: "circle",
            source: MAP_ADVERT_SOURCE_ID,
            paint: {
              "circle-radius": 9,
              "circle-color": MAP_ICON_COLOR,
              "circle-opacity": 0.95,
              "circle-stroke-color": "#0f2b1e",
              "circle-stroke-width": 2,
            },
          });
        }
        if (!maplibreMap.getLayer(MAP_ADVERT_LAYER_ID)) {
          maplibreMap.addLayer({
            id: MAP_ADVERT_LAYER_ID,
            type: "symbol",
            source: MAP_ADVERT_SOURCE_ID,
            layout: {
              "icon-image": ["get", "icon"],
              "icon-size": 0.125,
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "icon-pitch-alignment": "viewport",
              "icon-rotation-alignment": "viewport",
              "icon-anchor": "center",
            },
            paint: {
              "icon-opacity": 1,
            },
          });
        }
        maplibreMap.on("click", MAP_ADVERT_HIT_LAYER_ID, (event) => {
          if (currentPopup) {
            currentPopup.remove();
            currentPopup = null;
          }
          const feature = event.features?.[0];
          const key = feature?.properties?.key;
          const current = markerRecords.get(key);
          if (!current) return;
          showDetail("Marker: " + (current.nodeName || current.nodeKey || "unknown"), resolveDetail(current.requestKey) || current);
        });
        maplibreMap.on("mouseenter", MAP_ADVERT_HIT_LAYER_ID, (event) => {
          if (currentPopup) {
            currentPopup.remove();
            currentPopup = null;
          }
          maplibreMap.getCanvas().style.cursor = "pointer";
          const feature = event.features?.[0];
          const coordinates = feature?.geometry?.coordinates;
          if (!coordinates) return;
          currentPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: 20, className: "meshcore-popup" })
            .setLngLat(coordinates)
            .setHTML(feature.properties?.tooltip || "")
            .addTo(maplibreMap);
        });
        maplibreMap.on("mouseleave", MAP_ADVERT_HIT_LAYER_ID, () => {
          maplibreMap.getCanvas().style.cursor = "";
          if (currentPopup) {
            currentPopup.remove();
            currentPopup = null;
          }
        });
        mapLayersReady = true;
        return true;
      })();
      mapLayerSetupPromise = mapLayerSetupPromise.catch((error) => {
        mapLayerSetupPromise = null;
        throw error;
      });
      return mapLayerSetupPromise;
    }

    async function renderMap(adverts) {
      if (pendingRender) return;
      pendingRender = (async () => {
      latestMapAdverts = adverts || [];
      ensureMap();
      if (!maplibreMap) {
        document.getElementById("map").textContent = "Map library could not be loaded.";
        return;
      }
      if (!await ensureMapLayers()) return;

      const nextKeys = new Set();
      const bounds = new maplibregl.LngLatBounds();
      const features = [];
      for (const advert of latestMapAdverts) {
        const key = markerKey(advert);
        nextKeys.add(key);
        bounds.extend([advert.lon, advert.lat]);
        features.push(markerFeature(advert));
      }

      for (const key of markerRecords.keys()) {
        if (!nextKeys.has(key)) {
          markerRecords.delete(key);
        }
      }

      const source = maplibreMap.getSource(MAP_ADVERT_SOURCE_ID);
      source?.setData({ type: "FeatureCollection", features });

      if (!bounds.isEmpty() && state.mapFirstRender) {
        maplibreMap.fitBounds(bounds, { padding: 38, maxZoom: 13 });
        state.mapFirstRender = false;
      } else if (bounds.isEmpty()) {
        maplibreMap.jumpTo({ center: [12, 54], zoom: 4 });
      }
      setTimeout(() => maplibreMap.resize(), 0);
      })();
      await pendingRender;
      pendingRender = null;
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
      const adverts = snapshot.map.advertsLast24Hours || [];
      const mapSignature = adverts.map((advert) => markerKey(advert) + "|" + markerFingerprint(advert)).join("\\n");
      renderWhenChanged("map", adverts, document.getElementById("map"), () => renderMap(adverts), mapSignature);
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

function isNodesInsertedResponse(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const parsed = JSON.parse(value) as { code?: unknown };
    return parsed.code === "NODES_INSERTED";
  } catch {
    return false;
  }
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

function mapAdvertIdentity(advert: DashboardAdvertLocation): string {
  if (advert.nodePublicKey) {
    return `public-key|${advert.nodePublicKey}`;
  }

  return [
    "fallback",
    advert.nodeName,
    advert.advertType,
    advert.lat.toFixed(5),
    advert.lon.toFixed(5),
  ].join("|");
}

function mapAdvertPayloads(adverts: DashboardAdvertLocation[]): unknown[] {
  const latestByNode = new Map<string, DashboardAdvertLocation>();
  for (const advert of adverts) {
    if (!isNodesInsertedResponse(advert.responseFromMeshcoreIO)) {
      continue;
    }

    latestByNode.set(mapAdvertIdentity(advert), advert);
  }

  return [...latestByNode.values()].map(advertPayload);
}

function dashboardPayload(state: DashboardState): unknown {
  const snapshot = state.snapshot();
  return {
    generatedAt: snapshot.generatedAt,
    queue: {
      items: snapshot.queue.map(queueItemPayload),
      history: snapshot.queueHistory.slice(0, 100).map(queueItemPayload),
    },
    worker: {
      workers: snapshot.workers.map(workerPayload),
    },
    map: {
      advertsLast24Hours: mapAdvertPayloads(snapshot.advertsLast24Hours),
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
