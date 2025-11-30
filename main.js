// ============================== main.js ===============================
// Configuración general
// =====================================================================

// Tomamos la configuración desde config.js (window.CONFIG)
const { SUPABASE_URL, SUPABASE_ANON_KEY, MAPBOX_TOKEN } = window.CONFIG;

// Clave anon de Supabase
const SUPABASE_KEY = SUPABASE_ANON_KEY;

// Cliente Supabase ÚNICO para todo el archivo
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const AUTO_REFRESH_MS = 15000; // 15s
const HISTORY_MINUTES = 1440; // 24h
const MAX_POINTS_PER_USER = 200;

// Mapbox (el token ya viene desde config.js)
const MAP_STYLE_CLARO =
  "mapbox://styles/kevincarter343/clzq0sfw0002x01pw1kxx865f";
const MAP_STYLE_STREETS = "mapbox://styles/mapbox/streets-v12";
const MAP_STYLE_SATELLITE = "mapbox://styles/mapbox/satellite-v9";

// Map Matching (KMZ) / trazado limpio
const USE_MAP_MATCHING = true; // si quieres desactivar el matching, pon false
const MAX_MM_POINTS = 50; // máximo de puntos por petición de map matching
const MAX_MM_SEGMENTS_PER_USER = 3; // máximo de segmentos a dibujar por usuario
const MIN_MM_DISTANCE_DIFF = 5; // metros: si la distancia cruda vs matched < 5m, evitamos re-dibujar
const MIN_MM_POINTS_TO_MATCH = 2;

// =====================================================================
// Estado global
// =====================================================================

const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(), // uid -> { marker, lastRow }
  pointsByUser: new Map(), // uid -> [rows]
  matchedSegmentsByUser: new Map(), // uid -> { segments: [[{lat,lng},...]], lastRawDistance: number }

  lastFetchAt: null,
  isFetching: false,
};

// =====================================================================
// Utilidades
// =====================================================================

function minutesDiff(from, to) {
  return Math.round((to.getTime() - from.getTime()) / 60000);
}

function getMinutesSince(row) {
  if (!row || !row.timestamp) return null;
  const now = new Date();
  const t = new Date(row.timestamp);
  return minutesDiff(t, now);
}

function getIconFor(row) {
  const minutes = getMinutesSince(row);
  let className = "brigada-marker";

  if (minutes == null || !isFinite(minutes)) {
    className += " brigada-unknown";
  } else if (minutes <= 5) {
    className += " brigada-online";
  } else if (minutes <= 30) {
    className += " brigada-idle";
  } else {
    className += " brigada-offline";
  }

  return L.divIcon({
    className,
    html: `
      <div class="brigada-icon-inner">
        <div class="brigada-arrow"></div>
        <div class="brigada-circle"></div>
      </div>
    `,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function buildPopup(row) {
  const minutes = getMinutesSince(row);
  let statusText = "Sin datos de tiempo";

  if (minutes != null && isFinite(minutes)) {
    if (minutes < 1) {
      statusText = "Hace menos de 1 minuto";
    } else {
      statusText = `Hace ${minutes} min`;
    }
  }

  const user = row.usuario || "N/A";
  const brig = row.brigada || "N/A";
  const lat = row.latitud?.toFixed(6) ?? "N/A";
  const lng = row.longitud?.toFixed(6) ?? "N/A";

  return `
    <div class="popup-content">
      <h3>Brigada: ${brig}</h3>
      <p><strong>Usuario:</strong> ${user}</p>
      <p><strong>Lat, Lon:</strong> ${lat}, ${lng}</p>
      <p><strong>Último reporte:</strong> ${statusText}</p>
      <p><strong>Fecha/Hora:</strong> ${row.timestamp ?? "N/A"}</p>
    </div>
  `;
}

function distMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s1 =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) *
      Math.cos(b.lat * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s1), Math.sqrt(1 - s1));
}

function getBearing(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  let br = toDeg(Math.atan2(y, x));
  if (br < 0) br += 360;
  return br;
}

// Animación suave + rotación
function applyMarkerRotation(marker, startLatLng, endLatLng) {
  if (!marker || !startLatLng || !endLatLng) return;

  const a = { lat: startLatLng.lat, lng: startLatLng.lng };
  const b = { lat: endLatLng.lat, lng: endLatLng.lng };
  const bearingDeg = getBearing(a, b);

  if (marker._icon) {
    marker._icon.style.transformOrigin = "center";

    const current = marker._icon.style.transform || "";
    const baseTransform = current.replace(/rotate\([^)]*\)/g, "").trim();

    marker._icon.style.transform = `${baseTransform} rotate(${bearingDeg}deg)`.trim();
  }
}

function animateMarker(marker, fromRow, toRow, baseDuration = 2000) {
  if (!marker || !toRow) return;

  const startLatLng = fromRow
    ? L.latLng(fromRow.latitud, fromRow.longitud)
    : marker.getLatLng();
  const endLatLng = L.latLng(toRow.latitud, toRow.longitud);

  // Distancia entre puntos en metros
  const d = distMeters(
    { lat: startLatLng.lat, lng: startLatLng.lng },
    { lat: endLatLng.lat, lng: endLatLng.lng }
  );

  // Ajuste de umbral: animar casi siempre salvo casos extremos
  if (!isFinite(d) || d < 1 || d > 10000) {
    marker.setLatLng(endLatLng);
    applyMarkerRotation(marker, startLatLng, endLatLng);
    return;
  }

  // Duración proporcional a la distancia, con límites
  const minDuration = 500; // ms
  const maxDuration = 5000; // ms
  let duration = d * 60; // ~60 ms por metro
  duration = Math.max(minDuration, Math.min(maxDuration, duration));

  let startTime = null;

  function frame(timestamp) {
    if (!startTime) startTime = timestamp;
    const elapsed = timestamp - startTime;
    const t = Math.min(1, elapsed / duration);

    const lat = startLatLng.lat + (endLatLng.lat - startLatLng.lat) * t;
    const lng = startLatLng.lng + (endLatLng.lng - startLatLng.lng) * t;

    // Leaflet actualiza translate3d(...) aquí
    marker.setLatLng([lat, lng]);

    // Y aquí solo tocamos la rotación, sin romper el translate
    applyMarkerRotation(marker, startLatLng, endLatLng);

    if (t < 1) {
      requestAnimationFrame(frame);
    }
  }

  requestAnimationFrame(frame);
}

// ====== Radio adaptativo (matching) ======
function adaptiveRadius(p) {
  const acc = p && p.acc != null ? Number(p.acc) : NaN;
  const base = isFinite(acc) ? acc + 5 : 25;
  return Math.max(10, Math.min(50, base));
}

// ====== Map Matching ======
async function mapMatchBlockSafe(seg) {
  if (!MAPBOX_TOKEN) return null;
  if (!seg || seg.length < 2) return null;
  if (seg.length > MAX_MM_POINTS) {
    console.warn("Segmento demasiado grande para map matching", seg.length);
    return null;
  }

  try {
    const coords = seg.map((p) => [p.lng, p.lat]);
    const coordStr = coords.map((c) => c.join(",")).join(";");
    const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coordStr}?geometries=geojson&radiuses=${seg
      .map((p) => adaptiveRadius(p))
      .join(
        ";"
      )}&access_token=${MAPBOX_TOKEN}&tid=cicsa-gps-routes&steps=false&overview=full`;

    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn("Map Matching: respuesta no OK", resp.status);
      return null;
    }
    const json = await resp.json();

    if (!json.matchings || json.matchings.length === 0) {
      return null;
    }

    const best = json.matchings[0]; // la mejor
    const geometry = best.geometry;
    if (!geometry || geometry.type !== "LineString") {
      return null;
    }

    const out = [];
    for (const [lng, lat] of geometry.coordinates) {
      out.push({ lat, lng });
    }
    return out;
  } catch (err) {
    console.error("Error en mapMatchBlockSafe:", err);
    return null;
  }
}

// =====================================================================
// UI / elementos
// =====================================================================

const ui = {
  status: document.getElementById("status"),
  // en tu index.html no existe last-update ni toggle-matching, así que quedarán null
  lastUpdate: document.getElementById("last-update"),
  // id correcto según index.html: "userList"
  userList: document.getElementById("userList"),
  toggleMatching: document.getElementById("toggle-matching"),
};

// =====================================================================
// Mapa Leaflet
// =====================================================================

function initMap() {
  state.map = L.map("map", {
    center: [-16.39889, -71.535],
    zoom: 13,
    zoomControl: true,
    attributionControl: false,
  });

  state.baseLayers = {
    CLARO: L.tileLayer(
      `https://api.mapbox.com/styles/v1/kevincarter343/clzq0sfw0002x01pw1kxx865f/tiles/256/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`,
      {
        maxZoom: 22,
        tileSize: 256,
        zoomOffset: 0,
        attribution:
          'Datos &copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a>, Imagery &copy; <a href="https://www.mapbox.com/">Mapbox</a>',
      }
    ),
    Streets: L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`,
      {
        maxZoom: 22,
        tileSize: 256,
        zoomOffset: 0,
      }
    ),
    Satélite: L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/256/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`,
      {
        maxZoom: 22,
        tileSize: 256,
        zoomOffset: 0,
      }
    ),
  };

  state.baseLayers.CLARO.addTo(state.map);

  L.control
    .layers(
      {
        CLARO: state.baseLayers.CLARO,
        Streets: state.baseLayers.Streets,
        Satélite: state.baseLayers.Satélite,
      },
      null,
      { position: "topright" }
    )
    .addTo(state.map);

  state.cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 50,
  });
  state.map.addLayer(state.cluster);
}

// =====================================================================
// Supabase / fetch de datos
// =====================================================================

async function fetchBrigadasData() {
  const now = new Date();
  const fromDt = new Date(now.getTime() - HISTORY_MINUTES * 60000);

  const { data, error } = await supabaseClient
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", fromDt.toISOString())
    .lte("timestamp", now.toISOString())
    .order("timestamp", { ascending: true });

  if (error) {
    console.error("Error al obtener datos:", error);
    throw error;
  }
  return data || [];
}

// =====================================================================
// Lógica de UI
// =====================================================================

function setStatus(text, kind = "info") {
  if (!ui.status) return;
  ui.status.textContent = text;
  ui.status.className = "";
  ui.status.classList.add("status", `status-${kind}`);
}

function setLastUpdate(date) {
  if (!ui.lastUpdate) return;
  if (!date) {
    ui.lastUpdate.textContent = "—";
  } else {
    ui.lastUpdate.textContent = date.toLocaleString();
  }
}

// =====================================================================
// Lista lateral de brigadas
// =====================================================================

function addOrUpdateUserInList(row) {
  if (!ui.userList) return;
  const brig = row.brigada || "SIN BRIGADA";
  const usuario = row.usuario || "N/A";
  const minutes = getMinutesSince(row);
  const statusClass =
    minutes == null || !isFinite(minutes)
      ? "unknown"
      : minutes <= 5
      ? "online"
      : minutes <= 30
      ? "idle"
      : "offline";

  const id = `brig-${brig}-${usuario}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  let li = document.getElementById(id);

  if (!li) {
    li = document.createElement("li");
    li.id = id;
    li.className = `user-item status-${statusClass}`;
    li.innerHTML = `
      <div class="user-main">
        <span class="user-brig">${brig}</span>
        <span class="user-name">${usuario}</span>
      </div>
      <div class="user-meta">
        <span class="user-time"></span>
        <span class="user-latlon"></span>
      </div>
    `;
    ui.userList.appendChild(li);
  }

  li.className = `user-item status-${statusClass}`;

  const timeSpan = li.querySelector(".user-time");
  const latlonSpan = li.querySelector(".user-latlon");

  if (timeSpan) {
    if (minutes == null || !isFinite(minutes)) {
      timeSpan.textContent = "Tiempo desconocido";
    } else if (minutes < 1) {
      timeSpan.textContent = "Hace < 1 min";
    } else {
      timeSpan.textContent = `Hace ${minutes} min`;
    }
  }

  if (latlonSpan) {
    const lat = row.latitud?.toFixed(5) ?? "N/A";
    const lng = row.longitud?.toFixed(5) ?? "N/A";
    latlonSpan.textContent = `${lat}, ${lng}`;
  }

  li.onclick = () => {
    const key = `${row.brigada || ""}::${row.usuario || ""}`;
    const userState = state.users.get(key);
    if (userState && userState.marker) {
      const latlng = userState.marker.getLatLng();
      state.map.setView(latlng, 17);
      userState.marker.openPopup();
    }
  };
}

// =====================================================================
// Actualización de marcadores + rutas
// =====================================================================

function updateMarkersFromData(rows) {
  if (!state.map || !state.cluster) return;

  const grouped = new Map();
  for (const r of rows) {
    const key = `${r.brigada || ""}::${r.usuario || ""}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }

  for (const [key, rowsArr] of grouped.entries()) {
    rowsArr.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    if (rowsArr.length > MAX_POINTS_PER_USER) {
      const slice = rowsArr.slice(-MAX_POINTS_PER_USER);
      grouped.set(key, slice);
    }
  }

  state.cluster.clearLayers();

  const newUsers = new Map();

  for (const [uid, rows] of grouped.entries()) {
    const last = rows[rows.length - 1];
    if (!last || last.latitud == null || last.longitud == null) continue;

    const prev = state.users.get(uid);
    let marker = null;

    if (prev && prev.marker) {
      marker = prev.marker;
      marker.setIcon(getIconFor(last));
      marker.setPopupContent(buildPopup(last));

      // animar desde lastRow anterior a última posición nueva
      animateMarker(marker, prev.lastRow, last);
      state.cluster.addLayer(marker);
    } else {
      marker = L.marker([last.latitud, last.longitud], {
        icon: getIconFor(last),
      }).bindPopup(buildPopup(last));

      state.cluster.addLayer(marker);
    }

    newUsers.set(uid, { marker, lastRow: last });
    state.pointsByUser.set(uid, rows);
    addOrUpdateUserInList(last);
  }

  state.users = newUsers;

  if (USE_MAP_MATCHING) {
    drawMatchedRoutesForAllUsers();
  }
}

// =====================================================================
// Trazado limpio (Map Matching) por usuario
// =====================================================================

async function computeMatchedRouteForUser(uid, rows) {
  if (!rows || rows.length < MIN_MM_POINTS_TO_MATCH) return null;

  const pts = rows
    .filter(
      (r) =>
        r.latitud != null &&
        r.longitud != null &&
        !isNaN(r.latitud) &&
        !isNaN(r.longitud)
    )
    .map((r) => ({
      lat: Number(r.latitud),
      lng: Number(r.longitud),
      timestamp: r.timestamp,
      acc: r.accuracy ?? null,
    }));

  if (pts.length < MIN_MM_POINTS_TO_MATCH) return null;

  let totalRawDist = 0;
  for (let i = 1; i < pts.length; i++) {
    totalRawDist += distMeters(
      { lat: pts[i - 1].lat, lng: pts[i - 1].lng },
      { lat: pts[i].lat, lng: pts[i].lng }
    );
  }

  const existing = state.matchedSegmentsByUser.get(uid);
  if (
    existing &&
    existing.lastRawDistance != null &&
    Math.abs(existing.lastRawDistance - totalRawDist) < MIN_MM_DISTANCE_DIFF
  ) {
    return existing.segments || [];
  }

  const segments = [];
  let block = [];

  for (const p of pts) {
    if (block.length === 0) {
      block.push(p);
      continue;
    }
    const last = block[block.length - 1];
    const d = distMeters(
      { lat: last.lat, lng: last.lng },
      { lat: p.lat, lng: p.lng }
    );
    if (d > 2000 || block.length >= MAX_MM_POINTS) {
      segments.push(block);
      block = [p];
    } else {
      block.push(p);
    }
  }
  if (block.length >= MIN_MM_POINTS_TO_MATCH) {
    segments.push(block);
  }

  const matchedSegments = [];
  let usedSegments = 0;

  for (const seg of segments) {
    if (usedSegments >= MAX_MM_SEGMENTS_PER_USER) break;
    const matched = await mapMatchBlockSafe(seg);
    if (matched && matched.length >= 2) {
      matchedSegments.push(matched);
      usedSegments++;
    }
  }

  state.matchedSegmentsByUser.set(uid, {
    segments: matchedSegments,
    lastRawDistance: totalRawDist,
  });

  return matchedSegments;
}

let routeLayerGroup = null;

function clearMatchedRouteLayers() {
  if (routeLayerGroup) {
    routeLayerGroup.clearLayers();
    state.map.removeLayer(routeLayerGroup);
    routeLayerGroup = null;
  }
}

async function drawMatchedRoutesForAllUsers() {
  if (!USE_MAP_MATCHING) {
    clearMatchedRouteLayers();
    return;
  }

  clearMatchedRouteLayers();
  routeLayerGroup = L.layerGroup().addTo(state.map);

  const entries = Array.from(state.pointsByUser.entries()).slice(0, 10);
  console.log("Dibujando rutas matched para usuarios:", entries.length);

  const tasks = entries.map(async ([uid, rows]) => {
    const segs = await computeMatchedRouteForUser(uid, rows);
    return { uid, segs };
  });

  const results = await Promise.all(tasks);

  for (const { uid, segs } of results) {
    if (!segs || !segs.length) continue;

    for (const line of segs) {
      const latlngs = line.map((p) => [p.lat, p.lng]);
      const poly = L.polyline(latlngs, {
        weight: 4,
        opacity: 0.9,
        className: "matched-route-line",
      });
      poly.addTo(routeLayerGroup);
    }
  }
}

// =====================================================================
// Loop principal de refresco
// =====================================================================

let firstLoadDone = false;

async function refreshData() {
  if (state.isFetching) return;
  state.isFetching = true;
  setStatus("Actualizando ubicación de brigadas...", "info");

  try {
    const rows = await fetchBrigadasData();
    console.log("Filas obtenidas:", rows.length);

    updateMarkersFromData(rows);

    const now = new Date();
    state.lastFetchAt = now;
    setLastUpdate(now);
    setStatus("Ubicaciones actualizadas correctamente", "success");

    if (!firstLoadDone) {
      firstLoadDone = true;
      fitMapToAllMarkers();
    }
  } catch (err) {
    console.error("Error en refreshData:", err);
    setStatus("Error al actualizar ubicaciones", "error");
  } finally {
    state.isFetching = false;
  }
}

function fitMapToAllMarkers() {
  if (!state.cluster) return;
  const bounds = state.cluster.getBounds();
  if (bounds && bounds.isValid()) {
    state.map.fitBounds(bounds, { padding: [50, 50] });
  }
}

// =====================================================================
// Toggle Matching
// =====================================================================

if (ui.toggleMatching) {
  ui.toggleMatching.checked = USE_MAP_MATCHING;
  ui.toggleMatching.addEventListener("change", (e) => {
    const checked = e.target.checked;
    if (!checked) {
      clearMatchedRouteLayers();
      setStatus("Trazado limpio desactivado", "info");
    } else {
      setStatus("Trazado limpio activado (Map Matching)", "info");
      drawMatchedRoutesForAllUsers();
    }
  });
}

// =====================================================================
// Inicio
// =====================================================================

document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  setStatus("Cargando datos iniciales...", "info");
  await refreshData();
  setStatus("Monitoreo en tiempo real activo", "success");
});

setInterval(refreshData, AUTO_REFRESH_MS);
