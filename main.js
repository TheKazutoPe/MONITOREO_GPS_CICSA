// ===============================
//  CICSA Monitoreo GPS PRO
//  Lógica principal (versión corregida)
// ===============================

// Extrae configuración global
const { SUPABASE_URL, SUPABASE_ANON_KEY, MAPBOX_TOKEN, DEFAULT_CENTER, DEFAULT_ZOOM } = CONFIG;

// Inicializa Supabase correctamente
const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let map, markers = {}, mapMode = "mapbox";
let lastUpdateTime = null;

// ===============================
//  Inicialización del mapa
// ===============================
function initMap() {
  const container = document.getElementById("map");
  container.innerHTML = ""; // limpia si cambia de modo

  if (mapMode === "mapbox") {
    mapboxgl.accessToken = MAPBOX_TOKEN;
    map = new mapboxgl.Map({
      container: "map",
      style: "mapbox://styles/mapbox/dark-v11",
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

// Cambiar modo de mapa dinámicamente
document.getElementById("mapMode").addEventListener("change", (e) => {
  mapMode = e.target.value;
  initMap();
  loadRealtimeData();
});

// ===============================
//  Actualización de datos en tiempo real
// ===============================
async function loadRealtimeData() {
  try {
    document.getElementById("status").innerText = "Conectando...";
    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .order("timestamp_pe", { ascending: false })
      .limit(200);

    if (error) throw error;
    if (data && data.length > 0) {
      renderBrigadas(data);
      document.getElementById("status").innerText = "Conectado ✅";
    } else {
      document.getElementById("status").innerText = "Sin datos ⚠️";
    }
  } catch (err) {
    console.error("Error al cargar datos:", err);
    document.getElementById("status").innerText = "Desconectado ⚠️";
  }
}

// ===============================
//  Renderizado de brigadas
// ===============================
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

// ===============================
//  Dibujar y animar marcadores
// ===============================
function drawMarker(p, color) {
  if (!p.latitud || !p.longitud) return;
  const key = p.brigada;

  // Animación de movimiento
  const animate = (marker, newLat, newLng) => {
    const start = marker.getLatLng();
    const latDiff = newLat - start.lat;
    const lngDiff = newLng - start.lng;
    let step = 0;
    const interval = setInterval(() => {
      step += 0.05;
      if (step >= 1) {
        clearInterval(interval);
        marker.setLatLng([newLat, newLng]);
      } else {
        marker.setLatLng([
          start.lat + latDiff * step,
          start.lng + lngDiff * step
        ]);
      }
    }, 25);
  };

  if (mapMode === "mapbox") {
    if (markers[key]) {
      markers[key].setLngLat([p.longitud, p.latitud]);
    } else {
      const el = document.createElement("div");
      el.className = "marker";
      el.style.backgroundImage = "url('assets/carro-green.png')";
      el.style.backgroundSize = "cover";
      el.style.width = "24px";
      el.style.height = "24px";
      el.style.borderRadius = "50%";
      markers[key] = new mapboxgl.Marker(el)
        .setLngLat([p.longitud, p.latitud])
        .addTo(map);
    }
  } else {
    if (markers[key]) {
      animate(markers[key], p.latitud, p.longitud);
    } else {
      markers[key] = L.marker([p.latitud, p.longitud], {
        icon: L.icon({
          iconUrl: "assets/carro-green.png",
          iconSize: [26, 26],
        })
      }).addTo(map);
    }
  }
}

// ===============================
//  Exportaciones (KMZ y CSV)
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

  const { data } = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .eq("brigada", brigada)
    .gte("timestamp_pe", start.toISOString())
    .lt("timestamp_pe", end.toISOString())
    .order("timestamp_pe", { ascending: true });

  return data || [];
}

// --- MAP MATCHING ---
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
  <Style id="line"><LineStyle><color>ff00ff00</color><width>3</width></LineStyle></Style>
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
//  Auto Refresh
// ===============================
setInterval(loadRealtimeData, 30000);
loadRealtimeData();
