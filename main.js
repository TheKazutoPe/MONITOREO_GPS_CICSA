// main.js — Monitoreo GPS CICSA (solo vehículos animados en mapa)
// Exporta KMZ con rutas reales + reconstrucciones con Mapbox Directions
// Usa las variables de config.js (CONFIG.MAPBOX_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY)

const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  baseSel: document.getElementById("baseMapSel"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
};

const state = {
  map: null,
  baseLayers: {},
  markers: new Map(),
  colors: new Map(),
  routeCache: new Map(),
  lastMapboxCall: 0,
  MAPBOX_DELAY: 100,
};

// ===================== MAPA =====================
function initMap() {
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png");
  state.baseLayers.sat = L.tileLayer("https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", { subdomains: ["mt0", "mt1", "mt2", "mt3"] });
  state.baseLayers.dark = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png");
  state.map = L.map("map", { center: [-12.0464, -77.0428], zoom: 12, layers: [state.baseLayers.osm] });

  ui.baseSel.onchange = () => {
    Object.values(state.baseLayers).forEach(l => state.map.removeLayer(l));
    (state.baseLayers[ui.baseSel.value] || state.baseLayers.osm).addTo(state.map);
  };
}
initMap();

// ===================== FUNCIONES AUXILIARES =====================
function randColor() {
  const h = Math.floor(Math.random() * 360);
  const s = 70 + Math.random() * 10;
  const l = 50 + Math.random() * 10;
  return `hsl(${h},${s}%,${l}%)`;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const distMeters = (a, b) => {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
  const c = s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2;
  return 2 * R * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));
};
const fmtAgo = ts => {
  const m = Math.round((Date.now() - new Date(ts)) / 60000);
  if (m < 1) return "hace segundos";
  if (m === 1) return "hace 1 min";
  return `hace ${m} min`;
};
const minsAgo = ts => Math.round((Date.now() - new Date(ts)) / 60000);
function brigadaColor(brig) {
  if (!state.colors.has(brig)) state.colors.set(brig, randColor());
  return state.colors.get(brig);
}

// ===================== ANIMACIÓN DE MARCADORES =====================
function animMarker(marker, from, to) {
  if (!from || !to) return marker.setLatLng(to || from);
  const start = performance.now();
  const dur = 1200;
  function step(t) {
    const k = Math.min(1, (t - start) / dur);
    const lat = from.lat + (to.lat - from.lat) * k;
    const lng = from.lng + (to.lng - from.lng) * k;
    marker.setLatLng([lat, lng]);
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ===================== MAPBOX ROUTING (para KMZ) =====================
async function getSnapped(from, to) {
  const key = `${from.lat},${from.lng}|${to.lat},${to.lng}`;
  if (state.routeCache.has(key)) return state.routeCache.get(key);

  const since = Date.now() - state.lastMapboxCall;
  if (since < state.MAPBOX_DELAY) await sleep(state.MAPBOX_DELAY - since);

  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?geometries=geojson&access_token=${CONFIG.MAPBOX_TOKEN}`;
  try {
    state.lastMapboxCall = Date.now();
    const r = await fetch(url);
    const j = await r.json();
    const c = j.routes?.[0]?.geometry?.coordinates?.map(([x, y]) => [y, x]) || [[from.lat, from.lng], [to.lat, to.lng]];
    state.routeCache.set(key, c);
    return c;
  } catch {
    return [[from.lat, from.lng], [to.lat, to.lng]];
  }
}

// ===================== ACTUALIZAR VEHÍCULOS =====================
async function updateVehicles() {
  const { data } = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    .order("timestamp", { ascending: true });

  if (!data?.length) return;

  const grouped = new Map();
  for (const r of data) {
    const u = String(r.usuario_id || r.tecnico);
    if (!grouped.has(u)) grouped.set(u, []);
    grouped.get(u).push(r);
  }

  ui.userList.innerHTML = "";
  for (const [uid, rows] of grouped) {
    const last = rows.at(-1);
    const brig = last.brigada || `Brig-${uid}`;
    const color = brigadaColor(brig);
    const icon = L.divIcon({
      html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};box-shadow:0 0 8px ${color};border:2px solid white"></div>`,
      className: "car-marker",
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    let entry = state.markers.get(uid);
    if (!entry) {
      const marker = L.marker([last.latitud, last.longitud], { icon }).addTo(state.map);
      state.markers.set(uid, { marker, lastRow: last });
    } else {
      const prev = entry.lastRow;
      animMarker(entry.marker, { lat: prev.latitud, lng: prev.longitud }, { lat: last.latitud, lng: last.longitud });
      entry.lastRow = last;
    }

    const li = document.createElement("li");
    const mins = minsAgo(last.timestamp);
    const status = mins <= 2 ? "green" : mins <= 5 ? "yellow" : "gray";
    li.className = "user-item";
    li.innerHTML = `<div class="title"><span class="dot ${status}"></span>${last.tecnico}</div>
    <div class="meta">Brig: ${brig} · ${fmtAgo(last.timestamp)}</div>`;
    li.onclick = () => state.map.setView([last.latitud, last.longitud], 15);
    ui.userList.appendChild(li);
  }
}

// ===================== EXPORTAR KMZ (con reconstrucción) =====================
async function exportKmz() {
  const { data } = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .order("timestamp", { ascending: true });

  if (!data?.length) return alert("No hay datos para exportar hoy.");

  const grouped = new Map();
  for (const r of data) {
    const u = String(r.usuario_id || r.tecnico);
    if (!grouped.has(u)) grouped.set(u, []);
    grouped.get(u).push(r);
  }

  let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>`;
  for (const [uid, rows] of grouped) {
    const last = rows.at(-1);
    const color = brigadaColor(last.brigada || `Brig-${uid}`);
    const name = (last.tecnico || `Usuario ${uid}`).replace(/&/g, "&amp;");
    const brig = last.brigada || `Brig-${uid}`;
    const h = color.match(/\d+/g);
    const rr = parseInt(h[0]), gg = parseInt(h[1]), bb = parseInt(h[2]);
    const hex = `ff${bb.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${rr.toString(16).padStart(2, "0")}`;

    kml += `<Folder><name>${brig} - ${name}</name>`;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      const from = { lat: a.latitud, lng: a.longitud };
      const to = { lat: b.latitud, lng: b.longitud };
      const gap = (new Date(b.timestamp) - new Date(a.timestamp)) / 60000;
      const dash = gap > 5;
      const coords = await getSnapped(from, to);
      kml += `<Placemark><Style><LineStyle><color>${dash ? "7d" + hex.slice(2) : hex}</color><width>${dash ? 3 : 4}</width>${dash ? "<gx:labelVisibility>0</gx:labelVisibility>" : ""}</LineStyle></Style>`;
      kml += `<LineString><coordinates>${coords.map(c => `${c[1]},${c[0]},0`).join(" ")}</coordinates></LineString></Placemark>`;
    }
    const lastP = rows.at(-1);
    kml += `<Placemark><name>${name}</name><Point><coordinates>${lastP.longitud},${lastP.latitud},0</coordinates></Point></Placemark>`;
    kml += `</Folder>`;
  }
  kml += `</Document></kml>`;

  const zip = new JSZip();
  zip.file("doc.kml", kml);
  const blob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `CICSA_Monitoreo_${new Date().toISOString().slice(0, 10)}.kmz`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ===================== EVENTOS =====================
ui.exportKmz.onclick = exportKmz;
updateVehicles();
setInterval(updateVehicles, 30 * 1000);
