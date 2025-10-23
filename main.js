// ====== Supabase client ======
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ====== UI refs ======
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  fecha: document.getElementById("fechaExport"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
  mapStyle: document.getElementById("mapStyleSel"),
};

// ====== Estado ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),
  pointsByUser: new Map(),
  brigadasDisponibles: [],
};

// ====== Config ======
const ROUTE_BRIDGE_M = 250;
const GAP_MINUTES = 5;
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

// ====== Íconos ======
const ICONS = {
  green: L.icon({
    iconUrl: "assets/carro-green.png",
    iconSize: [42, 25],
    iconAnchor: [21, 12],
  }),
  yellow: L.icon({
    iconUrl: "assets/carro-orange.png",
    iconSize: [42, 25],
    iconAnchor: [21, 12],
  }),
  gray: L.icon({
    iconUrl: "assets/carro-gray.png",
    iconSize: [42, 25],
    iconAnchor: [21, 12],
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

// ====== Animación del marcador ======
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

// ====== Mapbox Routing ======
async function routeBetween(a, b) {
  try {
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
    const r = await fetch(url);
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
    const r = await fetch(url);
    const j = await r.json();
    const c = j.matchings?.[0]?.geometry?.coordinates || [];
    return c.map(([lng, lat]) => ({ lat, lng }));
  } catch {
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
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png");
  state.baseLayers.sat = L.tileLayer("https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", {
    subdomains: ["mt0", "mt1", "mt2", "mt3"],
  });
  state.baseLayers.color = L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`, { tileSize: 512, zoomOffset: -1 });
  state.baseLayers.dark = L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`, { tileSize: 512, zoomOffset: -1 });

  state.map = L.map("map", { center: [-12.0464, -77.0428], zoom: 12, layers: [state.baseLayers.color] });
  state.cluster = L.markerClusterGroup({ disableClusteringAtZoom: 15 });
  state.map.addLayer(state.cluster);

  ui.mapStyle.addEventListener("change", () => {
    const sel = ui.mapStyle.value;
    Object.values(state.baseLayers).forEach(l => state.map.removeLayer(l));
    state.map.addLayer(state.baseLayers[sel]);
  });

  ui.apply.onclick = () => fetchInitial(true);
  ui.exportKmz.onclick = () => exportKMZFromState();
}
initMap();

// ====== Popup ======
function buildPopup(r) {
  const ts = new Date(r.timestamp).toLocaleString();
  return `
    <div>
      <b>${r.tecnico || "Sin nombre"}</b><br>
      <b>Brigada:</b> ${r.brigada || "-"}<br>
      <b>Contrata:</b> ${r.contrata || "-"}<br>
      <b>Zona:</b> ${r.zona || "-"}<br>
      <b>${ts}</b>
    </div>`;
}
function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}

// ====== Cargar brigadas disponibles ======
async function cargarBrigadasDisponibles() {
  const { data, error } = await supa.from("usuarios_brigadas").select("brigada");
  if (error) return console.warn("Error brigadas:", error);
  state.brigadasDisponibles = [...new Set(data.map(r => r.brigada))];
  ui.brigada.addEventListener("input", () => {
    const val = ui.brigada.value.toLowerCase();
    const sugerencias = state.brigadasDisponibles.filter(b => b.toLowerCase().includes(val)).slice(0, 5);
    const list = document.getElementById("brigada-suggest") || document.createElement("ul");
    list.id = "brigada-suggest";
    list.className = "suggest-box";
    list.innerHTML = sugerencias.map(s => `<li>${s}</li>`).join("");
    ui.brigada.parentNode.appendChild(list);
    list.querySelectorAll("li").forEach(li => {
      li.onclick = () => { ui.brigada.value = li.textContent; list.remove(); };
    });
  });
}
cargarBrigadasDisponibles();

// ====== Fetch inicial ======
async function fetchInitial(clear) {
  setStatus("Cargando…", "gray");
  if (clear) ui.userList.innerHTML = "";

  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("timestamp", { ascending: false });

  if (error) return setStatus("Error", "gray");

  const brig = (ui.brigada.value || "").trim();
  const grouped = new Map();

  for (const r of data) {
    if (brig && (r.brigada || "").toLowerCase().indexOf(brig.toLowerCase()) === -1) continue;
    const uid = String(r.usuario_id || "0");
    if (!grouped.has(uid)) grouped.set(uid, []);
    grouped.get(uid).push(r);
  }

  state.cluster.clearLayers();
  state.users.clear();
  state.pointsByUser.clear();

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
  supa.channel("ubicaciones_brigadas-changes")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_brigadas" }, (payload) => {
      const row = payload.new;
      const uid = String(row.usuario_id || "0");
      let u = state.users.get(uid);
      if (!u) {
        const m = L.marker([row.latitud, row.longitud], { icon: getIconFor(row) }).bindPopup(buildPopup(row));
        state.cluster.addLayer(m);
        state.users.set(uid, { marker: m, lastRow: row });
        addOrUpdateUserInList(row);
        return;
      }
      const from = { lat: u.lastRow.latitud, lng: u.lastRow.longitud };
      const to = { lat: row.latitud, lng: row.longitud };
      animateMarker(u.marker, from, to);
      u.marker.setIcon(getIconFor(row));
      u.marker.setPopupContent(buildPopup(row));
      u.lastRow = row;
      addOrUpdateUserInList(row);
    }).subscribe(() => setStatus("Conectado", "green"));
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
    <div class="brigada-footer ${color}">${estado}</div>`;

  if (existing) existing.innerHTML = html;
  else {
    const div = document.createElement("div");
    div.className = `brigada-item ${color}`;
    div.dataset.uid = uid;
    div.innerHTML = html;
    div.onclick = () => {
      const u = state.users.get(uid);
      if (u?.marker) {
        state.map.setView(u.marker.getLatLng(), 16, { animate: true });
        u.marker.openPopup();
      }
    };
    ui.userList.appendChild(div);
  }
}

// ====== Exportar KMZ filtrado ======
async function exportKMZFromState() {
  try {
    const brig = (ui.brigada.value || "").trim();
    const fechaSel = ui.fecha.value ? new Date(ui.fecha.value) : new Date();
    const start = new Date(fechaSel.getFullYear(), fechaSel.getMonth(), fechaSel.getDate());
    const end = new Date(fechaSel.getFullYear(), fechaSel.getMonth(), fechaSel.getDate() + 1);

    setStatus("Generando KMZ...", "gray");
    ui.exportKmz.disabled = true;

    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", start.toISOString())
      .lt("timestamp", end.toISOString())
      .order("timestamp", { ascending: true });

    if (error) throw new Error("Error Supabase");
    if (!data.length) return alert("⚠️ No hay datos para la fecha seleccionada.");

    const filtered = data.filter(r => !brig || (r.brigada || "").toLowerCase().includes(brig.toLowerCase()));
    if (!filtered.length) return alert("⚠️ No hay datos para esa brigada.");

    let kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Rutas ${brig} ${start.toISOString().slice(0,10)}</name>`;
    let count = 0;

    const grouped = filtered.reduce((m, r) => {
      const uid = String(r.usuario_id || "0");
      if (!m.has(uid)) m.set(uid, []);
      m.get(uid).push(r);
      return m;
    }, new Map());

    for (const [uid, rows] of grouped) {
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
        await sleep(120);
      }
      if (full.length < 2) continue;
      const coords = full.map(s => `${s.lng},${s.lat},0`).join(" ");
      kml += `<Placemark><name>${name}</name><Style><LineStyle><color>ff00a6ff</color><width>4</width></LineStyle></Style><LineString><coordinates>${coords}</coordinates></LineString></Placemark>`;
      count++;
    }

    kml += `</Document></kml>`;
    if (!count) throw new Error("No se generó ninguna ruta.");

    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `RUTA_${brig || "GENERAL"}_${start.toISOString().slice(0,10)}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);

    alert(`✅ KMZ generado (${count} rutas).`);
  } catch (err) {
    alert("❌ Error al generar KMZ: " + err.message);
  } finally {
    setStatus("Conectado", "green");
    ui.exportKmz.disabled = false;
  }
}

setStatus("Cargando...", "gray");
fetchInitial(true);
