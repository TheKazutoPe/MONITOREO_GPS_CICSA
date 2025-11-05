// main.js (corregido) — Mapbox en tiempo real con map‑matching e inserción en rutas_brigadas_dia
// Requisitos en tu HTML:
//  - Inputs: #brigada (texto), #fecha (type=date)
//  - Botones: #btnStart, #btnStop
//  - Div mapa: #map
//  - Cargar primero config.js con SUPABASE_URL, SUPABASE_ANON_KEY, MAPBOX_TOKEN y nombres de tablas.

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  MAPBOX_TOKEN,
  TABLE_RAW,
  TABLE_CLEAN,
  WINDOW_MINUTES,
  MAX_BATCH
} from "./config.js";

// ---------------------
// Inicializaciones
// ---------------------
const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
mapboxgl.accessToken = MAPBOX_TOKEN;

const map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/mapbox/streets-v12",
  center: [-77.04, -12.06], // Lima aprox
  zoom: 12,
});

const $brigada = document.getElementById("brigada");
const $fecha = document.getElementById("fecha");
const $start = document.getElementById("btnStart");
const $stop = document.getElementById("btnStop");
const $status = document.getElementById("status") || { innerText: () => {} };

let channel = null;
let currentKey = null; // `${brigada}_${fecha}`
let running = false;

// GeoJSON de la ruta en vivo por clave (brigada_fecha)
const liveRoutes = new Map(); // key -> {fc, sourceId, layerId}

function setStatus(msg) {
  if ($status) $status.innerText = msg;
  console.log("STATUS:", msg);
}

// ---------------------
// Utilidades
// ---------------------
function keyFor(b, isoDate) { return `${b}_${isoDate}`; }
function toISODateUTC(d) { return new Date(d).toISOString().slice(0,10); }

function getTs(o){
  // prioriza timestamp_pe si existe; si no, usa timestamp
  return o.timestamp_pe || o.timestamp || o.ts || null;
}

function getLat(o){ return Number(o.latitud ?? o.lat ?? o.latitude); }
function getLng(o){ return Number(o.longitud ?? o.lng ?? o.longitude); }

async function ensureLiveLayer(key) {
  if (liveRoutes.has(key)) return liveRoutes.get(key);
  const sourceId = `src-${key}`;
  const layerId = `ly-${key}`;

  const fc = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } }
    ]
  };

  map.addSource(sourceId, { type: "geojson", data: fc });
  map.addLayer({
    id: layerId,
    type: "line",
    source: sourceId,
    paint: { "line-width": 4 }
  });

  const entry = { fc, sourceId, layerId };
  liveRoutes.set(key, entry);
  return entry;
}

function updateLiveLayer(entry, coord){
  entry.fc.features[0].geometry.coordinates.push(coord);
  const src = map.getSource(entry.sourceId);
  if (src) src.setData(entry.fc);
}

async function getMaxSeq(brigada, fecha){
  const { data, error } = await supa
    .from(TABLE_CLEAN)
    .select("seq")
    .eq("brigada", brigada)
    .eq("fecha", fecha)
    .order("seq", { ascending:false })
    .limit(1);
  if (error) { console.error("max seq error", error); return 0; }
  return data && data.length ? Number(data[0].seq) : 0;
}

async function insertCleanPoint(brigada, fecha, coord, ts, source="realtime", confidence=null){
  const currentMax = await getMaxSeq(brigada, fecha);
  const row = {
    brigada,
    fecha,
    seq: currentMax + 1,
    lat: coord[1],
    lng: coord[0],
    timestamp: new Date(ts).toISOString(),
    source,
    confidence
  };
  const { error } = await supa.from(TABLE_CLEAN).insert(row);
  if (error) {
    console.error("INSERT rutas_brigadas_dia falló:", error);
    setStatus("Error guardando ruta limpia (ver consola)");
    return false;
  }
  return true;
}

// Map Matching con ventana deslizante (últimos WINDOW_MINUTES)
async function matchAndAppend(brigada, tsISO){
  // ventana [ts-Window, ts]
  const tsDate = new Date(tsISO);
  const fromISO = new Date(tsDate.getTime() - WINDOW_MINUTES*60000).toISOString();
  const toISO = tsDate.toISOString();

  // Trae puntos recientes para misma brigada
  const { data: win, error: werr } = await supa
    .from(TABLE_RAW)
    .select("latitud,longitud,timestamp,timestamp_pe,acc")
    .eq("brigada", brigada)
    .or(`and(timestamp_pe.gte.${fromISO},timestamp_pe.lte.${toISO}),and(timestamp.gte.${fromISO},timestamp.lte.${toISO})`)
    .order("timestamp_pe", { ascending:true })
    .limit(200);

  if (werr) { console.error("ventana error", werr); return; }
  const pts = (win||[])
    .map(p => ({
      lon: getLng(p),
      lat: getLat(p),
      ts: getTs(p),
      acc: p.acc ?? null
    }))
    .filter(p => isFinite(p.lat) && isFinite(p.lon) && p.ts)
    .sort((a,b)=> new Date(a.ts) - new Date(b.ts));

  if (pts.length < 2) return; // se necesita al menos 2

  // Batching simple (usamos solo los últimos MAX_BATCH para estabilidad y costo)
  const chunk = pts.slice(-Math.min(MAX_BATCH, pts.length));
  const coords = chunk.map(p => `${p.lon},${p.lat}`).join(";");
  const timestamps = chunk.map(p => Math.floor(new Date(p.ts).getTime()/1000)).join(";");
  const radiuses = chunk.map(p => (p.acc ? Math.max(5, Math.min(50, Math.round(p.acc))) : 25)).join(";");

  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?`+
              `geometries=geojson&timestamps=${timestamps}&radiuses=${radiuses}&steps=false&overview=full&access_token=${MAPBOX_TOKEN}`;

  const res = await fetch(url);
  if (!res.ok) { console.error("Mapbox error", res.status, await res.text()); return; }
  const json = await res.json();
  const match = json.matchings && json.matchings[0];
  if (!match || !match.geometry || !match.geometry.coordinates?.length) return;

  // Tomamos el último punto del match (corresponde al último crudo entrante)
  const lastCoord = match.geometry.coordinates[match.geometry.coordinates.length-1]; // [lon, lat]
  return { coord: lastCoord, confidence: null };
}

async function handleInsert(payload){
  try{
    const row = payload.new;
    const brigada = row.brigada;
    const ts = getTs(row);
    const lat = getLat(row);
    const lng = getLng(row);
    if (!brigada || !ts || !isFinite(lat) || !isFinite(lng)) return;

    const fecha = toISODateUTC(ts);
    const key = keyFor(brigada, fecha);
    const layer = await ensureLiveLayer(key);

    // mover mapa hacia el último punto crudo (mejor UX)
    map.easeTo({ center: [lng, lat], duration: 600 });

    // map‑matching ventana y añadir último punto "snapped"
    const m = await matchAndAppend(brigada, ts);
    if (!m || !m.coord) return;

    // actualizar línea en vivo
    updateLiveLayer(layer, m.coord);

    // guardar en tabla limpia con secuencia
    await insertCleanPoint(brigada, fecha, m.coord, ts, "realtime", m.confidence);
  }catch(err){
    console.error("handleInsert err", err);
  }
}

async function start(){
  if (running) return;
  const brigada = ($brigada.value||"").trim();
  const fecha = ($fecha.value||"").trim();
  if (!brigada) { setStatus("Escribe la brigada"); return; }
  if (!fecha) { setStatus("Elige la fecha (UTC)"); return; }

  currentKey = keyFor(brigada, fecha);
  await ensureLiveLayer(currentKey);

  // Suscripción Realtime
  channel = supa
    .channel(`rt_${TABLE_RAW}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: TABLE_RAW }, async (payload) => {
      // solo procesa la brigada activa y la fecha activa
      const row = payload.new;
      if (!row) return;
      const b = row.brigada;
      const ts = getTs(row);
      if (!b || !ts) return;
      if (b !== brigada) return; // filtra brigada
      if (toISODateUTC(ts) !== fecha) return; // filtra día
      await handleInsert(payload);
    })
    .subscribe((s) => {
      if (s === "SUBSCRIBED") setStatus("Suscrito en tiempo real");
    });

  running = true;
  $start.disabled = true; $stop.disabled = false;
}

async function stop(){
  if (channel) { await supa.removeChannel(channel); channel = null; }
  running = false;
  $start.disabled = false; $stop.disabled = true;
  setStatus("Detenido");
}

$start?.addEventListener("click", start);
$stop?.addEventListener("click", stop);

// Espera a que cargue el estilo del mapa antes de añadir capas
map.on("load", () => setStatus("Mapa listo"));
