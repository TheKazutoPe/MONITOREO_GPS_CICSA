// ===========================
// main.js (versión final)
// ===========================
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
let map, markers = new Map(), brigadasActivas = new Set();

// Colores dinámicos por brigada
function getColor(brigada) {
  let hash = 0;
  for (let i = 0; i < brigada.length; i++)
    hash = brigada.charCodeAt(i) + ((hash << 5) - hash);
  const c = (hash & 0x00FFFFFF)
    .toString(16)
    .toUpperCase();
  return "#" + "00000".substring(0, 6 - c.length) + c;
}

// Inicialización del mapa
function initMap() {
  map = L.map("map").setView([-12.06, -77.04], 12);
  const baseLayers = {
    "OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
    }),
    "Claro": L.tileLayer("https://tile.openstreetmap.fr/hot/{z}/{x}/{y}.png"),
    "Oscuro": L.tileLayer("https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png"),
    "Satélite": L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=${CONFIG.MAPBOX_TOKEN}`
    ),
  };
  baseLayers["OpenStreetMap"].addTo(map);

  document.getElementById("baseMapSel").addEventListener("change", e => {
    Object.values(baseLayers).forEach(layer => map.removeLayer(layer));
    baseLayers[e.target.value].addTo(map);
  });
}

// Cargar brigadas activas (<5 min)
async function cargarBrigadasActivas() {
  const status = document.getElementById("status");
  const lista = document.getElementById("userList");

  const ahora = new Date();
  const hace5Min = new Date(ahora.getTime() - 5 * 60 * 1000).toISOString();

  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("tecnico, brigada, contrata, zona, latitud, longitud, timestamp_pe")
    .gte("timestamp_pe", hace5Min)
    .order("timestamp_pe", { ascending: false });

  if (error) {
    console.error(error);
    status.className = "status gray";
    status.textContent = "Desconectado";
    return;
  }

  status.className = "status green";
  status.textContent = "Conectado";
  lista.innerHTML = "";
  const nuevasActivas = new Set();

  data.forEach(row => {
    if (!row.latitud || !row.longitud) return;

    const brigKey = row.brigada || "Sin-ID";
    nuevasActivas.add(brigKey);
    const color = getColor(brigKey);

    // Crear o actualizar marcador
    if (!markers.has(brigKey)) {
      const icon = L.icon({
        iconUrl: "assets/carro-animado.png",
        iconSize: [45, 45],
        className: "car-icon",
      });

      const marker = L.marker([row.latitud, row.longitud], { icon }).addTo(map);
      marker.bindPopup(`
        🚗 <b>Brigada:</b> ${brigKey}<br>
        👷 <b>Técnico:</b> ${row.tecnico || "-"}<br>
        🏢 <b>Contrata:</b> ${row.contrata || "-"}<br>
        🌎 <b>Zona:</b> ${row.zona || "-"}<br>
        🕒 <b>Última act.:</b> ${timeAgo(row.timestamp_pe)}
      `);
      markers.set(brigKey, marker);
    } else {
      markers.get(brigKey).setLatLng([row.latitud, row.longitud]);
    }

    // Agregar a la lista
    const li = document.createElement("li");
    li.textContent = `${row.tecnico || "Sin técnico"} — ${brigKey}`;
    li.style.color = color;
    li.onclick = () => map.panTo([row.latitud, row.longitud]);
    lista.appendChild(li);
  });

  // Eliminar las brigadas inactivas
  markers.forEach((m, k) => {
    if (!nuevasActivas.has(k)) {
      map.removeLayer(m);
      markers.delete(k);
    }
  });

  document.getElementById("bottom-panel").classList.add("visible");
}

// Convertir fecha a “hace x min”
function timeAgo(fechaStr) {
  const diff = (Date.now() - new Date(fechaStr)) / 1000;
  if (diff < 60) return "hace unos segundos";
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  return `hace ${Math.floor(diff / 3600)} h`;
}

// Exportar KMZ global
async function exportarKMZ() {
  const ahora = new Date();
  const inicio = new Date();
  inicio.setHours(0, 0, 0, 0);

  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("brigada, tecnico, contrata, latitud, longitud, timestamp_pe")
    .gte("timestamp_pe", inicio.toISOString())
    .order("timestamp_pe", { ascending: true });

  if (error) {
    alert("Error al obtener datos para exportar.");
    return;
  }

  const kmz = await generarKMZ(data);
  const blob = new Blob([kmz], { type: "application/vnd.google-earth.kmz" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const nombre = `Rutas_Brigadas_${ahora.toISOString().slice(0, 19).replace(/[-:T]/g, "_")}.kmz`;
  link.href = url;
  link.download = nombre;
  link.click();
}

// Generar KMZ completo
async function generarKMZ(data) {
  const grupos = {};
  for (const d of data) {
    if (!d.latitud || !d.longitud) continue;
    const b = d.brigada || "Sin-ID";
    if (!grupos[b]) grupos[b] = [];
    grupos[b].push(d);
  }

  let kml = `<?xml version="1.0" encoding="UTF-8"?>
  <kml xmlns="http://www.opengis.net/kml/2.2"><Document>`;

  for (const [brig, puntos] of Object.entries(grupos)) {
    const color = getColor(brig).replace("#", "FF");
    kml += `<Folder><name>${brig} — ${puntos[0]?.tecnico || ""} — ${puntos[0]?.contrata || ""}</name>`;
    kml += `<Style><LineStyle><color>${color}</color><width>3</width></LineStyle></Style>`;
    kml += "<Placemark><LineString><tessellate>1</tessellate><coordinates>";

    for (const p of puntos)
      kml += `${p.longitud},${p.latitud},0 `;

    kml += "</coordinates></LineString></Placemark></Folder>";
  }

  kml += "</Document></kml>";
  return kml;
}

// ========================
// INICIALIZACIÓN
// ========================
window.addEventListener("DOMContentLoaded", () => {
  initMap();
  cargarBrigadasActivas();
  setInterval(cargarBrigadasActivas, 20000);
  document.getElementById("applyFilters").onclick = cargarBrigadasActivas;
  document.getElementById("exportKmzBtn").onclick = exportarKMZ;
});
