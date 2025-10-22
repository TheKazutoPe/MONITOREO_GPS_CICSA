// ======================== CONFIGURACIÓN ========================
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

// ======================== ELEMENTOS UI ========================
const ui = {
  baseSel: document.getElementById("baseMapSel"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
  status: document.getElementById("status"),
};

// ======================== ESTADO ========================
const state = {
  map: null,
  markers: new Map(),
  colors: new Map(),
  lastPositions: new Map(),
  routeCache: new Map(),
};

// ======================== UTILIDADES ========================
function brigadaColor(name) {
  if (state.colors.has(name)) return state.colors.get(name);
  const hue = (name.split("").reduce((a, c) => a + c.charCodeAt(0), 0) * 47) % 360;
  const color = `hsl(${hue}, 70%, 55%)`;
  state.colors.set(name, color);
  return color;
}

function timeAgo(ts) {
  const mins = Math.floor((Date.now() - new Date(ts)) / 60000);
  return mins < 1 ? "hace segundos" : `hace ${mins} min`;
}

function deg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

// ======================== MAPA ========================
function initMap() {
  state.map = L.map("map", { center: [-12.0464, -77.0428], zoom: 12 });
  const layers = {
    OpenStreetMap: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"),
    Claro: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"),
    Oscuro: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"),
    Satélite: L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`
    ),
  };
  layers.OpenStreetMap.addTo(state.map);

  ui.baseSel.onchange = () => {
    Object.values(layers).forEach((l) => state.map.removeLayer(l));
    layers[ui.baseSel.value].addTo(state.map);
  };

  ui.apply.onclick = loadBrigadas;
  ui.exportKmz.onclick = exportKmz;

  ui.status.textContent = "Conectado";
  ui.status.classList.add("green");

  animatePanel("#bottom-panel");
}

initMap();

// ======================== ACTUALIZAR BRIGADAS ========================
async function loadBrigadas() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min
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
  const grouped = new Map();

  for (const row of data) {
    const key = row.brigada || row.tecnico || "Sin-ID";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  for (const [brigada, rows] of grouped) {
    const last = rows.at(-1);
    const color = brigadaColor(brigada);
    const coords = [last.latitud, last.longitud];
    const icon = L.icon({
      iconUrl: "assets/carro-animado.png",
      iconSize: [48, 28],
      iconAnchor: [24, 14],
      className: "car-icon",
    });

    const popup = `
      <b>🚘 Brigada:</b> ${brigada}<br>
      <b>Técnico:</b> ${last.tecnico || "—"}<br>
      <b>Zona:</b> ${last.zona || "—"}<br>
      <b>Contrata:</b> ${last.contrata || "—"}<br>
      <b>Última actualización:</b> ${timeAgo(last.timestamp)}
    `;

    const existing = state.markers.get(brigada);
    if (!existing) {
      const marker = L.marker(coords, { icon }).addTo(state.map);
      marker.bindPopup(popup);
      state.markers.set(brigada, marker);
      state.lastPositions.set(brigada, coords);
      showNotification(`🚗 ${brigada} conectada`, color);
    } else {
      const prev = state.lastPositions.get(brigada);
      const angle = deg(
        (prev[0] * Math.PI) / 180,
        (prev[1] * Math.PI) / 180,
        (coords[0] * Math.PI) / 180,
        (coords[1] * Math.PI) / 180
      );
      animateMarker(existing, prev, coords, angle);
      existing.setPopupContent(popup);
      state.lastPositions.set(brigada, coords);
    }

    const li = document.createElement("li");
    li.innerHTML = `<span style="color:${color}">●</span> ${brigada}`;
    li.onclick = () => state.map.setView(coords, 15);
    ui.userList.appendChild(li);
  }
}

function animateMarker(marker, from, to, angle, steps = 25, duration = 800) {
  let i = 0;
  const latStep = (to[0] - from[0]) / steps;
  const lonStep = (to[1] - from[1]) / steps;
  const el = marker._icon;
  el.style.transition = "transform 0.5s linear";
  el.style.transform = `rotate(${angle}deg)`;

  const interval = setInterval(() => {
    i++;
    marker.setLatLng([from[0] + latStep * i, from[1] + lonStep * i]);
    if (i >= steps) clearInterval(interval);
  }, duration / steps);
}

setInterval(loadBrigadas, 20000);
loadBrigadas();

// ======================== EXPORTAR KMZ ========================
async function exportKmz() {
  ui.exportKmz.textContent = "Generando...";
  ui.exportKmz.disabled = true;

  try {
    const startDay = new Date();
    startDay.setHours(0, 0, 0, 0);
    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", startDay.toISOString())
      .order("timestamp", { ascending: true });

    if (error) throw error;
    if (!data?.length) {
      alert("No hay datos del día para exportar.");
      resetExport();
      return;
    }

    const grouped = new Map();
    for (const r of data) {
      const key = r.brigada || r.tecnico || "sin-id";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }

    let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>`;
    for (const [brigada, rows] of grouped) {
      const color = brigadaColor(brigada);
      const [r, g, b] = getComputedStyle(Object.assign(document.createElement("div"), { style: `color:${color}` })).color.match(/\d+/g).map(Number);
      const hex = `ff${b.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${r.toString(16).padStart(2, "0")}`;

      kml += `<Folder><name>${brigada}</name>`;
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1],
          b2 = rows[i];
        const gap = (new Date(b2.timestamp) - new Date(a.timestamp)) / 60000;
        const coords = await getMapboxRoute(a, b2);
        const lineColor = gap > 5 ? "7d" + hex.slice(2) : hex;
        kml += `<Placemark><Style><LineStyle><color>${lineColor}</color><width>4</width></LineStyle></Style><LineString><coordinates>${coords}</coordinates></LineString></Placemark>`;
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

    alert("✅ KMZ generado correctamente.");
  } catch (e) {
    console.error(e);
    alert("❌ Error al generar KMZ.");
  } finally {
    resetExport();
  }
}

async function getMapboxRoute(a, b) {
  const key = `${a.latitud},${a.longitud}|${b.latitud},${b.longitud}`;
  if (state.routeCache.has(key)) return state.routeCache.get(key);

  try {
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${a.longitud},${a.latitud};${b.longitud},${b.latitud}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
    const res = await fetch(url);
    const json = await res.json();
    const coords =
      json.routes?.[0]?.geometry?.coordinates
        ?.map((c) => `${c[0]},${c[1]},0`)
        .join(" ") || `${a.longitud},${a.latitud},0 ${b.longitud},${b.latitud},0`;
    state.routeCache.set(key, coords);
    return coords;
  } catch {
    return `${a.longitud},${a.latitud},0 ${b.longitud},${b.latitud},0`;
  }
}

function resetExport() {
  ui.exportKmz.textContent = "Exportar KMZ";
  ui.exportKmz.disabled = false;
}

// ======================== ANIMACIONES DE UI ========================
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

function animatePanel(sel) {
  const el = document.querySelector(sel);
  if (el) {
    el.style.opacity = 0;
    el.style.transform = "translateY(20px)";
    setTimeout(() => {
      el.style.transition = "all 0.8s ease";
      el.style.opacity = 1;
      el.style.transform = "translateY(0)";
    }, 300);
  }
}
