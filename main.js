const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
let map, markers = new Map();
let mapboxLayer, leafletLayer, currentProvider = "mapbox";

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  loadRealtimeData();
  setInterval(loadRealtimeData, 15000);
  document.getElementById("exportBtn").addEventListener("click", openExportModal);
  document.getElementById("providerSelect").addEventListener("change", switchProvider);
});

/* ===== MAPAS ===== */
function initMap() {
  mapboxgl.accessToken = CONFIG.MAPBOX_TOKEN;
  mapboxLayer = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/streets-v12",
    center: [-77.03, -12.05],
    zoom: 12
  });

  leafletLayer = L.map("map2", {
    center: [-12.05, -77.03],
    zoom: 12,
    layers: [L.tileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png")]
  });

  document.getElementById("map2").style.display = "none";
  map = mapboxLayer;
}

function switchProvider(e) {
  const val = e.target.value;
  if (val === "leaflet") {
    document.getElementById("map").style.display = "none";
    document.getElementById("map2").style.display = "block";
    map = leafletLayer;
    currentProvider = "leaflet";
  } else {
    document.getElementById("map2").style.display = "none";
    document.getElementById("map").style.display = "block";
    map = mapboxLayer;
    currentProvider = "mapbox";
  }
}

/* ===== CARGA BRIGADAS ===== */
async function loadRealtimeData() {
  const { data } = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .order("timestamp_pe", { ascending: false })
    .limit(200);

  if (!data) return;
  const grouped = {};
  for (const r of data) {
    if (!r.brigada || !r.latitud || !r.longitud) continue;
    if (!grouped[r.brigada]) grouped[r.brigada] = [];
    grouped[r.brigada].push(r);
  }
  renderBrigadas(grouped);
}

/* ===== RENDER BRIGADAS ===== */
function renderBrigadas(grouped) {
  const list = document.getElementById("brigadaList");
  list.innerHTML = "";

  for (const [brigada, rows] of Object.entries(grouped)) {
    const last = rows[0];
    const lat = parseFloat(last.latitud);
    const lng = parseFloat(last.longitud);

    if (!markers.has(brigada)) {
      const el = document.createElement("img");
      el.src = "assets/carro-green.png";
      el.style.width = "28px";
      el.style.height = "28px";
      const marker = new mapboxgl.Marker(el).setLngLat([lng, lat]).addTo(mapboxLayer);
      markers.set(brigada, marker);
    } else animateMarker(markers.get(brigada), lat, lng);

    const card = document.createElement("div");
    card.className = "brigada-card";
    card.innerHTML = `<h3>${brigada}</h3>
      <p><b>Técnico:</b> ${last.tecnico || "-"}</p>
      <p><b>Zona:</b> ${last.zona || "-"}</p>
      <p><b>Contrata:</b> ${last.contrata || "-"}</p>`;
    card.onclick = () => map.flyTo({ center: [lng, lat], zoom: 15 });
    list.appendChild(card);
  }
}

/* ===== ANIMACIÓN ===== */
function animateMarker(marker, lat, lng) {
  if (!marker) return;
  const start = marker.getLngLat();
  const steps = 15;
  let i = 0;
  const step = () => {
    i++;
    marker.setLngLat([
      start.lng + (lng - start.lng) * (i / steps),
      start.lat + (lat - start.lat) * (i / steps)
    ]);
    if (i < steps) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ===== MODAL EXPORTACIÓN ===== */
async function openExportModal() {
  const modal = document.createElement("div");
  modal.className = "modal-export";
  modal.innerHTML = `
    <div class="modal-content">
      <h2>Exportar recorrido</h2>
      <label>Brigada:</label>
      <select id="brigadaSelect"></select>
      <label>Fecha:</label>
      <input type="date" id="fechaSelect" value="${new Date().toISOString().split('T')[0]}">
      <div class="modal-actions">
        <button id="btnCancelar">Cancelar</button>
        <button id="btnCSV">CSV</button>
        <button id="btnKMZ">KMZ</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const { data } = await supa.from("ubicaciones_brigadas").select("brigada");
  const brigadas = [...new Set(data.map(r => r.brigada))].sort();
  document.getElementById("brigadaSelect").innerHTML = brigadas.map(b => `<option>${b}</option>`).join("");

  modal.querySelector("#btnCancelar").onclick = () => modal.remove();
  modal.querySelector("#btnKMZ").onclick = async () => {
    await generarKMZ(getValues(modal)); modal.remove();
  };
  modal.querySelector("#btnCSV").onclick = async () => {
    await generarCSV(getValues(modal)); modal.remove();
  };
}

function getValues(modal) {
  return {
    brigada: modal.querySelector("#brigadaSelect").value,
    fecha: modal.querySelector("#fechaSelect").value
  };
}

/* ===== GENERAR KMZ ===== */
async function generarKMZ({ brigada, fecha }) {
  const { data } = await supa.from("ubicaciones_brigadas")
    .select("latitud,longitud,timestamp_pe")
    .eq("brigada", brigada)
    .gte("timestamp_pe", `${fecha} 00:00:00`)
    .lte("timestamp_pe", `${fecha} 23:59:59`)
    .order("timestamp_pe");

  if (!data?.length) return alert("No hay registros.");

  const coords = data.map(r => [r.longitud, r.latitud]);
  const coordStr = coords.map(c => c.join(",")).join(";");
  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coordStr}?geometries=geojson&access_token=${CONFIG.MAPBOX_TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();
  const geom = json.matchings?.[0]?.geometry;
  if (!geom) return alert("No se pudo generar el trazo con Mapbox.");

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
  <kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <name>${brigada}_${fecha}</name>
  <Placemark><LineString><coordinates>${geom.coordinates.map(c => c.join(",")).join(" ")}</coordinates></LineString></Placemark>
  </Document></kml>`;

  const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${brigada}_${fecha}.kml`;
  link.click();
}

/* ===== GENERAR CSV ===== */
async function generarCSV({ brigada, fecha }) {
  const { data } = await supa.from("ubicaciones_brigadas")
    .select("*")
    .eq("brigada", brigada)
    .gte("timestamp_pe", `${fecha} 00:00:00`)
    .lte("timestamp_pe", `${fecha} 23:59:59`)
    .order("timestamp_pe");

  if (!data?.length) return alert("No hay registros para CSV.");

  const headers = Object.keys(data[0]).join(",");
  const rows = data.map(r => Object.values(r).join(","));
  const csv = [headers, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${brigada}_${fecha}.csv`;
  link.click();
}
