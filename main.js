// ============================== main.js ==============================
// Usa CONFIG y supabase globales cargados en index.html
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN || null;

// ====== UI refs (mismos IDs que tu HTML) ======
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
  inactiveList: document.getElementById("inactiveList"),
  toggleInactive: document.getElementById("toggleInactiveBtn"),
};

// ====== Estado del mapa/lista ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(), // uid -> { marker, lastRow }
};

// timer para actualizaciones en vivo
let liveTimer = null;

// ====== Helpers UI ======
function setStatus(msg, color = "gray") {
  if (!ui.status) return;
  ui.status.textContent = msg;
  ui.status.classList.remove("status-green", "status-red", "status-gray");
  ui.status.classList.add(
    color === "green" ? "status-green" :
    color === "red" ? "status-red" :
    "status-gray"
  );
}

// Distancia aproximada en metros entre 2 puntos (lat,lng)
function distMeters(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const sinH = Math.sin(dLat / 2) ** 2 +
               Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(sinH));
}

// ====== MAPA ======
function initMap() {
  // Capa base OSM
  state.baseLayers.osm = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 20 }
  );

  // Crear mapa
  state.map = L.map("map", {
    center: [-12.0464, -77.0428], // Lima por defecto
    zoom: 12,
    layers: [state.baseLayers.osm],
  });

  // Agrupador de markers
  state.cluster = L.markerClusterGroup({
    disableClusteringAtZoom: 16,
  });
  state.map.addLayer(state.cluster);

  // Eventos de UI
  if (ui.apply) {
    ui.apply.onclick = () => fetchInitial(true);
  }

  if (ui.exportKmz) {
    ui.exportKmz.onclick = () => exportKMZFromState();
  }

  if (ui.toggleInactive && ui.inactiveList) {
    ui.toggleInactive.onclick = () => {
      const visible = ui.inactiveList.style.display !== "none";
      ui.inactiveList.style.display = visible ? "none" : "block";
      ui.toggleInactive.classList.toggle("collapsed", !visible);
    };
  }
}

// ====== ICONO ======
function getIconFor(row) {
  // Puedes tunear por brigada, contrata, etc.
  const color = "#2563eb";
  const html = `
    <div class="marker-circle" style="border-color:${color};">
      <div class="marker-dot"></div>
    </div>
  `;
  return L.divIcon({
    className: "brigada-marker",
    html,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

// ====== Popup ======
function buildPopup(row) {
  const brig = row.brigada || "-";
  const tecnico = row.tecnico || "Sin nombre";
  const tel = row.telefono || "";
  const contrata = row.contrata || "";
  const fecha = new Date(row.timestamp).toLocaleString();

  let html = `<div class="popup-brigada">`;
  html += `<div class="popup-title">${tecnico}</div>`;
  html += `<div class="popup-sub">${brig}</div>`;
  html += `<div class="popup-row"><span class="lbl">Contrata:</span> <span>${contrata}</span></div>`;
  if (tel) {
    html += `<div class="popup-row"><span class="lbl">Tel:</span> <span>${tel}</span></div>`;
  }
  html += `<div class="popup-row"><span class="lbl">Último reporte:</span> <span>${fecha}</span></div>`;
  html += `</div>`;
  return html;
}

// ====== Animación de movimiento ======
function animateMarker(marker, fromLatLng, toLatLng, duration = 1000, onComplete) {
  const start = performance.now();

  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const lat = fromLatLng.lat + (toLatLng.lat - fromLatLng.lat) * t;
    const lng = fromLatLng.lng + (toLatLng.lng - fromLatLng.lng) * t;
    marker.setLatLng([lat, lng]);

    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      if (onComplete) onComplete();
    }
  }

  requestAnimationFrame(step);
}

// ====== Lista de brigadas (activas / inactivas) ======
function updateInactiveCounter() {
  if (!ui.toggleInactive || !ui.inactiveList) return;
  const n = ui.inactiveList.children.length;
  ui.toggleInactive.textContent = `Inactivas (${n})`;
  ui.toggleInactive.style.display = n ? "block" : "none";
}

function addOrUpdateUserInList(row) {
  const uid = String(row.usuario_id || "0");
  let el = document.getElementById(`u-${uid}`);
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  const brig = row.brigada || "-";
  const hora = new Date(row.timestamp).toLocaleTimeString();

  const isInactive = mins > 5; // >5 minutos -> lista inactiva
  const ledColor = mins <= 2 ? "#4ade80" : mins <= 5 ? "#eab308" : "#777";
  const cls = mins <= 2 ? "text-green" : mins <= 5 ? "text-yellow" : "text-gray";

  const parent = isInactive ? ui.inactiveList : ui.userList;
  if (!parent) return;

  const html = `
    <div class="brigada-header">
      <div style="display:flex;gap:6px;align-items:flex-start;">
        <div class="brigada-dot" style="background:${ledColor};"></div>
        <div class="brigada-info">
          <b class="brig-name">${row.tecnico || "Sin nombre"}</b>
          <div class="brigada-sub">${brig}</div>
        </div>
      </div>
      <div class="brigada-hora">${hora}</div>
    </div>
  `;

  if (!el) {
    el = document.createElement("div");
    el.id = `u-${uid}`;
  } else if (el.parentElement && el.parentElement !== parent) {
    // mover de lista activa a inactiva o viceversa
    el.parentElement.removeChild(el);
  }

  el.className = `brigada-item ${cls} ${isInactive ? "brigada-inactiva" : ""} marker-pulse`;
  el.innerHTML = html;
  el.onclick = () => {
    focusOnUser(uid);
    ui.brigada.value = brig;
  };

  if (!el.parentElement) parent.appendChild(el);

  // quitar efecto pulse después de un rato
  setTimeout(() => el.classList.remove("marker-pulse"), 600);

  updateInactiveCounter();
}

// Re-aplicar clasificación activo/inactivo en base al reloj
function refreshUserActivityUI() {
  state.users.forEach((u) => {
    if (u && u.lastRow) addOrUpdateUserInList(u.lastRow);
  });
}

// ====== Foco en brigada ======
function focusOnUser(uid) {
  const u = state.users.get(uid);
  if (!u || !u.marker || !state.map) return;
  const latlng = u.marker.getLatLng();
  state.map.setView(latlng, 17, { animate: true });
  u.marker.openPopup();
}

// ====== Crear/actualizar marker con animación ======
function upsertUserMarker(uid, row) {
  const lat = Number(row.latitud);
  const lng = Number(row.longitud);
  if (!isFinite(lat) || !isFinite(lng)) return;

  const newLatLng = L.latLng(lat, lng);
  const existing = state.users.get(uid);

  if (!existing) {
    // Marker nuevo
    const marker = L.marker([lat, lng], { icon: getIconFor(row) }).bindPopup(buildPopup(row));
    state.cluster.addLayer(marker);
    state.users.set(uid, { marker, lastRow: row });
  } else {
    const marker = existing.marker;
    const from = marker.getLatLng();
    const dist = distMeters({ lat: from.lat, lng: from.lng }, { lat, lng });

    if (dist < 1) {
      // casi no se movió, solo actualizamos popup/icono
      marker.setIcon(getIconFor(row));
      marker.setPopupContent(buildPopup(row));
    } else {
      animateMarker(marker, from, newLatLng, 1200, () => {
        marker.setIcon(getIconFor(row));
        marker.setPopupContent(buildPopup(row));
      });
    }
    state.users.set(uid, { marker, lastRow: row });
  }

  addOrUpdateUserInList(row);
}

// ====== Carga inicial (últimas 24 horas) ======
async function fetchInitial(clear = true) {
  try {
    setStatus("Cargando posiciones iniciales...", "gray");

    if (!state.map) initMap();

    if (clear) {
      // Limpiar clusters y listas
      if (state.cluster) {
        state.cluster.clearLayers();
      }
      state.users.clear();
      if (ui.userList) ui.userList.innerHTML = "";
      if (ui.inactiveList) ui.inactiveList.innerHTML = "";
      updateInactiveCounter();
    }

    const brigFilter = (ui.brigada?.value || "").trim().toLowerCase();
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", sinceIso)
      .order("timestamp", { ascending: false });

    if (error) {
      console.error(error);
      setStatus("Error cargando datos", "red");
      return;
    }

    if (!data || !data.length) {
      setStatus("Sin datos recientes", "red");
      return;
    }

    const grouped = new Map(); // uid -> último registro

    for (const r of data) {
      const uid = String(r.usuario_id || "0");
      if (brigFilter) {
        const b = (r.brigada || "").toLowerCase();
        const t = (r.tecnico || "").toLowerCase();
        if (!b.includes(brigFilter) && !t.includes(brigFilter)) continue;
      }
      if (!grouped.has(uid)) {
        grouped.set(uid, r);
      }
    }

    grouped.forEach((row, uid) => {
      upsertUserMarker(uid, row);
    });

    setStatus("Conectado", "green");
  } catch (e) {
    console.error(e);
    setStatus("Error en la carga inicial", "red");
  }
}

// ====== Actualización en “tiempo real” (poll cada 15s) ======
async function fetchLiveUpdate() {
  try {
    const brigFilter = (ui.brigada?.value || "").trim().toLowerCase();
    const sinceIso = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // últimos 10 min

    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", sinceIso)
      .order("timestamp", { ascending: false });

    if (error) {
      console.warn("Error en live update:", error);
      return;
    }
    if (!data || !data.length) return;

    const grouped = new Map();

    for (const r of data) {
      const uid = String(r.usuario_id || "0");

      if (brigFilter) {
        const b = (r.brigada || "").toLowerCase();
        const t = (r.tecnico || "").toLowerCase();
        if (!b.includes(brigFilter) && !t.includes(brigFilter)) continue;
      }

      if (!grouped.has(uid)) {
        grouped.set(uid, r); // como vienen ordenados desc, el primero es el más reciente
      }
    }

    grouped.forEach((row, uid) => {
      const existing = state.users.get(uid);
      if (existing && new Date(row.timestamp) <= new Date(existing.lastRow.timestamp)) {
        // no es más reciente, ignorar
        return;
      }
      upsertUserMarker(uid, row);
    });
  } catch (e) {
    console.warn("Excepción en fetchLiveUpdate:", e);
  }
}

function startLiveLoop() {
  if (liveTimer) clearInterval(liveTimer);
  // Primera vez
  fetchLiveUpdate();
  // Cada 15 segundos
  liveTimer = setInterval(fetchLiveUpdate, 15000);
}

// ====== Exportar KMZ (simple KML envuelto en KMZ “fake” para Google Earth) ======
function exportKMZFromState() {
  try {
    if (!state.users.size) {
      alert("No hay brigadas cargadas para exportar.");
      return;
    }

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const ymd = `${y}${m}${d}`;

    let kml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    kml += `<kml xmlns="http://www.opengis.net/kml/2.2">\n`;
    kml += `<Document>\n`;
    kml += `<name>Rutas brigadas ${ymd}</name>\n`;

    state.users.forEach((u) => {
      if (!u || !u.lastRow) return;
      const r = u.lastRow;
      const lat = Number(r.latitud);
      const lng = Number(r.longitud);
      if (!isFinite(lat) || !isFinite(lng)) return;

      const name = r.tecnico || r.brigada || "Brigada";
      const fecha = new Date(r.timestamp).toLocaleString();

      kml += `<Placemark>\n`;
      kml += `  <name>${name}</name>\n`;
      kml += `  <description><![CDATA[Último reporte: ${fecha}]]></description>\n`;
      kml += `  <Point><coordinates>${lng},${lat},0</coordinates></Point>\n`;
      kml += `</Placemark>\n`;
    });

    kml += `</Document>\n</kml>\n`;

    const blob = new Blob([kml], { type: "application/vnd.google-earth.kmz" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `brigadas_${ymd}.kmz`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    alert("✅ KMZ generado.");
  } catch (e) {
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  }
}

// ====== Arranque ======
setStatus("Cargando...", "gray");

(async () => {
  initMap();
  await fetchInitial(true);         // carga inicial (últimas 24h)
  startLiveLoop();                  // loop de “tiempo real” (poll 15s)
  setInterval(refreshUserActivityUI, 30000); // re-clasifica activas/inactivas cada 30s
})();
