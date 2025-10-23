// ====== Supabase client ======
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ====== UI refs ======
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
};

// ====== Estado ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),
  pointsByUser: new Map(),
};

// ====== Config ======
const ROUTE_BRIDGE_M = 250;
const GAP_MINUTES = 5;
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

// ====== Íconos ======
const ICONS = {
  green: L.icon({
    iconUrl: "assets/carro-green.png",
    iconSize: [40, 24],
    iconAnchor: [20, 12],
  }),
  yellow: L.icon({
    iconUrl: "assets/carro-orange.png",
    iconSize: [40, 24],
    iconAnchor: [20, 12],
  }),
  gray: L.icon({
    iconUrl: "assets/carro-gray.png",
    iconSize: [40, 24],
    iconAnchor: [20, 12],
  }),
};

function getIconFor(row) {
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  if (mins <= 2) return ICONS.green;
  if (mins <= 5) return ICONS.yellow;
  return ICONS.gray;
}

// ====== Helpers ======
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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ====== Animación ======
function animateMarker(marker, from, to) {
  if (!from || !to) { marker.setLatLng(to || from); return; }
  const d = distMeters(from, to);
  const dur = clamp((d / 40) * 1000, 300, 4000);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / dur, 1);
    const lat = from.lat + (to.lat - from.lat) * t;
    const lng = from.lng + (to.lng - from.lng) * t;
    marker.setLatLng([lat, lng]);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ====== Mapbox ======
async function routeBetween(a, b) {
  try {
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
    const r = await fetch(url, { mode: "cors", cache: "no-cache" });
    if (!r.ok) throw new Error(`Mapbox error: ${r.status}`);
    const j = await r.json();
    const coords = j.routes?.[0]?.geometry?.coordinates || [];
    return coords.map(([lng, lat]) => ({ lat, lng }));
  } catch (err) {
    console.warn("routeBetween error:", err);
    return [a, b];
  }
}

async function snapSegmentToRoad(seg) {
  if (seg.length < 2) return seg;
  const coords = seg.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?geometries=geojson&tidy=true&radiuses=${seg.map(() => 40).join(";")}&access_token=${MAPBOX_TOKEN}`;
  try {
    const r = await fetch(url, { mode: "cors", cache: "no-cache" });
    if (!r.ok) throw new Error(`Mapbox error: ${r.status}`);
    const j = await r.json();
    const c = j.matchings?.[0]?.geometry?.coordinates || [];
    return c.map(([lng, lat]) => ({ lat, lng }));
  } catch (err) {
    console.warn("snapSegmentToRoad error:", err);
    return seg;
  }
}

async function mergeOrBridgeCoords(a, b) {
  if (!a.length) return b;
  const last = a[a.length - 1], first = b[0];
  const gap = distMeters(last, first);
  if (gap > ROUTE_BRIDGE_M) {
    const bridge = await routeBetween(last, first);
    return [...a, ...bridge, ...b];
  }
  return [...a, ...b];
}

// ====== Inicializar mapa ======
function initMap() {
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20 });
  state.baseLayers.sat = L.tileLayer("https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", { subdomains: ["mt0","mt1","mt2","mt3"] });
  state.map = L.map("map", { center: [-12.0464, -77.0428], zoom: 12, layers: [state.baseLayers.osm] });
  state.cluster = L.markerClusterGroup({ disableClusteringAtZoom: 16 });
  state.map.addLayer(state.cluster);

  ui.apply.onclick = () => fetchInitial(true);
  ui.exportKmz.onclick = () => exportKMZFromState();
}
initMap();

// ====== Popup ======
function buildPopup(r) {
  const acc = Math.round(r.acc || 0);
  const spd = (r.spd || 0).toFixed(1);
  const ts = new Date(r.timestamp).toLocaleString();
  return `<div><b>${r.tecnico || "Sin nombre"}</b><br>Brigada: ${r.brigada || "-"}<br>Acc: ${acc} m · Vel: ${spd} m/s<br>${ts}</div>`;
}
function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}

// ====== Cargar datos iniciales ======
async function fetchInitial(clear) {
  setStatus("Cargando…", "gray");
  if (clear) ui.userList.innerHTML = "";
  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("timestamp", { ascending: false });

  if (error) { setStatus("Error", "gray"); return; }

  const brig = (ui.brigada.value || "").trim();
  const perUser = 100;
  const grouped = new Map();

  for (const r of data) {
    if (brig && (r.brigada || "").toLowerCase().indexOf(brig.toLowerCase()) === -1) continue;
    const uid = String(r.usuario_id || "0");
    if (!grouped.has(uid)) grouped.set(uid, []);
    if (grouped.get(uid).length >= perUser) continue;
    grouped.get(uid).push(r);
  }

  state.pointsByUser.clear();
  state.cluster.clearLayers();
  state.users.clear();

  grouped.forEach((rows, uid) => {
    const last = rows[0];
    const marker = L.marker([last.latitud, last.longitud], { icon: getIconFor(last) }).bindPopup(buildPopup(last));
    state.cluster.addLayer(marker);
    state.users.set(uid, { marker, lastRow: last });
    state.pointsByUser.set(uid, rows);
    addOrUpdateUserInList(last);
  });
  setStatus("Conectado", "green");
}

// ====== Realtime ======
function subscribeRealtime() {
  supa
    .channel("ubicaciones_brigadas-changes")
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "ubicaciones_brigadas" },
      (payload) => {
        const row = payload.new;
        const uid = String(row.usuario_id || "0");
        let u = state.users.get(uid);
        if (!u) {
          const m = L.marker([row.latitud, row.longitud], { icon: getIconFor(row) }).bindPopup(buildPopup(row));
          state.cluster.addLayer(m);
          state.users.set(uid, { marker: m, lastRow: row });
          state.pointsByUser.set(uid, [row]);
          addOrUpdateUserInList(row);
          return;
        }
        const from = { lat: u.lastRow.latitud, lng: u.lastRow.longitud };
        const to = { lat: row.latitud, lng: row.longitud };
        animateMarker(u.marker, from, to);
        u.marker.setIcon(getIconFor(row));
        u.marker.setPopupContent(buildPopup(row));
        u.lastRow = row;
        const list = state.pointsByUser.get(uid) || [];
        list.unshift(row);
        state.pointsByUser.set(uid, list.slice(0, 100));
        addOrUpdateUserInList(row);
      }
    )
    .subscribe(() => setStatus("Conectado", "green"));
}
subscribeRealtime();

// ====== Panel lateral ======
function addOrUpdateUserInList(row) {
  const uid = String(row.usuario_id || "0");
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  let color = "text-gray", estado = "Desconectado";
  if (mins <= 2) { color = "text-green"; estado = "Activo"; }
  else if (mins <= 5) { color = "text-yellow"; estado = "Inactivo"; }

  const existing = ui.userList.querySelector(`[data-uid="${uid}"]`);
  const hora = new Date(row.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const html = `
    <div class="brigada-header">
      <span class="brigada-dot ${color}"></span>
      <div class="brigada-info">
        <b>${row.tecnico || "Sin nombre"}</b>
        <span class="brigada-sub">${row.brigada || "-"}</span>
      </div>
      <div class="brigada-hora">${hora}</div>
    </div>
    <div class="brigada-footer ${color}">${estado}</div>
  `;
  if (existing) { existing.className = `brigada-item ${color}`; existing.innerHTML = html; }
  else {
    const div = document.createElement("div");
    div.className = `brigada-item ${color}`;
    div.setAttribute("data-uid", uid);
    div.innerHTML = html;
    div.addEventListener("click", () => {
      const u = state.users.get(uid);
      if (u && u.marker) {
        state.map.setView(u.marker.getLatLng(), 16, { animate: true });
        u.marker.openPopup();
      }
    });
    ui.userList.appendChild(div);
  }
}

// ====== Exportar KMZ (corregido y optimizado) ======
async function exportKMZFromState() {
  try {
    setStatus("Generando KMZ...", "gray");
    ui.exportKmz.disabled = true;

    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const brig = (ui.brigada.value || "").trim();

    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", start.toISOString())
      .lt("timestamp", end.toISOString())
      .order("timestamp", { ascending: true });

    if (error) throw new Error("Error en consulta Supabase");
    if (!data || data.length === 0) { alert("⚠️ No hay datos disponibles para exportar."); return; }

    const byUser = new Map();
    for (const r of data) {
      if (brig && (r.brigada || "").toLowerCase().indexOf(brig.toLowerCase()) === -1) continue;
      const uid = String(r.usuario_id || "0");
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid).push(r);
    }

    let kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Rutas ${start.toISOString().slice(0,10)}</name>`;
    let totalProcessed = 0;

    for (const [uid, rows] of byUser.entries()) {
      if (rows.length < 2) continue;
      const name = (rows[0].tecnico || `Brigada ${uid}`).replace(/&/g, "&amp;");
      let full = [];

      for (let i = 0; i < rows.length - 1; i++) {
        const a = { lat: rows[i].latitud, lng: rows[i].longitud, timestamp: rows[i].timestamp };
        const b = { lat: rows[i + 1].latitud, lng: rows[i + 1].longitud, timestamp: rows[i + 1].timestamp };
        const dt = (new Date(b.timestamp) - new Date(a.timestamp)) / 60000;
        const gap = distMeters(a, b);
        let seg = [a, b];

        if (dt > GAP_MINUTES || gap > ROUTE_BRIDGE_M) seg = await routeBetween(a, b);
        const snap = await snapSegmentToRoad(seg);
        full = await mergeOrBridgeCoords(full, snap);
        await sleep(150); // evitar bloqueo Mapbox
      }

      if (full.length < 2) continue;
      const coords = full.map(s => `${s.lng},${s.lat},0`).join(" ");
      kml += `<Placemark><name>${name}</name><Style><LineStyle><color>ff00a6ff</color><width>4</width></LineStyle></Style><LineString><coordinates>${coords}</coordinates></LineString></Placemark>`;
      totalProcessed++;
    }

    kml += `</Document></kml>`;

    if (totalProcessed === 0) throw new Error("No se generó ninguna ruta válida.");

    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `monitoreo_${start.toISOString().slice(0,10)}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);

    alert(`✅ Archivo KMZ generado correctamente (${totalProcessed} brigadas).`);
  } catch (err) {
    console.error("Error al exportar KMZ:", err);
    alert("❌ No se pudo generar el KMZ:\n" + err.message);
  } finally {
    setStatus("Conectado", "green");
    ui.exportKmz.disabled = false;
  }
}

setStatus("Cargando...", "gray");
fetchInitial(true);
