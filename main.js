// ===============================
//  CICSA Monitoreo GPS PRO
//  Lógica principal
// ===============================

const { SUPABASE_URL, SUPABASE_ANON_KEY, MAPBOX_TOKEN, DEFAULT_CENTER, DEFAULT_ZOOM } = CONFIG;
const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let map, markers = {}, mapMode = "mapbox";
let lastUpdateTime = null;

// Inicialización del mapa
function initMap() {
  if (mapMode === "mapbox") {
    mapboxgl.accessToken = MAPBOX_TOKEN;
    map = new mapboxgl.Map({
      container: "map",
      style: "mapbox://styles/mapbox/streets-v12",
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
    });
  } else {
    map = L.map("map").setView([DEFAULT_CENTER[1], DEFAULT_CENTER[0]], DEFAULT_ZOOM);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
  }
}
initMap();

// Escucha de cambio de modo de mapa
document.getElementById("mapMode").addEventListener("change", (e) => {
  mapMode = e.target.value;
  document.getElementById("map").innerHTML = "";
  initMap();
  loadRealtimeData();
});

// ===============================
//  Actualización en tiempo real
// ===============================
async function loadRealtimeData() {
  const { data } = await supabase
    .from("ubicaciones_brigadas")
    .select("*")
    .order("timestamp_pe", { ascending: false })
    .limit(200);

  if (data) renderBrigadas(data);
}

function renderBrigadas(data) {
  const userList = document.getElementById("userList");
  userList.innerHTML = "";

  const brigadasMap = new Map();
  data.forEach((p) => {
    if (!brigadasMap.has(p.brigada)) brigadasMap.set(p.brigada, p);
  });

  let active = 0, inactive = 0, off = 0;

  brigadasMap.forEach((p) => {
    const ts = new Date(p.timestamp_pe);
    const now = new Date();
    const diffMin = (now - ts) / 60000;
    let color = "#6b7280", state = "Inactivo";

    if (diffMin < 3) {
      color = "#10b981"; state = "Activo"; active++;
    } else if (diffMin < 10) {
      color = "#fbbf24"; state = "Reciente"; inactive++;
    } else {
      color = "#ef4444"; state = "Desconectado"; off++;
    }

    // Crear tarjeta lateral
    const div = document.createElement("div");
    div.className = "brigada-item glass";
    div.innerHTML = `
      <div class="brigada-header">
        <span>${p.brigada}</span>
        <span style="color:${color};font-weight:600;">${state}</span>
      </div>
      <div class="brigada-body">
        <small><b>Técnico:</b> ${p.tecnico || "Sin registro"}</small><br/>
        <small><b>Contrata:</b> ${p.contrata || "-"}</small><br/>
        <small><b>Zona:</b> ${p.zona || "-"}</small><br/>
        <small><b>Velocidad:</b> ${(p.spd || 0).toFixed(1)} km/h</small>
      </div>
    `;
    div.onclick = () => {
      if (mapMode === "mapbox") {
        map.flyTo({ center: [p.longitud, p.latitud], zoom: 16 });
      } else {
        map.setView([p.latitud, p.longitud], 16);
      }
    };
    userList.appendChild(div);

    // Animar marcador en mapa
    drawMarker(p, color);
  });

  document.getElementById("countActive").innerText = active;
  document.getElementById("countInactive").innerText = inactive;
  document.getElementById("countOff").innerText = off;

  lastUpdateTime = new Date();
  document.getElementById("lastUpdate").innerText =
    `Última actualización: ${lastUpdateTime.toLocaleTimeString("es-PE", { hour: '2-digit', minute: '2-digit' })}`;
}

function drawMarker(p, color) {
  if (!p.latitud || !p.longitud) return;
  const key = p.brigada;

  if (mapMode === "mapbox") {
    if (markers[key]) markers[key].remove();
    const el = document.createElement("div");
    el.className = "marker";
    el.style.background = color;
    el.style.width = "14px";
    el.style.height = "14px";
    el.style.borderRadius = "50%";
    markers[key] = new mapboxgl.Marker(el)
      .setLngLat([p.longitud, p.latitud])
      .addTo(map);
  } else {
    if (markers[key]) map.removeLayer(markers[key]);
    markers[key] = L.circleMarker([p.latitud, p.longitud], {
      color, radius: 6, fillOpacity: 0.8
    }).addTo(map);
  }
}

// ===============================
//  Exportación KMZ / CSV
// ===============================
document.getElementById("exportBtn").addEventListener("click", () => {
  document.getElementById("modalExport").style.display = "flex";
});
document.getElementById("closeModal").addEventListener("click", () => {
  document.getElementById("modalExport").style.display = "none";
});

async function getDataByBrigadaAndDate(brigada, fecha) {
  const start = new Date(fecha);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const { data } = await supabase
    .from("ubicaciones_brigadas")
    .select("*")
    .eq("brigada", brigada)
    .gte("timestamp_pe", start.toISOString())
    .lt("timestamp_pe", end.toISOString())
    .order("timestamp_pe", { ascending: true });

  return data || [];
}

// --- MAP MATCHING con Mapbox API ---
async function mapMatchRoute(points) {
  if (!points.length) return [];
  const coords = points.map(p => `${p.longitud},${p.latitud}`).join(";");
  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?geometries=geojson&tidy=true&access_token=${MAPBOX_TOKEN}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    return data.matchings?.[0]?.geometry?.coordinates || [];
  } catch (err) {
    console.error("Map Matching error:", err);
    return [];
  }
}

// --- KMZ Export ---
document.getElementById("exportKmzBtn").addEventListener("click", async () => {
  const brigada = document.getElementById("brigadaSelect").value.trim();
  const fecha = document.getElementById("fechaSelect").value;
  if (!brigada || !fecha) return alert("Completa todos los campos.");

  const data = await getDataByBrigadaAndDate(brigada, fecha);
  if (!data.length) return alert("No hay datos para esa brigada/fecha.");

  const matched = await mapMatchRoute(data);
  if (!matched.length) return alert("No se pudo generar el trazo.");

  let kml = `<?xml version="1.0" encoding="UTF-8"?>
  <kml xmlns="http://www.opengis.net/kml/2.2">
  <Document><name>${brigada}_${fecha}</name>
  <Style id="line"><LineStyle><color>ff0000ff</color><width>3</width></LineStyle></Style>
  <Placemark><styleUrl>#line</styleUrl><LineString><coordinates>`;

  matched.forEach(c => kml += `${c[0]},${c[1]},0 `);
  kml += `</coordinates></LineString></Placemark></Document></kml>`;

  const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${brigada}_${fecha}.kmz`;
  a.click();
});

// --- CSV Export ---
document.getElementById("exportCsvBtn").addEventListener("click", async () => {
  const brigada = document.getElementById("brigadaSelect").value.trim();
  const fecha = document.getElementById("fechaSelect").value;
  if (!brigada || !fecha) return alert("Completa todos los campos.");

  const data = await getDataByBrigadaAndDate(brigada, fecha);
  if (!data.length) return alert("No hay datos para esa brigada/fecha.");

  const rows = [["Latitud", "Longitud", "Fecha", "Velocidad", "Precisión"]];
  data.forEach(d => rows.push([d.latitud, d.longitud, d.timestamp_pe, d.spd, d.acc]));

  const csv = rows.map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${brigada}_${fecha}.csv`;
  a.click();
});

// ===============================
//  Auto Refresh y Actualización
// ===============================
setInterval(loadRealtimeData, 30000); // cada 30 segundos
loadRealtimeData();
