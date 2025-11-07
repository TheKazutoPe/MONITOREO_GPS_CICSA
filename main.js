// ============================== main.js ==============================
// Usa CONFIG y supabase globales cargados en index.html
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

// ====== UI refs (mismos IDs que tu HTML) ======
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
};

// ====== Estado del mapa/lista ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),        // uid -> { marker, lastRow }
  pointsByUser: new Map(), // uid -> [rows]
};

// ====== Ajustes de trazado / matching ======
const CLEAN_MIN_METERS      = 6;     // suaviza “dientes”
const DENSIFY_STEP          = 10;    // curvatura urbana más real
const MAX_MM_POINTS         = 40;    // tamaño de bloque crudo por bloque
const MAX_MATCH_INPUT       = 90;    // límite duro para URL GET del Matching
const MAX_DIST_RATIO        = 0.35;  // tolerancia matching vs crudo
const ENDPOINT_TOL          = 25;    // tolerancia de puntas (m)
const CONFIDENCE_MIN        = 0.70;  // confianza mínima Mapbox (0..1)

// Gaps / “teleport”
const GAP_MINUTES           = 8;     // gap tiempo → nuevo segmento
const GAP_JUMP_METERS       = 800;   // salto espacial brusco → nuevo segmento

// Puentes por carretera (Directions)
const BRIDGE_MAX_METERS     = 800;
const DIRECTIONS_HOP_METERS = 300;
const MAX_BRIDGE_SPEED_KMH  = 70;
const MIN_BRIDGE_SPEED_KMH  = 3;
const DIRECTIONS_PROFILE    = "driving";

// Ritmo de llamadas
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

// ====== Ajustes de trazado en tiempo real ======
const RT_WINDOW_POINTS    = 30;     // ventana corta matching incremental
const RT_MIN_MOVE_METERS  = 8;      // si no se mueve suficiente, no traza
const RT_SAVE_EVERY_N     = 15;     // upsert cada N puntos nuevos
const RT_SAVE_EVERY_MS    = 60000;  // o cada X ms

// ====== DEBUG (para verificar Mapbox) ======
const DEBUG_ROUTE = false; // pon en true cuando quieras auditar el trazo

// ====== Estado rutas en vivo por brigada ======
const routes = new Map();
// routes.get(brigada) => { points:[], polyline:L.Polyline, lastSavedAt:0, appendedSinceSave:0 }

// ====== Helpers generales ======
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

// ====== Helpers RT ======
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

// ====== densificar ======
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

// ====== limitar puntos para Matching ======
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

// ====== limpiar y cortar ======
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

// ====== Radio adaptativo ======
function adaptiveRadius(p){
  const acc = (p && p.acc != null) ? Number(p.acc) : NaN;
  const base = isFinite(acc) ? acc + 5 : 25;
  return Math.max(10, Math.min(50, base));   // 10–50 m
}

// ====== Map Matching con Mapbox ======
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
    if (DEBUG_ROUTE) console.log("MM: sin geometría, fallback");
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

// ====== Directions con plausibilidad ======
async function directionsBetween(a, b) {
  if (!MAPBOX_TOKEN) return null;

  const direct = distMeters(a, b);
  if (direct > BRIDGE_MAX_METERS) return null;

  const url =
    `https://api.mapbox.com/directions/v5/mapbox/${DIRECTIONS_PROFILE}/` +
    `${a.lng},${a.lat};${b.lng},${b.lat}` +
    `?geometries=geojson&overview=full&annotations=distance,duration` +
    `&access_token=${MAPBOX_TOKEN}`;

  let r;
  try { r = await fetch(url); } catch {
    if (DEBUG_ROUTE) console.log("Directions fetch error");
    return null;
  }
  if (!r.ok) return null;

  const j = await r.json().catch(()=>null);
  const route = j?.routes?.[0];
  const coords = route?.geometry?.coordinates || [];
  const meters = route?.distance ?? 0;
  if (!coords.length || meters <= 0) return null;

  const first = { lat: coords[0][1], lng: coords[0][0] };
  if (distMeters(a, first) > 80) return null;

  const dt = Math.max(1, (new Date(b.timestamp) - new Date(a.timestamp))/1000);
  const v_kmh_imp = (meters/1000) / (dt/3600);
  if (v_kmh_imp > MAX_BRIDGE_SPEED_KMH) return null;
  if (v_kmh_imp < MIN_BRIDGE_SPEED_KMH && dt < 300) return null;

  return coords.map(([lng,lat]) => ({ lat, lng, timestamp: a.timestamp }));
}

// ====== Bridge multi-hop ======
async function smartBridge(a, b) {
  const d = distMeters(a, b);
  if (d > BRIDGE_MAX_METERS) return null;

  if (d <= DIRECTIONS_HOP_METERS) {
    return await directionsBetween(a, b);
  }

  const hops = Math.ceil(d / DIRECTIONS_HOP_METERS);
  const out = [a];
  let prev = a;
  for (let i=1; i<=hops; i++){
    const t = i / hops;
    const mid = {
      lat: a.lat + (b.lat - a.lat)*t,
      lng: a.lng + (b.lng - a.lng)*t,
      timestamp: new Date(
        new Date(a.timestamp).getTime() +
        (new Date(b.timestamp) - new Date(a.timestamp)) * t
      ).toISOString()
    };
    const seg = await directionsBetween(prev, mid);
    if (!seg) return null;
    out.push(...seg.slice(1));
    prev = mid;
    await sleep(60);
  }
  return out;
}

// ====== Mapa / Lista ======
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

// ====== Carga inicial últimas 24h ======
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
    state.pointsByUser.set(uid, rows);
    addOrUpdateUserInList(last);
  });

  setStatus("Conectado","green");
}

// ====== Persistencia del trazo diario ======
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
  const d = new Date(lastTs);
  const ymd = toYMD(d);

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

// ====== Matching incremental en tiempo real ======
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

  // Empalme con trazo previo
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
    // Dibujar puntos crudos usados (cyan)
    rawTail.forEach(p => {
      L.circleMarker([p.lat, p.lng], {
        radius: 3,
        color: '#00bcd4',
        opacity: 0.6
      }).addTo(state.map);
    });
  }

  r.points.push(...tailToAdd);

  const allLatLngs = r.points.map(p => [p.lat, p.lng]);
  r.polyline.setLatLngs(allLatLngs);

  r.appendedSinceSave += tailToAdd.length;
  maybePersistRoute(brigada, r);
}

// ====== Realtime (INSERT) ======
function subscribeRealtime(){
  const chan = supa.channel('ubicaciones_brigadas-changes')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'ubicaciones_brigadas' },
      async (payload) => {
        const r = payload?.new;
        if (!r) return;

        const brigFilter = (ui.brigada.value || "").trim().toLowerCase();
        const brigada = String(r.brigada || "");
        if (brigFilter && !brigada.toLowerCase().includes(brigFilter)) return;

        addOrUpdateUserInList(r);

        const uid = String(r.usuario_id || "0");
        let u = state.users.get(uid);
        if (!u){
          const marker = L.marker([r.latitud, r.longitud], { icon: getIconFor(r) }).bindPopup(buildPopup(r));
          state.cluster.addLayer(marker);
          u = { marker, lastRow: r };
          state.users.set(uid, u);
        } else {
          u.marker
            .setLatLng([r.latitud, r.longitud])
            .setIcon(getIconFor(r))
            .setPopupContent(buildPopup(r));
          u.lastRow = r;
        }

        // Punto crudo nuevo
        const rawPoint = {
          lat: +r.latitud,
          lng: +r.longitud,
          timestamp: r.timestamp_pe || r.timestamp,
          acc: r.acc ?? null,
          spd: r.spd ?? null
        };

        // Si está quieto, no se traza
        const route = ensureRouteLayer(brigada);
        const last = route.points.at(-1);
        if (last && !isMovingEnough(last, rawPoint, RT_MIN_MOVE_METERS)) return;

        // Ventana chica con últimos crudos conocidos de ese uid
        const prevRawList = (state.pointsByUser.get(uid) || []).slice(0, 5)
          .map(x => ({
            lat:+x.latitud,
            lng:+x.longitud,
            timestamp:x.timestamp_pe || x.timestamp,
            acc:x.acc ?? null
          }));
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

// ====== EXPORTAR KMZ ======
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
    const next = new Date(chosen.getTime() + 24*60*60*1000);
    const ymdNext = toYMD(next);

    // 1) Usar ruta corregida del día generada en tiempo real (tabla rutas_brigadas_dia)
    const { data:routeRow, error:routeErr } = await supa
      .from("rutas_brigadas_dia")
      .select("line_geojson, puntos")
      .eq("brigada", brig)
      .eq("fecha", ymd)
      .maybeSingle();

    if (!routeErr && routeRow?.line_geojson?.coordinates?.length >= 2){
      const coords = routeRow.line_geojson.coordinates; // [ [lng,lat], ... ]
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

      alert(`✅ KMZ listo (desde rutas_brigadas_dia): ${brig} (${ymd})`);
      return;
    }

    // 2) Si no hay registro en rutas_brigadas_dia (casos antiguos), usar fallback sobre crudo
    const {data, error} = await supa
      .from("ubicaciones_brigadas")
      .select("latitud,longitud,timestamp,tecnico,usuario_id,timestamp_pe,brigada,acc,spd")
      .eq("brigada", brig)
      .gte("timestamp_pe", ymd)
      .lt("timestamp_pe", ymdNext)
      .order("timestamp_pe",{ascending:true});

    if (error) throw new Error(error.message);
    if (!data || data.length < 2){
      alert(`⚠️ No hay datos para "${brig}" en ${ymd}.`);
      return;
    }

    const all = (data || [])
      .map(r => ({
        lat: +r.latitud,
        lng: +r.longitud,
        timestamp: r.timestamp_pe || r.timestamp,
        acc: r.acc ?? null,
        spd: r.spd ?? null
      }))
      .filter(p => isFinite(p.lat) && isFinite(p.lng) && p.timestamp)
      .sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

    if (all.length < 2){
      alert(`⚠️ No hay suficientes puntos para "${brig}" en ${ymd}.`);
      return;
    }

    const rows1 = [all[0], ...cleanClosePoints(all.slice(1), CLEAN_MIN_METERS)];
    const segments = splitOnGaps(rows1, GAP_MINUTES, GAP_JUMP_METERS);

    const renderedSegments = [];
    for (const seg of segments){
      if (seg.length < 2) continue;

      const blocks = chunk(seg, MAX_MM_POINTS);
      let current = [];
      for (let i=0;i<blocks.length;i++){
        const block = blocks[i];

        let finalBlock = densifySegment(block, DENSIFY_STEP);

        try {
          const mm = await mapMatchBlockSafe(block);
          if (mm && mm.length >= 2) finalBlock = mm;
        } catch(_) {}

        if (!current.length){
          current.push(...finalBlock);
        } else {
          const last  = current[current.length-1];
          const first = finalBlock[0];
          const gapM  = distMeters(last, first);

          if (gapM > 5) {
            let appended = false;
            if (gapM <= BRIDGE_MAX_METERS) {
              const bridge = await smartBridge(last, first);
              if (bridge?.length) {
                current.push(...bridge.slice(1));
                appended = true;
              }
            }
            if (!appended) {
              if (current.length > 1) renderedSegments.push(current);
              current = [...finalBlock];
              await sleep(PER_BLOCK_DELAY);
              continue;
            }
          }
          current.push(...finalBlock.slice(1));
        }

        await sleep(PER_BLOCK_DELAY);
      }
      if (current.length > 1) renderedSegments.push(current);
    }

    if (!renderedSegments.length){
      alert("No se generó traza válida.");
      return;
    }

    let kml = `<?xml version="1.0" encoding="UTF-8"?>` +
              `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
              `<name>${brig} - ${ymd}</name>` +
              `<Style id="routeStyle"><LineStyle><color>ffFF0000</color><width>4</width></LineStyle></Style>`;

    for (const seg of renderedSegments) {
      const coordsStr = seg.map(p=>`${p.lng},${p.lat},0`).join(" ");
      kml += `
        <Placemark>
          <name>${brig} (${ymd})</name>
          <styleUrl>#routeStyle</styleUrl>
          <LineString><tessellate>1</tessellate><coordinates>${coordsStr}</coordinates></LineString>
        </Placemark>`;
    }

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

    alert(`✅ KMZ listo (fallback crudo procesado): ${brig} (${ymd})`);
  } catch(e){
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado","green");
    if (ui?.exportKmz) ui.exportKmz.disabled = prevDisabled;
  }
}

// ====== Arranque ======
setStatus("Cargando...","gray");
subscribeRealtime();   // genera/actualiza rutas_brigadas_dia en tiempo real
fetchInitial(true);    // carga inicial de marcadores/lista
