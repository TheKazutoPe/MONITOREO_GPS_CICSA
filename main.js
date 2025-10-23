// ==================== CONFIGURACIÓN GLOBAL ====================
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
mapboxgl.accessToken = CONFIG.MAPBOX_TOKEN;

const ui = {
  status: document.getElementById("status"),
  exportBtn: document.getElementById("exportKmzBtn"),
  brigadaSelect: document.getElementById("brigadaSelect"),
  fechaSelect: document.getElementById("fechaSelect"),
  userList: document.getElementById("userList"),
};

const state = { map: null, markers: {}, brigadas: new Map() };

// ==================== MAPA MAPBOX ====================
function initMap() {
  state.map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/streets-v12",
    center: [-77.0428, -12.0464],
    zoom: 13,
  });
  state.map.addControl(new mapboxgl.NavigationControl(), "bottom-right");
  state.map.addControl(new mapboxgl.FullscreenControl(), "bottom-right");
}
initMap();

// ==================== UTILIDADES ====================
function setStatus(text, color) {
  ui.status.textContent = text;
  ui.status.className = `status-badge ${color}`;
}

function showToast(text, color = "#00c851") {
  const toast = document.createElement("div");
  toast.textContent = text;
  Object.assign(toast.style, {
    position: "fixed",
    bottom: "25px",
    right: "25px",
    background: color,
    color: "#fff",
    padding: "10px 18px",
    borderRadius: "8px",
    fontWeight: "600",
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
    opacity: "0",
    transition: "opacity 0.3s ease, transform 0.3s ease",
    zIndex: "9999",
    transform: "translateY(20px)",
  });
  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  });
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(20px)";
    setTimeout(() => document.body.removeChild(toast), 400);
  }, 3000);
}

// ==================== LISTA DE BRIGADAS ====================
async function loadBrigadasList() {
  setStatus("Cargando brigadas...", "gray");
  try {
    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("brigada")
      .not("brigada", "is", null);

    if (error) throw error;

    const únicas = [...new Set(data.map((r) => r.brigada.trim()))].sort();
    ui.brigadaSelect.innerHTML = `<option value="">-- Selecciona una brigada --</option>`;
    únicas.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b;
      opt.textContent = b;
      ui.brigadaSelect.appendChild(opt);
    });

    setStatus("Conectado", "green");
  } catch (err) {
    console.error("Error al cargar brigadas:", err);
    setStatus("Error", "gray");
  }
}
loadBrigadasList();

// ==================== MOSTRAR BRIGADAS ACTIVAS ====================
async function fetchBrigadas() {
  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("usuario_id, tecnico, brigada, latitud, longitud, zona, timestamp")
    .gte("timestamp", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("timestamp", { ascending: false });

  if (error) return console.error(error);

  const grouped = new Map();
  for (const r of data) {
    if (!grouped.has(r.brigada)) grouped.set(r.brigada, r);
  }

  ui.userList.innerHTML = "";
  grouped.forEach((r) => {
    const mins = Math.round((Date.now() - new Date(r.timestamp)) / 60000);
    const color = mins <= 2 ? "text-green" : mins <= 5 ? "text-yellow" : "text-gray";
    const div = document.createElement("div");
    div.className = `brigada-item ${color}`;
    div.textContent = `${r.brigada} — ${r.tecnico}`;
    ui.userList.appendChild(div);
  });
}
fetchBrigadas();

// ==================== EXPORTAR KMZ (RECORRIDO COMPLETO DEL DÍA) ====================
ui.exportBtn.addEventListener("click", async () => {
  const brigada = ui.brigadaSelect.value;
  const fecha = ui.fechaSelect.value;
  if (!brigada || !fecha) {
    alert("Selecciona una brigada y una fecha para generar el KMZ.");
    return;
  }
  await exportKMZ(brigada, fecha);
});

async function exportKMZ(brigada, fecha) {
  try {
    setStatus("Generando KMZ...", "gray");

    const start = new Date(`${fecha}T00:00:00`);
    const end = new Date(`${fecha}T23:59:59`);

    // 1️⃣ Traer TODAS las coordenadas del día de esa brigada
    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("latitud,longitud,timestamp,tecnico,brigada")
      .gte("timestamp", start.toISOString())
      .lte("timestamp", end.toISOString())
      .ilike("brigada", `%${brigada}%`)
      .order("timestamp", { ascending: true });

    if (error) throw error;
    if (!data || data.length < 2) {
      alert("⚠️ No hay suficientes datos para generar el recorrido del día.");
      setStatus("Conectado", "green");
      return;
    }

    // 2️⃣ Limpiar y preparar coordenadas
    const coords = data
      .map((r) => [r.longitud, r.latitud])
      .filter((c) => c[0] && c[1]);

    console.log(`Procesando ${coords.length} coordenadas del día completo`);

    // 3️⃣ Snap a carretera (Mapbox Matching) en lotes de 100
    async function snapBatch(batch) {
      const coordsStr = batch.map(([lng, lat]) => `${lng},${lat}`).join(";");
      const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coordsStr}?geometries=geojson&tidy=true&access_token=${CONFIG.MAPBOX_TOKEN}`;
      try {
        const res = await fetch(url);
        const json = await res.json();
        const path = json.matchings?.[0]?.geometry?.coordinates || batch;
        return path;
      } catch (err) {
        console.warn("Error Mapbox Matching:", err.message);
        return batch;
      }
    }

    const batchSize = 100;
    let snappedAll = [];
    for (let i = 0; i < coords.length; i += batchSize) {
      const batch = coords.slice(i, i + batchSize);
      const snapped = await snapBatch(batch);
      snappedAll.push(...snapped);
      await new Promise((res) => setTimeout(res, 150));
    }

    const unique = snappedAll.filter(
      (c, i, a) => i === 0 || (c[0] !== a[i - 1][0] && c[1] !== a[i - 1][1])
    );

    // 4️⃣ Crear descripción
    const tecnico = data[0].tecnico || "-";
    const inicio = new Date(data[0].timestamp).toLocaleString();
    const fin = new Date(data[data.length - 1].timestamp).toLocaleString();

    const desc = `
      <b>Brigada:</b> ${brigada}<br>
      <b>Técnico:</b> ${tecnico}<br>
      <b>Total puntos:</b> ${data.length}<br>
      <b>Inicio jornada:</b> ${inicio}<br>
      <b>Fin jornada:</b> ${fin}
    `;

    // 5️⃣ Generar KML
    const coordsStr = unique.map((c) => `${c[0]},${c[1]},0`).join(" ");
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
      <kml xmlns="http://www.opengis.net/kml/2.2">
        <Document>
          <name>Recorrido ${brigada}</name>
          <description><![CDATA[${desc}]]></description>
          <Style id="linea">
            <LineStyle><color>ff007bff</color><width>4</width></LineStyle>
          </Style>
          <Placemark>
            <name>Ruta ${brigada}</name>
            <styleUrl>#linea</styleUrl>
            <LineString><coordinates>${coordsStr}</coordinates></LineString>
          </Placemark>
        </Document>
      </kml>`;

    // 6️⃣ Crear y descargar KMZ
    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `RECORRIDO_${brigada}_${fecha}.kmz`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);

    showToast(`✅ KMZ generado con recorrido completo (${data.length} puntos)`);
    setStatus("Conectado", "green");

  } catch (err) {
    console.error("Error al generar KMZ:", err);
    showToast("❌ Error al generar KMZ", "#ff4444");
    setStatus("Error", "gray");
  }
}
