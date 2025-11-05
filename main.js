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
  cleanRouteLayer: null,   // capa del trazo limpio del día
};

// ====== Envío en vivo del trazo limpio (cliente -> Supabase) ======
const live = {
  bufferByBrigada: new Map(),      // brigada -> [{lat,lng,timestamp,acc,spd}]
  timerByBrigada: new Map(),       // brigada -> setTimeout id
  lastSeqByBrigada: new Map(),     // brigada -> último seq persistido hoy
  lastSentHashByBrigada: new Map(),// anti-duplicado simple
  BATCH_INTERVAL_MS: 20000,        // procesa cada ~20 s
  MIN_POINTS: 4                    // mínimo para map-match
};

// ====== Ajustes de trazado / matching ======
const CLEAN_MIN_METERS      = 6;     // suaviza “dientes”
const DENSIFY_STEP          = 10;    // curvatura urbana más real
const MAX_MM_POINTS         = 40;    // tamaño de bloque crudo
const MAX_MATCH_INPUT       = 90;    // límite para URL GET de Matching
const MAX_DIST_RATIO        = 0.35;  // tolerancia matching vs crudo
const ENDPOINT_TOL          = 25;    // tolerancia de puntas (m)
const CONFIDENCE_MIN        = 0.70;  // confianza mínima Mapbox (0..1)
const GAP_MINUTES           = 8;     // gap de tiempo → nuevo segmento
const GAP_JUMP_METERS       = 800;   // salto espacial brusco → nuevo segmento
const BRIDGE_MAX_METERS     = 800;   // tope de “puente” (directions)
const DIRECTIONS_HOP_METERS = 300;   // hops si el puente es largo
const MAX_BRIDGE_SPEED_KMH  = 70;    // >70 km/h → no unir
const MIN_BRIDGE_SPEED_KMH  = 3;     // <3 km/h en gap corto → ruido
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
function chunk(arr,size){ const out=[]; for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }
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
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, timestamp: a.timestamp, acc: a.acc });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
function downsamplePoints(arr, maxN){
  if (!arr || arr.length <= maxN) return arr || [];
  const out = []; const step = (arr.length - 1) / (maxN - 1);
  for (let i = 0; i < maxN; i++) out.push(arr[Math.round(i * step)]);
  out[0] = arr[0]; out[out.length - 1] = arr[arr.length - 1]; return out;
}
function cleanClosePoints(points, minMeters = CLEAN_MIN_METERS){
  if (!points.length) return points;
  const out = [points[0]];
  for (let i=1;i<points.length;i++){ if (distMeters(out.at(-1),points[i]) >= minMeters) out.push(points[i]); }
  return out;
}
function splitOnGaps(points, maxGapMin = GAP_MINUTES, maxJumpM = GAP_JUMP_METERS){
  const groups = []; let cur = [];
  for (let i=0;i<points.length;i++){
    const p = points[i];
    if (!cur.length){ cur.push(p); continue; }
    const prev = cur.at(-1);
    const dtMin = (new Date(p.timestamp) - new Date(prev.timestamp))/60000;
    const djump = distMeters(prev, p);
    if (dtMin > maxGapMin || djump > maxJumpM){ if (cur.length>1) groups.push(cur); cur = [p]; }
    else cur.push(p);
  }
  if (cur.length>1) groups.push(cur);
  return groups;
}
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

  // densificar para curvatura real
  const dense0 = densifySegment(seg, DENSIFY_STEP);

  // limitar puntos para no exceder URL GET
  const dense = downsamplePoints(dense0, MAX_MATCH_INPUT);

  // distancia cruda (validación)
  let rawDist = 0;
  for (let i=0;i<dense.length-1;i++) rawDist += distMeters(dense[i], dense[i+1]);

  // parámetros con timestamps y radiuses ADAPTATIVOS
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
  // Confianza mínima + fallback partiendo el bloque
  if (!m?.geometry?.coordinates || (typeof m.confidence === "number" && m.confidence < CONFIDENCE_MIN)) {
    if (dense.length > 24) {
      const mid = Math.floor(dense.length/2);
      const left  = await mapMatchBlockSafe(dense.slice(0, mid));
      const right = await mapMatchBlockSafe(dense.slice(mid-1));
      if (left && right) return left.concat(right.slice(1));
    }
    return null;
  }

  const matched = m.geometry.coordinates.map(([lng,lat])=>({lat,lng}));

  // validaciones anti-teleport
  let mmDist=0;
  for (let i=0;i<matched.length-1;i++) mmDist += distMeters(matched[i], matched[i+1]);
  if ((Math.abs(mmDist - rawDist) / Math.max(rawDist,1)) > MAX_DIST_RATIO) return null;
  if (distMeters(dense[0], matched[0]) > ENDPOINT_TOL) return null;
  if (distMeters(dense.at(-1), matched.at(-1)) > ENDPOINT_TOL) return null;

  // timestamps aproximados (opcional)
  for (let i=0;i<matched.length;i++){
    matched[i].timestamp = dense[Math.min(i, dense.length-1)].timestamp;
    matched[i].acc = dense[Math.min(i, dense.length-1)].acc;
  }
  return matched;
}

// ====== Directions con plausibilidad (distancia / duración / velocidad) ======
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

  // coherencia espacial al inicio del puente
  const first = { lat: coords[0][1], lng: coords[0][0] };
  if (distMeters(a, first) > 80) return null;

  // coherencia temporal: ¿da el tiempo para recorrer esa distancia?
  const dt = Math.max(1, (new Date(b.timestamp) - new Date(a.timestamp))/1000);
  const v_kmh_imp = (meters/1000) / (dt/3600);
  if (v_kmh_imp > MAX_BRIDGE_SPEED_KMH) return null;
  if (v_kmh_imp < MIN_BRIDGE_SPEED_KMH && dt < 300) return null;

  return coords.map(([lng,lat]) => ({ lat, lng, timestamp: a.timestamp }));
}

// ====== Bridge en varios “hops” (si falla uno, se cancela) ======
async function smartBridge(a, b) {
  const d = distMeters(a, b);
  if (d > BRIDGE_MAX_METERS) return null;

  if (d <= DIRECTIONS_HOP_METERS) return await directionsBetween(a, b);

  const hops = Math.ceil(d / DIRECTIONS_HOP_METERS);
  const out = [a];
  let prev = a;
  for (let i=1; i<=hops; i++){
    const t = i / hops;
    const mid = {
      lat: a.lat + (b.lat - a.lat)*t,
      lng: a.lng + (b.lng - a.lng)*t,
      timestamp: new Date( new Date(a.timestamp).getTime() + (new Date(b.timestamp) - new Date(a.timestamp)) * t ).toISOString()
    };
    const seg = await directionsBetween(prev, mid);
    if (!seg) return null; // si un hop no pasa validaciones, NO unimos
    out.push(...seg.slice(1));
    prev = mid;
    await sleep(60);
  }
  return out;
}

// ====== hash + seed seq + push a rutas_brigadas_dia ======
function hashCoords(arr){
  const take = arr.slice(-5).map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");
  let h=0; for (let i=0;i<take.length;i++) h=(h*31 + take.charCodeAt(i))|0;
  return String(h);
}
async function ensureSeqSeed(brig, ymd){
  if (live.lastSeqByBrigada.has(brig)) return;
  const { data, error } = await supa
    .from("rutas_brigadas_dia")
    .select("seq")
    .eq("brigada", brig)
    .eq("fecha", ymd)
    .order("seq", { ascending: false })
    .limit(1);
  const last = (!error && data && data[0]) ? Number(data[0].seq) : 0;
  live.lastSeqByBrigada.set(brig, isFinite(last) ? last : 0);
}
async function pushCleanChunk(brig, ymd, points){
  if (!points || points.length < 2) return;
  await ensureSeqSeed(brig, ymd);

  // Anti-duplicado rápido
  const h = hashCoords(points);
  if (live.lastSentHashByBrigada.get(brig) === h) return;
  live.lastSentHashByBrigada.set(brig, h);

  // Armar filas con seq incremental
  let seq = (live.lastSeqByBrigada.get(brig) || 0) + 1;
  const rows = points.map(p => ({
    brigada: brig,
    fecha: ymd,
    seq: seq++,
    lat: p.lat,
    lng: p.lng,
    timestamp: new Date(p.timestamp || Date.now()).toISOString(),
    source: "realtime",
    confidence: 1
  }));

  // Insert por lotes
  for (let i=0;i<rows.length;i+=1000){
    const chunk = rows.slice(i, i+1000);
    const { error } = await supa.from("rutas_brigadas_dia").insert(chunk);
    if (error) {
      // si colisiona UNIQUE por seq, reseed y reintenta una vez
      if ((error.message||"").toLowerCase().includes("duplicate")) {
        live.lastSeqByBrigada.delete(brig);
        await ensureSeqSeed(brig, ymd);
        return pushCleanChunk(brig, ymd, points);
      }
      console.warn("Insert rutas_brigadas_dia error:", error.message);
      return;
    }
    live.lastSeqByBrigada.set(brig, seq - 1);
  }
}
async function processLiveBuffer(brig){
  try{
    const buf = live.bufferByBrigada.get(brig) || [];
    if (buf.length < live.MIN_POINTS) return;

    // Hoy (según el input kmzDate si está seteado)
    const dateInput = document.getElementById("kmzDate");
    const chosen = (dateInput && dateInput.value) ? new Date(dateInput.value+"T00:00:00") : new Date();
    const ymd = toYMD(chosen);

    // Limpieza básica
    const cleaned = cleanClosePoints(buf, CLEAN_MIN_METERS);
    if (cleaned.length < live.MIN_POINTS) return;

    // Cortar por gaps y tomar el segmento más reciente
    const segments = splitOnGaps(cleaned, GAP_MINUTES, GAP_JUMP_METERS);
    const seg = segments.length ? segments.at(-1) : cleaned;
    if (!seg || seg.length < live.MIN_POINTS) return;

    // Map-matching
    let matched = await mapMatchBlockSafe(seg);
    if (!matched || matched.length < 2) {
      matched = densifySegment(seg, DENSIFY_STEP); // fallback si el matching falla
    }

    // Enviar tramo limpio a la tabla
    await pushCleanChunk(brig, ymd, matched);

    // Si estás viendo esa brigada, refresca la polilínea limpia
    const current = (ui.brigada.value || "").trim().toLowerCase();
    if (current && current === brig.toLowerCase()) {
      await loadCleanRouteFor(brig, ymd);
    }
  } catch(e){
    console.warn("processLiveBuffer error:", e?.message || e);
  } finally {
    live.timerByBrigada.delete(brig);
    // Conserva sólo los últimos 30 puntos para continuidad
    const buf2 = live.bufferByBrigada.get(brig) || [];
    live.bufferByBrigada.set(brig, buf2.slice(-30));
  }
}

// ====== Mapa / Lista ======
function initMap(){
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20});
  state.map = L.map("map",{center:[-12.0464,-77.0428],zoom:12,layers:[state.baseLayers.osm]});
  state.cluster = L.markerClusterGroup({disableClusteringAtZoom:16});
  state.map.addLayer(state.cluster);

  ui.apply.onclick = async () => {
    await fetchInitial(true);
    const brig = (ui.brigada.value || "").trim();
    if (brig) {
      const dateInput = document.getElementById("kmzDate");
      const chosen = (dateInput && dateInput.value) ? new Date(dateInput.value+"T00:00:00") : new Date();
      await loadCleanRouteFor(brig, toYMD(chosen)); // pinta el trazo limpio del día
    }
  };
  ui.exportKmz.onclick = () => exportKMZFromState();

  // ===== Realtime: al llegar un INSERT a ubicaciones_brigadas, alimentar el buffer =====
  if (CONFIG.SEND_CLEAN_TO_SUPABASE) {
    const chan = supa
      .channel("rt-ubicaciones-send-clean")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ubicaciones_brigadas" },
        async (payload) => {
          try {
            const r = payload?.new;
            const brig = r?.brigada;
            if (!brig || !isFinite(r?.latitud) || !isFinite(r?.longitud)) return;

            // Añadir al buffer
            const p = {
              lat: +r.latitud, lng: +r.longitud,
              timestamp: r.timestamp_pe || r.timestamp,
              acc: r.acc ?? null, spd: r.spd ?? null
            };
            const buf = live.bufferByBrigada.get(brig) || [];
            buf.push(p);
            live.bufferByBrigada.set(brig, buf);

            // Programar procesamiento (cada ~20 s por brigada)
            if (!live.timerByBrigada.has(brig)) {
              const t = setTimeout(() => processLiveBuffer(brig), live.BATCH_INTERVAL_MS);
              live.timerByBrigada.set(brig, t);
            }
          } catch(e){
            console.warn("Realtime handler error:", e?.message || e);
          }
        }
      )
      .subscribe();

    window.addEventListener("beforeunload", () => {
      try { supa.removeChannel(chan); } catch (_) {}
    });
  }
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

// ====== Últimas 24h ======
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

// ============================= EXPORTAR KMZ =============================
// Exporta el KMZ directamente desde la tabla de trazo limpio (rutas_brigadas_dia)
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

    // Lee vértices limpios en orden por seq
    const { data, error } = await supa
      .from("rutas_brigadas_dia")
      .select("lat,lng,seq,fecha")
      .eq("brigada", brig)
      .eq("fecha", ymd)
      .order("seq", { ascending: true });

    if (error) throw new Error(error.message);
    if (!data || data.length < 2){
      alert(`⚠️ No hay trazo limpio para "${brig}" en ${ymd}.`);
      return;
    }

    // Un único LineString con todo el trazo limpio
    const coordsStr = data.map(p => `${p.lng},${p.lat},0`).join(" ");

    let kml = `<?xml version="1.0" encoding="UTF-8"?>` +
              `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
              `<name>${brig} - ${ymd}</name>` +
              `<Style id="routeStyle"><LineStyle><color>ffFF0000</color><width>4</width></LineStyle></Style>` +
              `<Placemark><name>${brig} (${ymd})</name><styleUrl>#routeStyle</styleUrl>` +
              `<LineString><tessellate>1</tessellate><coordinates>${coordsStr}</coordinates></LineString>` +
              `</Placemark></Document></kml>`;

    // Generar KMZ
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

    alert(`✅ KMZ listo: ${brig} (${ymd})`);
  } catch(e){
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado","green");
    if (ui?.exportKmz) ui.exportKmz.disabled = prevDisabled;
  }
}

// ====== Pintar el trazo limpio del día en el mapa ======
async function loadCleanRouteFor(brig, dateYMD){
  try{
    if (state.cleanRouteLayer) {
      state.map.removeLayer(state.cleanRouteLayer);
      state.cleanRouteLayer = null;
    }
    const { data, error } = await supa
      .from("rutas_brigadas_dia")
      .select("lat,lng,seq")
      .eq("brigada", brig)
      .eq("fecha", dateYMD)
      .order("seq", { ascending: true });

    if (error || !data || data.length < 2) return;

    const latlngs = data.map(p => [p.lat, p.lng]);
    state.cleanRouteLayer = L.polyline(latlngs, { weight: 4, opacity: 0.9 }).addTo(state.map);
    try { state.map.fitBounds(state.cleanRouteLayer.getBounds(), { padding: [20,20] }); } catch(_){}
  } catch(_) {}
}

// ====== Arranque ======
setStatus("Cargando...","gray");
fetchInitial(true);
