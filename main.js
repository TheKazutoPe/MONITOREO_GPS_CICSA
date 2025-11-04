// ================= main.js (compatible con tu index + Leaflet) =================

// Lee configuración global del config.js
const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  ROUTE_PROVIDER,
  MAPBOX_TOKEN
} = window.CONFIG || {};

// Constantes de tabla/columnas
const TABLE_UBICACIONES = "ubicaciones_brigadas";
const COL_LAT = "latitud";
const COL_LNG = "longitud";
const COL_TS  = "timestamp";      // ISO 8601 UTC
const COL_TS_TZ = "timestamp_pe"; // fecha local (si existe)
const COL_BRG = "brigada";
const COL_TEC = "tecnico";
const COL_UID = "usuario_id";
const COL_ACC = "acc";            // opcional
const COL_SPD = "spd";            // opcional

// Parámetros finos para trazado/matching
const CLEAN_MIN_METERS      = 6;
const DENSIFY_STEP          = 15;
const MAX_MM_POINTS         = 75;
const MAX_DIST_RATIO        = 0.45;
const ENDPOINT_TOL          = 35;
const GAP_MINUTES           = 8;
const GAP_JUMP_METERS       = 800;
const BRIDGE_MAX_METERS     = 2000;
const DIRECTIONS_PROFILE    = "driving"; // o "driving-traffic"

// Supabase: usa el global ya incluido en tu index.html
// (En tu HTML cargas: <script src="https://unpkg.com/@supabase/supabase-js@2"></script>)
const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ====== Leaflet map (tu index ya carga Leaflet) ======
/* Tu index tiene:
   <main id="map" class="map-container"></main>
   <input id="brigadaFilter" ... />
   <input id="kmzDate" type="date" />
   <button id="exportKmzBtn">📍 Exportar KMZ</button>
*/
let map, routeLayer;

window.addEventListener("DOMContentLoaded", () => {
  initMap();

  const btn = document.getElementById("exportKmzBtn");
  if (btn) btn.addEventListener("click", onExportKmzClick);

  // badge de estado opcional
  const st = document.getElementById("status");
  if (st) st.textContent = "LISTO";
});

function initMap() {
  // centro por defecto: Lima
  map = L.map('map', { zoomControl: true }).setView([-12.0464, -77.0428], 11);

  // capa base (puedes cambiarla si deseas)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  routeLayer = L.polyline([], { color: '#ff1a1a', weight: 4 }).addTo(map);
}

function drawOnMap(coords) {
  if (!map || !routeLayer) return;
  const latlngs = coords.map(c => [c.lat, c.lng]);
  routeLayer.setLatLngs(latlngs);
  if (latlngs.length) {
    map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
  }
}

// ====== Utilidades de distancia/tiempo ======
function distMeters(a, b) {
  const R=6371000, toRad = v=>v*Math.PI/180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const s = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}

function cleanClosePoints(points, minMeters) {
  if (points.length < 2) return points;
  const out = [points[0]];
  for (let i=1; i<points.length; i++) {
    if (distMeters(out[out.length-1], points[i]) >= minMeters) out.push(points[i]);
  }
  return out;
}

function densifySegment(seg, stepMeters = DENSIFY_STEP) {
  if (seg.length < 2) return seg.slice();
  const out = [seg[0]];
  for (let i=0; i<seg.length-1; i++) {
    const a = seg[i], b = seg[i+1];
    const d = distMeters(a,b);
    const n = Math.floor(d/stepMeters);
    for (let k=1; k<=n; k++) {
      const t = k/(n+1);
      out.push({
        lat: a.lat + (b.lat-a.lat)*t,
        lng: a.lng + (b.lng-a.lng)*t,
        timestamp: a.timestamp
      });
    }
    out.push(b);
  }
  return out;
}

// ====== Filtros anti-ruido ======
function filterByAccuracy(points, maxAcc = 50) {
  return points.filter(p => p[COL_ACC] == null || p[COL_ACC] <= maxAcc);
}
function filterBySpeed(points, maxMps = 45) {
  if (points.length<2) return points;
  const out=[points[0]];
  for (let i=1; i<points.length; i++) {
    const a = out[out.length-1], b = points[i];
    const dt = (new Date(b.timestamp) - new Date(a.timestamp))/1000;
    if (dt <= 0) continue;
    const v = distMeters(a,b)/dt;
    if (v <= maxMps) out.push(b);
  }
  return out;
}
function splitOnGapOrJump(points, maxGapMin = GAP_MINUTES, maxJumpM = GAP_JUMP_METERS) {
  const groups = [];
  let cur = [];
  for (const p of points) {
    if (!cur.length) { cur.push(p); continue; }
    const prev = cur[cur.length-1];
    const dtMin = (new Date(p.timestamp) - new Date(prev.timestamp))/60000;
    const djump = distMeters(prev, p);
    if (dtMin > maxGapMin || djump > maxJumpM) {
      if (cur.length > 1) groups.push(cur);
      cur = [p];
    } else cur.push(p);
  }
  if (cur.length > 1) groups.push(cur);
  return groups;
}

// ====== Map Matching (timestamps + radiuses) ======
async function mapMatchBlockSafe(seg) {
  if (ROUTE_PROVIDER !== "mapbox") return null;
  if (!MAPBOX_TOKEN || !MAPBOX_TOKEN.startsWith("pk.")) return null;
  if (seg.length < 2 || seg.length > MAX_MM_POINTS) return null;

  const dense = densifySegment(seg, DENSIFY_STEP);

  // distancia cruda para validar
  let rawDist = 0;
  for (let i=0; i<dense.length-1; i++) rawDist += distMeters(dense[i], dense[i+1]);

  const coords = dense.map(p => `${p.lng},${p.lat}`).join(";");
  const tsArr  = dense.map(p => Math.floor(new Date(p.timestamp).getTime()/1000)).join(";");
  const radArr = dense.map(() => 25).join(";"); // 25m tolerancia/punto

  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?` +
              `geometries=geojson&overview=full&tidy=true&timestamps=${tsArr}&radiuses=${radArr}` +
              `&access_token=${MAPBOX_TOKEN}`;

  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const m = j.matchings && j.matchings[0];
  if (!m?.geometry?.coordinates) return null;

  const matched = m.geometry.coordinates.map(([lng,lat]) => ({ lat, lng }));

  // comparar distancias para evitar “teleports”
  let mmDist = 0;
  for (let i=0; i<matched.length-1; i++) mmDist += distMeters(matched[i], matched[i+1]);

  if ((Math.abs(mmDist - rawDist) / Math.max(rawDist, 1)) > MAX_DIST_RATIO) return null;
  if (distMeters(dense[0], matched[0]) > ENDPOINT_TOL) return null;
  if (distMeters(dense.at(-1), matched.at(-1)) > ENDPOINT_TOL) return null;

  // propaga/aproxima timestamps (KML no los usa, pero sirve para debugging)
  for (let i=0; i<matched.length; i++) {
    matched[i].timestamp = dense[Math.min(i, dense.length-1)].timestamp;
  }
  return matched;
}

// ====== Puente entre bloques (Directions por carretera) ======
async function directionsBridge(a, b) {
  if (ROUTE_PROVIDER !== "mapbox") return null;
  if (!MAPBOX_TOKEN || !MAPBOX_TOKEN.startsWith("pk.")) return null;

  const url = `https://api.mapbox.com/directions/v5/mapbox/${DIRECTIONS_PROFILE}/${a.lng},${a.lat};${b.lng},${b.lat}` +
              `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const route = j.routes?.[0]?.geometry?.coordinates;
  if (!route) return null;
  return route.map(([lng,lat]) => ({ lat, lng }));
}

// ====== Exportar KML/KMZ ======
function buildKmlFromCoords(coords, { name, color, width }) {
  const hex = (color || "#FF0000").replace("#", "");
  const abgr = `ff${hex.slice(4,6)}${hex.slice(2,4)}${hex.slice(0,2)}`; // ABGR en KML
  const line = coords.map(c => `${c.lng},${c.lat},0`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Style id="line">
      <LineStyle><color>${abgr}</color><width>${width || 4}</width></LineStyle>
    </Style>
    <Placemark><name>${escapeXml(name || "Ruta")}</name><styleUrl>#line</styleUrl>
      <LineString><tessellate>1</tessellate><coordinates>${line}</coordinates></LineString>
    </Placemark>
  </Document>
</kml>`;
}
function escapeXml(s) { return (s||"").replace(/[<>&'"]/g, c => ({ "<":"&lt;","&":"&amp;",">":"&gt;","'":"&apos;",'"':"&quot;" }[c] )); }

async function downloadKmz(kmlString, filename="ruta.kmz") {
  // tu index ya carga JSZip (CDN). Si no está, cae a KML.
  if (!window.JSZip) {
    try { await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"); } catch(_){}
  }
  if (window.JSZip) {
    const zip = new JSZip();
    zip.file("doc.kml", kmlString);
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename.endsWith(".kmz") ? filename : (filename + ".kmz");
    document.body.appendChild(a); a.click(); a.remove();
  } else {
    const blob = new Blob([kmlString], { type: "application/vnd.google-earth.kml+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename.endsWith(".kml") ? filename : (filename.replace(/\.kmz$/i,"") + ".kml");
    document.body.appendChild(a); a.click(); a.remove();
  }
}

// ====== Flujo principal: Export KMZ ======
async function onExportKmzClick() {
  const brigadaInput = document.getElementById("brigadaFilter");
  const dateInput = document.getElementById("kmzDate");
  if (!brigadaInput || !dateInput) {
    alert("Faltan #brigadaFilter y/o #kmzDate en tu HTML.");
    return;
  }
  const brigada = (brigadaInput.value || "").trim();
  const ymd = dateInput.value; // YYYY-MM-DD
  if (!brigada || !ymd) {
    alert("Escribe brigada y elige una fecha.");
    return;
  }
  try {
    const coords = await exportKMZFromState(brigada, ymd);
    drawOnMap(coords);
  } catch (e) {
    console.error(e);
    alert("No se pudo exportar KMZ. Revisa consola.");
  }
}

function nextYmd(ymd) {
  const d = new Date(`${ymd}T00:00:00`);
  const d2 = new Date(d.getTime() + 24*3600*1000);
  return d2.toISOString().slice(0,10);
}

async function exportKMZFromState(brigada, ymd) {
  // Rango del día local
  const dayStart = new Date(`${ymd}T00:00:00`);
  const dayEnd   = new Date(dayStart.getTime() + 24*3600*1000);
  const minISO   = dayStart.toISOString();
  const maxISO   = dayEnd.toISOString();

  // Usa fecha local si existe la columna COL_TS_TZ; sino, usa COL_TS ISO
  let query = supa.from(TABLE_UBICACIONES)
    .select(`${COL_LAT},${COL_LNG},${COL_TS},${COL_TEC},${COL_UID},${COL_ACC},${COL_SPD},${COL_TS_TZ}`)
    .eq(COL_BRG, brigada)
    .gte(COL_TS_TZ, ymd)
    .lt(COL_TS_TZ, nextYmd(ymd))
    .order(COL_TS_TZ, { ascending: true });

  if (!COL_TS_TZ) {
    query = supa.from(TABLE_UBICACIONES)
      .select(`${COL_LAT},${COL_LNG},${COL_TS},${COL_TEC},${COL_UID},${COL_ACC},${COL_SPD}`)
      .eq(COL_BRG, brigada)
      .gte(COL_TS, minISO)
      .lt(COL_TS,  maxISO)
      .order(COL_TS, { ascending: true });
  }

  const { data, error } = await query;
  if (error) throw error;

  const rows0 = (data || []).map(r => ({
    lat: +r[COL_LAT],
    lng: +r[COL_LNG],
    timestamp: r[COL_TS] || r[COL_TS_TZ],
    acc: r[COL_ACC] ?? null,
    spd: r[COL_SPD] ?? null,
    tecnico: r[COL_TEC] || "",
    uid: r[COL_UID] || ""
  })).filter(p => isFinite(p.lat) && isFinite(p.lng) && p.timestamp)
    .sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (rows0.length < 2) {
    alert("No hay suficientes puntos para ese día/brigada.");
    return [];
  }

  // Filtros anti-ruido
  const rowsA = filterByAccuracy(rows0, 50);
  const rowsB = cleanClosePoints(rowsA, CLEAN_MIN_METERS);
  const rowsC = filterBySpeed(rowsB, 45);

  // Cortes por huecos/saltos
  const segsRaw = splitOnGapOrJump(rowsC, GAP_MINUTES, GAP_JUMP_METERS);

  // Map-matching por bloques
  const matchedSegments = [];
  for (const seg of segsRaw) {
    for (let i=0; i<seg.length; i+= (MAX_MM_POINTS - 1)) {
      const slice = seg.slice(i, i+MAX_MM_POINTS);
      if (slice.length < 2) continue;
      const mm = await mapMatchBlockSafe(slice);
      if (mm) matchedSegments.push(mm);
    }
  }
  if (!matchedSegments.length) {
    alert("No se pudo matchear la ruta. Verifica el token Mapbox o calidad de datos.");
    return [];
  }

  // Unir bloques con Directions (carretera, sin rectas)
  const finalCoords = [];
  for (let s=0; s<matchedSegments.length; s++) {
    const cur = matchedSegments[s];
    if (!cur?.length) continue;

    if (finalCoords.length === 0) {
      finalCoords.push(...cur);
      continue;
    }

    const prevEnd = finalCoords[finalCoords.length-1];
    const curStart= cur[0];
    const gap = distMeters(prevEnd, curStart);

    if (gap > 50 && gap <= BRIDGE_MAX_METERS) {
      const bridge = await directionsBridge(prevEnd, curStart);
      if (bridge?.length) finalCoords.push(...bridge);
    }
    finalCoords.push(...cur);
  }

  // Exportar KMZ
  const name = `${brigada}-${ymd}`;
  const kml = buildKmlFromCoords(finalCoords, { name, color: "#FF0000", width: 4 });
  await downloadKmz(kml, `${brigada}_${ymd}.kmz`);

  return finalCoords;
}
