// Espera: config.js define window.CONFIG
const { createClient } = window.supabase;

const LIMA_TZ = "America/Lima";
const MATCH_MAX_POINTS = 100;       // límite Mapbox
const MATCH_DEBOUNCE_MS = 12000;    // 12s por brigada
const MAX_BUFFER_POINTS = 5000;     // buffer por brigada

// Estado en memoria
const buffers = new Map();   // brigada -> [{lat, lon, t, acc}]
const polylines = new Map(); // brigada -> L.Polyline
const debouncers = new Map();// brigada -> timeout id
let realtimeEnabled = true;
let supabase = null;
let map = null;

// UI refs
const brigadaInput = document.getElementById("brigadaInput");
const fechaInput = document.getElementById("fechaInput");
const btnExportKMZ = document.getElementById("btnExportKMZ");
const btnSnapshot  = document.getElementById("btnSnapshot");
const toggleRealtime = document.getElementById("toggleRealtime");
const rtState = document.getElementById("rtState");
const brigadaActiva = document.getElementById("brigadaActiva");
const bufferCount = document.getElementById("bufferCount");
const lastMatch = document.getElementById("lastMatch");

// ---------- Utilidades de tiempo/geo ----------
function hoyLimaISODate() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: LIMA_TZ, year: "numeric", month: "2-digit", day: "2-digit"
  });
  return fmt.format(new Date()); // YYYY-MM-DD
}

function toLineString(coords) {
  return { type: "LineString", coordinates: coords.map(p => [p.lon, p.lat]) };
}

function bboxOfCoords(coords) {
  let minLon=Infinity, minLat=Infinity, maxLon=-Infinity, maxLat=-Infinity;
  for (const {lon,lat} of coords) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI/180;
  const dLon = (b.lon - a.lon) * Math.PI/180;
  const lat1 = a.lat * Math.PI/180;
  const lat2 = b.lat * Math.PI/180;
  const x = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function approxDistanceKm(coords) {
  let d = 0;
  for (let i=1; i<coords.length; i++) {
    d += haversineKm(
      {lat: coords[i-1][1], lon: coords[i-1][0]},
      {lat: coords[i][1],   lon: coords[i][0]}
    );
  }
  return d;
}

// ---------- Buffer ----------
function pushPoint(brigada, pt) {
  if (!buffers.has(brigada)) buffers.set(brigada, []);
  const arr = buffers.get(brigada);
  arr.push(pt);
  if (arr.length > MAX_BUFFER_POINTS) arr.splice(0, arr.length - MAX_BUFFER_POINTS);

  // UI
  if (brigadaInput.value === brigada) bufferCount.textContent = arr.length.toString();
}

// ---------- Realtime supabase ----------
async function subscribeRealtimeUbicaciones(onPoint) {
  const channel = supabase
    .channel("rt-ubicaciones")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "ubicaciones_brigadas" },
      payload => {
        const r = payload.new;
        try {
          // Campos esperados (ajusta a tu tabla real):
          // r.brigada, r.latitud, r.longitud, r.timestamp, r.accuracy (opcional)
          if (!r || !r.brigada || r.latitud == null || r.longitud == null || !r.timestamp) return;

          // Solo hoy (Lima)
          const ts = new Date(r.timestamp);
          const fmt = new Intl.DateTimeFormat("en-CA", {
            timeZone: LIMA_TZ, year:"numeric", month:"2-digit", day:"2-digit"
          });
          const fechaPE = fmt.format(ts);
          if (fechaPE !== hoyLimaISODate()) return;

          const pt = {
            brigada: String(r.brigada),
            lat: Number(r.latitud),
            lon: Number(r.longitud),
            t: Math.floor(new Date(r.timestamp).getTime()/1000),
            acc: r.accuracy != null ? Number(r.accuracy) : 20
          };
          onPoint(pt);
        } catch (e) {
          console.warn("RT parse fail", e);
        }
      }
    )
    .subscribe(status => console.log("Realtime ubicaciones:", status));

  return channel;
}

// ---------- Map Matching + pintado + persistencia ----------
function scheduleMatch(brigada) {
  if (debouncers.get(brigada)) return;
  const id = setTimeout(() => {
    debouncers.delete(brigada);
    runMapMatchAndPersist(brigada);
  }, MATCH_DEBOUNCE_MS);
  debouncers.set(brigada, id);
}

async function runMapMatchAndPersist(brigada) {
  const arr = buffers.get(brigada) || [];
  if (arr.length < 2) return;

  // Últimos N puntos
  const slice = arr.slice(-MATCH_MAX_POINTS);
  const coords = slice.map(p => `${p.lon},${p.lat}`).join(';');
  const timestamps = slice.map(p => p.t).join(';');
  const radiuses = slice.map(p => Math.min(Math.max(Math.round(p.acc || 20), 5), 50)).join(';');

  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?geometries=geojson&tidy=true&timestamps=${timestamps}&radiuses=${radiuses}&access_token=${CONFIG.MAPBOX_TOKEN}`;

  let geom = null;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Map Matching HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.matchings && data.matchings.length > 0) {
      geom = data.matchings[0].geometry; // GeoJSON LineString
    }
  } catch (e) {
    console.warn("Map Matching error", e);
  }
  if (!geom) return;

  // 1) Pintar/actualizar polyline
  try {
    const latlngs = geom.coordinates.map(([lon,lat]) => [lat, lon]);
    if (!polylines.has(brigada)) {
      const pl = L.polyline(latlngs, { weight: 4, opacity: 0.9 }).addTo(map);
      polylines.set(brigada, pl);
    } else {
      polylines.get(brigada).setLatLngs(latlngs);
    }
  } catch (_) {}

  // 2) Persistir en Supabase (upsert del día)
  try {
    const fecha = hoyLimaISODate();
    const puntos = geom.coordinates.length;
    const bbox = bboxOfCoords(geom.coordinates.map(([lon,lat]) => ({lon,lat})));
    const dist = approxDistanceKm(geom.coordinates);

    const { data: up, error: upErr } = await supabase.rpc("upsert_ruta_brigada", {
      p_fecha: fecha,
      p_brigada: brigada,
      p_line: geom,
      p_puntos: puntos,
      p_dist_km: dist,
      p_bbox: bbox
    });
    if (upErr) console.warn("upsert_ruta_brigada error", upErr);

    // UI
    lastMatch.textContent = new Date().toLocaleTimeString("es-PE", { hour12: false });
  } catch (e) {
    console.warn("Supabase upsert error", e);
  }
}

// ---------- Exportar KMZ desde la línea persistida ----------
async function exportKMZDesdeSupabase(brigada, fechaISO) {
  if (!brigada) { alert("Ingresa brigada"); return; }
  if (!fechaISO) { alert("Elige una fecha"); return; }

  try {
    const { data, error } = await supabase
      .from("rutas_brigadas_dia")
      .select("line_geojson")
      .eq("brigada", brigada)
      .eq("fecha", fechaISO)
      .single();

    if (error || !data) {
      alert("No hay trazo persistido para esa brigada/fecha");
      return;
    }

    const line = data.line_geojson; // GeoJSON LineString
    const coordsKml = line.coordinates.map(([lon,lat]) => `${lon},${lat},0`).join(" ");
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <name>${brigada} - ${fechaISO}</name>
  <Placemark>
    <name>${brigada}</name>
    <Style><LineStyle><width>4</width></LineStyle></Style>
    <LineString><tessellate>1</tessellate><coordinates>${coordsKml}</coordinates></LineString>
  </Placemark>
</Document></kml>`;

    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({ type: "blob" });
    const fname = `RUTA_${brigada}_${fechaISO}.kmz`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = fname; a.click();
    URL.revokeObjectURL(url);
    alert(`KMZ generado: ${fname}`);
  } catch (e) {
    console.error(e);
    alert("Error generando KMZ");
  }
}

// ---------- Snapshot PNG del mapa ----------
function saveSnapshotPNG(brigada, fechaISO) {
  if (!polylines.size) alert("Aún no hay un trazo en pantalla");
  leafletImage(map, function(err, canvas) {
    if (err) { alert("No se pudo capturar el mapa"); return; }
    canvas.toBlob(blob => {
      const fname = `SNAPSHOT_${brigada || "BRIGADA"}_${fechaISO || hoyLimaISODate()}.png`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fname; a.click();
      URL.revokeObjectURL(url);
    });
  });
}

// ---------- Handler de cada punto realtime ----------
async function onPointRealtime(pt) {
  if (!realtimeEnabled) return;
  pushPoint(pt.brigada, pt);
  if (brigadaInput.value === "" || brigadaInput.value === pt.brigada) {
    brigadaInput.value = pt.brigada;
    brigadaActiva.textContent = pt.brigada;
  }
  scheduleMatch(pt.brigada);
}

// ---------- Init ----------
async function init() {
  // Fecha hoy (Lima) por defecto
  fechaInput.value = hoyLimaISODate();

  // Supabase
  supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

  // Mapa
  map = L.map("map").setView([-12.0464, -77.0428], 12); // Lima por defecto
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  // Suscripción realtime
  await subscribeRealtimeUbicaciones(onPointRealtime);

  // Eventos UI
  toggleRealtime.addEventListener("click", () => {
    realtimeEnabled = !realtimeEnabled;
    rtState.textContent = realtimeEnabled ? "ON" : "OFF";
    toggleRealtime.classList.toggle("btn-primary", realtimeEnabled);
  });

  btnExportKMZ.addEventListener("click", () => {
    exportKMZDesdeSupabase(brigadaInput.value.trim(), fechaInput.value);
  });

  btnSnapshot.addEventListener("click", () => {
    saveSnapshotPNG(brigadaInput.value.trim(), fechaInput.value);
  });
}

init();
