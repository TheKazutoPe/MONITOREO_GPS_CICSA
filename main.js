// ========================== CONFIGURACIÓN INICIAL ==========================
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

// ========================== ELEMENTOS DE LA INTERFAZ ==========================
const ui = {
  baseSel: document.getElementById("baseMapSel"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
  status: document.getElementById("status")
};

// ========================== ESTADO GLOBAL ==========================
const state = {
  map: null,
  markers: new Map(),
  colors: new Map(),
  lastPositions: new Map(),
  routeCache: new Map()
};

// ========================== FUNCIONES AUXILIARES ==========================
function brigadaColor(name) {
  if (state.colors.has(name)) return state.colors.get(name);
  const hue = (name.split("").reduce((a, c) => a + c.charCodeAt(0), 0) * 53) % 360;
  const color = `hsl(${hue}, 75%, 50%)`;
  state.colors.set(name, color);
  return color;
}

function timeAgo(ts) {
  const mins = Math.floor((Date.now() - new Date(ts)) / 60000);
  return mins < 1 ? "hace segundos" : `hace ${mins} min`;
}

// ========================== INICIALIZAR MAPA ==========================
function initMap() {
  state.map = L.map("map", { center: [-12.0464, -77.0428], zoom: 12 });

  const baseLayers = {
    OpenStreetMap: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }),
    Satélite: L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`),
    Claro: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"),
    Oscuro: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png")
  };
  baseLayers.OpenStreetMap.addTo(state.map);

  ui.baseSel.onchange = () => {
    Object.values(baseLayers).forEach(l => state.map.removeLayer(l));
    baseLayers[ui.baseSel.value].addTo(state.map);
  };

  ui.apply.onclick = loadBrigadas;
  ui.exportKmz.onclick = exportKmz;

  ui.status.textContent = "Conectado";
  ui.status.classList.add("green");
}

initMap();

// ========================== CARGAR BRIGADAS EN VIVO ==========================
async function loadBrigadas() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // últimos 10 minutos
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
    const key = row.brigada || row.tecnico || "Sin ID";
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
      iconAnchor: [24, 14]
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
    } else {
      const prev = state.lastPositions.get(brigada);
      animateMarker(existing, prev, coords);
      existing.setPopupContent(popup);
      state.lastPositions.set(brigada, coords);
    }

    const li = document.createElement("li");
    li.innerHTML = `<span style="color:${color}">●</span> ${brigada}`;
    li.onclick = () => state.map.setView(coords, 15);
    ui.userList.appendChild(li);
  }
}

function animateMarker(marker, from, to, steps = 30, duration = 900) {
  let i = 0;
  const latStep = (to[0] - from[0]) / steps;
  const lonStep = (to[1] - from[1]) / steps;
  const interval = setInterval(() => {
    i++;
    marker.setLatLng([from[0] + latStep * i, from[1] + lonStep * i]);
    if (i >= steps) clearInterval(interval);
  }, duration / steps);
}

setInterval(loadBrigadas, 20000);
loadBrigadas();

// ========================== EXPORTAR KMZ (CON DIRECCIONES MAPBOX) ==========================
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
      alert("No hay datos de hoy para exportar.");
      resetExport();
      return;
    }

    const grouped = new Map();
    for (const row of data) {
      const key = row.brigada || row.tecnico || "sin-id";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }

    let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>`;
    for (const [brigada, rows] of grouped) {
      const color = brigadaColor(brigada);
      const [r, g, b] = getComputedStyle(Object.assign(document.createElement("div"), { style: `color:${color}` })).color.match(/\d+/g).map(Number);
      const hex = `ff${b.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${r.toString(16).padStart(2, "0")}`;

      kml += `<Folder><name>${brigada}</name>`;
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b2 = rows[i];
        const gap = (new Date(b2.timestamp) - new Date(a.timestamp)) / 60000;
        const coords = await getMapboxRoute(a, b2);
        const lineStyle = gap > 5
          ? `<LineStyle><color>7d${hex.slice(2)}</color><width>3</width></LineStyle><LineStyle><gx:outerColor>${hex}</gx:outerColor><gx:outerWidth>0.5</gx:outerWidth></LineStyle>`
          : `<LineStyle><color>${hex}</color><width>4</width></LineStyle>`;
        kml += `<Placemark><Style>${lineStyle}</Style><LineString><coordinates>${coords}</coordinates></LineString></Placemark>`;
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
    const coords = json.routes?.[0]?.geometry?.coordinates
      ?.map(c => `${c[0]},${c[1]},0`)
      .join(" ") || `${a.longitud},${a.latitud},0 ${b.longitud},${b.latitud},0`;
    state.routeCache.set(key, coords);
    return coords;
  } catch {
    return `${a.longitud},${a.latitud},0 ${b.longitud},${b.latitud},0`;
  }
}

function resetExport() {
  ui.exportKmz.textContent = "Exportar KMZ (día)";
  ui.exportKmz.disabled = false;
}
