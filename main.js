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
  lastUpdate: document.getElementById("lastUpdate"),
  btnCenter: document.getElementById("btnCenter"),
  btnShowAll: document.getElementById("btnShowAll"),
  btnRefresh: document.getElementById("btnRefresh"),
  btnToggleCluster: document.getElementById("btnToggleCluster"),
  filterZona: document.getElementById("filterZona"),
  filterContrata: document.getElementById("filterContrata"),
  mapStyleSelect: document.getElementById("mapStyleSelect"),

  // panel de rutas a sites
  siteSearch: document.getElementById("siteSearch"),
  btnBuscarSite: document.getElementById("btnBuscarSite"),
  siteSuggestions: document.getElementById("siteSuggestions"),
  routesPanel: document.getElementById("routesPanel"),
  showRoutesPanelBtn: document.getElementById("showRoutesPanelBtn")
};

// ====== Estado global ======
const state = {
  map: null,
  users: new Map(), // key: usuario_id, val: { marker, lastRow }
  cluster: null,
  plainLayer: null,
  mode: "cluster", // "cluster" o "plain"

  lastFetchTS: null,
  isOnline: true,

  baseLayers: {}, // estilos base mapbox
  currentBase: "streets",

  routeLayer: null,
  siteMarker: null
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

// Intervalo de muestreo para KMZ (minutos)
const KMZ_INTERVAL_MIN = 10;

const BRIDGE_MAX_METERS = 800;
const DIRECTIONS_HOP_METERS = 300;
const MAX_BRIDGE_SPEED_KMH = 70;
const MIN_BRIDGE_SPEED_KMH = 3;
const DIRECTIONS_PROFILE = "driving";

const PER_BLOCK_DELAY = 150;

// ====== Iconos adaptativos ======
const CAR_ICONS = {
  green: L.icon({
    iconUrl:
      "https://cdn-icons-png.flaticon.com/512/854/854894.png",
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -13]
  }),
  yellow: L.icon({
    iconUrl:
      "https://cdn-icons-png.flaticon.com/512/854/854996.png",
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -13]
  }),
  red: L.icon({
    iconUrl:
      "https://cdn-icons-png.flaticon.com/512/854/854878.png",
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -13]
  }),
  gray: L.icon({
    iconUrl:
      "https://cdn-icons-png.flaticon.com/512/854/854927.png",
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -13]
  })
};

const DOT_ICONS = {
  green: L.divIcon({
    className: "dot-icon dot-green",
    iconSize: [14, 14]
  }),
  yellow: L.divIcon({
    className: "dot-icon dot-yellow",
    iconSize: [14, 14]
  }),
  red: L.divIcon({
    className: "dot-icon dot-red",
    iconSize: [14, 14]
  }),
  gray: L.divIcon({
    className: "dot-icon dot-gray",
    iconSize: [14, 14]
  })
};

// Elegir icono (carro/punto) según zoom + tiempo de la última actualización
function getIconFor(row) {
  const zoom = state.map?.getZoom?.() ?? 10;

  const mins = Math.round(
    (Date.now() - new Date(row.timestamp)) / 60000
  );
  let color = "green";
  if (mins > 60) color = "gray";
  else if (mins > 20) color = "red";
  else if (mins > 8) color = "yellow";

  if (zoom >= 14) {
    return CAR_ICONS[color];
  } else {
    return DOT_ICONS[color];
  }
}

// ====== Mapa base ======
function initMap() {
  state.map = L.map("map", {
    center: [-12.0464, -77.0428],
    zoom: 11,
    zoomControl: true
  });

  // ====== Capas base Mapbox ======
  const styles = {
    streets: "mapbox/streets-v12",
    satellite: "mapbox/satellite-streets-v12",
    dark: "mapbox/dark-v11",
    light: "mapbox/light-v11",
    outdoors: "mapbox/outdoors-v12"
  };

  for (const [key, styleId] of Object.entries(styles)) {
    state.baseLayers[key] = L.tileLayer(
      `https://api.mapbox.com/styles/v1/${styleId}/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`,
      {
        tileSize: 512,
        zoomOffset: -1,
        maxZoom: 19,
        attribution:
          '© <a href="https://www.openstreetmap.org/">OpenStreetMap</a> contributors, ' +
          '© <a href="https://www.mapbox.com/">Mapbox</a>'
      }
    );
  }

  state.baseLayers.streets.addTo(state.map);

  // ====== Capas de marcadores ======
  state.cluster = L.markerClusterGroup({
    spiderfyOnEveryZoom: true,
    showCoverageOnHover: false,
    disableClusteringAtZoom: 16
  }).addTo(state.map);

  state.plainLayer = L.layerGroup().addTo(state.map);

  state.routeLayer = L.layerGroup().addTo(state.map);

  // toggles
  state.mode = "cluster";
  state.currentBase = "streets";

  initUIEvents();
}

// ====== UI / Eventos ======
function setStatus(msg, color = "black") {
  if (ui.status) {
    ui.status.textContent = msg;
    ui.status.style.color = color;
  }
}

function initUIEvents() {
  if (ui.filterStatus) {
    ui.filterStatus.addEventListener("change", () =>
      fetchInitial(true)
    );
  }

  if (ui.filterName) {
    ui.filterName.addEventListener("input", () =>
      renderUsersFromState()
    );
  }

  if (ui.brigada) {
    ui.brigada.addEventListener("keydown", e => {
      if (e.key === "Enter") fetchInitial(true);
    });
  }

  if (ui.filterZona) {
    ui.filterZona.addEventListener("change", () =>
      fetchInitial(true)
    );
  }

  if (ui.filterContrata) {
    ui.filterContrata.addEventListener("change", () =>
      fetchInitial(true)
    );
  }

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

  // Rutas a site
  if (ui.showRoutesPanelBtn) {
    ui.showRoutesPanelBtn.onclick = () => {
      const panel = document.getElementById("routesPanelWrapper");
      if (!panel) return;
      panel.classList.toggle("open");
    };
  }

  if (ui.btnBuscarSite) {
    ui.btnBuscarSite.addEventListener("click", () => handleBuscarSite());
  }

  if (ui.siteSearch) {
    ui.siteSearch.addEventListener("input", () => handleSiteInput());
    ui.siteSearch.addEventListener("keydown", e => {
      if (e.key === "Enter") handleBuscarSite();
    });
  }
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
    state.cluster.clearLayers();
    for (const [, u] of state.users.entries()) {
      state.plainLayer.addLayer(u.marker);
    }
    if (ui.btnToggleCluster)
      ui.btnToggleCluster.textContent = "🌐 Vista global (OFF)";
  } else {
    state.mode = "cluster";
    state.plainLayer.clearLayers();
    for (const [, u] of state.users.entries()) {
      state.cluster.addLayer(u.marker);
    }
    if (ui.btnToggleCluster)
      ui.btnToggleCluster.textContent = "🌐 Vista global (ON)";
  }
}

// ====== POPUP ======
function buildPopup(row) {
  const brig = row.brigada || "-";
  const tecnico = row.tecnico || "-";
  const zona = row.zona || "-";
  const contrata = row.contrata || "-";
  const cargo = row.cargo || "-";
  const acc = row.acc ?? "N/D";
  const spd = row.spd ?? "N/D";

  const fechaLocal = new Date(row.timestamp).toLocaleString();

  return `
    <div class="popup">
      <div class="popup-title">${tecnico}</div>
      <div class="popup-sub">${brig}</div>
      <div class="popup-row"><strong>Zona:</strong> ${zona}</div>
      <div class="popup-row"><strong>Contrata:</strong> ${contrata}</div>
      <div class="popup-row"><strong>Cargo:</strong> ${cargo}</div>
      <div class="popup-row"><strong>Última actualización:</strong> ${fechaLocal}</div>
      <div class="popup-row"><strong>Precisión:</strong> ${acc} m</div>
      <div class="popup-row"><strong>Velocidad:</strong> ${spd} Km/h</div>
    </div>
  `;
}

// ====== FETCH INICIAL ======
async function fetchInitial(showLoader = true) {
  try {
    if (showLoader) setStatus("Cargando ubicaciones...", "gray");

    const brigText = (ui.brigada?.value || "").trim();
    const zonaFilter = (ui.filterZona?.value || "").trim();
    const contrataFilter = (ui.filterContrata?.value || "").trim();
    const statusFilter = ui.filterStatus?.value || "all";

    let query = supa
      .from("ubicaciones_brigadas")
      .select(
        "usuario_id,latitud,longitud,timestamp,brigada,tecnico,zona,contrata,cargo,acc,spd"
      )
      .order("timestamp", { ascending: false });

    if (brigText) {
      query = query.ilike("brigada", `%${brigText}%`);
    }
    if (zonaFilter) {
      query = query.eq("zona", zonaFilter);
    }
    if (contrataFilter) {
      query = query.eq("contrata", contrataFilter);
    }

    const { data, error } = await query;
    if (error) throw error;

    // llena combos zona/contrata
    populateFilterOptionsFromData(data || []);

    const brigFilter = (ui.brigada?.value || "").trim().toLowerCase();
    const zonaFilter2 = (ui.filterZona?.value || "").trim().toLowerCase();
    const contrataFilter2 = (ui.filterContrata?.value || "")
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
        zonaFilter2 &&
        (r.zona || "").trim().toLowerCase() !== zonaFilter2
      )
        continue;

      if (
        contrataFilter2 &&
        (r.contrata || "").trim().toLowerCase() !== contrataFilter2
      )
        continue;

      const uid = String(r.usuario_id || "0");
      if (!grouped.has(uid)) grouped.set(uid, []);
      const arr = grouped.get(uid);
      if (arr.length < perUser) arr.push(r);
    }

    state.users.clear();
    const activeUids = new Set();
    state.cluster.clearLayers();
    state.plainLayer.clearLayers();

    for (const [uid, rows] of grouped.entries()) {
      if (!rows.length) continue;
      rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      const last = rows[rows.length - 1];
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
        userState.lastRow = last;
      }
    }

    for (const [uid, u] of state.users.entries()) {
      if (!activeUids.has(uid)) {
        if (state.mode === "cluster") {
          state.cluster.removeLayer(u.marker);
        } else {
          state.plainLayer.removeLayer(u.marker);
        }
        state.users.delete(uid);
      }
    }

    renderUsersFromState();

    state.lastFetchTS = new Date();
    if (ui.lastUpdate) {
      ui.lastUpdate.textContent =
        "Última actualización: " + state.lastFetchTS.toLocaleString();
    }

    setStatus("Conectado", "green");
  } catch (e) {
    console.error(e);
    setStatus("Error al cargar datos", "red");
  }
}

// ====== Animación de marcador ======
function animateMarker(marker, from, to, duration = 700) {
  const start = performance.now();

  function frame(t) {
    const elapsed = t - start;
    const frac = Math.min(elapsed / duration, 1);
    const lat = from.lat + (to.lat - from.lat) * frac;
    const lng = from.lng + (to.lng - from.lng) * frac;
    marker.setLatLng([lat, lng]);
    if (frac < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ====== Render de lista de brigadas (sidebar) ======
function renderUsersFromState() {
  if (!ui.userList) return;

  const nameFilter = (ui.filterName?.value || "").trim().toLowerCase();
  const statusFilter = ui.filterStatus?.value || "all";

  const arr = [];
  for (const [uid, u] of state.users.entries()) {
    const row = u.lastRow;
    if (!row) continue;

    const mins = Math.round(
      (Date.now() - new Date(row.timestamp)) / 60000
    );

    let statusCode = "online";
    if (mins > 60) statusCode = "offline";
    else if (mins > 20) statusCode = "delay";
    else if (mins > 8) statusCode = "warn";

    if (statusFilter !== "all" && statusFilter !== statusCode) {
      continue;
    }

    if (
      nameFilter &&
      !(
        (row.tecnico || "").toLowerCase().includes(nameFilter) ||
        (row.brigada || "").toLowerCase().includes(nameFilter)
      )
    ) {
      continue;
    }

    arr.push({ uid, row, statusCode });
  }

  arr.sort((a, b) => {
    const brigA = (a.row.brigada || "").toLowerCase();
    const brigB = (b.row.brigada || "").toLowerCase();
    return brigA.localeCompare(brigB);
  });

  ui.userList.innerHTML = "";
  for (const item of arr) {
    const el = addOrUpdateUserInList(item.row, item.statusCode);
    ui.userList.appendChild(el);
  }
}

// ====== Combos de zona/contrata ======
function populateFilterOptionsFromData(data) {
  const zonas = new Set();
  const contratas = new Set();

  for (const r of data) {
    if (r.zona) zonas.add(r.zona.trim());
    if (r.contrata) contratas.add(r.contrata.trim());
  }

  if (ui.filterZona) {
    const currentZona = ui.filterZona.value;
    ui.filterZona.innerHTML = '<option value="">Todas las zonas</option>';
    Array.from(zonas)
      .sort((a, b) => a.localeCompare(b))
      .forEach(z => {
        const opt = document.createElement("option");
        opt.value = z;
        opt.textContent = z;
        ui.filterZona.appendChild(opt);
      });
    if (currentZona) ui.filterZona.value = currentZona;
  }

  if (ui.filterContrata) {
    const currentContrata = ui.filterContrata.value;
    ui.filterContrata.innerHTML =
      '<option value="">Todas las contratas</option>';
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
        Cargo: ${cargo}<br>
        Última posición: ${hora} (${mins} min)
      </div>
    </div>
    <div class="brig-status brig-${statusCode}">
      ${statusCode === "online" ? "ONLINE" : 
        statusCode === "warn" ? "WARN" :
        statusCode === "delay" ? "DELAY" :
        "OFFLINE"}
    </div>
  `;

  if (!el) {
    el = document.createElement("div");
    el.id = `u-${uid}`;
    el.className = "brig-item";
    el.innerHTML = html;
    el.onclick = () => {
      const userState = state.users.get(uid);
      if (!userState) return;
      const row2 = userState.lastRow;
      state.map.setView(
        [row2.latitud, row2.longitud],
        16,
        { animate: true }
      );
      userState.marker.openPopup();
    };
  } else {
    el.innerHTML = html;
  }

  return el;
}

// ====== Utilidades de geometría y rutas limpias ======
function haversine(a, b) {
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
function distMeters(a, b) {
  return haversine(a, b);
}

function cleanClosePoints(points, minDist) {
  if (!points.length) return [];
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    const d = distMeters(
      { lat: prev.lat, lng: prev.lng },
      { lat: cur.lat, lng: cur.lng }
    );
    if (d >= minDist) out.push(cur);
  }
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function densifySegment(segment, stepMeters) {
  if (segment.length < 2) return segment.slice();
  const result = [];
  for (let i = 0; i < segment.length - 1; i++) {
    const a = segment[i];
    const b = segment[i + 1];
    result.push(a);
    const d = distMeters(a, b);
    const steps = Math.floor(d / stepMeters);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      result.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t
      });
    }
  }
  result.push(segment[segment.length - 1]);
  return result;
}

function approxTimeGapMinutes(a, b) {
  if (!a.timestamp || !b.timestamp) return 0;
  const t1 = new Date(a.timestamp).getTime();
  const t2 = new Date(b.timestamp).getTime();
  return Math.abs(t2 - t1) / 60000;
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
    const gapM = approxTimeGapMinutes(prev, p);
    const dM = distMeters(prev, p);

    if (gapM > maxGapMin || dM > maxJumpM) {
      if (cur.length > 1) groups.push(cur);
      cur = [p];
    } else {
      cur.push(p);
    }
  }
  if (cur.length > 1) groups.push(cur);
  return groups;
}

// ====== Map Matching con Mapbox ======
async function mapMatchBlockSafe(block) {
  if (!block?.length) return null;
  const coords = block
    .map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`)
    .join(";");

  const profile = DIRECTIONS_PROFILE;
  const url = `https://api.mapbox.com/matching/v5/mapbox.${profile}/${coords}?geometries=geojson&access_token=${MAPBOX_TOKEN}`;

  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = await resp.json();
  if (!json.matchings?.length) return null;

  const match = json.matchings[0];
  const pts = match.geometry?.coordinates || [];
  if (!pts.length) return null;

  return pts.map(c => ({ lng: c[0], lat: c[1] }));
}

// ====== Puentes inteligentes entre bloques ======
async function smartBridge(a, b) {
  const d = distMeters(a, b);
  if (d > BRIDGE_MAX_METERS) return null;

  const avgLat = (a.lat + b.lat) / 2;
  const metersPerDegLat = 111320;
  const km = d / 1000;
  const approxHoursMin = 0.1;
  const approxSpeed = km / approxHoursMin;
  if (approxSpeed > MAX_BRIDGE_SPEED_KMH) return null;
  if (approxSpeed < MIN_BRIDGE_SPEED_KMH) return null;

  const dx = (b.lng - a.lng) * Math.cos((avgLat * Math.PI) / 180);
  const dy = b.lat - a.lat;
  const distDeg = Math.sqrt(dx * dx + dy * dy);
  if (!distDeg) return [a, b];

  const steps = Math.max(2, Math.floor(d / DIRECTIONS_HOP_METERS));
  const bridge = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    bridge.push({
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t
    });
  }
  return bridge;
}

// ====== Exportar KMZ (muestreo cada 10 minutos) ======
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

    // 1) Traer TODAS las posiciones del día
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

    // 2) Normalizar puntos crudos (ordenados por tiempo)
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

    // 3) Muestrear cada KMZ_INTERVAL_MIN minutos (≈10 min)
    const kmzBasePoints = (() => {
      const out = [];
      let lastKeptTime = null;

      for (const p of all) {
        const t = new Date(p.timestamp);
        if (!lastKeptTime) {
          out.push(p);
          lastKeptTime = t;
          continue;
        }
        const diffMin = (t - lastKeptTime) / 60000;
        if (diffMin >= KMZ_INTERVAL_MIN - 0.5) {
          out.push(p);
          lastKeptTime = t;
        }
      }

      // Asegurar último punto del día
      if (out.length && out[out.length - 1] !== all[all.length - 1]) {
        out.push(all[all.length - 1]);
      } else if (!out.length) {
        // fallback rarísimo: usamos todos los puntos originales
        return all;
      }

      return out;
    })();

    if (kmzBasePoints.length < 2) {
      alert(
        `⚠️ El muestreo de ${KMZ_INTERVAL_MIN} min dejó muy pocos puntos para "${brig}" en ${ymd}.`
      );
      return;
    }

    // 4) Limpieza espacial básica (quitar puntos demasiado cercanos entre sí)
    const rows1 = [
      kmzBasePoints[0],
      ...cleanClosePoints(kmzBasePoints.slice(1), CLEAN_MIN_METERS)
    ];

    // 5) Detectar huecos grandes en tiempo/distancia
    //    Usamos un umbral más relajado (30 min) para no cortar cada 10 min.
    const segments = splitOnGaps(rows1, 30, GAP_JUMP_METERS);

    const renderedSegments = [];

    // 6) Para cada segmento: Map Matching en bloques + “puentes” inteligentes
    for (const seg of segments) {
      if (seg.length < 2) continue;

      const blocks = chunk(seg, MAX_MM_POINTS);
      let current = [];

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];

        // Por defecto: densificado simple
        let finalBlock = densifySegment(block, DENSIFY_STEP);

        // Intentar Map Matching con Mapbox (ruta limpia sobre vías)
        try {
          const mm = await mapMatchBlockSafe(block);
          if (mm && mm.length >= 2) finalBlock = mm;
        } catch (_) {
          // Si falla, nos quedamos con finalBlock densificado
        }

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
          // unir sin duplicar punto
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

    // 7) Construir KML con los segmentos (se verá como una ruta completa)
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

    // 8) Empaquetar a KMZ (zip con doc.kml)
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
      `✅ KMZ listo (cada ${KMZ_INTERVAL_MIN} min): ${brig} (${ymd}) — ${renderedSegments.length} tramo(s) plausibles`
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
  if (m < 60) return `${m.toFixed(0)} min`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  if (rm < 5) return `${h} h`;
  return `${h} h ${rm.toFixed(0)} min`;
}

function spdKmhToMinutesPerKm(spdKmh) {
  if (!spdKmh || spdKmh <= 0) return Infinity;
  return 60 / spdKmh;
}

async function fetchSitesSuggestions(query) {
  if (!query || query.length < 2) return [];
  const { data, error } = await supa
    .from("sites_catalogo")
    .select("id,name,latitud,longitud")
    .ilike("name", `%${query}%`)
    .limit(10);
  if (error) {
    console.error("Error buscando sites:", error);
    return [];
  }
  return data || [];
}

// Pintar sugerencias
async function handleSiteInput() {
  const q = (ui.siteSearch?.value || "").trim();
  if (!q) {
    if (ui.siteSuggestions) ui.siteSuggestions.style.display = "none";
    return;
  }

  const suggestions = await fetchSitesSuggestions(q);
  const box = ui.siteSuggestions;
  if (!box) return;

  box.innerHTML = "";
  if (!suggestions.length) {
    box.style.display = "none";
    return;
  }

  suggestions.forEach(site => {
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

// ====== Rutas desde brigadas hacia el SITE ======
async function handleBuscarSite(preselectedSite = null) {
  try {
    if (!state.map) return;

    let siteData = preselectedSite;
    if (!siteData) {
      const text = (ui.siteSearch?.value || "").trim();
      if (!text) {
        alert("Escribe el nombre del site.");
        return;
      }

      const { data, error } = await supa
        .from("sites_catalogo")
        .select("id,name,latitud,longitud")
        .ilike("name", `%${text}%`)
        .limit(1);

      if (error) throw error;
      if (!data || !data.length) {
        alert("No se encontró el site.");
        return;
      }
      siteData = data[0];
    }

    if (state.siteMarker) {
      state.map.removeLayer(state.siteMarker);
      state.siteMarker = null;
    }

    if (!state.routeLayer) {
      state.routeLayer = L.layerGroup().addTo(state.map);
    }
    state.routeLayer.clearLayers();
    ui.routesPanel.innerHTML = "";

    const site = {
      lat: +siteData.latitud,
      lng: +siteData.longitud,
      name: siteData.name || "SITE"
    };

    state.siteMarker = L.marker([site.lat, site.lng], {
      icon: L.icon({
        iconUrl:
          "https://cdn-icons-png.flaticon.com/512/684/684908.png",
        iconSize: [32, 32],
        iconAnchor: [16, 32]
      })
    })
      .addTo(state.map)
      .bindPopup(`<b>${site.name}</b>`)
      .openPopup();

    state.map.setView([site.lat, site.lng], 14, { animate: true });

    const brigadas = [];
    for (const [, u] of state.users.entries()) {
      const row = u.lastRow;
      if (!row) continue;
      const lat = parseFloat(row.latitud);
      const lng = parseFloat(row.longitud);
      if (!isFinite(lat) || !isFinite(lng)) continue;

      const d = distMeters({ lat, lng }, { lat: site.lat, lng: site.lng });
      brigadas.push({
        row,
        lat,
        lng,
        distM: d
      });
    }

    brigadas.sort((a, b) => a.distM - b.distM);

    const topBrigadas = brigadas.slice(0, 10);

    for (const item of topBrigadas) {
      await drawRouteBrigadaToSite(item, site);
      await sleep(150);
    }
  } catch (e) {
    console.error("Error en handleBuscarSite:", e);
    alert("No se pudo calcular las rutas.");
  }
}

async function drawRouteBrigadaToSite(item, site) {
  const row = item.row;
  const from = {
    lat: parseFloat(row.latitud),
    lng: parseFloat(row.longitud)
  };

  const dM = distMeters(from, site);
  const dKm = dM / 1000;

  const profile = DIRECTIONS_PROFILE;
  const url = `https://api.mapbox.com/directions/v5/mapbox.${profile}/${from.lng},${from.lat};${site.lng},${site.lat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

  let coords = [];
  let durationMin = null;
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      const json = await resp.json();
      const route = json.routes?.[0];
      if (route?.geometry?.coordinates?.length) {
        coords = route.geometry.coordinates.map(c => ({
          lng: c[0],
          lat: c[1]
        }));
        durationMin = route.duration ? route.duration / 60 : null;
      }
    }
  } catch (err) {
    console.error("Error con Mapbox Directions:", err);
  }

  if (!coords.length) {
    coords = densifySegment([from, site], 80);
  }

  const poly = L.polyline(coords.map(p => [p.lat, p.lng]), {
    color: "blue",
    weight: 4,
    opacity: 0.7
  }).addTo(state.routeLayer);

  const brigName = row.brigada || "SIN BRIGADA";
  const tec = row.tecnico || "SIN TÉCNICO";
  const distText = `${dKm.toFixed(2)} km`;
  const timeText =
    durationMin != null
      ? formatMinutes(durationMin)
      : "~" +
        formatMinutes(
          dKm * spdKmhToMinutesPerKm(30)
        );

  const card = document.createElement("div");
  card.className = "route-card";
  card.innerHTML = `
    <div class="route-title">${brigName}</div>
    <div class="route-sub">${tec}</div>
    <div class="route-row"><strong>Distancia:</strong> ${distText}</div>
    <div class="route-row"><strong>Tiempo estimado:</strong> ${timeText}</div>
  `;

  card.onclick = () => {
    state.map.fitBounds(poly.getBounds(), { padding: [40, 40] });
  };

  ui.routesPanel.appendChild(card);
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
