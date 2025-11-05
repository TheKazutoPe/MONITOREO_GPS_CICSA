// ============================== main.js ==============================
// Usa CONFIG y supabase globales ya cargados en index.html
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

// ====== Tablas ======
const TABLE_RAW   = "ubicaciones_brigadas";   // original (puntos crudos)
const TABLE_CLEAN = "rutas_brigadas_dia";     // NUEVA: ruta limpia (map-matched) por día

// ====== Ajustes de trazado / matching ======
const CLEAN_MIN_METERS      = 6;     // suaviza “dientes”
const DENSIFY_STEP          = 10;    // curvatura urbana más real
const MAX_MM_POINTS         = 40;    // tamaño de bloque crudo
const MAX_MATCH_INPUT       = 90;    // límite para URL GET del Matching
const MAX_DIST_RATIO        = 0.35;  // tolerancia matching vs crudo
const ENDPOINT_TOL          = 25;    // tolerancia puntas (m)
const CONFIDENCE_MIN        = 0.70;  // confianza mínima Mapbox (0..1)

// Gaps / “teleport” (evitar uniones falsas)
const GAP_MINUTES           = 8;     // gap de tiempo → nuevo segmento
const GAP_JUMP_METERS       = 800;   // salto espacial brusco → nuevo segmento

// Puentes por carretera (Directions) con plausibilidad
const BRIDGE_MAX_METERS     = 800;   // tope de puente
const DIRECTIONS_HOP_METERS = 300;   // hops cuando el puente es largo
const MAX_BRIDGE_SPEED_KMH  = 70;    // si la unión implica >70 km/h = NO unir
const MIN_BRIDGE_SPEED_KMH  = 3;     // si implica <3 km/h en gap corto = ruido
const DIRECTIONS_PROFILE    = "driving"; // o "driving-traffic"

// Ritmo de llamadas a APIs
const PER_BLOCK_DELAY       = 150;

// ====== Iconos/estética (igual a tu base) ======
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

// ====== Helpers base ======
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
  const out=[]; for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out;
}

// ====== Geometría: densificar / downsample ======
function densifySegment(points, step = DENSIFY_STEP) {
  if (!points || points.length < 2) return points;
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
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
  const out = [], step = (arr.length - 1) / (maxN - 1);
  for (let i = 0; i < maxN; i++){
    const idx = Math.round(i * step);
    out.push(arr[idx]);
  }
  out[0] = arr[0];
  out[out.length - 1] = arr[arr.length - 1];
  return out;
}

// ====== Limpieza / cortes ======
function cleanClosePoints(points, minMeters = CLEAN_MIN_METERS){
  if (!points.length) return points;
  const out = [points[0]];
  for (let i=1;i<points.length;i++){
    const prev = out[out.length-1], cur = points[i];
    if (distMeters(prev,cur) >= minMeters) out.push(cur);
  }
  return out;
}
function splitOnGaps(points, maxGapMin = GAP_MINUTES, maxJumpM = GAP_JUMP_METERS){
  const groups = []; let cur = [];
  for (let i=0;i<points.length;i++){
    const p = points[i];
    if (!cur.length){ cur.push(p); continue; }
    const prev = cur[cur.length-1];
    const dtMin = (new Date(p.timestamp) - new Date(prev.timestamp))/60000;
    const djump = distMeters(prev, p);
    if (dtMin > maxGapMin || djump > maxJumpM){
      if (cur.length>1) groups.push(cur);
      cur = [p];
    } else cur.push(p);
  }
  if (cur.length>1) groups.push(cur);
  return groups;
}

// ====== Radio adaptativo por punto (usa 'acc' si existe) ======
function adaptiveRadius(p){
  const acc = (p && p.acc != null) ? Number(p.acc) : NaN;
  const base = isFinite(acc) ? acc + 5 : 25; // leve holgura
  return Math.max(10, Math.min(50, base));   // 10–50 m
}

// ====== Map Matching (timestamps + radiuses + downsample) ======
async function mapMatchBlockSafe(seg){
  if (!MAPBOX_TOKEN) return null;
  if (!seg || seg.length < 2) return null;
  if (seg.length > MAX_MM_POINTS) return null;

  const dense0 = densifySegment(seg, DENSIFY_STEP);
  const dense  = downsamplePoints(dense0, MAX_MATCH_INPUT);

  // distancia cruda (validación)
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
  catch(e){ console.warn("Matching fetch error:", e); return null; }

  if (!r.ok){
    const txt = await r.text().catch(()=> "");
    console.warn("Matching status:", r.status, txt.slice(0,200));
    return null;
  }

  const j = await r.json().catch(()=> null);
  const m = j?.matchings?.[0];
  if (!m?.geometry?.coordinates || (typeof m.confidence === "number" && m.confidence < CONFIDENCE_MIN)) {
    // fallback: partir bloque
    if (dense.length > 24) {
      const mid = Math.floor(dense.length/2);
      const left  = await mapMatchBlockSafe(dense.slice(0, mid));
      const right = await mapMatchBlockSafe(dense.slice(mid-1));
      if (left && right) return left.concat(right.slice(1));
    }
    return null;
  }

  const matched = m.geometry.coordinates.map(([lng,lat])=>({lat,lng}));
  let mmDist=0; for (let i=0;i<matched.length-1;i++) mmDist += distMeters(matched[i], matched[i+1]);
  if ((Math.abs(mmDist - rawDist) / Math.max(rawDist,1)) > MAX_DIST_RATIO) return null;
  if (distMeters(dense[0], matched[0]) > ENDPOINT_TOL) return null;
  if (distMeters(dense.at(-1), matched.at(-1)) > ENDPOINT_TOL) return null;

  // Propagar timestamps (opcional)
  for (let i=0;i<matched.length;i++){
    matched[i].timestamp = dense[Math.min(i, dense.length-1)].timestamp;
    matched[i].acc = dense[Math.min(i, dense.length-1)].acc;
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
  try { r = await fetch(url); } catch { return null; }
  if (!r.ok) return null;

  const j = await r.json().catch(()=>null);
  const route = j?.routes?.[0];
  const coords = route?.geometry?.coordinates || [];
  const meters = route?.distance ?? 0;   // m
  const secs   = route?.duration ?? 0;   // s
  if (!coords.length || meters <= 0) return null;

  const first = { lat: coords[0][1], lng: coords[0][0] };
  if (distMeters(a, first) > 80) return null;

  const dt = Math.max(1, (new Date(b.timestamp) - new Date(a.timestamp))/1000);
  const v_kmh_imp = (meters/1000) / (dt/3600);
  if (v_kmh_imp > MAX_BRIDGE_SPEED_KMH) return null;
  if (v_kmh_imp < MIN_BRIDGE_SPEED_KMH && dt < 300) return null;

  return coords.map(([lng,lat]) => ({ lat, lng, timestamp: a.timestamp }));
}
async function smartBridge(a, b) {
  const d = distMeters(a, b);
  if (d > BRIDGE_MAX_METERS) return null;
  if (d <= DIRECTIONS_HOP_METERS) return await directionsBetween(a, b);

  const hops = Math.ceil(d / DIRECTIONS_HOP_METERS);
  const out = [a]; let prev = a;
  for (let i=1; i<=hops; i++){
    const t = i / hops;
    const mid = {
      lat: a.lat + (b.lat - a.lat)*t,
      lng: a.lng + (b.lng - a.lng)*t,
      timestamp: new Date(new Date(a.timestamp).getTime() + (new Date(b.timestamp) - new Date(a.timestamp)) * t).toISOString()
    };
    const seg = await directionsBetween(prev, mid);
    if (!seg) return null;
    out.push(...seg.slice(1));
    prev = mid;
    await sleep(60);
  }
  return out;
}

// ====== Mapa / Lista (tu UI base) ======
function initMap(){
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20});
  state.map = L.map("map",{center:[-12.0464,-77.0428],zoom:12,layers:[state.baseLayers.osm]});
  state.cluster = L.markerClusterGroup({disableClusteringAtZoom:16});
  state.map.addLayer(state.cluster);

  ui.apply.onclick = () => fetchInitial(true);
  ui.exportKmz.onclick = () => exportKMZFromState();

  // Iniciar guardado en tiempo real del trazado limpio
  startRealtimeCleanRouteSaver();
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

// ====== Últimas 24h (tu lista lateral) ======
async function fetchInitial(clear){
  setStatus("Cargando…","gray");
  if (clear) ui.userList.innerHTML = "";

  const {data, error} = await supa
    .from(TABLE_RAW)
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

// ====================================================================
// =========== GUARDADO EN TIEMPO REAL DEL TRAZO LIMPIO  ==============
// ====================================================================
//
// Qué hace:
// - Escucha inserts en `ubicaciones_brigadas` (tu tabla cruda).
// - Por cada brigada y día actual, toma los últimos puntos crudos,
//   hace map-matching incremental y APPENDEA la geometría limpia
//   en `rutas_brigadas_dia` con un `seq` incremental.
//
// Tabla sugerida (ver SQL más abajo):
//   rutas_brigadas_dia(
//     id bigserial pk,
//     brigada text,
//     fecha date,
//     seq int,                 -- orden incremental
//     lat double precision,
//     lng double precision,
//     timestamp timestamptz,   -- local o utc, el que uses (usa timestamp_pe si tienes)
//     source text,             -- 'realtime' | 'backfill'
//     confidence numeric       -- opcional: confianza del matching [0..1]
//   )
//
function startRealtimeCleanRouteSaver() {
  try {
    const ch = supa
      .channel("rutas-clean")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: TABLE_RAW },
        async (payload) => {
          const r = payload.new;
          if (!r) return;

          // Briga seleccionada (si escribiste filtro, guardamos esa; si está vacío, guardamos todas)
          const brigFilter = (ui.brigada.value||"").trim();
          if (brigFilter && String(r.brigada) !== brigFilter) return;

          // Fecha local del punto (si tienes timestamp_pe úsalo; sino toma date(timestamp))
          const ts = r.timestamp_pe || r.timestamp;
          if (!ts) return;
          const ymd = toYMD(new Date(ts));

          // Armamos una ventana de puntos recientes (últimos ~20 min) para extender suavemente
          const { data: win, error } = await supa
            .from(TABLE_RAW)
            .select("latitud,longitud,timestamp,timestamp_pe,acc,spd")
            .eq("brigada", r.brigada)
            .gte("timestamp_pe", new Date(new Date(ts).getTime() - 20*60000).toISOString().slice(0,10)) // guardrail
            .lt("timestamp_pe", ymd) // evitamos mezclar días
            .order("timestamp_pe", { ascending: true })
            .limit(200);

          // Incluye el propio punto insertado (día actual)
          const windowPoints = (win || []).map(x => ({
            lat: +x.latitud, lng: +x.longitud,
            timestamp: x.timestamp_pe || x.timestamp, acc: x.acc ?? null
          }));
          windowPoints.push({ lat:+r.latitud, lng:+r.longitud, timestamp: ts, acc: r.acc ?? null });

          const sorted = windowPoints
            .filter(p => isFinite(p.lat) && isFinite(p.lng) && p.timestamp)
            .sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

          if (sorted.length < 2) return;

          // Matching incremental (bloque chico)
          const base = cleanClosePoints(sorted, CLEAN_MIN_METERS);
          const segments = splitOnGaps(base, GAP_MINUTES, GAP_JUMP_METERS);
          let ext = [];
          for (const seg of segments) {
            if (seg.length < 2) continue;
            const blocks = chunk(seg, Math.min(MAX_MM_POINTS, 20));
            for (const block of blocks) {
              const mm = await mapMatchBlockSafe(block);
              if (mm && mm.length > 1) {
                if (!ext.length) ext.push(...mm);
                else {
                  const last = ext[ext.length-1], first = mm[0];
                  const gapM = distMeters(last, first);
                  if (gapM > 5 && gapM <= BRIDGE_MAX_METERS) {
                    const bridge = await smartBridge(last, first);
                    if (bridge?.length) ext.push(...bridge.slice(1));
                  }
                  ext.push(...mm.slice(1));
                }
              }
              await sleep(60);
            }
          }

          if (ext.length < 2) return;

          // Persistir en TABLE_CLEAN, haciendo append con seq incremental
          const { data: maxSeqRows } = await supa
            .from(TABLE_CLEAN)
            .select("seq")
            .eq("brigada", r.brigada)
            .eq("fecha", ymd)
            .order("seq", { ascending:false })
            .limit(1);

          let seq = (maxSeqRows && maxSeqRows[0] ? (maxSeqRows[0].seq + 1) : 1);
          const rowsToInsert = ext.map(p => ({
            brigada: r.brigada,
            fecha: ymd,
            seq: seq++,
            lat: p.lat,
            lng: p.lng,
            timestamp: p.timestamp,
            source: "realtime",
            confidence: null
          }));

          await supa.from(TABLE_CLEAN).insert(rowsToInsert);
        }
      )
      .subscribe();

    setStatus("Conectado (realtime)", "green");
  } catch (e) {
    console.warn("Realtime saver error:", e);
    setStatus("Conectado", "green");
  }
}

// ============================= EXPORTAR KMZ =============================
//
// 1) Intenta leer la ruta LIMPIA guardada (TABLE_CLEAN).
// 2) Si no hay suficiente, genera desde crudo (map-matching), exporta
//    y además GUARDA como “backfill” en TABLE_CLEAN.
//
async function exportKMZFromState(){
  let prevDisabled = false;
  try {
    setStatus("Generando KMZ…","gray");
    if (ui?.exportKmz){ prevDisabled = ui.exportKmz.disabled; ui.exportKmz.disabled = true; }

    const brig = (ui.brigada.value || "").trim();
    if (!brig){ alert("Escribe la brigada EXACTA para exportar su KMZ."); return; }

    const dateInput = document.getElementById("kmzDate");
    const chosen = (dateInput && dateInput.value) ? new Date(dateInput.value+"T00:00:00") : new Date();
    const ymd = toYMD(chosen);

    // 1) Ruta LIMPIA guardada
    const { data: cleanRows, error: cleanErr } = await supa
      .from(TABLE_CLEAN)
      .select("lat,lng,seq")
      .eq("brigada", brig)
      .eq("fecha", ymd)
      .order("seq", { ascending: true });

    if (!cleanErr && cleanRows && cleanRows.length >= 2) {
      const coordsStr = cleanRows.map(p=>`${p.lng},${p.lat},0`).join(" ");
      let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <name>${brig} - ${ymd}</name>
  <Style id="routeStyle"><LineStyle><color>ffFF0000</color><width>4</width></LineStyle></Style>
  <Placemark><name>${brig} (${ymd})</name><styleUrl>#routeStyle</styleUrl>
    <LineString><tessellate>1</tessellate><coordinates>${coordsStr}</coordinates></LineString>
  </Placemark>
</Document></kml>`;

      await ensureJsZip();
      const zip = new JSZip(); zip.file("doc.kml", kml);
      const blob = await zip.generateAsync({type:"blob",compression:"DEFLATE",compressionOptions:{level:1}});
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `recorrido_${brig.replace(/[^a-zA-Z0-9_-]+/g,"_")}_${ymd}.kmz`;
      a.click(); URL.revokeObjectURL(a.href);

      alert(`✅ KMZ (ruta guardada) — ${brig} ${ymd}`);
      setStatus("Conectado","green");
      return;
    }

    // 2) Si no hay ruta limpia suficiente, la generamos desde CRUDO (día completo)
    const ymdNext = toYMD(new Date(chosen.getTime() + 24*60*60*1000));
    const {data, error} = await supa
      .from(TABLE_RAW)
      .select("latitud,longitud,timestamp,tecnico,usuario_id,timestamp_pe,brigada,acc,spd")
      .eq("brigada", brig)
      .gte("timestamp_pe", ymd)
      .lt("timestamp_pe", ymdNext)
      .order("timestamp_pe",{ascending:true});

    if (error) throw new Error(error.message);
    const all = (data || [])
      .map(r => ({ lat:+r.latitud, lng:+r.longitud, timestamp:r.timestamp_pe || r.timestamp, acc:r.acc ?? null, spd:r.spd ?? null }))
      .filter(p => isFinite(p.lat) && isFinite(p.lng) && p.timestamp)
      .sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

    if (all.length < 2){ alert(`⚠️ No hay suficientes puntos para "${brig}" en ${ymd}.`); return; }

    const base = [all[0], ...cleanClosePoints(all.slice(1), CLEAN_MIN_METERS)];
    const segments = splitOnGaps(base, GAP_MINUTES, GAP_JUMP_METERS);

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
        } catch(_){}
        if (!current.length) current.push(...finalBlock);
        else {
          const last = current[current.length-1], first = finalBlock[0];
          const gapM = distMeters(last, first);
          if (gapM > 5) {
            let appended = false;
            if (gapM <= BRIDGE_MAX_METERS) {
              const bridge = await smartBridge(last, first);
              if (bridge?.length) { current.push(...bridge.slice(1)); appended = true; }
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

    if (!renderedSegments.length){ alert("No se generó traza válida."); return; }

    // Exportar KML/KMZ (un Placemark por tramo)
    let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <name>${brig} - ${ymd}</name>
  <Style id="routeStyle"><LineStyle><color>ffFF0000</color><width>4</width></LineStyle></Style>`;
    for (const seg of renderedSegments) {
      const coordsStr = seg.map(p=>`${p.lng},${p.lat},0`).join(" ");
      kml += `
  <Placemark><name>${brig} (${ymd})</name><styleUrl>#routeStyle</styleUrl>
    <LineString><tessellate>1</tessellate><coordinates>${coordsStr}</coordinates></LineString>
  </Placemark>`;
    }
    kml += `\n</Document></kml>`;

    await ensureJsZip();
    const zip = new JSZip(); zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({type:"blob",compression:"DEFLATE",compressionOptions:{level:1}});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `recorrido_${brig.replace(/[^a-zA-Z0-9_-]+/g,"_")}_${ymd}.kmz`;
    a.click(); URL.revokeObjectURL(a.href);

    alert(`✅ KMZ (generado y guardado) — ${brig} ${ymd}`);

    // 3) GUARDAR también lo generado como “backfill” en TABLE_CLEAN
    let seq = 1;
    const rowsToInsert = [];
    for (const seg of renderedSegments) {
      for (const p of seg) {
        rowsToInsert.push({
          brigada: brig,
          fecha: ymd,
          seq: seq++,
          lat: p.lat,
          lng: p.lng,
          timestamp: p.timestamp,
          source: "backfill",
          confidence: null
        });
      }
    }
    await supa.from(TABLE_CLEAN).insert(rowsToInsert);

  } catch(e){
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado","green");
    if (ui?.exportKmz) ui.exportKmz.disabled = prevDisabled;
  }
}

async function ensureJsZip(){
  if (!window.JSZip) {
    try { await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"); } catch(_){}
  }
}

// ====== Arranque ======
setStatus("Cargando...","gray");
fetchInitial(true);
