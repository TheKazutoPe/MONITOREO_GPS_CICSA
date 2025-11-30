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
  btnCenter: document.getElementById("btnCenter"),
  btnShowAll: document.getElementById("btnShowAll"),
  mapStyleSelect: document.getElementById("mapStyleSelect"),
  btnRefresh: document.getElementById("btnRefresh"),
  btnToggleCluster: document.getElementById("btnToggleCluster")
};

// ====== Estado ======
const state = {
  map: null,
  baseLayers: {},
  currentBase: "streets",
  cluster: null,
  plainLayer: null,
  mode: "cluster", // cluster | plain
  users: new Map(),
  pointsByUser: new Map()
};

// ====== Parámetros de trazado / matching ======
const CLEAN_MIN_METERS = 6;
const DENSIFY_STEP = 10;
const MAX_MM_POINTS = 40;
const MAX_MATCH_INPUT = 90;
const MAX_DIST_RATIO = 0.35;
const ENDPOINT_TOL = 25;
const CONFIDENCE_MIN = 0.7;

const GAP_MINUTES = 8;
const GAP_JUMP_METERS = 800;

const BRIDGE_MAX_METERS = 800;
const DIRECTIONS_HOP_METERS = 300;
const MAX_BRIDGE_SPEED_KMH = 70;
const MIN_BRIDGE_SPEED_KMH = 3;
const DIRECTIONS_PROFILE = "driving";

const PER_BLOCK_DELAY = 150;

// ====== Iconos adaptativos (carro / punto) ======
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
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  }),
  yellow: L.divIcon({
    className: "marker-dot marker-dot-yellow",
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  }),
  gray: L.divIcon({
    className: "marker-dot marker-dot-gray",
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  })
};

function getStatusColor(row) {
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  if (mins <= 2) return "green";
  if (mins <= 5) return "yellow";
  return "gray";
}

// Decide icono según zoom (carro cerca, punto lejos)
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

// densificar
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

// ====== Map matching ======
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
    (typeof m.confidence === "number" && m.confidence < CONFIDENCE_MIN)
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

// ====== Animación de marcador ======
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

// ====== Mapbox tiles en Leaflet ======
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

// ====== MAPA ======
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
  state.map.addLayer(state.cluster);

  // Cambiar iconos carro/punto al cambiar zoom
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

// ====== capas y cluster toggle ======
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

// ====== UI de estado ======
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
  }<br>Acc: ${acc} m · Vel: ${spd} m/s<br>${ts}</div>`;
}

// ====== Lista de brigadas ======
function addOrUpdateUserInList(row, statusCode) {
  const uid = String(row.usuario_id || "0");
  const brig = row.brigada || "-";
  const tech = row.tecnico || "Sin nombre";
  const mins = Math.round(
    (Date.now() - new Date(row.timestamp)) / 60000
  );
  const hora = new Date(row.timestamp).toLocaleTimeString();

  let el = document.getElementById(`u-${uid}`);

  const html = `
    <div class="brig-main">
      <div class="brig-name">${tech}</div>
      <div class="brig-sub">${brig}</div>
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

  const cards = ui.userList.querySelectorAll(".brigada-item");
  cards.forEach(card => {
    const t = card.dataset.tech || "";
    const b = card.dataset.brigada || "";
    const s = card.dataset.status || "";

    const match =
      (!name || t.includes(name)) &&
      (!brigadaText || b.includes(brigadaText)) &&
      (!status || s === status);

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

    const brigFilter = (ui.brigada?.value || "").trim().toLowerCase();
    const grouped = new Map();
    const perUser = 100;

    for (const r of data) {
      if (
        brigFilter &&
        !(r.brigada || "").toLowerCase().includes(brigFilter)
      )
        continue;
      const uid = String(r.usuario_id || "0");
      if (!grouped.has(uid)) grouped.set(uid, []);
      if (grouped.get(uid).length >= perUser) continue;
      grouped.get(uid).push(r);
    }

    state.cluster.clearLayers();
    state.plainLayer.clearLayers();

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

// ====== Exportar KMZ (igual que antes) ======
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

    const rows1 = [all[0], ...cleanClosePoints(all.slice(1), CLEAN_MIN_METERS)];
    const segments = splitOnGaps(rows1, GAP_MINUTES, GAP_JUMP_METERS);

    const renderedSegments = [];
    for (const seg of segments) {
      if (seg.length < 2) continue;

      const blocks = chunk(seg, MAX_MM_POINTS);
      let current = [];
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];

        let finalBlock = densifySegment(block, DENSIFY_STEP);

        try {
          const mm = await mapMatchBlockSafe(block);
          if (mm && mm.length >= 2) finalBlock = mm;
        } catch (_) {}

        if (!current.length) {
          current.push(...finalBlock);
        } else {
          const last = current[current.length - 1];
          const first = finalBlock[0];
          const gapM = distMeters(last, first);

          if (gapM > 5) {
            let appended = false;
            if (gapM <= BRIDGE_MAX_METERS) {
              const bridge = await smartBridge(last, first);
              if (bridge?.length) {
                current.push(...bridge.slice(1));
                appended = true;
              }
            }
            if (!appended) {
              if (current.length > 1) renderedSegments.push(current);
              current = [...finalBlock];
              await sleep(PER_BLOCK_DELAY);
              continue;
            }
          }
          current.push(...finalBlock.slice(1));
        }

        await sleep(PER_BLOCK_DELAY);
      }
      if (current.length > 1) renderedSegments.push(current);
    }

    if (!renderedSegments.length) {
      alert("No se generó traza válida.");
      return;
    }

    let kml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
      `<name>${brig} - ${ymd}</name>` +
      '<Style id="routeStyle"><LineStyle><color>ffFF0000</color><width>4</width></LineStyle></Style>';

    for (const seg of renderedSegments) {
      const coordsStr = seg.map(p => `${p.lng},${p.lat},0`).join(" ");
      kml += `
        <Placemark>
          <name>${brig} (${ymd})</name>
          <styleUrl>#routeStyle</styleUrl>
          <LineString><tessellate>1</tessellate><coordinates>${coordsStr}</coordinates></LineString>
        </Placemark>`;
    }

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
      `✅ KMZ listo: ${brig} (${ymd}) — ${renderedSegments.length} tramo(s) plausibles`
    );
  } catch (e) {
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado", "green");
    if (ui?.exportKmz) ui.exportKmz.disabled = prevDisabled;
  }
}

// ====== Arranque ======
setStatus("Cargando...", "gray");
fetchInitial(true);
// setInterval(() => fetchInitial(false), 30000); // si quieres auto-refresh
