// ============================== main.js ==============================
// 🔁 Versión corregida basada en TU main original: traza la ruta limpia en tiempo real usando MAPBOX, NO punto a punto

const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  userList: document.getElementById("userList"),
  kmzDate: document.getElementById("kmzDate"),
  exportKmz: document.getElementById("exportKmz"),
};

const state = {
  map: null,
  cluster: null,
  rutasPorBrigada: new Map(),
  puntosPorBrigada: new Map(),
  lineasPorBrigada: new Map(),
};

function initMap() {
  const base = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20 });
  state.map = L.map("map", { center: [-12.0464, -77.0428], zoom: 13, layers: [base] });
  state.cluster = L.markerClusterGroup({ disableClusteringAtZoom: 15 });
  state.map.addLayer(state.cluster);
  ui.apply.onclick = fetchUbicaciones;
  ui.exportKmz.onclick = exportarKMZ;
}

function mostrarBrigadas(data) {
  ui.userList.innerHTML = "";
  const grupos = {};
  for (const r of data) {
    const brigada = r.brigada || "(Sin brigada)";
    if (!grupos[brigada]) grupos[brigada] = [];
    grupos[brigada].push(r);
  }
  for (const [brigada, miembros] of Object.entries(grupos)) {
    const div = document.createElement("div");
    div.className = "brigada-item";
    div.innerHTML = `<div class='brigada-header'>${miembros.map(m => `${m.tecnico || "?"} — ${m.brigada}`).join("<br>")}</div>`;
    div.onclick = () => enfocarBrigada(brigada);
    ui.userList.appendChild(div);
  }
}

function enfocarBrigada(brigada) {
  const puntos = state.puntosPorBrigada.get(brigada);
  if (puntos?.length) {
    const ultimo = puntos.at(-1);
    state.map.setView([ultimo.latitud, ultimo.longitud], 16, { animate: true });
  }
}

async function fetchUbicaciones() {
  const brigada = ui.brigada.value.trim();
  if (!brigada) return alert("Especifica una brigada");
  const hoy = new Date().toISOString().slice(0, 10);

  const { data, error } = await supa.from("ubicaciones_brigadas")
    .select("*").eq("brigada", brigada).gte("timestamp", `${hoy}T00:00:00`).order("timestamp");

  if (error || !data?.length) return alert("Sin puntos para esta brigada");

  state.puntosPorBrigada.set(brigada, data);
  state.cluster.clearLayers();

  for (const r of data) {
    const marker = L.marker([r.latitud, r.longitud]);
    state.cluster.addLayer(marker);
  }

  const coords = data.map(p => ({ lat: p.latitud, lng: p.longitud, timestamp: p.timestamp, acc: p.accuracy ?? 25 }));
  const trazado = await trazarRutaLimpia(coords);
  if (!trazado?.length) return alert("No se pudo trazar la ruta limpia con Mapbox");

  const linea = L.polyline(trazado.map(p => [p.lat, p.lng]), { color: "red", weight: 4 });
  linea.addTo(state.map);
  state.lineasPorBrigada.set(brigada, linea);
  state.rutasPorBrigada.set(brigada, trazado);
  state.map.fitBounds(linea.getBounds());
  mostrarBrigadas(data);
}

async function trazarRutaLimpia(segmento) {
  const coords = segmento.map(p => `${p.lng},${p.lat}`).join(";");
  const tsArr = segmento.map(p => Math.floor(new Date(p.timestamp).getTime() / 1000)).join(";");
  const radArr = segmento.map(p => Math.max(10, Math.min(50, p.acc || 25))).join(";");
  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}` +
    `?geometries=geojson&overview=full&tidy=true` +
    `&timestamps=${tsArr}&radiuses=${radArr}&access_token=${MAPBOX_TOKEN}`;

  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const matched = json?.matchings?.[0];
  if (!matched?.geometry?.coordinates?.length || matched.confidence < 0.5) return null;

  return matched.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
}

function exportarKMZ() {
  const brigada = ui.brigada.value.trim();
  if (!brigada) return alert("Brigada requerida para exportar");
  const ruta = state.rutasPorBrigada.get(brigada);
  if (!ruta?.length) return alert("Sin trazo para exportar");

  const coords = ruta.map(p => `${p.lng},${p.lat},0`).join(" ");
  const kml = `<?xml version='1.0' encoding='UTF-8'?>
  <kml xmlns='http://www.opengis.net/kml/2.2'>
    <Document><name>${brigada}.kml</name>
      <Placemark>
        <name>Ruta limpia ${brigada}</name>
        <Style><LineStyle><color>ff0000ff</color><width>4</width></LineStyle></Style>
        <LineString><coordinates>${coords}</coordinates></LineString>
      </Placemark>
    </Document>
  </kml>`;

  const zip = new JSZip();
  zip.file("doc.kml", kml);
  zip.generateAsync({ type: "blob" }).then(blob => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `ruta_${brigada}.kmz`;
    link.click();
  });
}

initMap();
