// ====== Supabase client ======
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ====== UI refs ======
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
};

// ====== Estado global ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  // uid -> { marker, lastRow }
  users: new Map(),
  // uid -> [rows]
  pointsByUser: new Map(),
};

// ====== Constantes para KMZ y cortes ======
// ahora NO puentiamos huecos grandes, se cortan
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;
const MAX_MM_POINTS = 90;       // puntos por request de map-matching
const GAP_MINUTES = 20;         // si pasan >20 min sin dato -> trazo nuevo
const GAP_METERS = 120;         // si el salto es >120 m -> trazo nuevo (evita diagonales)
const CLEAN_MIN_METERS = 4;     // quitar puntos muy pegados (manchas)
const MAX_DIST_RATIO = 0.35;    // mapbox no puede cambiar >35% de distancia
const ENDPOINT_TOL = 25;        // no mover inicio/fin del bloque >25m
const PER_BLOCK_DELAY = 110;    // ms entre requests a mapbox

// ====== Íconos de los carros ======
const ICONS = {
  green: L.icon({ iconUrl: "assets/carro-green.png", iconSize: [40, 24], iconAnchor: [20, 12] }),
  yellow: L.icon({ iconUrl: "assets/carro-orange.png", iconSize: [40, 24], iconAnchor: [20, 12] }),
  gray:   L.icon({ iconUrl: "assets/carro-gray.png",   iconSize: [40, 24], iconAnchor: [20, 12] }),
};
function getIconFor(row) {
  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  if (mins <= 2) return ICONS.green;
  if (mins <= 5) return ICONS.yellow;
  return ICONS.gray;
}

// ====== Helpers ======
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ====== Mapa ======
function initMap() {
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20 });
  state.map = L.map("map", { center: [-12.0464, -77.0428], zoom: 12, layers: [state.baseLayers.osm] });
  state.cluster = L.markerClusterGroup({ disableClusteringAtZoom: 16 });
  state.map.addLayer(state.cluster);

  ui.apply.onclick = () => fetchInitial(true);
  ui.exportKmz.onclick = () => exportKMZFromState();
}
initMap();

// ====== Status ======
function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}

// ====== Centrar en brigada (lo nuevo) ======
function focusOnUser(uid) {
  const u = state.users.get(uid);
  if (!u || !u.marker) return;
  const latlng = u.marker.getLatLng();
  state.map.setView(latlng, 17, { animate: true });
  u.marker.openPopup();
}

// ====== Popup ======
function buildPopup(r) {
  const acc = Math.round(r.acc || 0);
  const spd = (r.spd || 0).toFixed(1);
  const ts = new Date(r.timestamp).toLocaleString();
  return `<div><b>${r.tecnico || "Sin nombre"}</b><br>Brigada: ${r.brigada || "-"}<br>Acc: ${acc} m · Vel: ${spd} m/s<br>${ts}</div>`;
}

// ====== Lista lateral (actualizada con click) ======
function addOrUpdateUserInList(row) {
  const uid = String(row.usuario_id || "0");
  let el = document.getElementById(`u-${uid}`);

  const mins = Math.round((Date.now() - new Date(row.timestamp)) / 60000);
  const brig = row.brigada || "-";
  const hora = new Date(row.timestamp).toLocaleTimeString();
  const ledColor = mins <= 2 ? "#4ade80" : mins <= 5 ? "#eab308" : "#777";
  const cls = mins <= 2 ? "text-green" : mins <= 5 ? "text-yellow" : "text-gray";

  const html = `
    <div class="brigada-header">
      <div style="display:flex;gap:6px;align-items:flex-start;">
        <div class="brigada-dot" style="background:${ledColor};"></div>
        <div class="brigada-info">
          <b class="brig-name">${row.tecnico || "Sin nombre"}</b>
          <div class="brigada-sub">${brig}</div>
        </div>
      </div>
      <div class="brigada-hora">${hora}</div>
    </div>
  `;

  if (!el) {
    el = document.createElement("div");
    el.id = `u-${uid}`;
    el.className = `brigada-item ${cls}`;
    el.innerHTML = html;
    el.onclick = () => {
      focusOnUser(uid);      // centrar en mapa
      ui.brigada.value = brig; // llenar input
    };
    ui.userList.appendChild(el);
  } else {
    el.className = `brigada-item ${cls} marker-pulse`;
    el.innerHTML = html;
    el.onclick = () => {
      focusOnUser(uid);
      ui.brigada.value = brig;
    };
    setTimeout(() => el.classList.remove("marker-pulse"), 600);
  }
}

// ====== Cargar últimas 24h para la vista ======
async function fetchInitial(clear) {
  setStatus("Cargando…", "gray");
  if (clear) ui.userList.innerHTML = "";

  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("timestamp", { ascending: false });

  if (error) {
    setStatus("Error", "gray");
    return;
  }

  const brigFilter = (ui.brigada.value || "").trim().toLowerCase();
  const grouped = new Map();
  const perUser = 100;

  for (const r of data) {
    if (brigFilter && !(r.brigada || "").toLowerCase().includes(brigFilter)) continue;
    const uid = String(r.usuario_id || "0");
    if (!grouped.has(uid)) grouped.set(uid, []);
    if (grouped.get(uid).length >= perUser) continue;
    grouped.get(uid).push(r);
  }

  state.pointsByUser.clear();
  state.cluster.clearLayers();
  state.users.clear();

  grouped.forEach((rows, uid) => {
    const last = rows[0];
    const marker = L.marker([last.latitud, last.longitud], { icon: getIconFor(last) }).bindPopup(buildPopup(last));
    state.cluster.addLayer(marker);
    state.users.set(uid, { marker, lastRow: last });
    state.pointsByUser.set(uid, rows);
    addOrUpdateUserInList(last);
  });

  setStatus("Conectado", "green");
}

// ============================================================================
// ======================= KMZ: funciones internas ============================
// ============================================================================

// quitar puntos muy pegados (evita la “mancha” cuando está detenido)
function cleanClosePoints(points, minMeters = CLEAN_MIN_METERS) {
  if (!points.length) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    if (distMeters(prev, cur) >= minMeters) {
      out.push(cur);
    }
  }
  return out;
}

// partir en tramos: si el hueco es grande -> SE CORTA
function splitOnGaps(points, maxGapMin = GAP_MINUTES, maxGapMeters = GAP_METERS) {
  const groups = [];
  let cur = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!cur.length) { cur.push(p); continue; }
    const prev = cur[cur.length - 1];
    const dtMin = (new Date(p.timestamp) - new Date(prev.timestamp)) / 60000;
    const dm = distMeters(prev, p);
    if (dtMin > maxGapMin || dm > maxGapMeters) {
      if (cur.length > 1) groups.push(cur);
      cur = [p];
    } else {
      cur.push(p);
    }
  }
  if (cur.length > 1) groups.push(cur);
  return groups;
}

// map-matching SEGURO (si deforma mucho, lo descartamos)
async function mapMatchBlockSafe(seg) {
  if (!MAPBOX_TOKEN) return null;
  if (seg.length < 2) return null;
  if (seg.length > MAX_MM_POINTS) return null;

  // distancia cruda
  let rawDist = 0;
  for (let i = 0; i < seg.length - 1; i++) {
    rawDist += distMeters(seg[i], seg[i + 1]);
  }

  const coords = seg.map(p => `${p.lng},${p.lat}`).join(";");
  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?geometries=geojson&overview=full&tidy=true&access_token=${MAPBOX_TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const match = j.matchings && j.matchings[0];
  if (!match || !match.geometry || !match.geometry.coordinates) return null;
  const matched = match.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));

  // distancia matcheada
  let mmDist = 0;
  for (let i = 0; i < matched.length - 1; i++) {
    mmDist += distMeters(matched[i], matched[i + 1]);
  }

  const diff = Math.abs(mmDist - rawDist);
  if (diff / Math.max(rawDist, 1) > MAX_DIST_RATIO) return null;

  // no muevas inicio/fin
  if (distMeters(seg[0], matched[0]) > ENDPOINT_TOL) return null;
  if (distMeters(seg[seg.length - 1], matched[matched.length - 1]) > ENDPOINT_TOL) return null;

  return matched;
}

// ============================================================================
// =========================== EXPORTAR KMZ ===================================
// ============================================================================
async function exportKMZFromState() {
  let prevDisabled = false;
  try {
    setStatus("Generando KMZ…", "gray");
    if (ui?.exportKmz) { prevDisabled = ui.exportKmz.disabled; ui.exportKmz.disabled = true; }

    // 1) brigada
    const brig = (ui.brigada.value || "").trim();
    if (!brig) {
      alert("Escribe la brigada EXACTA para exportar su KMZ.");
      return;
    }

    // 2) fecha
    const dateInput = document.getElementById("kmzDate");
    const chosen = (dateInput && dateInput.value) ? new Date(dateInput.value + "T00:00:00") : new Date();
    const ymd = toYMD(chosen);
    const next = new Date(chosen.getTime() + 24 * 60 * 60 * 1000);
    const ymdNext = toYMD(next);

    // 3) leer día completo usando timestamp_pe
    const { data, error } = await supa
      .from("ubicaciones_brigadas")
      .select("latitud,longitud,timestamp,tecnico,usuario_id")
      .eq("brigada", brig)
      .gte("timestamp_pe", ymd)
      .lt("timestamp_pe", ymdNext)
      .order("timestamp_pe", { ascending: true });

    if (error) throw new Error(error.message);
    if (!data || data.length < 2) {
      alert(`⚠️ No hay datos para "${brig}" en ${ymd}.`);
      return;
    }

    // 4) agrupar por usuario_id
    const byUser = new Map();
    for (const r of data) {
      const uid = String(r.usuario_id || "0");
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid).push({
        lat: r.latitud,
        lng: r.longitud,
        timestamp: r.timestamp,
        tecnico: r.tecnico || `Tecnico ${uid}`
      });
    }

    // 5) construir KML
    let kml = `<?xml version="1.0" encoding="UTF-8"?>` +
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
      `<name>${brig} - ${ymd}</name>`;
    let placemarks = 0;

    for (const [uid, rows0] of byUser.entries()) {
      if (rows0.length < 2) continue;
      const tecnicoName = (rows0[0].tecnico || `Tecnico ${uid}`).replace(/&/g, "&amp;");

      // limpiar puntos pegados
      const rows1 = cleanClosePoints(rows0, CLEAN_MIN_METERS);

      // partir en tramos -> cada uno será un Placemark, NO los unimos
      const segments = splitOnGaps(rows1, GAP_MINUTES, GAP_METERS);

      for (const seg of segments) {
        if (seg.length < 2) continue;

        // si el trazo es corto -> intentar mapbox completo
        if (seg.length <= MAX_MM_POINTS) {
          const mm = await mapMatchBlockSafe(seg);
          const finalSeg = mm ? mm : seg;
          const coords = finalSeg.map(p => `${p.lng},${p.lat},0`).join(" ");
          kml += `
            <Placemark>
              <name>${tecnicoName} (${brig})</name>
              <Style><LineStyle><color>ff00a6ff</color><width>4</width></LineStyle></Style>
              <LineString><coordinates>${coords}</coordinates></LineString>
            </Placemark>`;
          placemarks++;
          continue;
        }

        // si el trazo es largo -> lo troceamos, pero SIN puentear
        const blocks = chunk(seg, MAX_MM_POINTS);
        for (const block of blocks) {
          let finalBlock = block;
          try {
            const mm = await mapMatchBlockSafe(block);
            if (mm && mm.length >= 2) finalBlock = mm;
          } catch (e) {
            finalBlock = block;
          }
          const coords = finalBlock.map(p => `${p.lng},${p.lat},0`).join(" ");
          kml += `
            <Placemark>
              <name>${tecnicoName} (${brig})</name>
              <Style><LineStyle><color>ff00a6ff</color><width>4</width></LineStyle></Style>
              <LineString><coordinates>${coords}</coordinates></LineString>
            </Placemark>`;
          placemarks++;
          await sleep(PER_BLOCK_DELAY);
        }
      }
    }

    kml += `</Document></kml>`;

    if (!placemarks) throw new Error("No se generó ninguna traza válida.");

    // 6) descargar KMZ
    const safeBrig = brig.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 1 }
    });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `recorrido_${safeBrig}_${ymd}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);

    alert(`✅ KMZ listo para "${brig}" (${placemarks} tramo(s))`);
  } catch (e) {
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado", "green");
    if (ui?.exportKmz) ui.exportKmz.disabled = prevDisabled;
  }
}

// ====== Arranque ======
setStatus("Cargando...", "gray");
fetchInitial(true);
