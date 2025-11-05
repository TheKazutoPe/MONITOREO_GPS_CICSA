// ============================== main.js ==============================
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

// ====== UI refs ======
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
};

// ====== Estado del mapa ======
const state = {
  map: null,
  cluster: null,
  users: new Map(),
  pointsByUser: new Map(),
};

// ====== Iconos ======
const ICONS = {
  green: L.icon({ iconUrl: "assets/carro-green.png", iconSize: [40, 24], iconAnchor: [20, 12] }),
  yellow: L.icon({ iconUrl: "assets/carro-orange.png", iconSize: [40, 24], iconAnchor: [20, 12] }),
  gray: L.icon({ iconUrl: "assets/carro-gray.png", iconSize: [40, 24], iconAnchor: [20, 12] }),
};
function getIconFor(row) {
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  if (mins <= 2) return ICONS.green;
  if (mins <= 5) return ICONS.yellow;
  return ICONS.gray;
}

// ====== Helpers ======
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
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

// ====== MAPA ======
function initMap() {
  state.map = L.map("map", { center: [-12.0464, -77.0428], zoom: 12 });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
  }).addTo(state.map);
  state.cluster = L.markerClusterGroup({ disableClusteringAtZoom: 16 });
  state.map.addLayer(state.cluster);

  ui.apply.onclick = () => fetchInitial(true);
  ui.exportKmz.onclick = () => exportKMZFromState();
}
initMap();

// ====== STATUS ======
function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}

// ====== Mostrar Brigadas ======
function buildPopup(r) {
  const acc = Math.round(r.acc || 0);
  const spd = (r.spd || 0).toFixed(1);
  const ts = new Date(r.timestamp).toLocaleString();
  return `<div><b>${r.tecnico || "Sin nombre"}</b><br>Brigada: ${r.brigada || "-"}<br>Acc: ${acc} m · Vel: ${spd} m/s<br>${ts}</div>`;
}
function addOrUpdateUserInList(row) {
  const uid = String(row.usuario_id || "0");
  let el = document.getElementById(`u-${uid}`);
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  const brig = row.brigada || "-";
  const hora = new Date(row.timestamp).toLocaleTimeString();
  const ledColor = mins <= 2 ? "#4ade80" : mins <= 5 ? "#eab308" : "#777";
  const html = `
    <div class="brigada-header">
      <div style="display:flex;gap:6px;align-items:flex-start;">
        <div class="brigada-dot" style="background:${ledColor};"></div>
        <div class="brigada-info">
          <b>${row.tecnico || "Sin nombre"}</b>
          <div class="brigada-sub">${brig}</div>
        </div>
      </div>
      <div class="brigada-hora">${hora}</div>
    </div>`;
  if (!el) {
    el = document.createElement("div");
    el.id = `u-${uid}`;
    el.className = "brigada-item";
    el.innerHTML = html;
    el.onclick = () => focusOnUser(uid);
    ui.userList.appendChild(el);
  } else {
    el.innerHTML = html;
    el.classList.add("marker-pulse");
    setTimeout(() => el.classList.remove("marker-pulse"), 500);
  }
}

// ====== Fetch inicial ======
async function fetchInitial(clear) {
  setStatus("Cargando…", "gray");
  if (clear) ui.userList.innerHTML = "";

  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("timestamp", { ascending: false });

  if (error) {
    console.error("Error fetch:", error);
    setStatus("Error", "gray");
    return;
  }

  const grouped = new Map();
  for (const r of data) {
    const uid = String(r.usuario_id || "0");
    if (!grouped.has(uid)) grouped.set(uid, []);
    grouped.get(uid).push(r);
  }

  state.cluster.clearLayers();
  state.users.clear();

  grouped.forEach((rows, uid) => {
    const last = rows[0];
    const marker = L.marker([last.latitud, last.longitud], { icon: getIconFor(last) })
      .bindPopup(buildPopup(last));
    state.cluster.addLayer(marker);
    state.users.set(uid, { marker, lastRow: last });
    addOrUpdateUserInList(last);
  });

  setStatus("Conectado", "green");
}

// ===================== 🚀 REALTIME CORREGIDO =====================
console.log("🛰️ Suscribiendo a Realtime ubicaciones_brigadas...");

const channel = supa.channel('realtime:ubicaciones_brigadas')
  .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'ubicaciones_brigadas' },
      async (payload) => {
        console.log("📡 Evento recibido:", payload);

        const row = payload.new;
        if (!row?.latitud || !row?.longitud) return;

        const brig = row.brigada || "SIN_BRIGADA";
        try {
          const { data: prev } = await supa
            .from("rutas_limpias")
            .select("latitud,longitud,timestamp")
            .eq("brigada", brig)
            .order("timestamp", { ascending: false })
            .limit(1);

          let a = null;
          if (prev?.length) {
            a = { lat: prev[0].latitud, lng: prev[0].longitud, timestamp: prev[0].timestamp };
          }

          const b = { lat: row.latitud, lng: row.longitud, timestamp: row.timestamp };

          // Primer punto
          if (!a) {
            await supa.from("rutas_limpias").insert({
              brigada: brig,
              usuario_id: row.usuario_id,
              tecnico: row.tecnico,
              latitud: b.lat,
              longitud: b.lng,
              timestamp: b.timestamp,
              fuente_id: row.id
            });
            console.log(`✅ Primer punto limpio para ${brig}`);
            return;
          }

          // Obtener ruta corregida entre A y B
          const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
          const res = await fetch(url);
          const j = await res.json();
          const coords = j?.routes?.[0]?.geometry?.coordinates || [];

          if (!coords.length) {
            console.warn("⚠️ No se pudo obtener ruta entre puntos.");
            return;
          }

          const cleanPoints = coords.map(([lng, lat]) => ({
            brigada: brig,
            usuario_id: row.usuario_id,
            tecnico: row.tecnico,
            latitud: lat,
            longitud: lng,
            timestamp: b.timestamp,
            fuente_id: row.id
          }));

          await supa.from("rutas_limpias").insert(cleanPoints);
          console.log(`✅ Ruta limpia actualizada para ${brig}`);
        } catch (err) {
          console.error("❌ Error al limpiar ruta:", err);
        }
      })
  .subscribe((status) => {
    console.log("🔄 Estado canal realtime:", status);
  });

// ===================== EXPORTAR KMZ =====================
async function exportKMZFromState() {
  try {
    setStatus("Generando KMZ…", "gray");

    const brig = (ui.brigada.value || "").trim();
    if (!brig) {
      alert("Escribe la brigada EXACTA para exportar su KMZ.");
      return;
    }

    const dateInput = document.getElementById("kmzDate");
    const chosen = dateInput && dateInput.value ? new Date(dateInput.value + "T00:00:00") : new Date();
    const ymd = toYMD(chosen);
    const next = new Date(chosen.getTime() + 24 * 60 * 60 * 1000);
    const ymdNext = toYMD(next);

    // ✅ Usa rutas_limpias
    const { data, error } = await supa
      .from("rutas_limpias")
      .select("latitud,longitud,timestamp,tecnico,usuario_id,brigada")
      .eq("brigada", brig)
      .gte("timestamp", ymd)
      .lt("timestamp", ymdNext)
      .order("timestamp", { ascending: true });

    if (error) throw error;
    if (!data || data.length < 2) {
      alert(`⚠️ No hay datos limpios para "${brig}" en ${ymd}.`);
      return;
    }

    const coordsStr = data.map(r => `${r.longitud},${r.latitud},0`).join(" ");
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
      <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document>
        <name>${brig} - ${ymd}</name>
        <Style id="routeStyle"><LineStyle><color>ffFF0000</color><width>4</width></LineStyle></Style>
        <Placemark>
          <name>${brig} (${ymd})</name>
          <styleUrl>#routeStyle</styleUrl>
          <LineString><tessellate>1</tessellate><coordinates>${coordsStr}</coordinates></LineString>
        </Placemark>
      </Document></kml>`;

    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 1 } });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `recorrido_${brig}_${ymd}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);

    alert(`✅ KMZ generado correctamente para ${brig}`);
    setStatus("Conectado", "green");
  } catch (err) {
    console.error("Error KMZ:", err);
    alert("❌ Error generando KMZ: " + err.message);
    setStatus("Error", "gray");
  }
}

// ====== Arranque ======
setStatus("Cargando...", "gray");
fetchInitial(true);
