// ==========================
//  MONITOREO GPS - MAPBOX GL
//  Kevin (CICSA 2025)
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
    style: "mapbox://styles/mapbox/streets-v12", // mapa colorido
    center: [-77.0428, -12.0464], // Lima
    zoom: 12
  });

  state.map.addControl(new mapboxgl.NavigationControl());
  state.map.addControl(new mapboxgl.FullscreenControl());
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

function distMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s1 =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) *
      Math.cos(b.lat * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s1), Math.sqrt(1 - s1));
}

// ===== Cargar brigadas =====
async function fetchBrigadas() {
  setStatus("Cargando brigadas...", "gray");
  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("usuario_id, tecnico, brigada, latitud, longitud, timestamp")
    .gte("timestamp", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("timestamp", { ascending: false });

  if (error) {
    console.error(error);
    setStatus("Error al cargar", "gray");
    return;
  }

  const grouped = new Map();
  for (const row of data) {
    const id = String(row.usuario_id || "0");
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
    <div class="brigada-footer">${color === "text-green" ? "Activo" : color === "text-yellow" ? "Inactivo" : "Desconectado"}</div>
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
    <b>${r.tecnico || "Sin nombre"}</b><br>
    Brigada: ${r.brigada || "-"}<br>
    Hora: ${new Date(r.timestamp).toLocaleTimeString()}
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
      const id = String(row.usuario_id || "0");
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

  const { data } = await supa.from("ubicaciones_brigadas").select("brigada").not("brigada", "is", null);
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

    if (error) throw new Error("Error Supabase");
    if (!data || data.length < 2) {
      alert("⚠️ No hay datos para esa brigada y fecha.");
      return;
    }

    // Construir KML
    let kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${brigada} - ${fecha}</name>`;
    const coords = data.map(r => `${r.longitud},${r.latitud},0`).join(" ");
    kml += `<Placemark><name>${brigada}</name><Style><LineStyle><color>ff007bff</color><width>4</width></LineStyle></Style><LineString><coordinates>${coords}</coordinates></LineString></Placemark>`;
    kml += `</Document></kml>`;

    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${brigada}_${fecha}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);

    alert("✅ KMZ generado correctamente.");
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
