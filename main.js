// ============================== main.js ==============================
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("filterBrigada"),
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

  siteSearch: document.getElementById("siteSearch"),
  btnBuscarSite: document.getElementById("btnBuscarSite"),
  btnClearSearch: document.getElementById("btnClearSearch"),
  siteSuggestions: document.getElementById("siteSuggestions"),
  routesPanel: document.getElementById("routesPanel")
};

const state = {
  map: null,
  baseLayers: {},
  currentBase: "streets",
  cluster: null,
  plainLayer: null,
  mode: "plain",
  users: new Map(),
  routeLayer: null,
  siteMarker: null
};

const CAR_ICONS = {
  green: L.icon({ iconUrl: "assets/carro-green.png", iconSize: [40, 24], iconAnchor: [20, 12] }),
  yellow: L.icon({ iconUrl: "assets/carro-orange.png", iconSize: [40, 24], iconAnchor: [20, 12] }),
  gray: L.icon({ iconUrl: "assets/carro-gray.png", iconSize: [40, 24], iconAnchor: [20, 12] })
};

const DOT_ICONS = {
  green: L.divIcon({ className: "marker-dot marker-dot-green", iconSize: [18, 18], iconAnchor: [9, 9] }),
  yellow: L.divIcon({ className: "marker-dot marker-dot-yellow", iconSize: [18, 18], iconAnchor: [9, 9] }),
  gray: L.divIcon({ className: "marker-dot marker-dot-gray", iconSize: [18, 18], iconAnchor: [9, 9] })
};

function getStatusColor(row) {
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  if (mins <= 2) return "green";
  if (mins <= 5) return "yellow";
  return "gray";
}

function getIconFor(row) {
  const color = getStatusColor(row);
  const zoom = state.map ? state.map.getZoom() : 10;
  return zoom >= 11 ? CAR_ICONS[color] : DOT_ICONS[color];
}

function distMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s1), Math.sqrt(1 - s1));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function animateMarker(marker, fromLatLng, toLatLng, duration = 900) {
  if (!fromLatLng || !toLatLng) { marker.setLatLng(toLatLng); return; }
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

function createMapboxLayer(styleId) {
  return L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/${styleId}/tiles/256/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`, { maxZoom: 20, tileSize: 256, attribution: '© OpenStreetMap © Mapbox' });
}

function initMap() {
  state.baseLayers.streets = createMapboxLayer("streets-v12");
  state.baseLayers.dark = createMapboxLayer("dark-v11");
  state.baseLayers.satellite = createMapboxLayer("satellite-streets-v12");
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20 });

  state.map = L.map("map", {
    center: [-12.0464, -77.0428], zoom: 6, layers: [state.baseLayers.streets], zoomControl: false 
  });
  L.control.zoom({ position: 'bottomleft' }).addTo(state.map); 
  
  state.cluster = L.markerClusterGroup({ disableClusteringAtZoom: 16 });
  state.plainLayer = L.layerGroup();
  state.routeLayer = L.layerGroup().addTo(state.map);

  state.map.addLayer(state.plainLayer);
  if (ui.btnToggleCluster) ui.btnToggleCluster.innerHTML = "🌐";

  state.map.on("zoomend", () => {
    for (const [, u] of state.users.entries()) {
      if (!u.lastRow) continue;
      u.marker.setIcon(getIconFor(u.lastRow));
    }
  });

  if (ui.exportKmz) ui.exportKmz.onclick = () => exportKMZFromState();
  if (ui.btnCenter) ui.btnCenter.onclick = () => state.map.setView([-12.0464, -77.0428], 10, { animate: true });
  if (ui.btnShowAll) {
    ui.btnShowAll.onclick = () => {
      const group = state.mode === "cluster" ? state.cluster : state.plainLayer;
      const layers = group.getLayers();
      if (!layers.length) return;
      state.map.fitBounds(group.getBounds(), { padding: [40, 40] });
    };
  }

  if (ui.mapStyleSelect) {
    ui.mapStyleSelect.onchange = () => {
      const chosen = ui.mapStyleSelect.value;
      if (chosen === state.currentBase) return;
      if (state.baseLayers[state.currentBase]) state.map.removeLayer(state.baseLayers[state.currentBase]);
      if (state.baseLayers[chosen]) state.map.addLayer(state.baseLayers[chosen]);
      state.currentBase = chosen;
    };
  }

  if (ui.btnRefresh) ui.btnRefresh.onclick = () => fetchInitial(false);
  if (ui.btnToggleCluster) ui.btnToggleCluster.onclick = () => {
    if (state.mode === "cluster") {
      state.mode = "plain"; state.map.removeLayer(state.cluster); state.map.addLayer(state.plainLayer);
    } else {
      state.mode = "cluster"; state.map.removeLayer(state.plainLayer); state.map.addLayer(state.cluster);
    }
    refreshMarkerContainers();
  };

  [ui.filterName, ui.brigada].forEach(el => el?.addEventListener("input", applyLocalFilters));
  [ui.filterZona, ui.filterContrata, ui.filterStatus].forEach(el => el?.addEventListener("change", applyLocalFilters));
}
initMap();

function addMarkerToActiveLayer(marker) {
  if (state.mode === "cluster") state.cluster.addLayer(marker);
  else state.plainLayer.addLayer(marker);
}

function refreshMarkerContainers() {
  state.cluster.clearLayers();
  state.plainLayer.clearLayers();
  applyLocalFilters();
}

function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}

function focusOnUser(uid) {
  const u = state.users.get(uid);
  if (!u || !u.marker) return;
  state.map.setView(u.marker.getLatLng(), 17, { animate: true });
  u.marker.openPopup();
}

function buildPopup(r) {
  const acc = Math.round(r.acc || 0);
  const spd = (r.spd || 0).toFixed(1);
  const ts = new Date(r.timestamp).toLocaleString();
  return `<div><b style="font-size:14px; color:#fff;">${r.tecnico || "Sin nombre"}</b><br><span style="color:#a1a1aa;">Brigada: ${r.brigada || "-"}</span><br><span style="color:#a1a1aa;">Zona: ${r.zona || "-"} · Contrata: ${r.contrata || "-"}</span><br><br><span style="color:#71717a;">Acc: ${acc} m · Vel: ${spd} m/s<br>${ts}</span></div>`;
}

function populateFilterOptionsFromData(rows) {
  if (!ui.filterZona || !ui.filterContrata) return;
  const zonas = new Set(), contratas = new Set();
  rows.forEach(r => { if (r.zona) zonas.add(r.zona.trim()); if (r.contrata) contratas.add(r.contrata.trim()); });

  const currentZona = ui.filterZona.value || "";
  ui.filterZona.innerHTML = '<option value="">Zona: Todas</option>';
  Array.from(zonas).sort().forEach(z => {
    const opt = document.createElement("option"); opt.value = z; opt.textContent = z;
    ui.filterZona.appendChild(opt);
  });
  if (currentZona) ui.filterZona.value = currentZona;

  const currentContrata = ui.filterContrata.value || "";
  ui.filterContrata.innerHTML = '<option value="">Contrata: Todas</option>';
  Array.from(contratas).sort().forEach(c => {
    const opt = document.createElement("option"); opt.value = c; opt.textContent = c;
    ui.filterContrata.appendChild(opt);
  });
  if (currentContrata) ui.filterContrata.value = currentContrata;
}

function addOrUpdateUserInList(row, statusCode) {
  const uid = String(row.usuario_id || "0");
  const brig = row.brigada || "-", tech = row.tecnico || "Sin nombre", zona = row.zona || "-", contrata = row.contrata || "-", cargo = row.cargo || "-";
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  const hora = new Date(row.timestamp).toLocaleTimeString();

  let el = document.getElementById(`u-${uid}`);
  const html = `
    <div class="brig-main">
      <div class="brig-name">${tech}</div>
      <div class="brig-sub">Brigada: ${brig}</div>
      <div class="brig-extra">Zona: ${zona} · Contrata: ${contrata}<br>Cargo: ${cargo}</div>
    </div>
    <div class="brig-meta">
      <div class="brig-led ${statusCode}"></div>
      <div>${hora}</div>
      <div>${mins} min</div>
    </div>
  `;

  if (!el) {
    el = document.createElement("div"); el.id = `u-${uid}`; el.className = "brigada-item"; el.innerHTML = html;
    ui.userList.appendChild(el);
  } else {
    el.className = "brigada-item marker-pulse"; el.innerHTML = html;
    setTimeout(() => el.classList.remove("marker-pulse"), 600);
  }

  el.dataset.tech = tech.toLowerCase(); el.dataset.brigada = brig.toLowerCase(); el.dataset.status = statusCode; el.dataset.zona = zona.toLowerCase(); el.dataset.contrata = contrata.toLowerCase();
  el.onclick = () => { focusOnUser(uid); if (ui.brigada) ui.brigada.value = brig; applyLocalFilters(); };
}

function applyLocalFilters() {
  const name = (ui.filterName?.value || "").trim().toLowerCase(), brigadaText = (ui.brigada?.value || "").trim().toLowerCase(), status = ui.filterStatus?.value || "", zona = (ui.filterZona?.value || "").trim().toLowerCase(), contrata = (ui.filterContrata?.value || "").trim().toLowerCase();
  const cards = ui.userList.querySelectorAll(".brigada-item");
  cards.forEach(card => {
    const match = (!name || card.dataset.tech.includes(name)) && (!brigadaText || card.dataset.brigada.includes(brigadaText)) && (!status || card.dataset.status === status) && (!zona || card.dataset.zona === zona) && (!contrata || card.dataset.contrata === contrata);
    card.style.display = match ? "flex" : "none";
  });

  state.cluster.clearLayers(); state.plainLayer.clearLayers();
  for (const [uid, u] of state.users.entries()) {
    const r = u.lastRow, mins = Math.round((Date.now() - new Date(r.timestamp)) / 60000), s = mins <= 2 ? "online" : mins <= 5 ? "mid" : "off";
    const match = (!name || (r.tecnico || "").toLowerCase().includes(name)) && (!brigadaText || (r.brigada || "").toLowerCase().includes(brigadaText)) && (!status || s === status) && (!zona || (r.zona || "").toLowerCase().trim() === zona) && (!contrata || (r.contrata || "").toLowerCase().trim() === contrata);
    if (match) addMarkerToActiveLayer(u.marker);
  }
}

async function fetchInitial(clearList) {
  try {
    setStatus("Cargando…", "gray");
    if (clearList) ui.userList.innerHTML = "";
    const { data, error } = await supa.from("ubicaciones_brigadas").select("*").gte("timestamp", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).order("timestamp", { ascending: false });
    if (error) { console.error(error); setStatus("Error BD", "gray"); return; }

    populateFilterOptionsFromData(data || []);
    const grouped = new Map();
    for (const r of data) {
      const uid = String(r.usuario_id || "0");
      if (!grouped.has(uid)) grouped.set(uid, []);
      if (grouped.get(uid).length >= 1) continue; 
      grouped.get(uid).push(r);
    }

    state.cluster.clearLayers(); state.plainLayer.clearLayers();
    if (state.routeLayer) state.routeLayer.clearLayers();
    const activeUids = new Set();

    grouped.forEach((rows, uid) => {
      const last = rows[0], mins = Math.round((Date.now() - new Date(last.timestamp)) / 60000), statusCode = mins <= 2 ? "online" : mins <= 5 ? "mid" : "off";
      activeUids.add(uid);
      let userState = state.users.get(uid);
      if (!userState) {
        const marker = L.marker([last.latitud, last.longitud], { icon: getIconFor(last) }).bindPopup(buildPopup(last));
        state.users.set(uid, { marker, lastRow: last });
      } else {
        userState.marker.setLatLng([last.latitud, last.longitud]); userState.marker.setIcon(getIconFor(last)); userState.marker.setPopupContent(buildPopup(last)); userState.lastRow = last;
      }
      addOrUpdateUserInList(last, statusCode);
    });

    for (const [uid, u] of state.users.entries()) {
      if (!activeUids.has(uid)) {
        state.users.delete(uid); const el = document.getElementById(`u-${uid}`); if (el) el.remove();
      }
    }
    applyLocalFilters(); setStatus("Conectado (Realtime)", "green");
  } catch (e) { console.error(e); setStatus("Error de Red", "gray"); }
}

fetchInitial(true);

supa.channel('ubicaciones-realtime').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ubicaciones_brigadas' }, (payload) => {
  const row = payload.new, uid = String(row.usuario_id || "0"), statusCode = "online";
  let userState = state.users.get(uid);
  if (!userState) {
    const marker = L.marker([row.latitud, row.longitud], { icon: getIconFor(row) }).bindPopup(buildPopup(row));
    state.users.set(uid, { marker, lastRow: row });
  } else {
    const marker = userState.marker, oldPos = marker.getLatLng();
    animateMarker(marker, oldPos, { lat: row.latitud, lng: row.longitud }, 850);
    marker.setIcon(getIconFor(row)); marker.setPopupContent(buildPopup(row)); userState.lastRow = row;
  }
  addOrUpdateUserInList(row, statusCode); applyLocalFilters();
}).subscribe((status) => {
  if (status === 'SUBSCRIBED') setStatus("Conectado (Realtime)", "green");
  else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') setStatus("Desconectado", "gray");
});

// ====== RUTEADO Y BUSQUEDA ======
function formatMinutes(m) {
  if (m < 1) return "<1 min";
  if (m < 60) return `${Math.round(m)} min`;
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
}
function formatKm(meters) { return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`; }

async function searchSites(query) {
  if (query.length < 2) return [];
  const { data, error } = await supa.from("sites_nacional_tabla").select("Site_ID, Site_Name, Latitude, Longitude, DISTRITO").ilike("Site_Name", `%${query}%`).limit(15);
  if (error || !data) return [];
  return data.map(r => {
    const lat = parseFloat(r.Latitude), lng = parseFloat(r.Longitude);
    return isFinite(lat) && isFinite(lng) ? { id: r.Site_ID, name: r.Site_Name, lat, lng, distrito: r.DISTRITO } : null;
  }).filter(Boolean);
}

function showSiteSuggestions(list) {
  const box = ui.siteSuggestions; box.innerHTML = "";
  if (!list.length) { box.style.display = "none"; return; }
  list.forEach(site => {
    const div = document.createElement("div"); div.className = "suggestion-item";
    div.innerHTML = `<strong>${site.id || "COORD"}</strong> - ${site.name}`;
    div.onclick = () => { ui.siteSearch.value = site.name; box.style.display = "none"; handleBuscarSite(site); };
    box.appendChild(div);
  });
  box.style.display = "block";
}

async function calcularRutasBrigadasCercanas(site) {
  if (!state.map || !MAPBOX_TOKEN) return;
  if (!state.routeLayer) state.routeLayer = L.layerGroup().addTo(state.map);
  state.routeLayer.clearLayers();
  
  // Feedback visual
  ui.routesPanel.innerHTML = '<div style="padding:16px; text-align:center; color:#10b981; font-weight:600; font-size:13px; background:#18181b; border-radius:12px; border:1px solid #3f3f46;">⏳ Calculando rutas óptimas...</div>';

  const brigadas = [];
  for (const [, u] of state.users.entries()) {
    const r = u.lastRow;
    if (!r || !isFinite(r.latitud) || !isFinite(r.longitud)) continue;
    brigadas.push({ row: r, lat: r.latitud, lng: r.longitud, dist: distMeters({ lat: r.latitud, lng: r.longitud }, site) });
  }

  if (!brigadas.length) { ui.routesPanel.innerHTML = '<div style="padding:16px; color:#ef4444; background:#18181b; border-radius:12px;">No hay brigadas conectadas.</div>'; return; }
  const candidatos = brigadas.sort((a, b) => a.dist - b.dist).slice(0, 3);
  const routeColors = ["#10b981", "#3b82f6", "#ef4444"];
  const resultados = [];

  for (let i = 0; i < candidatos.length; i++) {
    const b = candidatos[i]; const color = routeColors[i];
    try {
      const resp = await fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${b.lng},${b.lat};${site.lng},${site.lat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`);
      const data = await resp.json(); const route = data.routes?.[0];
      if (!route) continue;

      const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
      const poly = L.polyline(coords, { color, weight: i === 0 ? 6 : 4, opacity: 0.9, dashArray: i === 0 ? null : "8 6" }).addTo(state.routeLayer);
      
      poly.bindTooltip(`${formatMinutes(route.duration/60)} • ${formatKm(route.distance)}`, { 
        permanent: true, direction: 'center', className: 'map-route-tooltip' 
      });

      L.circleMarker([b.lat, b.lng], { radius: 5, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 }).addTo(state.routeLayer).bindPopup(`<b>${b.row.brigada}</b>`);
      resultados.push({ ...b.row, duration: route.duration / 60, distance: route.distance, color, polyline: poly });
      await sleep(100);
    } catch (e) { }
  }

  if (resultados.length === 0) {
    ui.routesPanel.innerHTML = '<div style="padding:16px; color:#ef4444; background:#18181b; border-radius:12px;">Error al conectar con Mapbox API.</div>';
    return;
  }

  ui.routesPanel.innerHTML = ''; // Limpiamos "Calculando"
  
  resultados.sort((a, b) => a.duration - b.duration).forEach((r, idx) => {
    const item = document.createElement("div"); item.className = "route-card";
    const rankLabel = ["1️⃣","2️⃣","3️⃣"][idx];
    
    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <div style="font-weight: 700; font-size: 14px; color: ${r.color};">${rankLabel} ${r.brigada}</div>
        <div style="background: ${r.color}22; color: ${r.color}; padding: 4px 10px; border-radius: 6px; font-weight: 700; font-size: 13px; border: 1px solid ${r.color}66;">
          ${formatMinutes(r.duration)}
        </div>
      </div>
      <div style="font-size: 13px; color: #fff; margin-bottom: 6px; font-weight: 500;">🧑‍🔧 ${r.tecnico || "Sin nombre"}</div>
      <div style="font-size: 11px; color: #a1a1aa; display: flex; justify-content: space-between; align-items: center;">
        <span>📍 ${r.zona || "-"} | 🏢 ${r.contrata || "-"}</span>
        <span style="font-weight: 600; color: #d4d4d8;">🛣️ ${formatKm(r.distance)}</span>
      </div>
    `;
    item.onclick = () => state.map.fitBounds(r.polyline.getBounds(), { padding: [60, 60] });
    ui.routesPanel.appendChild(item);
  });
  
  state.map.fitBounds(state.routeLayer.getBounds(), { padding: [50, 50] });
  
  // AQUI ES DONDE EL BOTON SE HACE VISIBLE DE FORMA SEGURA
  if (ui.btnClearSearch) {
    ui.btnClearSearch.style.display = "block";
  }
}

async function handleBuscarSite(siteFromAutocomplete = null) {
  let site = siteFromAutocomplete;
  if (!site) {
    const text = (ui.siteSearch?.value || "").trim();
    if (!text) { alert("Ingresa un nombre o coordenada."); return; }
    const coordMatch = text.match(/^(-?\d+(\.\d+)?)[,\s]+(-?\d+(\.\d+)?)$/);
    if (coordMatch) site = { id: "COORD", name: `Punto GPS`, lat: parseFloat(coordMatch[1]), lng: parseFloat(coordMatch[3]) };
    else {
      const results = await searchSites(text);
      if (!results.length) { alert("No se encontró resultado."); return; }
      site = results[0];
    }
  }

  if (!state.siteMarker) state.siteMarker = L.marker([site.lat, site.lng], { icon: L.icon({ iconUrl: "https://docs.mapbox.com/help/demos/custom-markers-gl-js/mapbox-icon.png", iconSize: [30, 40], iconAnchor: [15, 40] }) }).addTo(state.map);
  else state.siteMarker.setLatLng([site.lat, site.lng]);
  state.siteMarker.bindPopup(`<b>${site.name}</b><br>Lat: ${site.lat.toFixed(5)}, Lng: ${site.lng.toFixed(5)}`).openPopup();
  await calcularRutasBrigadasCercanas(site);
}

// LOGICA SEGURA PARA LIMPIAR TODO Y ESCONDER EL BOTON
if (ui.btnClearSearch) {
  ui.btnClearSearch.addEventListener("click", () => {
    // 1. Limpiar input y panel
    ui.siteSearch.value = "";
    ui.routesPanel.innerHTML = "";
    
    // 2. Limpiar el mapa (lineas y pines)
    if (state.routeLayer) state.routeLayer.clearLayers();
    if (state.siteMarker) { 
      state.map.removeLayer(state.siteMarker); 
      state.siteMarker = null; 
    }
    
    // 3. Esconder el botón de nuevo
    ui.btnClearSearch.style.display = "none";
    
    // 4. Regresar la cámara a las brigadas
    const group = state.mode === "cluster" ? state.cluster : state.plainLayer;
    if (group.getLayers().length > 0) {
      state.map.fitBounds(group.getBounds(), { padding: [40, 40] });
    } else {
      state.map.setView([-12.0464, -77.0428], 6); // Centro de Perú por defecto
    }
  });
}

if (ui.siteSearch) {
  let siteTypingTimer = null;
  ui.siteSearch.addEventListener("input", () => {
    clearTimeout(siteTypingTimer);
    const text = ui.siteSearch.value.trim();
    if (text.length < 2) { ui.siteSuggestions.style.display = "none"; return; }
    if (text.match(/^[-0-9.,\s]+$/)) { ui.siteSuggestions.style.display = "none"; return; }
    siteTypingTimer = setTimeout(async () => showSiteSuggestions(await searchSites(text)), 250);
  });
}
if (ui.btnBuscarSite) ui.btnBuscarSite.addEventListener("click", () => handleBuscarSite());
document.addEventListener("click", e => { if (ui.siteSuggestions && !ui.siteSearch.contains(e.target) && !ui.siteSuggestions.contains(e.target)) ui.siteSuggestions.style.display = "none"; });

// ====== Exportar KMZ ======
async function exportKMZFromState() {
  let prevDisabled = false;
  try {
    setStatus("Generando KMZ…", "yellow");
    if (ui?.exportKmz) { prevDisabled = ui.exportKmz.disabled; ui.exportKmz.disabled = true; }
    const brig = (ui.brigada.value || "").trim();
    if (!brig) { alert("Escribe la brigada EXACTA para exportar su KMZ."); return; }
    const dateInput = document.getElementById("kmzDate");
    const chosen = dateInput && dateInput.value ? new Date(dateInput.value + "T00:00:00") : new Date();
    const ymd = toYMD(chosen);
    const next = new Date(chosen.getTime() + 24 * 60 * 60 * 1000);
    const ymdNext = toYMD(next);

    const { data, error } = await supa.from("ubicaciones_brigadas").select("latitud,longitud,timestamp,tecnico,usuario_id,timestamp_pe,brigada,acc,spd").eq("brigada", brig).gte("timestamp_pe", ymd).lt("timestamp_pe", ymdNext).order("timestamp_pe", { ascending: true });
    if (error) throw new Error(error.message);
    if (!data || data.length < 2) { alert(`⚠️ No hay datos para "${brig}" en ${ymd}.`); return; }

    const all = data.map(r => ({ lat: +r.latitud, lng: +r.longitud, timestamp: r.timestamp_pe || r.timestamp, acc: r.acc, spd: r.spd })).filter(p => isFinite(p.lat) && isFinite(p.lng) && p.timestamp).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const KMZ_INTERVAL_MIN = 10;
    const sampled = (() => {
      const out = []; let lastTime = null;
      for (const p of all) {
        const t = new Date(p.timestamp).getTime();
        if (lastTime === null) { out.push(p); lastTime = t; continue; }
        if ((t - lastTime) / 60000 >= KMZ_INTERVAL_MIN - 0.5) { out.push(p); lastTime = t; }
      }
      if (out.length && out[out.length - 1].timestamp !== all[all.length - 1].timestamp) out.push(all[all.length - 1]);
      return out.length ? out : all;
    })();

    async function routeBetweenPoints(a, b) {
      if (!MAPBOX_TOKEN) return null;
      const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
      try { const r = await fetch(url); if (!r.ok) return null; const j = await r.json(); const coords = j?.routes?.[0]?.geometry?.coordinates; return coords ? coords.map(c => ({ lng: c[0], lat: c[1] })) : null; } catch (e) { return null; }
    }

    const finalRoute = [];
    for (let i = 0; i < sampled.length - 1; i++) {
      const A = sampled[i], B = sampled[i + 1];
      const route = await routeBetweenPoints(A, B);
      if (route && route.length) { if (!finalRoute.length) finalRoute.push(...route); else finalRoute.push(...route.slice(1)); } else { if (!finalRoute.length) finalRoute.push({ lng: A.lng, lat: A.lat }); finalRoute.push({ lng: B.lng, lat: B.lat }); }
      await sleep(100);
    }

    if (finalRoute.length < 2) { alert("No se generó traza válida."); return; }

    let kml = '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>' + `<name>${brig} - ${ymd}</name>` + '<Style id="routeStyle"><LineStyle><color>ff0000ff</color><width>4</width></LineStyle></Style>';
    const coordsStr = finalRoute.map(p => `${p.lng},${p.lat},0`).join(" ");
    
    kml += `<Placemark><name>Ruta: ${brig} (${ymd})</name><styleUrl>#routeStyle</styleUrl><LineString><tessellate>1</tessellate><coordinates>${coordsStr}</coordinates></LineString></Placemark>`;

    const startPt = sampled[0], endPt = sampled[sampled.length - 1], timeStart = new Date(startPt.timestamp).toLocaleTimeString(), timeEnd = new Date(endPt.timestamp).toLocaleTimeString();
    kml += `<Placemark><name>🟢 INICIO (${timeStart})</name><description>Precisión: ${startPt.acc || '-'}m</description><Point><coordinates>${startPt.lng},${startPt.lat},0</coordinates></Point></Placemark><Placemark><name>🔴 FIN (${timeEnd})</name><description>Precisión: ${endPt.acc || '-'}m</description><Point><coordinates>${endPt.lng},${endPt.lat},0</coordinates></Point></Placemark>`;
    kml += "</Document></kml>";

    if (!window.JSZip) await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js").catch(()=>{});
    const zip = new JSZip(); zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `recorrido_${brig.replace(/[^a-zA-Z0-9_-]+/g, "_")}_${ymd}.kmz`; a.click(); URL.revokeObjectURL(a.href);
    alert(`✅ KMZ listo: ${brig} (${ymd})`);
  } catch (e) { alert("❌ No se pudo generar el KMZ: " + e.message); } finally { setStatus("Conectado (Realtime)", "green"); if (ui?.exportKmz) ui.exportKmz.disabled = prevDisabled; }
}