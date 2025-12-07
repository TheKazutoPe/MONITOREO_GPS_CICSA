// ============================== main.js ===============================
//  Versión corregida con relación de GPS por BRIGADA y fix de "usuario"
// =====================================================================

// Config global de Supabase
const supaUrl = CONFIG.SUPABASE_URL;
const supaKey = CONFIG.SUPABASE_KEY;
const supa = supabase.createClient(supaUrl, supaKey);

// Estado global simple
const state = {
  map: null,
  incidentLayer: null,
  brigadesLayer: null,
  selectedMarker: null,
  liveMode: false,
  pollingInterval: null,
  lastPositionsByUser: new Map(),
  incidentSiteMarker: null,
  lastKmzLayer: null,
  incidentGpsPolyline: null,
  kmzPolyline: null
};

// Referencias de UI
const ui = {
  statusText: document.getElementById("statusText"),
  userList: document.getElementById("userList"),
  filterName: document.getElementById("filterName"),
  filterZona: document.getElementById("filterZona"),
  filterContrata: document.getElementById("filterContrata"),
  filterStatus: document.getElementById("filterStatus"),
  btnLive: document.getElementById("btnLive"),
  btnRefresh: document.getElementById("btnRefresh"),
  btnSearchIncident: document.getElementById("btnSearchIncident"),
  inputIncident: document.getElementById("inputIncident"),
  incidentInfo: document.getElementById("incidentInfo"),
  kmzFileInput: document.getElementById("kmzFileInput"),
  btnClearKmz: document.getElementById("btnClearKmz"),
  incidentSummary: document.getElementById("incidentSummary")
};

// ====================== Utilidades de formato =========================

function setStatus(text, color = "black") {
  if (!ui.statusText) return;
  ui.statusText.textContent = text;
  ui.statusText.style.color = color;
}

function formatDateTime(isoStr) {
  if (!isoStr) return "-";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  return d.toLocaleString("es-PE", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatTime(isoStr) {
  if (!isoStr) return "-";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  return d.toLocaleTimeString("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatDuration(ms) {
  if (ms == null || isNaN(ms)) return "-";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!h && !m) parts.push(`${s}s`);
  return parts.join(" ");
}

function toFixedOrDash(num, decimals = 2) {
  if (num == null || isNaN(num)) return "-";
  return Number(num).toFixed(decimals);
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  function toRad(v) {
    return (v * Math.PI) / 180;
  }
  const R = 6371000; // Radio terrestre en metros
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ======================= Inicialización del mapa ======================

function initMap() {
  const mapaDiv = document.getElementById("map");
  if (!mapaDiv) {
    console.error("No se encontró el div #map en el DOM.");
    return;
  }

  const map = L.map("map", {
    center: [-12.0464, -77.0428],
    zoom: 12,
    zoomControl: true
  });

  // Capa base (puedes cambiar el provider según necesites)
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19
  }).addTo(map);

  state.map = map;
  state.incidentLayer = L.layerGroup().addTo(map);
  state.brigadesLayer = L.layerGroup().addTo(map);

  setStatus("Mapa inicializado", "green");
}

// ======================= Lógica de brigadas ===========================

function buildUserKey(row) {
  return String(row.usuario_id || "0");
}

function getRowStatus(row) {
  // Se puede ajustar según tus reglas de negocio de "estado"
  // Aquí se usa un campo "estado" si existe, o se deduce de spd/acc
  if (row.estado) return row.estado;
  if (row.spd == null) return "SIN_MOV";
  if (row.spd < 1) return "DETENIDO";
  if (row.spd < 5) return "LENTO";
  return "EN_RUTA";
}

// Actualizar/agregar un item en la lista lateral de brigadas
function addOrUpdateUserInList(row, statusCode) {
  const uid = String(row.usuario_id || "0");
  const brig = row.brigada || "-";
  const tech = row.tecnico || "Sin nombre";
  const zona = row.zona || "-";
  const contrata = row.contrata || "-";

  let li = document.querySelector(`li[data-uid="${uid}"]`);
  if (!li) {
    li = document.createElement("li");
    li.dataset.uid = uid;
    li.className = "user-item";
    li.innerHTML = `
      <div class="title">${tech}</div>
      <div class="subtitle">
        <span class="brigada"></span> |
        <span class="zona"></span> |
        <span class="contrata"></span>
      </div>
      <div class="meta">
        <span class="status"></span>
        <span class="time"></span>
        <span class="coords"></span>
        <span class="speed"></span>
      </div>
    `;
    li.addEventListener("click", () => {
      if (!state.map) return;
      const lat = row.latitud;
      const lng = row.longitud;
      if (lat != null && lng != null && isFinite(lat) && isFinite(lng)) {
        state.map.setView([lat, lng], 16);
      }
    });
    ui.userList.appendChild(li);
  }

  li.querySelector(".brigada").textContent = `Brigada: ${brig}`;
  li.querySelector(".zona").textContent = `Zona: ${zona}`;
  li.querySelector(".contrata").textContent = `Contrata: ${contrata}`;
  li.querySelector(".status").textContent = statusCode || "N/D";
  li.querySelector(".time").textContent = formatTime(row.timestamp);
  li.querySelector(
    ".coords"
  ).textContent = `(${toFixedOrDash(row.latitud, 5)}, ${toFixedOrDash(
    row.longitud,
    5
  )})`;
  li.querySelector(".speed").textContent = `${toFixedOrDash(
    row.spd,
    1
  )} km/h`;

  li.dataset.status = statusCode || "";
  li.dataset.name = tech.toUpperCase();
  li.dataset.zona = zona;
  li.dataset.contrata = contrata;
}

// ======================= Polling de posiciones ========================

async function fetchLatestPositions(clearList = true) {
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
      console.error("Error al traer ubicaciones:", error);
      setStatus("Error al traer ubicaciones", "red");
      return;
    }

    state.brigadesLayer.clearLayers();
    state.lastPositionsByUser.clear();

    const latestByUid = new Map();
    for (const row of data) {
      const uid = buildUserKey(row);
      if (!latestByUid.has(uid)) {
        latestByUid.set(uid, row);
      }
    }

    for (const [uid, row] of latestByUid.entries()) {
      if (
        row.latitud == null ||
        row.longitud == null ||
        !isFinite(row.latitud) ||
        !isFinite(row.longitud)
      )
        continue;

      const lat = row.latitud;
      const lng = row.longitud;

      const marker = L.circleMarker([lat, lng], {
        radius: 6,
        weight: 2,
        fillOpacity: 0.8
      }).addTo(state.brigadesLayer);

      marker.bindPopup(
        `
        <b>${row.tecnico || "Sin nombre"}</b><br>
        Brigada: ${row.brigada || "-"}<br>
        Zona: ${row.zona || "-"}<br>
        Contrata: ${row.contrata || "-"}<br>
        Velocidad: ${toFixedOrDash(row.spd, 1)} km/h<br>
        Hora: ${formatDateTime(row.timestamp)}
      `
      );

      const statusCode = getRowStatus(row);
      addOrUpdateUserInList(row, statusCode);
      state.lastPositionsByUser.set(uid, { row, marker });
    }

    setStatus("Ubicaciones actualizadas", "green");
  } catch (e) {
    console.error("Error inesperado al traer ubicaciones:", e);
    setStatus("Error inesperado", "red");
  }
}

// ========================= Filtros de la lista =======================

function applyListFilters() {
  const nameFilter = ui.filterName.value.trim().toUpperCase();
  const zonaFilter = ui.filterZona.value || "";
  const contrataFilter = ui.filterContrata.value || "";
  const statusFilter = ui.filterStatus.value || "";

  const items = ui.userList.querySelectorAll(".user-item");
  for (const item of items) {
    const n = item.dataset.name || "";
    const z = item.dataset.zona || "";
    const c = item.dataset.contrata || "";
    const s = item.dataset.status || "";

    let visible = true;

    if (nameFilter && !n.includes(nameFilter)) visible = false;
    if (zonaFilter && z !== zonaFilter) visible = false;
    if (contrataFilter && c !== contrataFilter) visible = false;
    if (statusFilter && s !== statusFilter) visible = false;

    item.style.display = visible ? "" : "none";
  }
}

// =================== Modo en vivo (polling continuo) =================

function startLiveMode() {
  if (state.liveMode) return;
  state.liveMode = true;
  setStatus("Modo en vivo ON", "green");
  fetchLatestPositions(true);
  state.pollingInterval = setInterval(() => {
    fetchLatestPositions(false);
  }, 15000);
  ui.btnLive.textContent = "Detener vivo";
}

function stopLiveMode() {
  if (!state.liveMode) return;
  state.liveMode = false;
  setStatus("Modo en vivo OFF", "gray");
  if (state.pollingInterval) clearInterval(state.pollingInterval);
  state.pollingInterval = null;
  ui.btnLive.textContent = "Modo vivo";
}

function toggleLiveMode() {
  if (state.liveMode) stopLiveMode();
  else startLiveMode();
}

// =================== Incidencias / Bitácoras (Supabase) ==============

// Obtiene detalle de avería por código / identificador
async function fetchBitacoraByIdentifier(identifier) {
  try {
    const { data, error } = await supa
      .from("bitacoras")
      .select("*")
      .or(`incidencia_bd.eq.${identifier},inc_bd.eq.${identifier}`)
      .limit(1);

    if (error) {
      console.error("Error consultando bitácora:", error);
      alert("Error consultando bitácora: " + error.message);
      return null;
    }
    return data && data.length ? data[0] : null;
  } catch (e) {
    console.error("Excepción consultando bitácora:", e);
    alert("Ocurrió un error consultando la bitácora");
    return null;
  }
}

// Ventana de tiempo de la avería
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

// Brigadas asociadas a la avería
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

// ==================== GPS por brigada para la incidencia =============

// *** FUNCIÓN CORREGIDA ***
// Ahora:
//   - filtra por brigada usando ilike (may/min y parecidos)
//   - usa usuario_id en lugar del campo inexistente "usuario"
//   - filtra por zona de la bitácora y ventana de tiempo de la incidencia
async function fetchGpsForBitacora(b, brigadas, inicio, fin) {
  // Obtiene el recorrido GPS de la(s) brigada(s) asociada(s) a la avería
  // dentro de la ventana de tiempo definida por inicio/fin.
  // Se hace el filtro por brigada de forma flexible:
  //  - Ignora mayúsculas/minúsculas
  //  - Permite coincidencias parciales en el nombre de la brigada
  if (!brigadas.length || !inicio || !fin) return [];

  // Normalizar y limpiar nombres de brigada
  const cleanBrigadas = brigadas
    .map((br) => (br || "").toString().trim())
    .filter((br) => br.length > 0);

  if (!cleanBrigadas.length) return [];

  // Construir condiciones OR con ilike para PostgREST
  // Ejemplo: "brigada.ilike.%BRG 01%,brigada.ilike.%BRIGADA 01%"
  const orParts = cleanBrigadas.map((br) => {
    // Evitar comas que rompan la sintaxis del or()
    const safe = br.replace(/,/g, "");
    return `brigada.ilike.%${safe}%`;
  });

  let query = supa
    .from("ubicaciones_brigadas")
    .select(
      "latitud,longitud,timestamp,brigada,tecnico,usuario_id,contrata,zona,cargo"
    )
    .eq("zona", b.zona_bd)
    .gte("timestamp", inicio)
    .lte("timestamp", fin)
    .order("timestamp", { ascending: true });

  if (orParts.length) {
    query = query.or(orParts.join(","));
  }

  const { data, error } = await query;

  if (error) {
    console.error("Error trayendo GPS de brigadas:", error);
    alert("Error obteniendo recorrido de brigadas: " + error.message);
    return [];
  }
  return data || [];
}

// ================== Dibujo de la incidencia en el mapa ===============

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
          iconSize: [30, 50],
          iconAnchor: [15, 50]
        })
      }).addTo(state.incidentLayer);
    } else {
      state.incidentSiteMarker.setLatLng([lat, lng]);
      state.incidentSiteMarker.addTo(state.incidentLayer);
    }
  }

  // polilínea del recorrido GPS de la brigada
  if (gpsRows && gpsRows.length > 0) {
    const coords = gpsRows
      .filter(
        (r) =>
          r.latitud != null &&
          r.longitud != null &&
          isFinite(r.latitud) &&
          isFinite(r.longitud)
      )
      .map((r) => [r.latitud, r.longitud]);

    if (coords.length > 1) {
      if (state.incidentGpsPolyline) {
        state.incidentLayer.removeLayer(state.incidentGpsPolyline);
      }
      state.incidentGpsPolyline = L.polyline(coords, {
        weight: 4,
        opacity: 0.9
      }).addTo(state.incidentLayer);

      state.map.fitBounds(state.incidentLayer.getBounds(), {
        padding: [40, 40]
      });
    }
  }
}

// Resumen de incidencia + tiempos/ruta (simple)
function showIncidentSummary(b, brigadas, gpsRows, inicio, fin) {
  if (!ui.incidentSummary) return;
  const totalPoints = (gpsRows || []).length;

  let first = null;
  let last = null;
  if (totalPoints > 0) {
    first = gpsRows[0].timestamp;
    last = gpsRows[gpsRows.length - 1].timestamp;
  }

  const durMs =
    first && last ? new Date(last).getTime() - new Date(first).getTime() : null;

  const brigText = brigadas && brigadas.length ? brigadas.join(", ") : "-";

  ui.incidentSummary.innerHTML = `
    <h3>Resumen de la avería</h3>
    <p><b>Incidencia:</b> ${b.incidencia_bd || b.inc_bd || "-"} </p>
    <p><b>Zona:</b> ${b.zona_bd || "-"} | <b>Enlace:</b> ${b.enlace_bd ||
    "-"} </p>
    <p><b>Brigadas asociadas:</b> ${brigText}</p>
    <p><b>Inicio ventana:</b> ${formatDateTime(inicio)}</p>
    <p><b>Fin ventana:</b> ${formatDateTime(fin)}</p>
    <p><b>Puntos GPS:</b> ${totalPoints}</p>
    <p><b>Duración del tramo GPS (primera a última muestra):</b> ${
      durMs ? formatDuration(durMs) : "-"
    }</p>
  `;
}

// ======================= Búsqueda de incidencia =======================

async function handleIncidentSearch(identifier) {
  if (!identifier) {
    alert("Ingresa un identificador de incidencia (INC/Código).");
    return;
  }
  try {
    setStatus("Buscando avería…", "gray");
    ui.incidentSummary.innerHTML = "";
    state.incidentLayer.clearLayers();

    const bit = await fetchBitacoraByIdentifier(identifier);
    if (!bit) {
      setStatus("No se encontró la avería", "red");
      alert("No se encontró una avería con ese identificador.");
      return;
    }

    const { inicio, fin } = getBitacoraTimeWindow(bit);
    const brigadas = getBitacoraBrigadas(bit);

    const gpsRows = await fetchGpsForBitacora(bit, brigadas, inicio, fin);

    drawIncidentOnMap(bit, gpsRows);
    showIncidentSummary(bit, brigadas, gpsRows, inicio, fin);

    setStatus("Avería cargada correctamente", "green");
  } catch (e) {
    console.error("Error en handleIncidentSearch:", e);
    setStatus("Error al cargar avería", "red");
    alert("Ocurrió un error al cargar la avería");
  }
}

// ========================= KMZ (recorrido externo) ===================

function parseKmlCoordinates(coordStr) {
  if (!coordStr) return [];
  return coordStr
    .trim()
    .split(/\s+/)
    .map((c) => c.trim().split(",").map(Number))
    .filter((arr) => arr.length >= 2 && isFinite(arr[0]) && isFinite(arr[1]));
}

function readKmz(file) {
  return new Promise((resolve, reject) => {
    const reader = new JSZip();
    reader
      .loadAsync(file)
      .then((zip) => {
        const kmlFile = Object.keys(zip.files).find((name) =>
          name.toLowerCase().endsWith(".kml")
        );
        if (!kmlFile) throw new Error("No se encontró un archivo KML en el KMZ");

        return zip.files[kmlFile].async("string");
      })
      .then((kmlText) => {
        const parser = new DOMParser();
        const xml = parser.parseFromString(kmlText, "text/xml");
        const coordsNodes = xml.getElementsByTagName("coordinates");
        if (!coordsNodes.length)
          throw new Error("No se encontraron coordenadas en el KML");

        // Tomamos todas las coordenadas concatenadas
        let coords = [];
        for (let i = 0; i < coordsNodes.length; i++) {
          const segment = parseKmlCoordinates(coordsNodes[i].textContent);
          coords = coords.concat(segment);
        }
        resolve(coords);
      })
      .catch((err) => {
        reject(err);
      });
  });
}

const GAP_MINUTES = 8;
const GAP_JUMP_METERS = 800;

const BRIDGE_MAX_JUMP_METERS = 300;

// Calcular distancia 2D simple (metros) entre puntos consecutivos
function dist2D(a, b) {
  return distanceMeters(a.lat, a.lng, b.lat, b.lng);
}

function sampleRoute(coords, minDistanceMeters = 30) {
  if (!coords || coords.length < 2) return coords || [];
  const sampled = [coords[0]];
  let last = coords[0];
  for (let i = 1; i < coords.length; i++) {
    const current = coords[i];
    const d = distanceMeters(
      last[1], // lat
      last[0], // lng
      current[1],
      current[0]
    );
    if (d >= minDistanceMeters) {
      sampled.push(current);
      last = current;
    }
  }
  return sampled;
}

async function buildKmzPolylineFromCoords(coords) {
  if (!state.map || !coords || !coords.length) return null;

  const sampled = sampleRoute(coords, 40);

  const serviceUrl = "https://api.mapbox.com/directions/v5/mapbox/driving";

  async function routeBetweenPoints(a, b) {
    const url =
      serviceUrl +
      "/" +
      a[0] +
      "," +
      a[1] +
      ";" +
      b[0] +
      "," +
      b[1] +
      "?geometries=geojson&access_token=" +
      CONFIG.MAPBOX_TOKEN;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = await res.json();
      const coords =
        json.routes?.[0]?.geometry?.coordinates || [];
      if (!coords.length) return null;
      return coords.map((c) => ({ lng: c[0], lat: c[1] }));
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
    }
  }
  if (!finalRoute.length) return null;

  return finalRoute;
}

async function handleKmzFile(file) {
  try {
    setStatus("Cargando KMZ…", "gray");
    const coords = await readKmz(file);
    if (!coords || !coords.length) {
      alert("No se pudieron leer coordenadas del KMZ");
      return;
    }

    const routePoints = await buildKmzPolylineFromCoords(coords);
    if (!routePoints || !routePoints.length) {
      alert("No se pudo construir la ruta del KMZ");
      return;
    }

    if (state.kmzPolyline) {
      state.incidentLayer.removeLayer(state.kmzPolyline);
    }

    state.kmzPolyline = L.polyline(
      routePoints.map((p) => [p.lat, p.lng]),
      { weight: 3, opacity: 0.8 }
    ).addTo(state.incidentLayer);

    state.map.fitBounds(state.incidentLayer.getBounds(), {
      padding: [40, 40]
    });

    setStatus("KMZ cargado correctamente", "green");
  } catch (e) {
    console.error("Error al manejar KMZ:", e);
    setStatus("Error al cargar KMZ", "red");
    alert("Ocurrió un error al cargar el archivo KMZ");
  }
}

function clearKmz() {
  if (state.kmzPolyline) {
    state.incidentLayer.removeLayer(state.kmzPolyline);
    state.kmzPolyline = null;
  }
  setStatus("KMZ limpiado", "gray");
}

// =========================== Eventos de UI ===========================

function setupEventListeners() {
  if (ui.btnRefresh) {
    ui.btnRefresh.addEventListener("click", () => fetchLatestPositions(true));
  }
  if (ui.btnLive) {
    ui.btnLive.addEventListener("click", toggleLiveMode);
  }
  if (ui.filterName) {
    ui.filterName.addEventListener("input", applyListFilters);
  }
  if (ui.filterZona) {
    ui.filterZona.addEventListener("change", applyListFilters);
  }
  if (ui.filterContrata) {
    ui.filterContrata.addEventListener("change", applyListFilters);
  }
  if (ui.filterStatus) {
    ui.filterStatus.addEventListener("change", applyListFilters);
  }

  if (ui.btnSearchIncident && ui.inputIncident) {
    ui.btnSearchIncident.addEventListener("click", () => {
      const val = ui.inputIncident.value.trim();
      handleIncidentSearch(val);
    });

    ui.inputIncident.addEventListener("keyup", (ev) => {
      if (ev.key === "Enter") {
        const val = ui.inputIncident.value.trim();
        handleIncidentSearch(val);
      }
    });
  }

  if (ui.kmzFileInput) {
    ui.kmzFileInput.addEventListener("change", (ev) => {
      const file = ev.target.files[0];
      if (file) handleKmzFile(file);
    });
  }
  if (ui.btnClearKmz) {
    ui.btnClearKmz.addEventListener("click", clearKmz);
  }
}

// ============================ Inicio =================================

function injectIncidentControls() {
  // Aquí asumo que ya tienes el HTML adecuado (inputs/botones)
  // y solo estamos activando la lógica desde JS.
  // Si requieres que genere elementos dinámicamente, se puede ampliar.
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  setupEventListeners();
  fetchLatestPositions(true);
});

// ====================== Helpers globales de prueba ===================

// Helper público por consola, por si quieres probar:
//   mostrarRecorridoAveria("123456");
async function mostrarRecorridoAveria(identificador) {
  await handleIncidentSearch(String(identificador || "").trim());
}
window.mostrarRecorridoAveria = mostrarRecorridoAveria;
