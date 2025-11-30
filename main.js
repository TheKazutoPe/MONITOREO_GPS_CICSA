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
  btnToggleCluster: document.getElementById("btnToggleCluster"),

  // Site search + rutas
  siteSearch: document.getElementById("siteSearch"),
  siteSuggestions: document.getElementById("siteSuggestions"),
  btnBuscarSite: document.getElementById("btnBuscarSite"),
  routesPanel: document.getElementById("routesPanel")
};

// ====== State ======
const state = {
  map: null,
  baseLayers: {},
  currentBase: null,
  clusterGroup: null,
  markersLayer: null,
  routeLayer: null,
  users: new Map(),
  siteMarker: null,
  autoCluster: true
};

// ====== Map init ======
function initMap() {
  const map = L.map("map", {
    center: [-12.0464, -77.0428],
    zoom: 6,
    worldCopyJump: true
  });

  const streets = L.tileLayer(
    "https://api.mapbox.com/styles/v1/mapbox/streets-v11/tiles/{z}/{x}/{y}?access_token=" +
      MAPBOX_TOKEN,
    {
      tileSize: 512,
      zoomOffset: -1
    }
  );

  const dark = L.tileLayer(
    "https://api.mapbox.com/styles/v1/mapbox/dark-v10/tiles/{z}/{x}/{y}?access_token=" +
      MAPBOX_TOKEN,
    {
      tileSize: 512,
      zoomOffset: -1
    }
  );

  const satellite = L.tileLayer(
    "https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=" +
      MAPBOX_TOKEN,
    {
      tileSize: 512,
      zoomOffset: -1
    }
  );

  const osm = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {}
  );

  const baseLayers = {
    streets,
    dark,
    satellite,
    osm
  };

  streets.addTo(map);

  const clusterGroup = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 60
  });

  const markersLayer = L.layerGroup().addTo(clusterGroup);
  const routeLayer = L.layerGroup().addTo(map);

  clusterGroup.addTo(map);

  state.map = map;
  state.baseLayers = baseLayers;
  state.currentBase = "streets";
  state.clusterGroup = clusterGroup;
  state.markersLayer = markersLayer;
  state.routeLayer = routeLayer;

  setupMapControls();
}

function setupMapControls() {
  if (!state.map) return;

  ui.btnCenter?.addEventListener("click", () => {
    state.map.setView([-12.0464, -77.0428], 6);
  });

  ui.btnShowAll?.addEventListener("click", () => {
    const bounds = state.markersLayer.getBounds();
    if (bounds.isValid()) {
      state.map.fitBounds(bounds, { padding: [40, 40] });
    }
  });

  ui.mapStyleSelect?.addEventListener("change", e => {
    const style = e.target.value;
    changeBaseLayer(style);
  });

  ui.btnToggleCluster?.addEventListener("click", () => {
    state.autoCluster = !state.autoCluster;
    ui.btnToggleCluster.textContent = state.autoCluster
      ? "🌐 Vista global (ON)"
      : "📍 Vista global (OFF)";
    refreshMarkers();
  });
}

function changeBaseLayer(name) {
  if (!state.map || !state.baseLayers[name]) return;

  const map = state.map;
  const current = state.baseLayers[state.currentBase];
  if (current) {
    map.removeLayer(current);
  }
  state.baseLayers[name].addTo(map);
  state.currentBase = name;
}

// ====== Helpers ======
function setStatus(msg, color = "gray") {
  if (!ui.status) return;
  ui.status.textContent = msg;
  ui.status.style.color = color;
}

function timeDiffMinutes(dateStr) {
  if (!dateStr) return Infinity;
  const ts = new Date(dateStr).getTime();
  if (!isFinite(ts)) return Infinity;
  const now = Date.now();
  const diffMs = now - ts;
  return diffMs / 60000;
}

function getStatusFromDiff(mins) {
  if (mins <= 2) return "online";
  if (mins <= 5) return "mid";
  return "off";
}

function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (!isFinite(d.getTime())) return ts;
  return d.toLocaleString("es-PE", {
    hour12: false
  });
}

function distMeters(a, b) {
  const R = 6371000;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const s1 =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
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

// ========= ICONOS =========
const IconGreen = L.divIcon({
  className: "marker marker-green",
  iconSize: [18, 18],
  iconAnchor: [9, 9]
});
const IconYellow = L.divIcon({
  className: "marker marker-yellow",
  iconSize: [18, 18],
  iconAnchor: [9, 9]
});
const IconRed = L.divIcon({
  className: "marker marker-red",
  iconSize: [18, 18],
  iconAnchor: [9, 9]
});

// ====== Render de usuario (list + markers) ======
function renderUserItem(u) {
  const li = document.createElement("li");
  li.className = `user-item status-${u.status || "off"}`;
  li.id = `u-${u.usuario_id}`;

  const t = u.tecnico || u.usuario || "Sin nombre";
  const brig = u.brigada || "-";
  const zona = u.zona || "-";
  const contrata = u.contrata || "-";
  const diffMin = timeDiffMinutes(u.timestamp_pe || u.timestamp);
  const last = formatTimestamp(u.timestamp_pe || u.timestamp);

  let statusLabel = "Desconocido";
  if (u.status === "online") statusLabel = "Conectado (≤2 min)";
  else if (u.status === "mid") statusLabel = "Medio (≤5 min)";
  else if (u.status === "off") statusLabel = "Inactivo (>5 min)";

  li.innerHTML = `
    <div class="user-main">
      <span class="user-name">${t}</span>
      <span class="user-brigada">${brig}</span>
    </div>
    <div class="user-sub">
      <span>Zona: ${zona}</span>
      <span>Contrata: ${contrata}</span>
    </div>
    <div class="user-sub">
      <span>${statusLabel}</span>
      <span>Último: ${last}</span>
    </div>
  `;

  li.onclick = () => {
    if (u.marker && state.map) {
      state.map.setView(u.marker.getLatLng(), 15);
      if (u.marker.getPopup()) u.marker.openPopup();
    }
  };

  return li;
}

function renderUserMarker(u) {
  if (!state.map) return null;
  const lat = +u.latitud;
  const lng = +u.longitud;
  if (!isFinite(lat) || !isFinite(lng)) return null;

  const diff = timeDiffMinutes(u.timestamp_pe || u.timestamp);
  const status = getStatusFromDiff(diff);

  let icon = IconRed;
  if (status === "online") icon = IconGreen;
  else if (status === "mid") icon = IconYellow;

  const marker = L.marker([lat, lng], { icon });

  const t = u.tecnico || u.usuario || "Sin nombre";
  const brig = u.brigada || "-";
  const zona = u.zona || "-";
  const contrata = u.contrata || "-";
  const ts = formatTimestamp(u.timestamp_pe || u.timestamp);
  const acc = u.acc ?? "N/A";
  const spd = u.spd ?? "N/A";

  const htmlPopup = `<div class="popup">
    <b>${t}</b><br />
    Brigada: ${brig}<br />
    Zona: ${zona}<br />
    Contrata: ${contrata}<br />
    Acc: ${acc} m · Vel: ${spd} m/s<br />
    ${ts}
  </div>`;

  marker.bindPopup(htmlPopup);
  return { marker, status };
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

  ui.filterZona.innerHTML = `<option value="">Zona: todas</option>`;
  Array.from(zonas)
    .sort()
    .forEach(z => {
      const opt = document.createElement("option");
      opt.value = z;
      opt.textContent = z;
      ui.filterZona.appendChild(opt);
    });

  ui.filterContrata.innerHTML = `<option value="">Contrata: todas</option>`;
  Array.from(contratas)
    .sort()
    .forEach(c => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      ui.filterContrata.appendChild(opt);
    });
}

// ====== Filtros en lista ======
function applyListFilters() {
  const nameFilter = (ui.filterName.value || "").toLowerCase();
  const brigFilter = (ui.brigada.value || "").toLowerCase();
  const statusFilter = ui.filterStatus.value;
  const zonaFilter = ui.filterZona.value;
  const contrataFilter = ui.filterContrata.value;

  document
    .querySelectorAll(".user-item")
    .forEach(li => li.classList.remove("hidden"));

  document.querySelectorAll(".user-item").forEach(li => {
    const uid = li.id.replace("u-", "");
    const user = state.users.get(uid);
    if (!user || !user.lastRow) return;

    const u = user.lastRow;
    const tecn = (u.tecnico || u.usuario || "").toLowerCase();
    const brig = (u.brigada || "").toLowerCase();
    const status = u.status || "off";
    const zona = u.zona || "";
    const contrata = u.contrata || "";

    if (nameFilter && !tecn.includes(nameFilter)) {
      li.classList.add("hidden");
      return;
    }
    if (brigFilter && !brig.includes(brigFilter)) {
      li.classList.add("hidden");
      return;
    }
    if (statusFilter && status !== statusFilter) {
      li.classList.add("hidden");
      return;
    }
    if (zonaFilter && zona !== zonaFilter) {
      li.classList.add("hidden");
      return;
    }
    if (contrataFilter && contrata !== contrataFilter) {
      li.classList.add("hidden");
      return;
    }
  });
}

// ====== Fetch inicial ======
async function fetchInitial(showStatus = true) {
  try {
    if (showStatus) setStatus("Cargando datos iniciales...", "gray");

    if (!state.map) initMap();

    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select(
        "id, usuario_id, tecnico, brigada, zona, contrata, latitud, longitud, timestamp, timestamp_pe, acc, spd"
      )
      .gt("timestamp_pe", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order("timestamp_pe", { ascending: false });

    if (error) throw new Error(error.message);

    const usersMap = new Map();
    (data || []).forEach(row => {
      const uid = row.usuario_id || row.tecnico || row.id;
      if (!uid) return;
      if (!usersMap.has(uid)) {
        usersMap.set(uid, {
          lastRow: row
        });
      } else {
        const current = usersMap.get(uid).lastRow;
        const tCurrent = new Date(current.timestamp_pe || current.timestamp).getTime();
        const tNew = new Date(row.timestamp_pe || row.timestamp).getTime();
        if (tNew > tCurrent) {
          usersMap.get(uid).lastRow = row;
        }
      }
    });

    state.users = usersMap;

    refreshMarkers();
    renderUsersList();
    populateFilterOptionsFromData(
      Array.from(usersMap.values()).map(u => u.lastRow)
    );

    ui.apply?.addEventListener("click", applyListFilters);

    if (showStatus) setStatus("Conectado", "green");
  } catch (e) {
    console.error(e);
    setStatus("Error al cargar", "red");
  }
}

function refreshMarkers() {
  if (!state.map) return;

  state.markersLayer.clearLayers();

  const allMarkers = [];

  for (const [uid, data] of state.users.entries()) {
    const u = data.lastRow;
    const r = renderUserMarker(u);
    if (!r) continue;
    const { marker, status } = r;

    data.status = status;
    data.marker = marker;

    allMarkers.push(marker);
  }

  if (state.autoCluster) {
    allMarkers.forEach(m => state.markersLayer.addLayer(m));
    if (!state.map.hasLayer(state.clusterGroup)) {
      state.map.addLayer(state.clusterGroup);
    }
  } else {
    allMarkers.forEach(m => m.addTo(state.map));
    if (state.map.hasLayer(state.clusterGroup)) {
      state.map.removeLayer(state.clusterGroup);
    }
  }
}

function renderUsersList() {
  if (!ui.userList) return;
  ui.userList.innerHTML = "";

  const arr = Array.from(state.users.values()).map(u => u.lastRow);

  arr.sort((a, b) => {
    const t1 = new Date(a.timestamp_pe || a.timestamp).getTime();
    const t2 = new Date(b.timestamp_pe || b.timestamp).getTime();
    return t2 - t1;
  });

  arr.forEach(row => {
    const uid = row.usuario_id || row.tecnico || row.id;
    const diff = timeDiffMinutes(row.timestamp_pe || row.timestamp);
    const status = getStatusFromDiff(diff);
    row.status = status;

    const el = renderUserItem(row);
    ui.userList.appendChild(el);
  });

  applyListFilters();
}

// ====== Autocomplete Sites (Supabase con nueva tabla) ======
async function searchSites(query) {
  query = (query || "").trim();
  if (query.length < 2) return [];

  console.log("Buscando sites para:", query);

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

  console.log("Sites encontrados:", data?.length || 0);
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
    div.textContent = `${site.id || ""} - ${site.name}`;
    div.onclick = () => {
      ui.siteSearch.value = site.name;
      ui.siteSuggestions.style.display = "none";
      handleBuscarSite(site);
    };
    box.appendChild(div);
  });

  box.style.display = "block";
}

let siteTypingTimer = null;
if (ui.siteSearch) {
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

// Cerrar sugerencias al hacer click fuera
document.addEventListener("click", e => {
  if (
    !ui.siteSearch.contains(e.target) &&
    !ui.siteSuggestions.contains(e.target)
  ) {
    ui.siteSuggestions.style.display = "none";
  }
});

// ====== Rutas brigadas más cercanas a Site ======
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

async function calcularRutasBrigadasCercanas(site) {
  if (!state.map || !MAPBOX_TOKEN) {
    alert("Falta mapa o MAPBOX_TOKEN para calcular rutas.");
    return;
  }

  state.routeLayer.clearLayers();
  ui.routesPanel.innerHTML = "";

  const brigadas = [];
  for (const [, u] of state.users.entries()) {
    if (!u.lastRow) continue;
    const lat = u.lastRow.latitud;
    const lng = u.lastRow.longitud;
    if (!isFinite(lat) || !isFinite(lng)) continue;

    const d = distMeters(
      { lat, lng },
      { lat: site.lat, lng: site.lng }
    );
    brigadas.push({
      row: u.lastRow,
      lat,
      lng,
      dist: d
    });
  }

  if (!brigadas.length) {
    alert("No hay brigadas con ubicación válida para calcular rutas.");
    return;
  }

  brigadas.sort((a, b) => a.dist - b.dist);
  const candidatos = brigadas.slice(0, 5);

  const resultados = [];

  for (const b of candidatos) {
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

      resultados.push({
        brigada: b.row.brigada || "-",
        tecnico: b.row.tecnico || "Sin nombre",
        zona: b.row.zona || "-",
        contrata: b.row.contrata || "-",
        distance: meters,
        duration: minutes,
        geometry: route.geometry
      });

      const coords = route.geometry.coordinates.map(([lng, lat]) => [
        lat,
        lng
      ]);

      L.polyline(coords, {
        color: "#ffcc00",
        weight: 4,
        opacity: 0.9
      }).addTo(state.routeLayer);

      await sleep(150);
    } catch (e) {
      console.error("Error en directions Mapbox:", e);
    }
  }

  if (!resultados.length) {
    ui.routesPanel.innerHTML =
      "<div style='font-size:12px;color:#bbb;'>No se pudo obtener rutas desde Mapbox.</div>";
    return;
  }

  resultados.sort((a, b) => a.duration - b.duration);

  const titulo = document.createElement("h3");
  titulo.textContent = `Rutas hacia: ${site.name}`;
  ui.routesPanel.appendChild(titulo);

  resultados.forEach(r => {
    const item = document.createElement("div");
    item.className = "route-item";
    item.innerHTML = `
      <div>
        <span class="route-item-main">${r.brigada} – ${r.tecnico}</span>
        <span class="route-item-sub">Zona: ${r.zona} · Contrata: ${r.contrata}</span>
      </div>
      <div style="text-align:right;">
        <span class="route-item-main">${formatMinutes(r.duration)}</span>
        <span class="route-item-sub">${formatKm(r.distance)}</span>
      </div>
    `;
    ui.routesPanel.appendChild(item);
  });

  const bounds = state.routeLayer.getBounds();
  if (bounds.isValid()) {
    state.map.fitBounds(bounds, { padding: [50, 50] });
  } else {
    state.map.setView([site.lat, site.lng], 13);
  }
}

// ====== Handler principal: buscar site ======
async function handleBuscarSite(siteFromAutocomplete = null) {
  let site = siteFromAutocomplete;

  if (!site) {
    const name = ui.siteSearch?.value || "";
    if (!name.trim()) {
      alert("Ingresa el nombre del Site.");
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
      `<b>${site.name}</b><br>${site.departamento} / ${site.provincia} / ${site.distrito}<br>Lat: ${site.lat.toFixed(
        5
      )}<br>Lng: ${site.lng.toFixed(5)}`
    )
    .openPopup();

  await calcularRutasBrigadasCercanas(site);
  setStatus("Conectado", "green");
  ui.siteSuggestions.style.display = "none";
}

// ====== Exportar KMZ (trazado limpio) ======
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
      alert("Selecciona o escribe una brigada para exportar su ruta.");
      return;
    }

    const today = new Date();
    const ymd = toYMD(today);
    const ymdNext = toYMD(new Date(today.getTime() + 24 * 60 * 60 * 1000));

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

    let kml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
      `<name>Ruta_${brig}_${ymd}</name><Placemark><name>${brig}</name>` +
      `<Style><LineStyle><color>ff0000ff</color><width>3</width></LineStyle></Style>` +
      `<LineString><coordinates>`;

    all.forEach(p => {
      kml += `${p.lng},${p.lat},0 `;
    });

    kml += `</coordinates></LineString></Placemark></Document></kml>`;

    const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `Ruta_${brig}_${ymd}.kml`;
    a.click();

    URL.revokeObjectURL(url);
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
initMap();
fetchInitial(true);
setInterval(() => fetchInitial(false), 30000);

if (ui.btnBuscarSite) {
  ui.btnBuscarSite.addEventListener("click", () => handleBuscarSite());
}
if (ui.exportKmz) {
  ui.exportKmz.addEventListener("click", exportKMZFromState);
}
