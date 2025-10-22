// =============== CLIENTE SUPABASE ===============
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// =============== ELEMENTOS UI ===============
const ui = {
  baseSel: document.getElementById("baseMapSel"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
  brigCount: document.getElementById("brigCount"),
  status: document.getElementById("status"),
};

// =============== ESTADO GLOBAL ===============
const state = {
  map: null,
  markers: new Map(),
  lastPoints: new Map(),
  colors: new Map(),
  routeCache: new Map(),
};

// =============== UTILIDADES ===============
function brigadaColor(id) {
  if (state.colors.has(id)) return state.colors.get(id);
  const hue = (id.split("").reduce((a, c) => a + c.charCodeAt(0), 0) * 37) % 360;
  const color = `hsl(${hue}, 70%, 55%)`;
  state.colors.set(id, color);
  return color;
}

function fmtAgo(ts) {
  const m = Math.round((Date.now() - new Date(ts)) / 60000);
  return m < 1 ? "hace segundos" : `hace ${m} min`;
}

function animMarker(marker, from, to, steps = 30, dur = 900) {
  let i = 0;
  const latStep = (to.lat - from.lat) / steps;
  const lngStep = (to.lng - from.lng) / steps;
  const interval = setInterval(() => {
    i++;
    marker.setLatLng([from.lat + latStep * i, from.lng + lngStep * i]);
    if (i >= steps) clearInterval(interval);
  }, dur / steps);
}

// =============== MAPA ===============
function initMap() {
  state.map = L.map("map", { center: [-12.0464, -77.0428], zoom: 12 });
  const layers = {
    osm: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }),
    sat: L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=${CONFIG.MAPBOX_TOKEN}`),
    dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"),
  };
  layers.osm.addTo(state.map);
  ui.baseSel.onchange = () => {
    Object.values(layers).forEach(l => state.map.removeLayer(l));
    layers[ui.baseSel.value].addTo(state.map);
  };
  ui.apply.onclick = updateBrigadas;
  ui.exportKmz.onclick = exportKmz;
  ui.status.textContent = "Conectado";
  ui.status.classList.add("green");
}
initMap();

// =============== BRIGADAS EN TIEMPO REAL ===============
async function updateBrigadas() {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // últimos 15 min
  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", cutoff)
    .order("timestamp", { ascending: true });

  if (error) {
    console.error("Error cargando brigadas:", error);
    return;
  }

  ui.userList.innerHTML = "";
  if (!data?.length) {
    ui.brigCount.textContent = "0 brigadas conectadas";
    return;
  }

  const grouped = new Map();
  for (const row of data) {
    const key = String(row.usuario_id || row.tecnico || "sin-id");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  ui.brigCount.textContent = `${grouped.size} brigadas conectadas`;

  for (const [uid, rows] of grouped) {
    const last = rows.at(-1);
    const brig = last.brigada || uid;
    const color = brigadaColor(brig);

    const icon = L.icon({
      iconUrl: "assets/carro-animado.png",
      iconSize: [46, 28],
      iconAnchor: [23, 14],
    });

    const popup = `
      <b>🚘 Brigada:</b> ${brig}<br>
      <b>Técnico:</b> ${last.tecnico || "—"}<br>
      <b>Contrata:</b> ${last.contrata || "—"}<br>
      <b>Zona:</b> ${last.zona || "—"}<br>
      <b>Último reporte:</b> ${fmtAgo(last.timestamp)}
    `;

    const entry = state.markers.get(uid);
    if (!entry) {
      const marker = L.marker([last.latitud, last.longitud], { icon }).addTo(state.map);
      marker.bindPopup(popup);
      marker.on("click", () => marker.openPopup());
      state.markers.set(uid, { marker, last });
      state.lastPoints.set(uid, { lat: last.latitud, lng: last.longitud });
      showNotification(`🚗 ${brig} conectada`, color);
    } else {
      const prev = state.lastPoints.get(uid);
      const to = { lat: last.latitud, lng: last.longitud };
      animMarker(entry.marker, prev, to);
      entry.marker.setPopupContent(popup);
      state.lastPoints.set(uid, to);
    }

    const li = document.createElement("li");
    li.innerHTML = `<span style="color:${color}">●</span> ${last.tecnico || uid} — ${brig}`;
    li.onclick = () => state.map.setView([last.latitud, last.longitud], 15);
    ui.userList.appendChild(li);
  }
}

setInterval(updateBrigadas, 20000);
updateBrigadas();

// =============== KMZ EXPORT OPTIMIZADO ===============
async function exportKmz() {
  ui.exportKmz.textContent = "Generando...";
  ui.exportKmz.disabled = true;

  try {
    const { data } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .order("timestamp", { ascending: true });

    if (!data?.length) {
      alert("No hay datos del día para exportar.");
      resetBtn();
      return;
    }

    const grouped = new Map();
    for (const r of data) {
      const key = String(r.usuario_id || r.tecnico || "sin-id");
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }

    let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>`;
    const batch = Array.from(grouped.entries());

    for (let [uid, rows] of batch) {
      const brig = rows.at(-1).brigada || `Brig-${uid}`;
      const color = brigadaColor(brig);
      const [r, g, b] = getComputedStyle(Object.assign(document.createElement("div"), { style: `color:${color}` })).color.match(/\d+/g).map(Number);
      const hex = `ff${b.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${r.toString(16).padStart(2, "0")}`;

      kml += `<Folder><name>${brig}</name>`;

      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b2 = rows[i];
        const gap = (new Date(b2.timestamp) - new Date(a.timestamp)) / 60000;
        const coords = await getDirectionsCached(a, b2);
        kml += `<Placemark><Style><LineStyle><color>${gap > 5 ? "7d" + hex.slice(2) : hex}</color><width>4</width></LineStyle></Style><LineString><coordinates>${coords}</coordinates></LineString></Placemark>`;
      }

      kml += `</Folder>`;
    }
    kml += `</Document></kml>`;

    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Rutas_Brigadas_${new Date().toISOString().slice(0, 10)}.kmz`;
    a.click();
    a.remove();

    alert("✅ KMZ generado correctamente");
  } catch (err) {
    console.error(err);
    alert("❌ Error al generar KMZ");
  }
  resetBtn();
}

function resetBtn() {
  ui.exportKmz.textContent = "Exportar KMZ";
  ui.exportKmz.disabled = false;
}

// =============== DIRECCIONES CACHEADAS MAPBOX ===============
async function getDirectionsCached(a, b) {
  const key = `${a.latitud},${a.longitud}|${b.latitud},${b.longitud}`;
  if (state.routeCache.has(key)) return state.routeCache.get(key);

  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${a.longitud},${a.latitud};${b.longitud},${b.latitud}?geometries=geojson&access_token=${CONFIG.MAPBOX_TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();

  const coords = json.routes?.[0]?.geometry?.coordinates
    ?.map(c => `${c[0]},${c[1]},0`)
    .join(" ") || `${a.longitud},${a.latitud},0 ${b.longitud},${b.latitud},0`;

  state.routeCache.set(key, coords);
  return coords;
}

// =============== NOTIFICACIÓN VISUAL DE BRIGADA ===============
function showNotification(msg, color) {
  const note = document.createElement("div");
  note.className = "notif";
  note.style.borderLeft = `4px solid ${color}`;
  note.textContent = msg;
  document.body.appendChild(note);
  setTimeout(() => note.classList.add("visible"), 50);
  setTimeout(() => note.classList.remove("visible"), 4000);
  setTimeout(() => note.remove(), 4500);
}
