const ADMIN_PASS = "cicsaconnect";
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

const ui = {
  status: document.getElementById("status"),
  userList: document.getElementById("userList"),
  mapStyleSelect: document.getElementById("mapStyleSelect"),
  siteSearch: document.getElementById("siteSearch"),
  siteSuggestions: document.getElementById("siteSuggestions"),
  routesPanel: document.getElementById("routesPanel"),
  btnClearRoute: document.getElementById("btnClearRoute"),
  filterBrigada: document.getElementById("filterBrigada"),
  filterZona: document.getElementById("filterZona"),
  filterStatus: document.getElementById("filterStatus")
};

const state = { map: null, markers: new Map(), users: new Map(), routeLayer: null, siteMarker: null, currentBase: "osm", baseLayers: {} };

const ICONS = {
  online: L.icon({ iconUrl: "assets/carro-green.png", iconSize: [40, 24], iconAnchor: [20, 12] }),
  mid: L.icon({ iconUrl: "assets/carro-orange.png", iconSize: [40, 24], iconAnchor: [20, 12] }),
  off: L.icon({ iconUrl: "assets/carro-gray.png", iconSize: [40, 24], iconAnchor: [20, 12] })
};

function initMap() {
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png");
  state.baseLayers.streets = L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`);
  state.baseLayers.satellite = L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`);

  state.map = L.map("map", { center: [-12.04, -77.02], zoom: 6, layers: [state.baseLayers.osm], zoomControl: false });
  state.routeLayer = L.layerGroup().addTo(state.map);

  state.map.on('zoomend', () => applyFilters());

  ui.mapStyleSelect.onchange = () => {
    const chosen = ui.mapStyleSelect.value;
    if (chosen === "osm") updateMapLayer("osm");
    else {
      const p = prompt("Acceso Restringido - Contraseña:");
      if (p === ADMIN_PASS) updateMapLayer(chosen);
      else { ui.mapStyleSelect.value = "osm"; updateMapLayer("osm"); }
    }
  };

  ui.siteSearch.oninput = async (e) => {
    const q = e.target.value; 
    if (q.length < 3) { ui.siteSuggestions.style.display = "none"; return; }
    const { data } = await supa.from("sites_nacional_tabla").select("*").ilike("Site_Name", `%${q}%`).limit(15);
    if (data) {
      ui.siteSuggestions.innerHTML = data.map(s => `<div class="suggestion-item" onclick="selSite(${s.Longitude},${s.Latitude},'${s.Site_Name}')">🏢 ${s.Site_Name}</div>`).join("");
      ui.siteSuggestions.style.display = "block";
    }
  };

  ui.btnClearRoute.onclick = () => {
    ui.siteSearch.value = ""; ui.routesPanel.innerHTML = ""; ui.btnClearRoute.style.display = "none";
    if(state.siteMarker) state.map.removeLayer(state.siteMarker);
    state.routeLayer.clearLayers();
    state.map.setView([-12.04, -77.02], 6);
  };

  ui.filterBrigada.oninput = applyFilters;
  ui.filterZona.onchange = applyFilters;
  ui.filterStatus.onchange = applyFilters;

  fetchInitial();
  initRealtime();
}

function updateMapLayer(k) { state.map.removeLayer(state.baseLayers[state.currentBase]); state.map.addLayer(state.baseLayers[k]); state.currentBase = k; }

async function calcularRutas(slat, slng) {
    if (!isFinite(slat) || !isFinite(slng)) return;
    ui.routesPanel.innerHTML = "<div class='status-badge green' style='width:100%'>⚡ Trazado de alta precisión...</div>";
    state.routeLayer.clearLayers();
    
    // Filtrar candidatos con coordenadas válidas (Lógica código antiguo)
    const candidates = Array.from(state.users.values())
        .map(u => u.lastRow)
        .filter(r => r && isFinite(r.latitud) && isFinite(r.longitud))
        .map(r => ({ ...r, airDist: Math.sqrt(Math.pow(slng - r.longitud, 2) + Math.pow(slat - r.latitud, 2)) }))
        .sort((a, b) => a.airDist - b.airDist).slice(0, 10);

    const colors = ["#00FF41", "#00E5FF", "#FF00F7"];
    
    // PETICIONES EN PARALELO CON OVERVIEW=FULL (FIX PRECISION)
    const fetchPromises = candidates.map(async (u) => {
        const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${u.longitud},${u.latitud};${slng},${slat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
        try {
            const resp = await fetch(url);
            const json = await resp.json();
            if (json.routes && json.routes[0]) {
                const r = json.routes[0];
                return { b: u.brigada, t: Math.round(r.duration/60), d: (r.distance/1000).toFixed(1), geo: r.geometry };
            }
        } catch(e){} return null;
    });

    const results = (await Promise.all(fetchPromises)).filter(r => r !== null).sort((a, b) => a.t - b.t);
    const top3 = results.slice(0, 3);
    
    ui.routesPanel.innerHTML = top3.map((r, i) => {
        // Renderizado detallado sin simplificación
        L.geoJSON(r.geo, { 
            style: { color: colors[i], weight: i === 0 ? 8 : 6, opacity: 0.9, smoothFactor: 0 } 
        }).addTo(state.routeLayer);
        
        return `<div class="route-card rank-${i+1}"><div style="display:flex; justify-content:space-between"><b>${i+1}° ${r.b}</b><b style="color:${colors[i]}">${r.t} MIN</b></div><small style="color:#71717a">Distancia: ${r.d} KM</small></div>`;
    }).join("");

    if(state.routeLayer.getLayers().length > 0) state.map.fitBounds(state.routeLayer.getBounds(), { padding: [50,50] });
}

function getStatusKey(row) {
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  return mins <= 2 ? "online" : (mins <= 5 ? "mid" : "off");
}

function applyFilters() {
    const bText = ui.filterBrigada.value.toLowerCase();
    const zValue = ui.filterZona.value;
    const sValue = ui.filterStatus.value;
    const zoom = state.map.getZoom();

    state.users.forEach((u, uid) => {
        const row = u.lastRow;
        const key = getStatusKey(row);
        const matches = (!bText || row.brigada.toLowerCase().includes(bText)) && (!zValue || row.zona === zValue) && (!sValue || key === sValue);
        const card = document.getElementById(`u-${uid}`);
        if(card) card.style.display = matches ? "flex" : "none";
        if (u.marker) {
            if (matches && isFinite(row.latitud)) {
                if(!state.map.hasLayer(u.marker)) u.marker.addTo(state.map);
                u.marker.setLatLng([row.latitud, row.longitud]).setIcon(zoom >= 11 ? ICONS[key] : L.divIcon({ className: `marker-dot marker-dot-${key}`, iconSize:[14,14] }));
            } else { state.map.removeLayer(u.marker); }
        }
    });
    updateStats();
}

function updateStats() {
    let on = 0, mid = 0, off = 0;
    state.users.forEach(u => { const k = getStatusKey(u.lastRow); if(k==='online') on++; else if(k==='mid') mid++; else off++; });
    document.getElementById("countOnline").textContent = on;
    document.getElementById("countMid").textContent = mid;
    document.getElementById("countOff").textContent = off;
}

async function fetchInitial() {
  const { data } = await supa.from("ubicaciones_brigadas").select("*").gte("timestamp", new Date(Date.now()-86400000).toISOString()).order("timestamp",{ascending:false});
  if (data) {
    ui.userList.innerHTML = "";
    const grouped = new Map();
    data.forEach(r => { if (!grouped.has(String(r.usuario_id))) grouped.set(String(r.usuario_id), r); });
    grouped.forEach(row => { 
        if (isFinite(row.latitud)) {
            const m = L.marker([row.latitud, row.longitud]).bindPopup(buildPopup(row));
            state.users.set(String(row.usuario_id), { marker: m, lastRow: row });
        }
        addOrUpdateUserInList(row); 
    });
    const zonas = [...new Set(data.map(r => r.zona).filter(Boolean))].sort();
    ui.filterZona.innerHTML = '<option value="">Todas las Zonas</option>' + zonas.map(z => `<option value="${z}">${z}</option>`).join("");
    applyFilters();
    ui.status.textContent = "Conectado"; ui.status.className = "status-badge green";
  }
}

function addOrUpdateUserInList(row) {
  const uid = String(row.usuario_id), key = getStatusKey(row);
  let el = document.getElementById(`u-${uid}`);
  if (!el) { el = document.createElement("div"); el.id = `u-${uid}`; el.className = "brigada-item"; ui.userList.appendChild(el); }
  el.onclick = () => { if(isFinite(row.latitud)) { state.map.setView([row.latitud, row.longitud], 16); state.users.get(uid).marker.openPopup(); } };
  el.innerHTML = `<div class="brig-main"><span class="brig-name">${row.brigada}</span><span class="brig-sub">${row.tecnico}</span><div class="brig-info">📍 ${row.zona || '-'} · Reporte: ${new Date(row.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div></div><div class="brig-led ${key}"></div>`;
}

window.selSite = (lng, lat, nom) => {
  ui.siteSearch.value = nom; ui.siteSuggestions.style.display = "none"; ui.btnClearRoute.style.display = "block";
  if (state.siteMarker) state.map.removeLayer(state.siteMarker);
  state.siteMarker = L.marker([lat, lng], { icon: L.icon({ iconUrl: 'https://docs.mapbox.com/help/demos/custom-markers-gl-js/mapbox-icon.png', iconSize: [30, 40] }) }).addTo(state.map);
  state.map.setView([lat, lng], 14);
  calcularRutas(lat, lng);
};

function buildPopup(r) { return `<div style="min-width:180px;"><b style="color:#ff3b30; font-size:14px;">${r.brigada}</b><br><b>${r.tecnico}</b><hr><small>📍 ZONA: ${r.zona || '-'}</small><br><small>🛰️ Precisión: ${Math.round(r.acc)}m | ⏰ ${new Date(r.timestamp).toLocaleTimeString()}</small></div>`; }
function initRealtime() { supa.channel('ubicaciones').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ubicaciones_brigadas' }, (p) => { const row = p.new; if(!isFinite(row.latitud)) return; if(!state.users.has(String(row.usuario_id))) { const m = L.marker([row.latitud, row.longitud]).bindPopup(buildPopup(row)); state.users.set(String(row.usuario_id), { marker: m, lastRow: row }); } else { state.users.get(String(row.usuario_id)).lastRow = row; } addOrUpdateUserInList(row); applyFilters(); }).subscribe(); }

initMap();