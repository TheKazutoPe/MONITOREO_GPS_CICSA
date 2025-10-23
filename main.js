// ==========================
//  MONITOREO GPS - MAPBOX GL
//  Kevin (CICSA 2025) - Versión PRO Azul Oscuro
// ==========================

// ===== Configuración principal =====
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;
mapboxgl.accessToken = MAPBOX_TOKEN;

// ===== Referencias UI =====
const ui = {
  status: document.getElementById("status"),
  brigadaFilter: document.getElementById("brigadaFilter"),
  applyFilters: document.getElementById("applyFilters"),
  userList: document.getElementById("userList"),
  openKmzModal: document.getElementById("openKmzModal"),
  kmzModal: document.getElementById("kmzModal"),
  brigadaSelect: document.getElementById("brigadaSelect"),
  fechaSelect: document.getElementById("fechaSelect"),
  cancelKmz: document.getElementById("cancelKmz"),
  generateKmz: document.getElementById("generateKmz")
};

// ===== Estado =====
const state = {
  map: null,
  markers: {},
  brigadas: new Map()
};

// ===== Inicializar mapa =====
function initMap() {
  state.map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/streets-v12", // mapa colorido pro
    center: [-77.0428, -12.0464], // Lima
    zoom: 12
  });

  state.map.addControl(new mapboxgl.NavigationControl(), "bottom-right");
  state.map.addControl(new mapboxgl.FullscreenControl(), "bottom-right");
}
initMap();

// ===== Utilidades =====
function setStatus(text, color) {
  ui.status.textContent = text;
  ui.status.className = `status-badge ${color}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ===== Cargar brigadas =====
async function fetchBrigadas() {
  setStatus("Cargando brigadas...", "gray");

  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("usuario_id, tecnico, brigada, contrata, zona, latitud, longitud, timestamp")
    .gte("timestamp", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("timestamp", { ascending: false });

  if (error) {
    console.error(error);
    setStatus("Error al cargar", "gray");
    return;
  }

  const grouped = new Map();
  for (const row of data) {
    const id = String(row.usuario_id || row.brigada || "0");
    if (!grouped.has(id)) grouped.set(id, row);
  }

  state.brigadas.clear();
  ui.userList.innerHTML = "";

  grouped.forEach((r, id) => {
    const lastSeen = new Date(r.timestamp);
    const mins = Math.round((Date.now() - lastSeen) / 60000);
    let color = "text-gray";
    if (mins <= 2) color = "text-green";
    else if (mins <= 5) color = "text-yellow";

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
        <div>
          <b>${r.tecnico || "Sin nombre"}</b>
          <div class="brigada-sub">${r.brigada || "-"}</div>
        </div>
      </div>
      <div class="brigada-hora">${hora}</div>
    </div>
    <div class="brigada-footer">
      ${color === "text-green" ? "Activo" : color === "text-yellow" ? "Inactivo" : "Desconectado"}
    </div>
  `;
  div.addEventListener("click", () => focusBrigada(id));
  ui.userList.appendChild(div);
}

function placeMarker(r, id, color) {
  const iconUrl =
    color === "text-green"
      ? "assets/carro-green.png"
      : color === "text-yellow"
      ? "assets/carro-orange.png"
      : "assets/carro-gray.png";

  const el = document.createElement("div");
  el.className = "marker";
  el.style.backgroundImage = `url(${iconUrl})`;
  el.style.width = "40px";
  el.style.height = "24px";
  el.style.backgroundSize = "contain";

  const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(`
  <div style="font-family: 'Inter', sans-serif; background: rgba(0, 51, 102, 0.9);
              color: white; padding: 8px 10px; border-radius: 8px; min-width: 150px;">
    <b style="font-size:14px; color:#00bfff;">${r.tecnico || "Sin nombre"}</b><br>
    <span style="font-size:13px;">🚧 Brigada: <b>${r.brigada || "-"}</b></span><br>
    <span style="font-size:13px;">📍 Zona: <b>${r.zona || "-"}</b></span><br>
    <span style="font-size:12px; opacity:0.8;">🕒 ${new Date(r.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
  </div>
`);


  const marker = new mapboxgl.Marker(el).setLngLat([r.longitud, r.latitud]).setPopup(popup).addTo(state.map);
  state.markers[id] = marker;
}

function focusBrigada(id) {
  const r = state.brigadas.get(id);
  if (!r) return;
  state.map.flyTo({ center: [r.longitud, r.latitud], zoom: 15 });
  const marker = state.markers[id];
  if (marker) marker.togglePopup();
}

// ===== Realtime =====
function subscribeRealtime() {
  supa
    .channel("ubicaciones_brigadas-updates")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_brigadas" }, payload => {
      const row = payload.new;
      const id = String(row.usuario_id || row.brigada || "0");
      const last = state.brigadas.get(id);
      if (!last) {
        fetchBrigadas();
        return;
      }
      const marker = state.markers[id];
      if (marker) {
        marker.setLngLat([row.longitud, row.latitud]);
        state.brigadas.set(id, row);
      }
    })
    .subscribe();
}

// ===== Modal KMZ =====
ui.openKmzModal.addEventListener("click", async () => {
  ui.kmzModal.classList.remove("hidden");
  ui.brigadaSelect.innerHTML = `<option value="">Cargando...</option>`;

  const { data } = await supa
    .from("ubicaciones_brigadas")
    .select("brigada")
    .not("brigada", "is", null);

  const unique = [...new Set(data.map(r => r.brigada))].filter(Boolean);
  ui.brigadaSelect.innerHTML = unique.map(b => `<option value="${b}">${b}</option>`).join("");
  ui.fechaSelect.valueAsDate = new Date();
});

ui.cancelKmz.addEventListener("click", () => {
  ui.kmzModal.classList.add("hidden");
});

ui.generateKmz.addEventListener("click", async () => {
  const brigada = ui.brigadaSelect.value;
  const fecha = ui.fechaSelect.value;
  if (!brigada || !fecha) {
    alert("Selecciona brigada y fecha");
    return;
  }
  ui.kmzModal.classList.add("hidden");
  await exportKMZ(brigada, fecha);
});

// ===== Exportar KMZ =====
async function exportKMZ(brigada, fecha) {
  try {
    setStatus("Generando KMZ...", "gray");
    const start = new Date(fecha);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);

    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", start.toISOString())
      .lt("timestamp", end.toISOString())
      .ilike("brigada", `%${brigada}%`)
      .order("timestamp", { ascending: true });

    if (error) throw new Error("Error al consultar Supabase");
    if (!data || data.length < 2) {
      alert("⚠️ No hay datos para esa brigada y fecha.");
      return;
    }

    // === Construcción de KML ===
    const inicio = data[0];
    const fin = data[data.length - 1];
    const coords = data.map(r => `${r.longitud},${r.latitud},0`).join(" ");

    let descripcion = `
      <b>Brigada:</b> ${brigada}<br>
      <b>Técnico:</b> ${inicio.tecnico || "No registrado"}<br>
      <b>Zona:</b> ${inicio.zona || "-"}<br>
      <b>Puntos:</b> ${data.length}<br>
      <b>Inicio:</b> ${new Date(inicio.timestamp).toLocaleString()}<br>
      <b>Fin:</b> ${new Date(fin.timestamp).toLocaleString()}
    `;

    let kml = `<?xml version="1.0" encoding="UTF-8"?>
      <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document>
        <name>Recorrido ${brigada} - ${fecha}</name>
        <description><![CDATA[${descripcion}]]></description>
        <Style id="lineaAzul">
          <LineStyle><color>ff007bff</color><width>4</width></LineStyle>
        </Style>

        <Placemark>
          <name>Ruta - ${brigada}</name>
          <styleUrl>#lineaAzul</styleUrl>
          <LineString><coordinates>${coords}</coordinates></LineString>
        </Placemark>

        <Placemark>
          <name>Inicio</name>
          <Point><coordinates>${inicio.longitud},${inicio.latitud},0</coordinates></Point>
        </Placemark>

        <Placemark>
          <name>Fin</name>
          <Point><coordinates>${fin.longitud},${fin.latitud},0</coordinates></Point>
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

    alert(`✅ KMZ generado correctamente para ${brigada}\nPuntos: ${data.length}`);
  } catch (err) {
    console.error(err);
    alert("❌ Error al generar KMZ: " + err.message);
  } finally {
    setStatus("Conectado", "green");
  }
}

// ===== Eventos =====
ui.applyFilters.addEventListener("click", fetchBrigadas);

// ===== Inicio =====
fetchBrigadas();
subscribeRealtime();
setStatus("Cargando...", "gray");
