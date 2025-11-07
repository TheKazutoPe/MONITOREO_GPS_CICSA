// ============================== main.js ==============================
// Usa CONFIG y supabase globales cargados en index.html
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

// ====== Estado general ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),        // uid -> { marker, lastRow }
  pointsByUser: new Map(), // uid -> [rawPoints] en orden cronológico
};

// ====== Ajustes matching / limpieza ======
const CLEAN_MIN_METERS      = 6;
const DENSIFY_STEP          = 10;
const MAX_MM_POINTS         = 40;
const MAX_MATCH_INPUT       = 90;
const MAX_DIST_RATIO        = 0.35;
const ENDPOINT_TOL          = 25;
const CONFIDENCE_MIN        = 0.70;

const GAP_MINUTES           = 8;
const GAP_JUMP_METERS       = 800;

const BRIDGE_MAX_METERS     = 800;
const DIRECTIONS_HOP_METERS = 300;
const MAX_BRIDGE_SPEED_KMH  = 70;
const MIN_BRIDGE_SPEED_KMH  = 3;
const DIRECTIONS_PROFILE    = "driving";

const PER_BLOCK_DELAY       = 150;

// ====== Iconos ======
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

// ====== Trazado en tiempo real ======
const RT_WINDOW_POINTS    = 30;
const RT_MIN_MOVE_METERS  = 8;
const RT_SAVE_EVERY_N     = 15;
const RT_SAVE_EVERY_MS    = 60000;

// ====== Estacionamiento ======
const STATIONARY_RADIUS_M        = 25;
const STATIONARY_MIN_SAMPLES     = 4;
const STATIONARY_MAX_INTERVAL_MS = 5 * 60 * 1000;
const stationaryBuffers = new Map(); // key: brigada::uid -> [{lat,lng,timestamp}]

// ====== DEBUG ======
const DEBUG_ROUTE = false;

// ====== Rutas en vivo por brigada ======
const routes = new Map();
// routes.get(brigada) => { points:[], polyline, lastSavedAt, appendedSinceSave }

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
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function toYMD(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${dd}`;
}
function chunk(arr,size){
  const out=[];
  for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
}

// RT helpers
function takeTailWindow(arr, maxN = RT_WINDOW_POINTS){
  if (!arr.length) return arr;
  return arr.slice(Math.max(0, arr.length - maxN));
}
function isMovingEnough(prev, cur, minMeters = RT_MIN_MOVE_METERS){
  return distMeters(prev, cur) >= minMeters;
}
function ensureRouteLayer(brigada){
  let r = routes.get(brigada);
  if (!r){
    const pl = L.polyline([], { weight: 4, opacity: 0.9, color: '#ff3b30' });
    pl.addTo(state.map);
    r = { points: [], polyline: pl, lastSavedAt: 0, appendedSinceSave: 0 };
    routes.set(brigada, r);
  }
  return r;
}

// Estacionamiento
function updateStationaryBuffer(key, p){
  let buf = stationaryBuffers.get(key) || [];
  buf.push(p);
  const now = new Date(p.timestamp).getTime();
  buf = buf.filter(q => (now - new Date(q.timestamp).getTime()) <= STATIONARY_MAX_INTERVAL_MS);
  stationaryBuffers.set(key, buf);
  return buf;
}
function analyzeStationary(buf){
  if (buf.length < STATIONARY_MIN_SAMPLES) return { stationary: false };
  let sumLat = 0, sumLng = 0;
  for (const p of buf){ sumLat += p.lat; sumLng += p.lng; }
  const c = { lat: sumLat / buf.length, lng: sumLng / buf.length };
  let maxD = 0;
  for (const p of buf){
    const d = distMeters(p, c);
    if (d > maxD) maxD = d;
    if (d > STATIONARY_RADIUS_M) return { stationary: false };
  }
  return { stationary: true, center: c, maxDistance: maxD };
}

// Densificar / downsample
function densifySegment(points, step = DENSIFY_STEP) {
  if (!points || points.length < 2) return points;
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const d = distMeters(a, b);
    if (d <= step) { out.push(a); continue; }
    const n = Math.ceil(d / step);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
        timestamp: a.timestamp,
        acc: a.acc
      });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
function downsamplePoints(arr, maxN){
  if (!arr || arr.length <= maxN) return arr || [];
  const out = [];
  const step = (arr.length - 1) / (maxN - 1);
  for (let i = 0; i < maxN; i++){
    const idx = Math.round(i * step);
    out.push(arr[idx]);
  }
  out[0] = arr[0];
  out[out.length - 1] = arr[arr.length - 1];
  return out;
}

// Limpieza/cortes (por si acaso; export ya no usa crudo)
function cleanClosePoints(points, minMeters = CLEAN_MIN_METERS){
  if (!points.length) return points;
  const out = [points[0]];
  for (let i=1;i<points.length;i++){
    const prev = out[out.length-1];
    const cur  = points[i];
    if (distMeters(prev,cur) >= minMeters){
      out.push(cur);
    }
  }
  return out;
}
function splitOnGaps(points, maxGapMin = GAP_MINUTES, maxJumpM = GAP_JUMP_METERS){
  const groups = [];
  let cur = [];
  for (let i=0;i<points.length;i++){
    const p = points[i];
    if (!cur.length){ cur.push(p); continue; }
    const prev = cur[cur.length-1];
    const dtMin = (new Date(p.timestamp) - new Date(prev.timestamp))/60000;
    const djump = distMeters(prev, p);
    if (dtMin > maxGapMin || djump > maxJumpM){
      if (cur.length>1) groups.push(cur);
      cur = [p];
    } else {
      cur.push(p);
    }
  }
  if (cur.length>1) groups.push(cur);
  return groups;
}

// Map Matching
function adaptiveRadius(p){
  const acc = (p && p.acc != null) ? Number(p.acc) : NaN;
  const base = isFinite(acc) ? acc + 5 : 25;
  return Math.max(10, Math.min(50, base));
}
async function mapMatchBlockSafe(seg){
  if (!MAPBOX_TOKEN) return null;
  if (!seg || seg.length < 2) return null;
  if (seg.length > MAX_MM_POINTS) return null;

  const dense0 = densifySegment(seg, DENSIFY_STEP);
  const dense = downsamplePoints(dense0, MAX_MATCH_INPUT);

  let rawDist = 0;
  for (let i=0;i<dense.length-1;i++) rawDist += distMeters(dense[i], dense[i+1]);

  const coords = dense.map(p=>`${p.lng},${p.lat}`).join(";");
  const tsArr  = dense.map(p=>Math.floor(new Date(p.timestamp).getTime()/1000)).join(";");
  const radArr = dense.map(p=>adaptiveRadius(p)).join(";");

  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}` +
              `?geometries=geojson&overview=full&tidy=true` +
              `&timestamps=${tsArr}&radiuses=${radArr}` +
              `&access_token=${MAPBOX_TOKEN}`;

  let r;
  try{ r = await fetch(url, { method:"GET", mode:"cors" }); }
  catch(e){
    if (DEBUG_ROUTE) console.log("MM fetch error", e);
    return null;
  }

  if (!r.ok){
    const txt = await r.text().catch(()=> "");
    if (DEBUG_ROUTE) console.log("MM status !ok", r.status, txt.slice(0,200));
    return null;
  }

  const j = await r.json().catch(()=> null);
  const m = j?.matchings?.[0];

  if (!m?.geometry?.coordinates){
    if (DEBUG_ROUTE) console.log("MM: sin geometría");
    return null;
  }

  if (typeof m.confidence === "number" && m.confidence < CONFIDENCE_MIN) {
    if (DEBUG_ROUTE) console.log("MM: baja confianza", m.confidence);
    if (dense.length > 24) {
      const mid = Math.floor(dense.length/2);
      const left  = await mapMatchBlockSafe(dense.slice(0, mid));
      const right = await mapMatchBlockSafe(dense.slice(mid-1));
      if (left && right) return left.concat(right.slice(1));
    }
    return null;
  }

  const matched = m.geometry.coordinates.map(([lng,lat])=>({lat,lng}));

  let mmDist=0;
  for (let i=0;i<matched.length-1;i++) mmDist += distMeters(matched[i], matched[i+1]);
  const ratio = Math.abs(mmDist - rawDist) / Math.max(rawDist,1);
  if (ratio > MAX_DIST_RATIO) {
    if (DEBUG_ROUTE) console.log("MM: ratio distancia alto", {mmDist,rawDist,ratio});
    return null;
  }
  if (distMeters(dense[0], matched[0]) > ENDPOINT_TOL) {
    if (DEBUG_ROUTE) console.log("MM: punta inicio lejos");
    return null;
  }
  if (distMeters(dense.at(-1), matched.at(-1)) > ENDPOINT_TOL) {
    if (DEBUG_ROUTE) console.log("MM: punta final lejos");
    return null;
  }

  for (let i=0;i<matched.length;i++){
    matched[i].timestamp = dense[Math.min(i, dense.length-1)].timestamp;
    matched[i].acc = dense[Math.min(i, dense.length-1)].acc;
  }

  if (DEBUG_ROUTE) {
    console.log("MM OK", {
      inputSize: seg.length,
      denseSize: dense.length,
      matchedSize: matched.length,
      confidence: m.confidence
    });
  }

  return matched;
}

// ====== UI / Mapa ======
function initMap(){
  state.baseLayers.osm = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }
  );
  state.map = L.map("map",{
    center:[-12.0464,-77.0428],
    zoom:12,
    maxZoom:19,
    layers:[state.baseLayers.osm]
  });
  state.cluster = L.markerClusterGroup({disableClusteringAtZoom:16});
  state.map.addLayer(state.cluster);

  ui.apply.onclick = () => fetchInitial(true);
  ui.exportKmz.onclick = () => exportKMZFromState();
}
initMap();

function setStatus(text, kind){
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}
function focusOnUser(uid) {
  const u = state.users.get(uid);
  if (!u || !u.marker) return;
  const latlng = u.marker.getLatLng();
  state.map.setView(latlng, 17, { animate: true });
  u.marker.openPopup();
}
function buildPopup(r){
  const acc = Math.round(r.acc || 0);
  const spd = (r.spd || 0).toFixed(1);
  const ts = new Date(r.timestamp).toLocaleString();
  return `<div><b>${r.tecnico || "Sin nombre"}</b><br>Brigada: ${r.brigada || "-"}<br>Acc: ${acc} m · Vel: ${spd} m/s<br>${ts}</div>`;
}
function addOrUpdateUserInList(row){
  const uid = String(row.usuario_id || "0");
  let el = document.getElementById(`u-${uid}`);
  const mins = Math.round((Date.now() - new Date(row.timestamp))/60000);
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
  if (!el){
    el = document.createElement("div");
    el.id = `u-${uid}`;
    el.className = `brigada-item ${cls}`;
    el.innerHTML = html;
    el.onclick = () => { focusOnUser(uid); ui.brigada.value = brig; };
    ui.userList.appendChild(el);
  } else {
    el.className = `brigada-item ${cls} marker-pulse`;
    el.innerHTML = html;
    el.onclick = () => { focusOnUser(uid); ui.brigada.value = brig; };
    setTimeout(()=>el.classList.remove("marker-pulse"),600);
  }
}

// Carga inicial (solo muestra últimos puntos)
async function fetchInitial(clear){
  setStatus("Cargando…","gray");
  if (clear) ui.userList.innerHTML = "";

  const {data, error} = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now()-24*60*60*1000).toISOString())
    .order("timestamp",{ascending:false});

  if (error){ setStatus("Error","gray"); return; }

  const brigFilter = (ui.brigada.value||"").trim().toLowerCase();
  const grouped = new Map();
  const perUser = 100;

  for (const r of data){
    if (brigFilter && !(r.brigada||"").toLowerCase().includes(brigFilter)) continue;
    const uid = String(r.usuario_id || "0");
    if (!grouped.has(uid)) grouped.set(uid, []);
    if (grouped.get(uid).length >= perUser) continue;
    grouped.get(uid).push(r);
  }

  state.pointsByUser.clear();
  state.cluster.clearLayers();
  state.users.clear();

  grouped.forEach((rows, uid)=>{
    const last = rows[0];
    const marker = L.marker([last.latitud,last.longitud],{icon:getIconFor(last)}).bindPopup(buildPopup(last));
    state.cluster.addLayer(marker);
    state.users.set(uid,{marker,lastRow:last});
    state.pointsByUser.set(uid, []); // hist se construye con realtime
    addOrUpdateUserInList(last);
  });

  setStatus("Conectado","green");
}

// Persistencia ruta limpia
function computeBBox(points){
  let minLat=  90, minLng= 180, maxLat= -90, maxLng= -180;
  for (const p of points){
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return [minLng, minLat, maxLng, maxLat];
}
function computeDistanceKm(points){
  let d=0;
  for (let i=0;i<points.length-1;i++) d += distMeters(points[i], points[i+1]);
  return d / 1000;
}
async function persistRoute(brigada, r){
  if (!r.points.length) return;
  const lastTs = r.points.at(-1).timestamp || new Date().toISOString();
  const ymd = toYMD(new Date(lastTs));

  const coords = r.points.map(p => [p.lng, p.lat]);
  const line_geojson = { type: "LineString", coordinates: coords };
  const bbox = computeBBox(r.points);
  const distancia_km = computeDistanceKm(r.points);
  const puntos = r.points.length;

  await supa.from("rutas_brigadas_dia").upsert({
    fecha: ymd,
    brigada,
    line_geojson,
    puntos,
    distancia_km,
    bbox,
    updated_at: new Date().toISOString()
  }, { onConflict: 'fecha,brigada' });
}
function maybePersistRoute(brigada, r){
  const now = Date.now();
  const dueByCount = r.appendedSinceSave >= RT_SAVE_EVERY_N;
  const dueByTime  = (now - r.lastSavedAt) >= RT_SAVE_EVERY_MS;
  if (dueByCount || dueByTime){
    persistRoute(brigada, r).catch(console.warn);
    r.lastSavedAt = now;
    r.appendedSinceSave = 0;
  }
}

// Matching incremental
async function matchAndAppendTail(brigada, rawTail){
  if (!rawTail || rawTail.length < 2) return;

  const r = ensureRouteLayer(brigada);

  const existingTail = takeTailWindow(r.points, Math.floor(RT_WINDOW_POINTS / 2));
  const seed = existingTail.length ? [ existingTail.at(-1) ] : [];
  const windowInput = [...seed, ...rawTail];

  const mm = await mapMatchBlockSafe(windowInput);
  const matched = (mm && mm.length >= 2)
    ? mm
    : densifySegment(windowInput, DENSIFY_STEP);

  if (!matched || matched.length < 2) return;

  let startIdx = 0;
  if (r.points.length){
    const last = r.points.at(-1);
    let bestI = 0, bestD = Infinity;
    for (let i=0;i<matched.length;i++){
      const d = distMeters(last, matched[i]);
      if (d < bestD){ bestD = d; bestI = i; }
    }
    if (bestD <= ENDPOINT_TOL) startIdx = bestI + 1;
  }
  if (startIdx >= matched.length) return;

  const tailToAdd = matched
    .slice(startIdx)
    .filter(p => isFinite(p.lat) && isFinite(p.lng));

  if (!tailToAdd.length) return;

  if (DEBUG_ROUTE) {
    console.log(`[${brigada}] matchAndAppendTail`, {
      rawSize: rawTail.length,
      matchedSize: matched.length,
      added: tailToAdd.length
    });
  }

  r.points.push(...tailToAdd);
  r.polyline.setLatLngs(r.points.map(p => [p.lat, p.lng]));

  r.appendedSinceSave += tailToAdd.length;
  maybePersistRoute(brigada, r);
}

// Realtime (AQUÍ estaba el bug principal; ahora está ordenado)
function subscribeRealtime(){
  supa.channel('ubicaciones_brigadas-changes')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'ubicaciones_brigadas' },
      async (payload) => {
        const row = payload?.new;
        if (!row) return;

        const brigada = String(row.brigada || "");
        const brigFilter = (ui.brigada.value || "").trim().toLowerCase();
        if (brigFilter && !brigada.toLowerCase().includes(brigFilter)) return;

        const uid = String(row.usuario_id || "0");
        const key = `${brigada}::${uid}`;

        // popup + lista
        addOrUpdateUserInList(row);
        let u = state.users.get(uid);
        if (!u){
          const marker = L.marker([row.latitud, row.longitud], { icon: getIconFor(row) }).bindPopup(buildPopup(row));
          state.cluster.addLayer(marker);
          u = { marker, lastRow: row };
          state.users.set(uid, u);
        } else {
          u.marker
            .setLatLng([row.latitud, row.longitud])
            .setIcon(getIconFor(row))
            .setPopupContent(buildPopup(row));
          u.lastRow = row;
        }

        // punto crudo
        const rawPoint = {
          lat: +row.latitud,
          lng: +row.longitud,
          timestamp: row.timestamp_pe || row.timestamp,
          acc: row.acc ?? null,
          spd: row.spd ?? null
        };

        // actualizar historial crudo (orden cronológico)
        let hist = state.pointsByUser.get(uid) || [];
        hist.push(rawPoint);
        if (hist.length > 200) {
          hist = hist.slice(hist.length - 200);
        }
        state.pointsByUser.set(uid, hist);

        // estacionamiento
        const buf = updateStationaryBuffer(key, rawPoint);
        const stat = analyzeStationary(buf);

        const route = ensureRouteLayer(brigada);
        const last = route.points.at(-1);

        if (stat.stationary) {
          const center = stat.center;
          if (!last || distMeters(last, center) > STATIONARY_RADIUS_M / 2) {
            const anchor = {
              lat: center.lat,
              lng: center.lng,
              timestamp: rawPoint.timestamp
            };
            route.points.push(anchor);
            route.polyline.setLatLngs(route.points.map(p => [p.lat, p.lng]));
            route.appendedSinceSave += 1;
            maybePersistRoute(brigada, route);
            if (DEBUG_ROUTE) console.log(`[${brigada}] estacionado, ancla agregado`, anchor);
          }
          return;
        }

        // no estacionado: filtrar movimientos muy chicos
        if (last && !isMovingEnough(last, rawPoint, RT_MIN_MOVE_METERS)) {
          if (DEBUG_ROUTE) console.log(`[${brigada}] poco movimiento, ignorado`);
          return;
        }

        // ventana cruda ordenada: últimos 4 anteriores + actual
        const prevRawList = hist.slice(Math.max(0, hist.length - 5), hist.length - 1);
        const win = [...prevRawList, rawPoint];

        try{
          await matchAndAppendTail(brigada, win);
        }catch(e){
          console.warn("RT match append error:", e);
        }
      }
    )
    .subscribe(status => console.log("Realtime status:", status));
}

// Export KMZ solo desde rutas_brigadas_dia
async function exportKMZFromState(){
  let prevDisabled = false;
  try {
    setStatus("Generando KMZ…","gray");
    if (ui?.exportKmz){ prevDisabled = ui.exportKmz.disabled; ui.exportKmz.disabled = true; }

    const brig = (ui.brigada.value || "").trim();
    if (!brig){
      alert("Escribe la brigada EXACTA para exportar su KMZ.");
      return;
    }

    const dateInput = document.getElementById("kmzDate");
    const chosen = (dateInput && dateInput.value)
      ? new Date(dateInput.value + "T00:00:00")
      : new Date();
    const ymd = toYMD(chosen);

    const { data:routeRow, error:routeErr } = await supa
      .from("rutas_brigadas_dia")
      .select("line_geojson, puntos")
      .eq("brigada", brig)
      .eq("fecha", ymd)
      .maybeSingle();

    if (routeErr) throw new Error(routeErr.message);

    if (!routeRow?.line_geojson?.coordinates?.length){
      alert(`⚠️ No hay ruta limpia registrada para "${brig}" en ${ymd}.`);
      return;
    }

    const coords = routeRow.line_geojson.coordinates;

    let kml = `<?xml version="1.0" encoding="UTF-8"?>` +
              `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
              `<name>${brig} - ${ymd}</name>` +
              `<Style id="routeStyle"><LineStyle><color>ffFF0000</color><width>4</width></LineStyle></Style>`;

    const coordsStr = coords.map(([lng,lat])=>`${lng},${lat},0`).join(" ");
    kml += `
      <Placemark>
        <name>${brig} (${ymd})</name>
        <styleUrl>#routeStyle</styleUrl>
        <LineString><tessellate>1</tessellate><coordinates>${coordsStr}</coordinates></LineString>
      </Placemark>`;
    kml += `</Document></kml>`;

    if (!window.JSZip) {
      try { await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"); } catch(_){}
    }
    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({type:"blob",compression:"DEFLATE",compressionOptions:{level:1}});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const safeBrig = brig.replace(/[^a-zA-Z0-9_-]+/g,"_");
    a.download = `recorrido_${safeBrig}_${ymd}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);

    alert(`✅ KMZ listo desde ruta limpia: ${brig} (${ymd})`);
  } catch(e){
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado","green");
    if (ui?.exportKmz) ui.exportKmz.disabled = prevDisabled;
  }
}

// Arranque
setStatus("Cargando...","gray");
subscribeRealtime();
fetchInitial(true);
