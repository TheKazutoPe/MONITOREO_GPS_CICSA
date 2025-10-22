// ===============================
// CLIENTE SUPABASE
// ===============================
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ===============================
// ESTADO GLOBAL
// ===============================
const state = {
  map: null,
  markers: new Map(),
  cluster: null,
  brigadas: [],
  soloActivas: false,
  modoNoche: false
};

// ===============================
// INICIALIZACIÓN
// ===============================
document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  await cargarUbicaciones();
  setInterval(cargarUbicaciones, 30000);

  document.getElementById("btnCenter").addEventListener("click", centrarBrigadas);
  document.getElementById("btnNight").addEventListener("click", toggleModoNoche);
  document.getElementById("btnActive").addEventListener("click", toggleSoloActivas);
  document.getElementById("btnRefresh").addEventListener("click", cargarUbicaciones);
  document.getElementById("exportKmzBtn").addEventListener("click", exportarKMZ);
});

// ===============================
// CONFIGURAR MAPA
// ===============================
function initMap() {
  state.map = L.map("map").setView([-12.0464, -77.0428], 10);

  state.capaDia = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19
  });

  state.capaNoche = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
    maxZoom: 19
  });

  state.capaDia.addTo(state.map);
  state.cluster = L.markerClusterGroup();
  state.map.addLayer(state.cluster);

  // Activar modo nocturno automático
  const h = new Date().getHours();
  if (h >= 18 || h < 6) toggleModoNoche(true);
}

// ===============================
// CARGAR UBICACIONES
// ===============================
async function cargarUbicaciones() {
  try {
    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .order("timestamp", { ascending: false });

    if (error) throw error;
    if (!data) return;

    state.brigadas = data;
    renderBrigadas();
    updateHeaderStatus();
  } catch (err) {
    console.error("Error al cargar ubicaciones:", err);
  }
}

// ===============================
// RENDERIZAR BRIGADAS
// ===============================
function renderBrigadas() {
  const list = document.getElementById("userList");
  list.innerHTML = "";
  state.cluster.clearLayers();

  if (state.brigadas.length === 0) {
    list.innerHTML = `<div class="placeholder">🚫 No hay brigadas conectadas</div>`;
    return;
  }

  state.brigadas.forEach((b) => {
    const lat = b.latitud, lon = b.longitud;
    if (!lat || !lon) return;

    const activo = b.activo ?? true;
    const estado = activo ? "Activo" : "Desconectado";
    const clase = activo ? "status-activo" : "status-desconectado";

    if (state.soloActivas && !activo) return;

    // === PANEL LATERAL ===
    const item = document.createElement("div");
    item.className = "brigada-item fade-in";
    item.innerHTML = `
      <div class="brigada-header">
        <div class="brigada-name">
          ${activo ? `<span class="active-icon"></span>` : ""}
          ${b.tecnico || b.usuario || "Sin nombre"}
        </div>
        <div class="brigada-hora">${new Date(b.timestamp).toLocaleTimeString()}</div>
      </div>
      <div class="brigada-info">
        <div><strong>Brigada:</strong> ${b.brigada || "—"}</div>
        <div><strong>Contrata:</strong> ${b.contrata || "—"}</div>
        <div><strong>Zona:</strong> ${b.zona || "—"}</div>
      </div>
      <div class="brigada-status ${clase}">${estado}</div>
    `;

    // === EVENTO DE CENTRAR ===
    item.addEventListener("click", () => {
      if (state.map) {
        state.map.setView([lat, lon], 16, { animate: true });
        if (state.markers.has(b.usuario)) state.markers.get(b.usuario).openPopup();
      }
    });

    list.appendChild(item);

    // === MARCADOR MAPA ===
    const icon = L.divIcon({
      className: "custom-marker",
      html: `<div class="marker-dot ${activo ? "dot-green" : "dot-red"}"></div>`,
      iconSize: [18, 18],
      popupAnchor: [0, -10]
    });

    const marker = L.marker([lat, lon], { icon }).bindPopup(`
      <b>${b.tecnico || "Brigada"}</b><br>
      <b>Brigada:</b> ${b.brigada || "—"}<br>
      <b>Contrata:</b> ${b.contrata || "—"}<br>
      <b>Zona:</b> ${b.zona || "—"}<br>
      <b>Hora:</b> ${new Date(b.timestamp).toLocaleTimeString()}
    `);

    state.cluster.addLayer(marker);
    state.markers.set(b.usuario, marker);
  });

  updateHeaderStatus();
}

// ===============================
// CONTADOR CABECERA
// ===============================
function updateHeaderStatus() {
  const info = document.getElementById("statusInfo");
  const last = document.getElementById("lastUpdate");

  const total = state.brigadas.length;
  const activos = state.brigadas.filter(b => b.activo).length;
  const desconectados = total - activos;

  info.textContent = `🟢 ${activos} Activas | 🟡 0 Inactivas | 🔴 ${desconectados} Desconectadas`;
  last.textContent = `Última actualización: ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const status = document.getElementById("status");
  status.textContent = "CONECTADO";
  status.className = "status-badge green";
}

// ===============================
// BOTONES DE INTERFAZ
// ===============================
function centrarBrigadas() {
  if (state.cluster && state.cluster.getLayers().length > 0) {
    state.map.fitBounds(state.cluster.getBounds(), { padding: [50, 50] });
  }
}

function toggleModoNoche(forzar) {
  const activar = typeof forzar === "boolean" ? forzar : !state.modoNoche;
  state.modoNoche = activar;

  if (activar) {
    state.map.removeLayer(state.capaDia);
    state.map.addLayer(state.capaNoche);
    document.body.classList.add("modo-noche");
  } else {
    state.map.removeLayer(state.capaNoche);
    state.map.addLayer(state.capaDia);
    document.body.classList.remove("modo-noche");
  }
}

function toggleSoloActivas() {
  state.soloActivas = !state.soloActivas;
  const btn = document.getElementById("btnActive");
  btn.textContent = state.soloActivas ? "🟢 Mostrar todas" : "🟢 Solo Activas";
  renderBrigadas();
}

// ===============================
// EXPORTACIÓN KMZ (manteniendo tu lógica original)
// ===============================
async function exportarKMZ() {
  try {
    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .order("timestamp", { ascending: true });

    if (error) throw error;
    if (!data || data.length === 0) return alert("No hay datos para exportar.");

    const zip = new JSZip();
    const kmlContent = buildKML(data);
    zip.file(`recorrido_brigadas_${new Date().toISOString()}.kml`, kmlContent);

    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `REPORTE_BRIGADAS_${new Date().toISOString().slice(0,10)}.kmz`;
    a.click();
  } catch (err) {
    console.error("Error al exportar KMZ:", err);
  }
}

// ===============================
// FUNCIÓN: CREAR KML (misma estructura base tuya)
// ===============================
function buildKML(data) {
  let kml = `<?xml version="1.0" encoding="UTF-8"?>
  <kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Recorrido Brigadas</name>`;

  // Agrupar por brigada
  const porBrigada = {};
  data.forEach(d => {
    if (!porBrigada[d.brigada]) porBrigada[d.brigada] = [];
    porBrigada[d.brigada].push([d.longitud, d.latitud]);
  });

  Object.entries(porBrigada).forEach(([brig, coords]) => {
    const line = coords.map(c => c.join(",")).join(" ");
    kml += `<Placemark><name>${brig}</name><LineString><coordinates>${line}</coordinates></LineString></Placemark>`;
  });

  kml += `</Document></kml>`;
  return kml;
}
