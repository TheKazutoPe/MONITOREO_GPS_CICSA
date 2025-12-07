// ============================== main.js ==============================
const supa = supabase.createClient(
  CONFIG.SUPABASE_URL,
  CONFIG.SUPABASE_ANON_KEY
);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

// ====== UI refs ======
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("filterBrigada"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
  filterName: document.getElementById("filterName"),
  filterStatus: document.getElementById("filterStatus"),
  filterZona: document.getElementById("filterZona"),
  filterContrata: document.getElementById("filterContrata"),
  btnCenter: document.getElementById("btnCenter"),
  btnShowAll: document.getElementById("btnShowAll"),
  mapStyleSelect: document.getElementById("mapStyleSelect"),
  btnRefresh: document.getElementById("btnRefresh"),
  btnToggleCluster: document.getElementById("btnToggleCluster"),

  // Site + rutas
  siteSearch: document.getElementById("siteSearch"),
  btnBuscarSite: document.getElementById("btnBuscarSite"),
  siteSuggestions: document.getElementById("siteSuggestions"),
  routesPanel: document.getElementById("routesPanel")
};

if (ui.siteSuggestions) {
  ui.siteSuggestions.classList.add("suggestions-box");
}

// ====== Estado global ======
const state = {
  map: null,
  baseLayers: {},
  currentBase: "streets",
  cluster: null,
  plainLayer: null,
  mode: "plain", // vista global ON por defecto
  users: new Map(), // uid -> { marker, lastRow }
  pointsByUser: new Map(),

  routeLayer: null,
  siteMarker: null,

  // capas para AVERÍA
  incidentLayer: null,
  incidentSiteMarker: null
};

// ====== Parámetros de limpieza y matching ======
const CLEAN_MIN_METERS = 6;
const DENSIFY_STEP = 10;
const MAX_MM_POINTS = 40;
const MAX_MATCH_INPUT = 90;
const MAX_DIST_RATIO = 0.35;
const ENDPOINT_TOL = 25;

const GAP_MINUTES = 8;
const GAP_JUMP_METERS = 800;

const BRIDGE_MAX_METERS = 800;
const DIRECTIONS_HOP_METERS = 300;
const MAX_BRIDGE_SPEED_KMH = 70;
const MIN_BRIDGE_SPEED_KMH = 3;
const DIRECTIONS_PROFILE = "driving";

const PER_BLOCK_DELAY = 150;

// ====== Iconos adaptativos ======
const CAR_ICONS = {
  green: L.icon({
    iconUrl: "assets/carro-green.png",
    iconSize: [40, 24],
    iconAnchor: [20, 12]
  }),
  yellow: L.icon({
    iconUrl: "assets/carro-orange.png",
    iconSize: [40, 24],
    iconAnchor: [20, 12]
  }),
  gray: L.icon({
    iconUrl: "assets/carro-gray.png",
    iconSize: [40, 24],
    iconAnchor: [20, 12]
  })
};

const DOT_ICONS = {
  green: L.divIcon({
    className: "marker-dot marker-dot-green",
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  }),
  yellow: L.divIcon({
    className: "marker-dot marker-dot-yellow",
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  }),
  gray: L.divIcon({
    className: "marker-dot marker-dot-gray",
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  })
};

function getStatusColor(row) {
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  if (mins <= 2) return "green";
  if (mins <= 5) return "yellow";
  return "gray";
}

// punto en zoom bajo, carro en zoom alto
function getIconFor(row) {
  const color = getStatusColor(row);
  const zoom = state.map ? state.map.getZoom() : 10;
  if (zoom >= 11) {
    return CAR_ICONS[color];
  } else {
    return DOT_ICONS[color];
  }
}

// ====== Helpers generales ======
function distMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s1 =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s1), Math.sqrt(1 - s1));
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function formatDateTime(d) {
  if (!d) return "-";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleString();
}

// ====== Limpieza / densificación ======
function densifySegment(points, step = DENSIFY_STEP) {
  if (!points || points.length < 2) return points;
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const d = distMeters(a, b);
    if (d <= step) {
      out.push(a);
      continue;
    }
    const n = Math.ceil(d / step);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
        timestamp: a.timestamp,
        acc: a.acc
      });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function downsamplePoints(arr, maxN) {
  if (!arr || arr.length <= maxN) return arr || [];
  const out = [];
  const step = (arr.length - 1) / (maxN - 1);
  for (let i = 0; i < maxN; i++) {
    const idx = Math.round(i * step);
    out.push(arr[idx]);
  }
  out[0] = arr[0];
  out[out.length - 1] = arr[arr.length - 1];
  return out;
}

function cleanClosePoints(points, minMeters = CLEAN_MIN_METERS) {
  if (!points.length) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    if (distMeters(prev, cur) >= minMeters) {
      out.push(cur);
    }
  }
  return out;
}

function splitOnGaps(points, maxGapMin = GAP_MINUTES, maxJumpM = GAP_JUMP_METERS) {
  const groups = [];
  let cur = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!cur.length) {
      cur.push(p);
      continue;
    }
    const prev = cur[cur.length - 1];
    const dtMin =
      (new Date(p.timestamp) - new Date(prev.timestamp)) / 60000;
    const djump = distMeters(prev, p);
    if (dtMin > maxGapMin || djump > maxJumpM) {
      if (cur.length > 1) groups.push(cur);
      cur = [p];
    } else {
      cur.push(p);
    }
  }
  if (cur.length > 1) groups.push(cur);
  return groups;
}

function adaptiveRadius(p) {
  const acc = p && p.acc != null ? Number(p.acc) : NaN;
  const base = isFinite(acc) ? acc + 5 : 25;
  return Math.max(10, Math.min(50, base));
}

// ====== Map Matching ======
async function mapMatchBlockSafe(seg) {
  if (!MAPBOX_TOKEN) return null;
  if (!seg || seg.length < 2) return null;
  if (seg.length > MAX_MM_POINTS) return null;

  const dense0 = densifySegment(seg, DENSIFY_STEP);
  const dense = downsamplePoints(dense0, MAX_MATCH_INPUT);

  let rawDist = 0;
  for (let i = 0; i < dense.length - 1; i++)
    rawDist += distMeters(dense[i], dense[i + 1]);

  const coords = dense.map(p => `${p.lng},${p.lat}`).join(";");
  const tsArr = dense
    .map(p => Math.floor(new Date(p.timestamp).getTime() / 1000))
    .join(";");
  const radArr = dense.map(p => adaptiveRadius(p)).join(";");

  const url =
    `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}` +
    `?geometries=geojson&overview=full&tidy=true` +
    `&timestamps=${tsArr}&radiuses=${radArr}` +
    `&access_token=${MAPBOX_TOKEN}`;

  let r;
  try {
    r = await fetch(url, { method: "GET", mode: "cors" });
  } catch (e) {
    console.warn("Matching fetch error:", e);
    return null;
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.warn("Matching status:", r.status, txt.slice(0, 200));
    return null;
  }

  const j = await r.json().catch(() => null);
  const m = j?.matchings?.[0];
  if (
    !m?.geometry?.coordinates ||
    (typeof m.confidence === "number" && m.confidence < 0.7)
  ) {
    if (dense.length > 24) {
      const mid = Math.floor(dense.length / 2);
      const left = await mapMatchBlockSafe(dense.slice(0, mid));
      const right = await mapMatchBlockSafe(dense.slice(mid - 1));
      if (left && right) return left.concat(right.slice(1));
    }
    return null;
  }

  const matched = m.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));

  let mmDist = 0;
  for (let i = 0; i < matched.length - 1; i++)
    mmDist += distMeters(matched[i], matched[i + 1]);
  if (
    Math.abs(mmDist - rawDist) / Math.max(rawDist, 1) >
    MAX_DIST_RATIO
  )
    return null;
  if (distMeters(dense[0], matched[0]) > ENDPOINT_TOL) return null;
  if (distMeters(dense.at(-1), matched.at(-1)) > ENDPOINT_TOL)
    return null;

  for (let i = 0; i < matched.length; i++) {
    matched[i].timestamp =
      dense[Math.min(i, dense.length - 1)].timestamp;
    matched[i].acc = dense[Math.min(i, dense.length - 1)].acc;
  }
  return matched;
}

// ====== Directions / puentes ======
async function directionsBetween(a, b) {
  if (!MAPBOX_TOKEN) return null;

  const direct = distMeters(a, b);
  if (direct > BRIDGE_MAX_METERS) return null;

  const url =
    `https://api.mapbox.com/directions/v5/mapbox/${DIRECTIONS_PROFILE}/` +
    `${a.lng},${a.lat};${b.lng},${b.lat}` +
    `?geometries=geojson&overview=full&annotations=distance,duration` +
    `&access_token=${MAPBOX_TOKEN}`;

  let r;
  try {
    r = await fetch(url);
  } catch {
    return null;
  }
  if (!r.ok) return null;

  const j = await r.json().catch(() => null);
  const route = j?.routes?.[0];
  const coords = route?.geometry?.coordinates || [];
  const meters = route?.distance ?? 0;
  const secs = route?.duration ?? 0;
  if (!coords.length || meters <= 0) return null;

  const first = { lat: coords[0][1], lng: coords[0][0] };
  if (distMeters(a, first) > 80) return null;

  const dt = Math.max(
    1,
    (new Date(b.timestamp) - new Date(a.timestamp)) / 1000
  );
  const v_kmh_imp = meters / 1000 / (dt / 3600);
  if (v_kmh_imp > MAX_BRIDGE_SPEED_KMH) return null;
  if (v_kmh_imp < MIN_BRIDGE_SPEED_KMH && dt < 300) return null;

  return coords.map(([lng, lat]) => ({
    lat,
    lng,
    timestamp: a.timestamp
  }));
}

async function smartBridge(a, b) {
  const d = distMeters(a, b);
  if (d > BRIDGE_MAX_METERS) return null;

  if (d <= DIRECTIONS_HOP_METERS) {
    return await directionsBetween(a, b);
  }

  const hops = Math.ceil(d / DIRECTIONS_HOP_METERS);
  const out = [a];
  let prev = a;
  for (let i = 1; i <= hops; i++) {
    const t = i / hops;
    const mid = {
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
      timestamp: new Date(
        new Date(a.timestamp).getTime() +
          (new Date(b.timestamp) - new Date(a.timestamp)) * t
      ).toISOString()
    };
    const seg = await directionsBetween(prev, mid);
    if (!seg) return null;
    out.push(...seg.slice(1));
    prev = mid;
    await sleep(60);
  }
  return out;
}

// ====== Animación de marcadores ======
function animateMarker(marker, fromLatLng, toLatLng, duration = 900) {
  if (!fromLatLng || !toLatLng) {
    marker.setLatLng(toLatLng);
    return;
  }
  const start = performance.now();
  function step(ts) {
    const elapsed = ts - start;
    const p = Math.min(elapsed / duration, 1);
    const lat = fromLatLng.lat + (toLatLng.lat - fromLatLng.lat) * p;
    const lng = fromLatLng.lng + (toLatLng.lng - fromLatLng.lng) * p;
    marker.setLatLng([lat, lng]);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ====== Capas base Mapbox/OSM ======
function createMapboxLayer(styleId) {
  return L.tileLayer(
    `https://api.mapbox.com/styles/v1/mapbox/${styleId}/tiles/256/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`,
    {
      maxZoom: 20,
      tileSize: 256,
      attribution:
        '© <a href="https://www.openstreetmap.org/">OpenStreetMap</a> ' +
        '© <a href="https://www.mapbox.com/">Mapbox</a>'
    }
  );
}

// ====== Inicialización del mapa ======
function initMap() {
  state.baseLayers.streets = createMapboxLayer("streets-v12");
  state.baseLayers.dark = createMapboxLayer("dark-v11");
  state.baseLayers.satellite = createMapboxLayer("satellite-streets-v12");
  state.baseLayers.osm = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 20 }
  );

  state.map = L.map("map", {
    center: [-12.0464, -77.0428],
    zoom: 6,
    layers: [state.baseLayers.streets]
  });
  state.currentBase = "streets";

  state.cluster = L.markerClusterGroup({
    disableClusteringAtZoom: 16
  });
  state.plainLayer = L.layerGroup();
  state.routeLayer = L.layerGroup().addTo(state.map);
  state.incidentLayer = L.layerGroup().addTo(state.map);

  // Vista global ON por defecto
  state.map.addLayer(state.plainLayer);
  if (ui.btnToggleCluster) ui.btnToggleCluster.textContent = "🌐 Vista global (ON)";

  // Cambiar iconos cuando cambie el zoom (punto/carro)
  state.map.on("zoomend", () => {
    for (const [, u] of state.users.entries()) {
      if (!u.lastRow) continue;
      u.marker.setIcon(getIconFor(u.lastRow));
    }
  });

  if (ui.apply) ui.apply.onclick = () => fetchInitial(true);
  if (ui.exportKmz) ui.exportKmz.onclick = () => exportKMZFromState();

  if (ui.btnCenter) {
    ui.btnCenter.onclick = () => {
      state.map.setView([-12.0464, -77.0428], 10, { animate: true });
    };
  }

  if (ui.btnShowAll) {
    ui.btnShowAll.onclick = () => {
      const group =
        state.mode === "cluster" ? state.cluster : state.plainLayer;
      const layers = group.getLayers();
      if (!layers.length) return;
      state.map.fitBounds(group.getBounds(), { padding: [40, 40] });
    };
  }

  if (ui.mapStyleSelect) {
    ui.mapStyleSelect.onchange = () => {
      const chosen = ui.mapStyleSelect.value;
      if (chosen === state.currentBase) return;
      const currentLayer = state.baseLayers[state.currentBase];
      const newLayer = state.baseLayers[chosen];
      if (currentLayer) state.map.removeLayer(currentLayer);
      if (newLayer) state.map.addLayer(newLayer);
      state.currentBase = chosen;
    };
  }

  if (ui.btnRefresh) ui.btnRefresh.onclick = () => fetchInitial(false);
  if (ui.btnToggleCluster) ui.btnToggleCluster.onclick = () => toggleClusterMode();
}
initMap();

// ====== Helpers de capas / cluster ======
function addMarkerToActiveLayer(marker) {
  if (state.mode === "cluster") {
    state.cluster.addLayer(marker);
  } else {
    state.plainLayer.addLayer(marker);
  }
}

function refreshMarkerContainers() {
  state.cluster.clearLayers();
  state.plainLayer.clearLayers();
  for (const [, u] of state.users.entries()) {
    addMarkerToActiveLayer(u.marker);
  }
}

function toggleClusterMode() {
  if (state.mode === "cluster") {
    state.mode = "plain";
    state.map.removeLayer(state.cluster);
    state.map.addLayer(state.plainLayer);
    refreshMarkerContainers();
    ui.btnToggleCluster.textContent = "🌐 Vista global (ON)";
  } else {
    state.mode = "cluster";
    state.map.removeLayer(state.plainLayer);
    state.map.addLayer(state.cluster);
    refreshMarkerContainers();
    ui.btnToggleCluster.textContent = "🌐 Vista global";
  }
}

// ====== UI estado y popups ======
function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}

function focusOnUser(uid) {
  const u = state.users.get(uid);
  if (!u || !u.marker) return;
  const latlng = u.marker.getLatLng();
  state.map.setView(latlng, 17, { animate: true });
  u.marker.openPopup();
}

function buildPopup(r) {
  const acc = Math.round(r.acc || 0);
  const spd = (r.spd || 0).toFixed(1);
  const ts = new Date(r.timestamp).toLocaleString();
  return `<div><b>${r.tecnico || "Sin nombre"}</b><br>Brigada: ${
    r.brigada || "-"
  }<br>Zona: ${r.zona || "-"} · Contrata: ${
    r.contrata || "-"
  }<br>Acc: ${acc} m · Vel: ${spd} m/s<br>${ts}</div>`;
}

/**
 * Llena los selects de zona y contrata a partir de los datos crudos.
 */
function populateFilterOptionsFromData(rows) {
  if (!ui.filterZona || !ui.filterContrata) return;

  const zonas = new Set();
  const contratas = new Set();

  rows.forEach(r => {
    if (r.zona) zonas.add(r.zona.trim());
    if (r.contrata) contratas.add(r.contrata.trim());
  });

  // Zona
  const currentZona = ui.filterZona.value || "";
  ui.filterZona.innerHTML = '<option value="">Zona: todas</option>';
  Array.from(zonas)
    .sort((a, b) => a.localeCompare(b))
    .forEach(z => {
      const opt = document.createElement("option");
      opt.value = z;
      opt.textContent = z;
      ui.filterZona.appendChild(opt);
    });
  if (currentZona) ui.filterZona.value = currentZona;

  // Contrata
  const currentContrata = ui.filterContrata.value || "";
  ui.filterContrata.innerHTML =
    '<option value="">Contrata: todas</option>';
  Array.from(contratas)
    .sort((a, b) => a.localeCompare(b))
    .forEach(c => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      ui.filterContrata.appendChild(opt);
    });
  if (currentContrata) ui.filterContrata.value = currentContrata;
}

// ====== Lista de brigadas en sidebar ======
function addOrUpdateUserInList(row, statusCode) {
  const uid = String(row.usuario_id || "0");
  const brig = row.brigada || "-";
  const tech = row.tecnico || "Sin nombre";
  const zona = row.zona || "-";
  const contrata = row.contrata || "-";
  const cargo = row.cargo || "-";

  const mins = Math.round(
    (Date.now() - new Date(row.timestamp)) / 60000
  );
  const hora = new Date(row.timestamp).toLocaleTimeString();

  let el = document.getElementById(`u-${uid}`);

  const html = `
    <div class="brig-main">
      <div class="brig-name">${tech}</div>
      <div class="brig-sub">Brigada: ${brig}</div>
      <div class="brig-extra">
        Zona: ${zona} · Contrata: ${contrata}<br>
        Cargo: ${cargo}
      </div>
    </div>
    <div class="brig-meta">
      <div class="brig-led ${
        statusCode === "online"
          ? "online"
          : statusCode === "mid"
          ? "mid"
          : "off"
      }"></div>
      <div>${hora}</div>
      <div>${mins} min</div>
    </div>
  `;

  const baseClass = `brigada-item brig-${
    statusCode === "online" ? "online" : statusCode === "mid" ? "mid" : "off"
  }`;

  if (!el) {
    el = document.createElement("div");
    el.id = `u-${uid}`;
    el.className = baseClass;
    el.innerHTML = html;

    el.dataset.tech = tech.toLowerCase();
    el.dataset.brigada = brig.toLowerCase();
    el.dataset.status = statusCode;
    el.dataset.zona = zona.toLowerCase();
    el.dataset.contrata = contrata.toLowerCase();

    el.onclick = () => {
      focusOnUser(uid);
      if (ui.brigada) ui.brigada.value = brig;
      const fb = document.getElementById("filterBrigada");
      if (fb) fb.value = brig;
    };
    ui.userList.appendChild(el);
  } else {
    el.className = baseClass + " marker-pulse";
    el.innerHTML = html;

    el.dataset.tech = tech.toLowerCase();
    el.dataset.brigada = brig.toLowerCase();
    el.dataset.status = statusCode;
    el.dataset.zona = zona.toLowerCase();
    el.dataset.contrata = contrata.toLowerCase();

    el.onclick = () => {
      focusOnUser(uid);
      if (ui.brigada) ui.brigada.value = brig;
      const fb = document.getElementById("filterBrigada");
      if (fb) fb.value = brig;
    };
    setTimeout(() => el.classList.remove("marker-pulse"), 600);
  }
}

function applyListFilters() {
  const name = (ui.filterName?.value || "").trim().toLowerCase();
  const brigadaText =
    (document.getElementById("filterBrigada")?.value || "")
      .trim()
      .toLowerCase();
  const status = ui.filterStatus?.value || "";
  const zona = (ui.filterZona?.value || "").trim().toLowerCase();
  const contrata = (ui.filterContrata?.value || "").trim().toLowerCase();

  const cards = ui.userList.querySelectorAll(".brigada-item");
  cards.forEach(card => {
    const t = card.dataset.tech || "";
    const b = card.dataset.brigada || "";
    const s = card.dataset.status || "";
    const z = card.dataset.zona || "";
    const c = card.dataset.contrata || "";

    const match =
      (!name || t.includes(name)) &&
      (!brigadaText || b.includes(brigadaText)) &&
      (!status || s === status) &&
      (!zona || z === zona) &&
      (!contrata || c === contrata);

    card.style.display = match ? "flex" : "none";
  });
}

// ====== Carga de ubicaciones ======
async function fetchInitial(clearList) {
  try {
    setStatus("Cargando…", "gray");
    if (clearList) ui.userList.innerHTML = "";

    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte(
        "timestamp",
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      )
      .order("timestamp", { ascending: false });

    if (error) {
      console.error(error);
      setStatus("Error", "gray");
      return;
    }

    // llena combos zona/contrata
    populateFilterOptionsFromData(data || []);

    const brigFilter = (ui.brigada?.value || "").trim().toLowerCase();
    const zonaFilter = (ui.filterZona?.value || "").trim().toLowerCase();
    const contrataFilter = (ui.filterContrata?.value || "")
      .trim()
      .toLowerCase();

    const grouped = new Map();
    const perUser = 100;

    for (const r of data) {
      // filtros de brigada / zona / contrata aplicados a mapa + lista
      if (
        brigFilter &&
        !(r.brigada || "").toLowerCase().includes(brigFilter)
      )
        continue;

      if (
        zonaFilter &&
        (r.zona || "").trim().toLowerCase() !== zonaFilter
      )
        continue;

      if (
        contrataFilter &&
        (r.contrata || "").trim().toLowerCase() !== contrataFilter
      )
        continue;

      const uid = String(r.usuario_id || "0");
      if (!grouped.has(uid)) grouped.set(uid, []);
      if (grouped.get(uid).length >= perUser) continue;
      grouped.get(uid).push(r);
    }

    state.cluster.clearLayers();
    state.plainLayer.clearLayers();
    if (state.routeLayer) state.routeLayer.clearLayers();
    // 👉 NO limpiamos incidentLayer, así el recorrido de avería se mantiene

    const activeUids = new Set();

    grouped.forEach((rows, uid) => {
      const last = rows[0];
      const mins = Math.round(
        (Date.now() - new Date(last.timestamp)) / 60000
      );
      const statusCode =
        mins <= 2 ? "online" : mins <= 5 ? "mid" : "off";

      activeUids.add(uid);

      let userState = state.users.get(uid);
      if (!userState) {
        const marker = L.marker([last.latitud, last.longitud], {
          icon: getIconFor(last)
        }).bindPopup(buildPopup(last));
        addMarkerToActiveLayer(marker);
        state.users.set(uid, { marker, lastRow: last });
      } else {
        const marker = userState.marker;
        const oldPos = marker.getLatLng();
        const newPos = { lat: last.latitud, lng: last.longitud };
        animateMarker(marker, oldPos, newPos, 850);
        marker.setIcon(getIconFor(last));
        marker.setPopupContent(buildPopup(last));
        addMarkerToActiveLayer(marker);
        userState.lastRow = last;
      }

      addOrUpdateUserInList(last, statusCode);
    });

    // quitar usuarios que no están en esta vista
    for (const [uid, u] of state.users.entries()) {
      if (!activeUids.has(uid)) {
        state.cluster.removeLayer(u.marker);
        state.plainLayer.removeLayer(u.marker);
        state.users.delete(uid);
        const el = document.getElementById(`u-${uid}`);
        if (el) el.remove();
      }
    }

    applyListFilters();
    setStatus("Conectado", "green");
  } catch (e) {
    console.error(e);
    setStatus("Error", "gray");
  }
}

// ====== Exportar KMZ (Directions cada ~10 min) ======
async function exportKMZFromState() {
  let prevDisabled = false;
  try {
    setStatus("Generando KMZ…", "gray");
    if (ui?.exportKmz) {
      prevDisabled = ui.exportKmz.disabled;
      ui.exportKmz.disabled = true;
    }

    const brig = (ui.brigada.value || "").trim();
    if (!brig) {
      alert("Escribe la brigada EXACTA para exportar su KMZ.");
      return;
    }

    const dateInput = document.getElementById("kmzDate");
    const chosen = dateInput && dateInput.value
      ? new Date(dateInput.value + "T00:00:00")
      : new Date();
    const ymd = toYMD(chosen);
    const next = new Date(chosen.getTime() + 24 * 60 * 60 * 1000);
    const ymdNext = toYMD(next);

    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select(
        "latitud,longitud,timestamp,tecnico,usuario_id,timestamp_pe,brigada,acc,spd"
      )
      .eq("brigada", brig)
      .gte("timestamp_pe", ymd)
      .lt("timestamp_pe", ymdNext)
      .order("timestamp_pe", { ascending: true });

    if (error) throw new Error(error.message);
    if (!data || data.length < 2) {
      alert(`⚠️ No hay datos para "${brig}" en ${ymd}.`);
      return;
    }

    const all = (data || [])
      .map(r => ({
        lat: +r.latitud,
        lng: +r.longitud,
        timestamp: r.timestamp_pe || r.timestamp,
        acc: r.acc ?? null,
        spd: r.spd ?? null
      }))
      .filter(
        p => isFinite(p.lat) && isFinite(p.lng) && p.timestamp
      )
      .sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
      );

    if (all.length < 2) {
      alert(`⚠️ No hay suficientes puntos para "${brig}" en ${ymd}.`);
      return;
    }

    // Muestreo por intervalo (10 min)
    const KMZ_INTERVAL_MIN = 10;
    const sampled = (() => {
      const out = [];
      let lastTime = null;
      for (const p of all) {
        const t = new Date(p.timestamp).getTime();
        if (lastTime === null) {
          out.push(p);
          lastTime = t;
          continue;
        }
        const diffMin = (t - lastTime) / 60000;
        if (diffMin >= KMZ_INTERVAL_MIN - 0.5) {
          out.push(p);
          lastTime = t;
        }
      }
      if (
        out.length &&
        out[out.length - 1].timestamp !== all[all.length - 1].timestamp
      ) {
        out.push(all[all.length - 1]);
      }
      if (!out.length) return all;
      return out;
    })();

    if (sampled.length < 2) {
      alert(
        `⚠️ El muestreo de ${KMZ_INTERVAL_MIN} min dejó muy pocos puntos para "${brig}" en ${ymd}.`
      );
      return;
    }

    async function routeBetweenPoints(a, b) {
      if (!MAPBOX_TOKEN) return null;
      const url =
        `https://api.mapbox.com/directions/v5/mapbox/driving/` +
        `${a.lng},${a.lat};${b.lng},${b.lat}` +
        `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const j = await r.json();
        const route = j?.routes?.[0];
        const coords = route?.geometry?.coordinates;
        if (!coords || !coords.length) return null;
        return coords.map(c => ({ lng: c[0], lat: c[1] }));
      } catch (e) {
        console.error("Error Directions (KMZ):", e);
        return null;
      }
    }

    const finalRoute = [];
    for (let i = 0; i < sampled.length - 1; i++) {
      const A = sampled[i];
      const B = sampled[i + 1];

      const route = await routeBetweenPoints(A, B);
      if (route && route.length) {
        if (!finalRoute.length) {
          finalRoute.push(...route);
        } else {
          finalRoute.push(...route.slice(1));
        }
      } else {
        if (!finalRoute.length) {
          finalRoute.push({ lng: A.lng, lat: A.lat });
        }
        finalRoute.push({ lng: B.lng, lat: B.lat });
      }
      await sleep(120);
    }

    if (finalRoute.length < 2) {
      alert("No se generó traza válida.");
      return;
    }

    let kml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
      `<name>${brig} - ${ymd}</name>` +
      '<Style id="routeStyle"><LineStyle><color>ff0000ff</color><width>4</width></LineStyle></Style>';

    const coordsStr = finalRoute.map(p => `${p.lng},${p.lat},0`).join(" ");
    kml += `
      <Placemark>
        <name>${brig} (${ymd})</name>
        <styleUrl>#routeStyle</styleUrl>
        <LineString><tessellate>1</tessellate><coordinates>${coordsStr}</coordinates></LineString>
      </Placemark>`;

    kml += "</Document></kml>";

    if (!window.JSZip) {
      try {
        await import(
          "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"
        );
      } catch (_) {}
    }
    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 1 }
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const safeBrig = brig.replace(/[^a-zA-Z0-9_-]+/g, "_");
    a.download = `recorrido_${safeBrig}_${ymd}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);

    alert(
      `✅ KMZ listo (cada ${KMZ_INTERVAL_MIN} min): ${brig} (${ymd}) — ${finalRoute.length} puntos`
    );
  } catch (e) {
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado", "green");
    if (ui?.exportKmz) ui.exportKmz.disabled = prevDisabled;
  }
}

/* ============ UTILIDADES PARA RUTAS A SITE ============ */
function formatMinutes(m) {
  if (m < 1) return "<1 min";
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const min = Math.round(m % 60);
  if (min === 0) return `${h} h`;
  return `${h} h ${min} min`;
}

function formatKm(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

// Buscar Sites en Supabase
async function searchSites(query) {
  query = (query || "").trim();
  if (query.length < 2) return [];

  const { data, error } = await supa
    .from("sites_nacional_tabla")
    .select(
      "Site_ID, Site_Name, Latitude, Longitude, DISTRITO, Departamento, Provincia"
    )
    .ilike("Site_Name", `%${query}%`)
    .limit(20);

  if (error) {
    console.error("Error buscando sites:", error);
    alert("Error buscando sites: " + error.message);
    return [];
  }

  if (!data || data.length === 0) return [];

  return data
    .map(row => {
      const lat = parseFloat(row.Latitude);
      const lng = parseFloat(row.Longitude);
      if (!isFinite(lat) || !isFinite(lng)) return null;
      return {
        id: row.Site_ID,
        name: row.Site_Name,
        lat,
        lng,
        distrito: row.DISTRITO,
        provincia: row.Provincia,
        departamento: row.Departamento
      };
    })
    .filter(Boolean);
}

// Mostrar lista de sugerencias debajo del input
function showSiteSuggestions(list) {
  const box = ui.siteSuggestions;
  if (!box) return;

  box.innerHTML = "";
  if (!list.length) {
    box.style.display = "none";
    return;
  }

  list.forEach(site => {
    const div = document.createElement("div");
    div.className = "suggestion-item";
    div.innerHTML = `<strong>${site.id || ""}</strong> - ${site.name}`;
    div.onclick = () => {
      ui.siteSearch.value = site.name;
      box.style.display = "none";
      handleBuscarSite(site);
    };
    box.appendChild(div);
  });

  box.style.display = "block";
}

// ====== Rutas desde brigadas hacia el Site ======
async function calcularRutasBrigadasCercanas(site) {
  if (!state.map || !MAPBOX_TOKEN) {
    alert("No hay mapa o token de Mapbox para calcular rutas.");
    return;
  }

  if (!state.routeLayer) {
    state.routeLayer = L.layerGroup().addTo(state.map);
  }
  state.routeLayer.clearLayers();
  ui.routesPanel.innerHTML = "";

  const brigadas = [];
  for (const [, u] of state.users.entries()) {
    const row = u.lastRow;
    if (!row) continue;
    const lat = parseFloat(row.latitud);
    const lng = parseFloat(row.longitud);
    if (!isFinite(lat) || !isFinite(lng)) continue;

    const d = distMeters({ lat, lng }, { lat: site.lat, lng: site.lng });
    brigadas.push({ row, lat, lng, dist: d });
  }

  if (!brigadas.length) {
    alert("No hay brigadas con ubicación válida.");
    return;
  }

  brigadas.sort((a, b) => a.dist - b.dist);
  const candidatos = brigadas.slice(0, 3); // 3 brigadas más cercanas

  const routeColors = ["#00e676", "#4fc3f7", "#ff5252"];

  const resultados = [];

  for (let i = 0; i < candidatos.length; i++) {
    const b = candidatos[i];
    const color = routeColors[i % routeColors.length];

    const url =
      `https://api.mapbox.com/directions/v5/mapbox/driving/` +
      `${b.lng},${b.lat};${site.lng},${site.lat}` +
      `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const data = await resp.json();
      const route = data.routes?.[0];
      if (!route) continue;

      const meters = route.distance || 0;
      const seconds = route.duration || 0;
      const minutes = seconds / 60;

      const coords = route.geometry.coordinates.map(([lng, lat]) => [
        lat,
        lng
      ]);

      const poly = L.polyline(coords, {
        color,
        weight: i === 0 ? 6 : 4,
        opacity: 0.9,
        dashArray: i === 0 ? null : "8 6",
        lineJoin: "round"
      }).addTo(state.routeLayer);

      poly.bringToFront();

      L.circleMarker([b.lat, b.lng], {
        radius: 5,
        color: "#000",
        weight: 2,
        fillColor: color,
        fillOpacity: 1
      })
        .addTo(state.routeLayer)
        .bindPopup(
          `<b>${b.row.brigada || "-"}</b><br>${b.row.tecnico ||
            b.row.usuario ||
            "Sin nombre"}`
        );

      resultados.push({
        brigada: b.row.brigada || "-",
        tecnico: b.row.tecnico || b.row.usuario || "Sin nombre",
        zona: b.row.zona || "-",
        contrata: b.row.contrata || "-",
        distance: meters,
        duration: minutes,
        color,
        polyline: poly
      });

      await sleep(120);
    } catch (e) {
      console.error("Error en directions Mapbox:", e);
    }
  }

  if (!resultados.length) {
    ui.routesPanel.innerHTML =
      "<div style='color:#bbb; padding:6px;'>No se pudo obtener rutas desde Mapbox.</div>";
    return;
  }

  resultados.sort((a, b) => a.duration - b.duration);

  const title = document.createElement("div");
  title.className = "routes-panel-title";
  title.textContent = `Rutas hacia: ${site.name}`;
  ui.routesPanel.appendChild(title);

  resultados.forEach((r, idx) => {
    const item = document.createElement("div");
    item.className = "route-item";

    const rankLabel = idx === 0 ? "1️⃣" : idx === 1 ? "2️⃣" : "3️⃣";

    item.innerHTML = `
      <div class="route-item-left">
        <div class="route-item-main">${rankLabel} ${r.brigada} – ${r.tecnico}</div>
        <div class="route-item-sub">Zona: ${r.zona} · Contrata: ${r.contrata}</div>
      </div>
      <div class="route-item-pill" style="background:${r.color}1f; border:1px solid ${r.color}80;">
        <div class="route-item-main">${formatMinutes(r.duration)}</div>
        <div class="route-item-sub">${formatKm(r.distance)}</div>
      </div>
    `;

    item.onclick = () => {
      if (r.polyline) {
        const bounds = r.polyline.getBounds();
        if (bounds.isValid()) {
          state.map.fitBounds(bounds, { padding: [60, 60] });
        }
      }
    };

    ui.routesPanel.appendChild(item);
  });

  const bounds = state.routeLayer.getBounds();
  if (bounds.isValid()) {
    state.map.fitBounds(bounds, { padding: [50, 50] });
  } else {
    state.map.setView([site.lat, site.lng], 13);
  }
}

// ====== Handler principal al buscar Site ======
async function handleBuscarSite(siteFromAutocomplete = null) {
  let site = siteFromAutocomplete;

  if (!site) {
    const name = ui.siteSearch?.value || "";
    if (!name.trim()) {
      alert("Ingresa un nombre de Site.");
      return;
    }

    const results = await searchSites(name);
    if (!results.length) {
      alert("No se encontró ningún Site con ese nombre.");
      return;
    }
    site = results[0];
  }

  if (!state.siteMarker) {
    state.siteMarker = L.marker([site.lat, site.lng], {
      icon: L.icon({
        iconUrl:
          "https://docs.mapbox.com/help/demos/custom-markers-gl-js/mapbox-icon.png",
        iconSize: [30, 40],
        iconAnchor: [15, 40]
      })
    }).addTo(state.map);
  } else {
    state.siteMarker.setLatLng([site.lat, site.lng]);
  }

  state.siteMarker
    .bindPopup(
      `<b>${site.name}</b><br>${site.departamento || ""} / ${site.provincia ||
        ""} / ${site.distrito || ""}<br>Lat: ${site.lat.toFixed(
        5
      )}<br>Lng: ${site.lng.toFixed(5)}`
    )
    .openPopup();

  await calcularRutasBrigadasCercanas(site);
}

/* ===========================================================
   MODO AVERÍA / BITÁCORA
   - Input + botón en sidebar
   - Busca bitácora por código/SOT/INC/TAS
   - Pinta recorrido de brigadas oficiales en ese rango de tiempo
   =========================================================== */

// Inyecta controles de avería en el sidebar (sin tocar index.html)
function injectIncidentControls() {
  if (document.getElementById("incidentSearch")) return;

  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;

  const firstFilter = sidebar.querySelector(".filter-group");
  const refNode = firstFilter ? firstFilter.nextSibling : sidebar.firstChild;

  const group = document.createElement("div");
  group.className = "filter-group";
  group.style.marginTop = "10px";
  group.innerHTML = `
    <input
      id="incidentSearch"
      type="text"
      placeholder="Código / SOT / INC / TAS..."
      autocomplete="off"
    />
    <button id="btnIncidentSearch" class="btn-full" style="margin-top:6px;">
      🔎 Buscar avería
    </button>
  `;

  const info = document.createElement("div");
  info.id = "incidentInfo";
  info.style.marginTop = "8px";
  info.style.padding = "8px";
  info.style.borderRadius = "10px";
  info.style.background = "#181818";
  info.style.fontSize = "12px";
  info.style.maxHeight = "210px";
  info.style.overflowY = "auto";
  info.style.border = "1px solid #262626";

  const title = document.createElement("div");
  title.style.fontWeight = "600";
  title.style.fontSize = "13px";
  title.style.marginBottom = "4px";
  title.textContent = "Resumen de avería";

  info.appendChild(title);
  const content = document.createElement("div");
  content.id = "incidentInfoBody";
  content.style.fontSize = "11px";
  content.style.color = "#ccc";
  content.textContent =
    "Ingresa un código, SOT, INC o TAS para ver el recorrido.";
  info.appendChild(content);

  sidebar.insertBefore(group, refNode);
  sidebar.insertBefore(info, group.nextSibling);

  const input = document.getElementById("incidentSearch");
  const btn = document.getElementById("btnIncidentSearch");
  if (btn && input) {
    btn.addEventListener("click", async () => {
      const term = input.value || "";
      if (!term.trim()) {
        alert("Ingresa un código, SOT, INC o TAS.");
        return;
      }
      await handleIncidentSearch(term.trim());
    });
  }
}

// Buscar bitácora por código/SOT/INC/TAS
async function fetchBitacoraBySearchTerm(term) {
  const t = term.trim();
  if (!t) return null;

  const isNumeric = /^\d+$/.test(t);
  const orParts = [];

  if (isNumeric) {
    orParts.push(`codigo_bd.eq.${t}`);
  }
  const safe = t.replace(/,/g, " ");
  orParts.push(`nrosot_bd.eq.${safe}`);
  orParts.push(`nroincidencia_bd.eq.${safe}`);
  orParts.push(`nrotas_bd.eq.${safe}`);

  const { data, error } = await supa
    .from("bitacoras")
    .select("*")
    .or(orParts.join(","))
    .order("fechainicial_bd", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Error buscando bitácora:", error);
    alert("Error buscando avería: " + error.message);
    return null;
  }
  return data && data.length ? data[0] : null;
}

function getBitacoraTimeWindow(b) {
  const inicio =
    b.est_01 ||
    (b.fechainicial_bd ? b.fechainicial_bd + "T00:00:00" : null);
  const fin =
    b.fecha_cierre ||
    b.ultima_actualizacion ||
    new Date().toISOString();
  return { inicio, fin };
}

function getBitacoraBrigadas(b) {
  const names = [
    b.bri1_oficial || b.bri1_bd,
    b.bri2_oficial || b.bri2_bd,
    b.bri3_oficial || b.bri3_bd,
    b.bri4_oficial || b.bri4_bd,
    b.bri5_oficial || b.bri5_bd
  ].filter(Boolean);
  return Array.from(new Set(names));
}

async function fetchGpsForBitacora(b, brigadas, inicio, fin) {
  if (!brigadas.length || !inicio || !fin) return [];

  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select(
      "latitud,longitud,timestamp,brigada,tecnico,usuario,contrata,zona,cargo"
    )
    .in("brigada", brigadas)
    .eq("zona", b.zona_bd)
    .gte("timestamp", inicio)
    .lte("timestamp", fin)
    .order("timestamp", { ascending: true });

  if (error) {
    console.error("Error trayendo GPS de brigadas:", error);
    alert("Error obteniendo recorrido de brigadas: " + error.message);
    return [];
  }
  return data || [];
}

function drawIncidentOnMap(b, gpsRows) {
  state.incidentLayer.clearLayers();

  // marker del sitio de la avería
  if (
    b.lat_bd != null &&
    b.lon_bd != null &&
    isFinite(Number(b.lat_bd)) &&
    isFinite(Number(b.lon_bd))
  ) {
    const lat = Number(b.lat_bd);
    const lng = Number(b.lon_bd);

    if (!state.incidentSiteMarker) {
      state.incidentSiteMarker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl:
            "https://docs.mapbox.com/help/demos/custom-markers-gl-js/mapbox-icon.png",
          iconSize: [30, 40],
          iconAnchor: [15, 40]
        })
      }).addTo(state.incidentLayer);
    } else {
      state.incidentSiteMarker.setLatLng([lat, lng]);
      state.incidentLayer.addLayer(state.incidentSiteMarker);
    }

    state.incidentSiteMarker.bindPopup(
      `<b>${b.nombresite_bd || "Sitio sin nombre"}</b><br>` +
        `Código: ${b.codigo_bd || "-"}<br>` +
        `Zona: ${b.zona_bd || "-"}`
    );
  }

  const byBrig = new Map();
  for (const r of gpsRows) {
    const name = r.brigada || "SIN_BRIGADA";
    if (!byBrig.has(name)) byBrig.set(name, []);
    byBrig.get(name).push(r);
  }

  const colors = ["#ff5252", "#00e676", "#40c4ff", "#ffa726", "#ce93d8"];
  const bounds = [];

  let idx = 0;
  for (const [brigName, rows] of byBrig.entries()) {
    if (!rows.length) continue;
    const color = colors[idx % colors.length];
    idx++;

    const latlngs = rows
      .map(r => [Number(r.latitud), Number(r.longitud)])
      .filter(([lat, lng]) => isFinite(lat) && isFinite(lng));

    if (latlngs.length < 2) continue;

    const poly = L.polyline(latlngs, {
      color,
      weight: 4,
      opacity: 0.9
    }).addTo(state.incidentLayer);

    bounds.push(poly.getBounds());

    const first = latlngs[0];
    const last = latlngs[latlngs.length - 1];

    L.circleMarker(first, {
      radius: 5,
      color,
      fillColor: "#000",
      fillOpacity: 1
    })
      .addTo(state.incidentLayer)
      .bindPopup(`<b>${brigName}</b><br>Inicio recorrido`);

    L.circleMarker(last, {
      radius: 5,
      color,
      fillColor: "#fff",
      fillOpacity: 1
    })
      .addTo(state.incidentLayer)
      .bindPopup(`<b>${brigName}</b><br>Fin recorrido`);
  }

  if (bounds.length) {
    let total = bounds[0];
    for (let i = 1; i < bounds.length; i++) {
      total = total.extend(bounds[i]);
    }
    state.map.fitBounds(total, { padding: [40, 40] });
  }
}

function showIncidentSummary(b, brigadas, gpsRows, inicio, fin) {
  const box = document.getElementById("incidentInfoBody");
  if (!box) return;

  const totalPuntos = gpsRows.length;
  const brigList = brigadas.length ? brigadas.join(", ") : "Sin brigadas";

  box.innerHTML = `
    <b>Avería ${b.codigo_bd || ""}</b><br>
    <b>Tipo:</b> ${b.tipoaveria_bd || "-"}<br>
    <b>Cliente:</b> ${b.nombrecliente_bd || "-"}<br>
    <b>Site:</b> ${b.nombresite_bd || "-"}<br>
    <b>Zona:</b> ${b.zona_bd || "-"}<br>
    <b>Brigadas:</b> ${brigList}<br>
    <b>Inicio:</b> ${formatDateTime(inicio)}<br>
    <b>Fin:</b> ${formatDateTime(fin)}<br>
    <b>Estado:</b> ${b.estado_trabajo || b.estado_bd || "-"}<br>
    <b>SLA total:</b> ${b.sla_total || "-"} (${b.cumplio_SLA || "-"})<br>
    <b>Puntos GPS:</b> ${totalPuntos}
  `;
}

async function handleIncidentSearch(term) {
  setStatus("Buscando avería...", "gray");

  const bit = await fetchBitacoraBySearchTerm(term);
  if (!bit) {
    setStatus("Conectado", "green");
    const box = document.getElementById("incidentInfoBody");
    if (box) {
      box.innerHTML =
        "<span>No se encontró avería para ese dato.</span>";
    }
    state.incidentLayer.clearLayers();
    return;
  }

  const { inicio, fin } = getBitacoraTimeWindow(bit);
  const brigadas = getBitacoraBrigadas(bit);
  const gpsRows = await fetchGpsForBitacora(bit, brigadas, inicio, fin);

  drawIncidentOnMap(bit, gpsRows);
  showIncidentSummary(bit, brigadas, gpsRows, inicio, fin);

  setStatus("Conectado", "green");
}

// ====== Arranque + eventos ======
setStatus("Cargando...", "gray");
fetchInitial(true);
setInterval(() => fetchInitial(false), 30000);

// Eventos para Site
if (ui.siteSearch) {
  let siteTypingTimer = null;
  ui.siteSearch.addEventListener("input", () => {
    clearTimeout(siteTypingTimer);
    const text = ui.siteSearch.value.trim();
    if (text.length < 2) {
      ui.siteSuggestions.style.display = "none";
      return;
    }
    siteTypingTimer = setTimeout(async () => {
      const results = await searchSites(text);
      showSiteSuggestions(results);
    }, 250);
  });
}

if (ui.btnBuscarSite) {
  ui.btnBuscarSite.addEventListener("click", () => handleBuscarSite());
}

// Cerrar sugerencias al hacer click fuera
document.addEventListener("click", e => {
  if (
    ui.siteSuggestions &&
    ui.siteSearch &&
    !ui.siteSearch.contains(e.target) &&
    !ui.siteSuggestions.contains(e.target)
  ) {
    ui.siteSuggestions.style.display = "none";
  }
});

// Filtros de lista
if (ui.filterName) ui.filterName.addEventListener("input", applyListFilters);
if (ui.filterStatus)
  ui.filterStatus.addEventListener("change", applyListFilters);

// Zona / contrata cambian dataset (refetch)
if (ui.filterZona)
  ui.filterZona.addEventListener("change", () => fetchInitial(true));
if (ui.filterContrata)
  ui.filterContrata.addEventListener("change", () => fetchInitial(true));

// Inyectar controles de AVERÍA
injectIncidentControls();

// Helper público por consola, por si quieres probar:
//   mostrarRecorridoAveria("123456");
async function mostrarRecorridoAveria(identificador) {
  await handleIncidentSearch(String(identificador || "").trim());
}
window.mostrarRecorridoAveria = mostrarRecorridoAveria;
