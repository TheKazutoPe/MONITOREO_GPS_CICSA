// =======================================================
//  MONITOREO GPS - CICSA 2025
//  Versión: Animación vehículo + KMZ con rutas pulidas (Mapbox Matching API)
// =======================================================

const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
mapboxgl.accessToken = CONFIG.MAPBOX_TOKEN;

// ==== UI y estado ====
const ui = {
  status: document.getElementById("status"),
  userList: document.getElementById("userList"),
  brigadaSelect: document.getElementById("brigadaSelect"),
  fechaSelect: document.getElementById("fechaSelect"),
  generateKmz: document.getElementById("generateKmz")
};

const state = {
  map: null,
  markers: {},
  brigadas: new Map(),
  lastPositions: {}
};

// ==== Mapa base ====
function initMap() {
  state.map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/streets-v12",
    center: [-77.0428, -12.0464],
    zoom: 12
  });

  state.map.addControl(new mapboxgl.NavigationControl(), "bottom-right");
  state.map.addControl(new mapboxgl.FullscreenControl(), "bottom-right");
}
initMap();

function setStatus(text, color) {
  ui.status.textContent = text;
  ui.status.className = `status-badge ${color}`;
}

// ==== Funciones útiles ====
function distance(a, b) {
  const R = 6371e3;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function bearing(a, b) {
  const rad = Math.PI / 180;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const dLon = (b.lng - a.lng) * rad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
            Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const brng = Math.atan2(y, x);
  return (brng * 180 / Math.PI + 360) % 360;
}

// ==== Cargar brigadas activas ====
async function fetchBrigadas() {
  setStatus("Cargando brigadas...", "gray");

  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("usuario_id, tecnico, brigada, zona, latitud, longitud, timestamp")
    .gte("timestamp", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("timestamp", { ascending: false });

  if (error) return console.error(error);

  const grouped = new Map();
  for (const row of data) {
    const id = String(row.usuario_id || row.brigada);
    if (!grouped.has(id)) grouped.set(id, row);
  }

  ui.userList.innerHTML = "";
  state.brigadas.clear();

  grouped.forEach((r, id) => {
    const mins = Math.round((Date.now() - new Date(r.timestamp)) / 60000);
    const color = mins <= 2 ? "text-green" : mins <= 5 ? "text-yellow" : "text-gray";
    addBrigadaToList(r, id, color);
    placeMarker(r, id, color);
    state.brigadas.set(id, r);
  });

  setStatus("Conectado", "green");
}

function addBrigadaToList(r, id, color) {
  const hora = new Date(r.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const div = document.createElement("div");
  div.className = `brigada-item ${color}`;
  div.innerHTML = `
    <div class="brigada-header">
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="brigada-dot"></span>
        <div><b>${r.tecnico}</b><div class="brigada-sub">${r.brigada}</div></div>
      </div>
      <div class="brigada-hora">${hora}</div>
    </div>
    <div class="brigada-footer">${color === "text-green" ? "Activo" : color === "text-yellow" ? "Inactivo" : "Desconectado"}</div>
  `;
  div.addEventListener("click", () => focusBrigada(id));
  ui.userList.appendChild(div);
}

// ==== Marcadores animados ====
function placeMarker(r, id, color) {
  const iconUrl =
    color === "text-green"
      ? "assets/carro-animado.png"
      : color === "text-yellow"
      ? "assets/carro-orange.png"
      : "assets/carro-gray.png";

  const el = document.createElement("div");
  el.className = "marker";
  el.style.backgroundImage = `url(${iconUrl})`;
  el.style.width = "42px";
  el.style.height = "42px";
  el.style.backgroundSize = "contain";
  el.style.backgroundRepeat = "no-repeat";
  el.style.filter = "drop-shadow(0 0 3px rgba(0,0,0,0.6))";
  el.style.transition = "transform 0.5s linear";

  const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(`
    <div style="background:rgba(0,51,102,0.9);color:white;padding:8px 10px;border-radius:8px;">
      <b style="color:#00bfff">${r.tecnico}</b><br>
      🚧 Brigada: <b>${r.brigada}</b><br>
      📍 Zona: ${r.zona}<br>
      🕒 ${new Date(r.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}
    </div>
  `);

  const marker = new mapboxgl.Marker({
    element: el,
    anchor: "bottom",
    offset: [0, 5],
  })
    .setLngLat([r.longitud, r.latitud])
    .setPopup(popup)
    .addTo(state.map);

  state.markers[id] = marker;
  state.lastPositions[id] = { lat: r.latitud, lng: r.longitud };
}

// ==== Movimiento suave ====
function smoothMove(id, newData) {
  const marker = state.markers[id];
  if (!marker) return;

  const prev = state.lastPositions[id];
  const newPos = { lat: newData.latitud, lng: newData.longitud };
  const d = distance(prev, newPos);
  if (d > 200) return;

  const br = bearing(prev, newPos);
  const el = marker.getElement();
  el.style.transform = `rotate(${br}deg)`;

  let t = 0;
  const duration = 900;
  const animate = () => {
    t += 16;
    const p = Math.min(t / duration, 1);
    const lat = prev.lat + (newPos.lat - prev.lat) * p;
    const lng = prev.lng + (newPos.lng - prev.lng) * p;
    marker.setLngLat([lng, lat]);
    if (p < 1) requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);

  state.lastPositions[id] = newPos;
}

function focusBrigada(id) {
  const r = state.brigadas.get(id);
  if (r) state.map.flyTo({ center: [r.longitud, r.latitud], zoom: 15 });
  const marker = state.markers[id];
  if (marker) marker.togglePopup();
}

// ==== Realtime ====
function subscribeRealtime() {
  supa.channel("ubicaciones_brigadas-updates")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_brigadas" }, (payload) => {
      const r = payload.new;
      const id = String(r.usuario_id || r.brigada);
      if (!state.brigadas.has(id)) return fetchBrigadas();
      smoothMove(id, r);
      state.brigadas.set(id, r);
    })
    .subscribe();
}

// ==== Snap-to-road para KMZ ====
async function getSnappedCoords(coords) {
  if (!CONFIG.MAPBOX_TOKEN.startsWith("pk.")) {
    alert("⚠️ Usa un token público (pk.) de Mapbox en config.js");
    return coords;
  }

  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords.join(";")}?geometries=geojson&access_token=${CONFIG.MAPBOX_TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();

  return json.matchings?.[0]?.geometry?.coordinates || coords;
}

// ==== Exportar KMZ ====
async function exportKMZ(brigada, fecha) {
  setStatus("Generando KMZ...", "gray");

  const start = new Date(fecha);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);

  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("latitud,longitud,timestamp,tecnico,brigada")
    .gte("timestamp", start.toISOString())
    .lt("timestamp", end.toISOString())
    .ilike("brigada", `%${brigada}%`)
    .order("timestamp", { ascending: true });

  if (error || !data.length) return alert("⚠️ No hay datos.");

  const coords = data.map(r => [r.longitud, r.latitud]);
  const snapped = await getSnappedCoords(coords);

  const inicio = data[0];
  const fin = data[data.length - 1];
  const coordsStr = snapped.map(c => `${c[0]},${c[1]},0`).join(" ");

  const desc = `
    <b>Brigada:</b> ${brigada}<br>
    <b>Técnico:</b> ${inicio.tecnico}<br>
    <b>Puntos:</b> ${data.length}<br>
    <b>Inicio:</b> ${new Date(inicio.timestamp).toLocaleString()}<br>
    <b>Fin:</b> ${new Date(fin.timestamp).toLocaleString()}
  `;

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
      <name>Recorrido ${brigada}</name>
      <description><![CDATA[${desc}]]></description>
      <Style id="ruta">
        <LineStyle><color>ff007bff</color><width>4</width></LineStyle>
      </Style>
      <Placemark>
        <name>Ruta ${brigada}</name>
        <styleUrl>#ruta</styleUrl>
        <LineString><coordinates>${coordsStr}</coordinates></LineString>
      </Placemark>
    </Document></kml>`;

  const zip = new JSZip();
  zip.file("doc.kml", kml);
  const blob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `RUTA_${brigada}_${fecha}.kmz`;
  a.click();
  URL.revokeObjectURL(a.href);

  setStatus("Conectado", "green");
  alert("✅ KMZ generado con ruta pulida correctamente");
}

// ==== Eventos ====
ui.generateKmz.addEventListener("click", async () => {
  const brigada = ui.brigadaSelect.value;
  const fecha = ui.fechaSelect.value;
  if (!brigada || !fecha) return alert("Selecciona brigada y fecha.");
  await exportKMZ(brigada, fecha);
});

// ==== Start ====
fetchBrigadas();
subscribeRealtime();
setStatus("Cargando...", "gray");
