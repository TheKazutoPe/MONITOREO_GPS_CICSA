const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const ui = {
  mapSel: document.getElementById("baseMapSel"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
};

const state = {
  map: null,
  markers: new Map(),
  colors: new Map(),
  routeCache: new Map(),
};

// Utilidades
function brigadaColor(id) {
  if (state.colors.has(id)) return state.colors.get(id);
  const hue = (id.split("").reduce((a, c) => a + c.charCodeAt(0), 0) * 137.5) % 360;
  const color = `hsl(${hue}, 70%, 55%)`;
  state.colors.set(id, color);
  return color;
}

function animMarker(marker, from, to, steps = 20, dur = 600) {
  let i = 0;
  const latStep = (to.lat - from.lat) / steps;
  const lngStep = (to.lng - from.lng) / steps;
  const interval = setInterval(() => {
    i++;
    marker.setLatLng([from.lat + latStep * i, from.lng + lngStep * i]);
    if (i >= steps) clearInterval(interval);
  }, dur / steps);
}

function fmtAgo(ts) {
  const m = Math.round((Date.now() - new Date(ts)) / 60000);
  return m < 1 ? "hace segundos" : `hace ${m} min`;
}

// Inicializar mapa
function initMap() {
  state.map = L.map("map").setView([-12.0464, -77.0428], 12);
  const layers = {
    osm: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"),
    sat: L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=${CONFIG.MAPBOX_TOKEN}`),
    dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"),
  };
  layers.osm.addTo(state.map);
  ui.mapSel.onchange = () => {
    Object.values(layers).forEach(l => state.map.removeLayer(l));
    layers[ui.mapSel.value].addTo(state.map);
  };
}
initMap();

// Actualizar brigadas conectadas
async function updateBrigadas() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // últimos 10 min
  const { data } = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", cutoff)
    .order("timestamp", { ascending: true });

  ui.userList.innerHTML = "";
  if (!data?.length) return;

  const grouped = new Map();
  for (const row of data) {
    const key = String(row.usuario_id || row.tecnico || "sin-id");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  for (const [uid, rows] of grouped) {
    const last = rows.at(-1);
    const brig = last.brigada || uid;
    const color = brigadaColor(brig);
    const icon = L.icon({
      iconUrl: "assets/carro-animado.png",
      iconSize: [42, 26],
      iconAnchor: [21, 13],
    });

    const popup = `
      <b>🚘 Brigada:</b> ${brig}<br>
      <b>Técnico:</b> ${last.tecnico || "—"}<br>
      <b>Contrata:</b> ${last.contrata || "—"}<br>
      <b>Zona:</b> ${last.zona || "—"}<br>
      <b>Última actualización:</b> ${fmtAgo(last.timestamp)}
    `;

    const entry = state.markers.get(uid);
    if (!entry) {
      const marker = L.marker([last.latitud, last.longitud], { icon }).addTo(state.map);
      marker.bindPopup(popup);
      marker.on("click", () => marker.openPopup());
      state.markers.set(uid, { marker, lastRow: last });
    } else {
      const prev = entry.lastRow;
      animMarker(entry.marker, { lat: prev.latitud, lng: prev.longitud }, { lat: last.latitud, lng: last.longitud });
      entry.marker.setPopupContent(popup);
      entry.lastRow = last;
    }

    const li = document.createElement("li");
    li.innerHTML = `<span style="color:${color}">●</span> ${last.tecnico} — ${brig}`;
    li.onclick = () => state.map.setView([last.latitud, last.longitud], 15);
    ui.userList.appendChild(li);
  }
}

setInterval(updateBrigadas, 15000);
updateBrigadas();
