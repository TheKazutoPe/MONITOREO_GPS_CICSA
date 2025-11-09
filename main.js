// ============================== main.js ==============================
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN; // :contentReference[oaicite:2]{index=2}

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
  pointsByUser: new Map(), // uid -> [rows] (últimas 24h (filtro))
};

// ====== Sesión de trazado limpio (solo desde ahora) ======
const TRACE_START_ISO = new Date().toISOString();     // <-- inicio de corrección
const LOGS = true;
function log(...a){ if (LOGS) console.log(...a); }
log("[INIT] Trazado limpio empezará solo desde ahora.", TRACE_START_ISO);

// Persistencia incremental por brigada
const session = {
  activeBrig: "",                          // brigada filtrada (se persiste esta)
  acceptedByBrig: new Map(),               // brig -> puntos aceptados (post anti-telaraña) desde TRACE_START_ISO
  persistTimerByBrig: new Map(),           // brig -> timer para agrupar/sincronizar
  lastPersistInfo: new Map(),              // brig -> { pts, dist_km }
};

// ====== Ajustes de trazado / matching ======
const CLEAN_MIN_METERS      = 6;
const DENSIFY_STEP          = 10;
const MAX_MM_POINTS         = 40;
const MAX_MATCH_INPUT       = 90;
const MAX_DIST_RATIO        = 0.35;
const ENDPOINT_TOL          = 25;
const CONFIDENCE_MIN        = 0.70;

// Gaps / “teleport”
const GAP_MINUTES           = 8;
const GAP_JUMP_METERS       = 800;

// Puentes plausibles
const BRIDGE_MAX_METERS     = 800;
const DIRECTIONS_HOP_METERS = 300;
const MAX_BRIDGE_SPEED_KMH  = 70;
const MIN_BRIDGE_SPEED_KMH  = 3;
const DIRECTIONS_PROFILE    = "driving";

// Ritmo de llamadas
const PER_BLOCK_DELAY       = 150;

// Anti-telaraña (quieto)
const STATIONARY_RADIUS_M   = 15;    // radio muerto para ignorar jitter
const MIN_MOVING_SPEED_MS   = 0.6;   // si speed < 0.6 m/s y sin avance real, ignorar
const KEEPALIVE_MINUTES     = 2;     // si está muy quieto, mete 1 punto cada 2 min

// ====== Iconos/estética ======
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

// ====== densificar una secuencia ======
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

// ====== limitar puntos (evita URL enorme del Matching) ======
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

// ====== limpieza, cortes ======
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

// ====== Radio adaptativo por punto (usa 'acc' si existe) ======
function adaptiveRadius(p){
  const acc = (p && p.acc != null) ? Number(p.acc) : NaN;
  const base = isFinite(acc) ? acc + 5 : 25;
  return Math.max(10, Math.min(50, base));
}

// ====== Map Matching (timestamps + radiuses + downsample) ======
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
  catch(e){ log("[MM] fetch error:", e); return null; }

  if (!r.ok){
    const txt = await r.text().catch(()=> "");
    log("[MM] status:", r.status, txt.slice(0,200));
    return null;
  }

  const j = await r.json().catch(()=> null);
  const m = j?.matchings?.[0];
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

  let mmDist=0;
  for (let i=0;i<matched.length-1;i++) mmDist += distMeters(matched[i], matched[i+1]);
  if ((Math.abs(mmDist - rawDist) / Math.max(rawDist,1)) > MAX_DIST_RATIO) return null;
  if (distMeters(dense[0], matched[0]) > ENDPOINT_TOL) return null;
  if (distMeters(dense.at(-1), matched.at(-1)) > ENDPOINT_TOL) return null;

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
  const meters = route?.distance ?? 0;
  const secs   = route?.duration ?? 0;
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

// ====== Mapa / Lista (como tu base) ======
function initMap(){
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20});
  state.map = L.map("map",{center:[-12.0464,-77.0428],zoom:12,layers:[state.baseLayers.osm]});
  state.cluster = L.markerClusterGroup({disableClusteringAtZoom:16});
  state.map.addLayer(state.cluster);

  ui.apply.onclick = () => {
    fetchInitial(true);
    session.activeBrig = (ui.brigada.value||"").trim();
    // reiniciar buffer desde este instante
    session.acceptedByBrig.set(session.activeBrig, []);
    log("[INIT] Brigada activa para persistir trazo:", session.activeBrig || "(todas)");
  };
  ui.exportKmz.onclick = () => exportKMZFromDB(); // <<-- ahora exporta desde rutas_brigadas_dia
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

// ====== Últimas 24h (igual que tenías) ======
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

// ===================== Realtime + anti-telaraña + persistencia =====================
function shouldAcceptPoint(prev, cur){
  if (!prev) return true;
  const d = distMeters(prev, cur);
  const spd = Number(cur.spd || 0);
  const dtMin = (new Date(cur.timestamp) - new Date(prev.timestamp)) / 60000;

  // Si no hay avance y speed bajo, ignora (telaraña)
  if (d < STATIONARY_RADIUS_M && spd < MIN_MOVING_SPEED_MS){
    // excepto cada KEEPALIVE_MINUTES para mantener continuidad
    if (dtMin >= KEEPALIVE_MINUTES) return true;
    return false;
  }
  return true;
}

function pushAcceptedPoint(brig, p){
  const buf = session.acceptedByBrig.get(brig) || [];
  const last = buf[buf.length-1];
  if (shouldAcceptPoint(last, p)) {
    buf.push(p);
    session.acceptedByBrig.set(brig, buf);
    log("[RT] +accept", brig, p.lat.toFixed(5), p.lng.toFixed(5));
    schedulePersist(brig);
  } else {
    log("[RT] ~ignored (quieto)", brig);
  }
}

function schedulePersist(brig){
  clearTimeout(session.persistTimerByBrig.get(brig));
  // Debounce 12s para agrupar puntos y no saturar Mapbox/DB
  const t = setTimeout(()=> persistCleanRoute(brig), 12000);
  session.persistTimerByBrig.set(brig, t);
}

async function persistCleanRoute(brig){
  try{
    const points = (session.acceptedByBrig.get(brig) || []).filter(p => new Date(p.timestamp) >= new Date(TRACE_START_ISO));
    if (points.length < 2){ log("[DB] skip persist (insuficiente)", brig); return; }

    // Limpieza y corte en gaps
    const rows1 = [points[0], ...cleanClosePoints(points.slice(1), CLEAN_MIN_METERS)];
    const segments = splitOnGaps(rows1, GAP_MINUTES, GAP_JUMP_METERS);

    // Matching por segmento
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

    // Unir segmentos en un solo LineString (con cortes duros entre tramos)
    const coords = [];
    for (const seg of renderedSegments){
      for (let i=0;i<seg.length;i++){
        coords.push([seg[i].lng, seg[i].lat, 0]);
      }
    }
    if (coords.length < 2){ log("[DB] nada para guardar", brig); return; }

    // Métricas
    let dist_m = 0;
    for (let i=1;i<coords.length;i++){
      const a = { lat: coords[i-1][1], lng: coords[i-1][0] };
      const b = { lat: coords[i][1],   lng: coords[i][0]   };
      dist_m += distMeters(a,b);
    }
    const distancia_km = +(dist_m/1000).toFixed(3);
    const lats = coords.map(c=>c[1]), lngs = coords.map(c=>c[0]);
    const bbox = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];

    // Fecha local (simple)
    const ymd = toYMD(new Date());
    const payload = {
      fecha: ymd,
      brigada: brig,
      usuario_id: null,
      line_geojson: { type:"LineString", coordinates: coords.map(c=>[c[0],c[1]]) },
      puntos: coords.length,
      distancia_km,
      bbox
    };

    const { error } = await supa
      .from("rutas_brigadas_dia")
      .upsert(payload, { onConflict: "fecha,brigada" });

    if (error) {
      log("[DB] upsert error", brig, error.message);
      setStatus("Error DB", "gray");
    } else {
      session.lastPersistInfo.set(brig, { pts: coords.length, distancia_km });
      log("[DB] upsert OK", brig, `pts=${coords.length}`, `km=${distancia_km}`);
      setStatus(`Guardado ${brig}: ${coords.length} pts · ${distancia_km} km`, "green");
    }
  } catch(e){
    log("[DB] persist exception", e);
  }
}

// ====== Suscripción realtime a ubicaciones_brigadas ======
const channel = supa.channel("ubicaciones_inserts")
  .on("postgres_changes",
      { event:"INSERT", schema:"public", table:"ubicaciones_brigadas" },
      (payload)=>{
        const r = payload.new;
        const uid = String(r.usuario_id || "0");

        // Actualiza marcador / lista
        let u = state.users.get(uid);
        if (!u){
          const marker = L.marker([r.latitud,r.longitud],{icon:getIconFor(r)}).bindPopup(buildPopup(r));
          state.cluster.addLayer(marker);
          state.users.set(uid,{marker,lastRow:r});
        } else {
          u.marker.setLatLng([r.latitud,r.longitud]).setIcon(getIconFor(r)).setPopupContent(buildPopup(r));
          u.lastRow = r;
        }
        addOrUpdateUserInList(r);

        // Solo consideramos puntos desde TRACE_START_ISO
        const tsISO = r.timestamp_pe || r.timestamp;
        if (new Date(tsISO) < new Date(TRACE_START_ISO)) return;

        // Si filtraste una brigada, solo persiste esa; si no, persiste todas.
        const brig = (r.brigada || "").trim();
        const active = (session.activeBrig || "").trim();
        const mustPersist = !active || brig === active;

        if (mustPersist){
          const p = { lat:+r.latitud, lng:+r.longitud, timestamp: tsISO, acc:r.acc ?? null, spd:r.spd ?? null };
          pushAcceptedPoint(brig, p);
        }

        log("[RT] insert", brig, new Date(tsISO).toLocaleTimeString());
      })
  .subscribe((status)=> log("[RT] Estado suscripción:", status));

// ============================= EXPORTAR KMZ DESDE DB =============================
async function exportKMZFromDB(){
  try {
    setStatus("Generando KMZ…","gray");
    if (ui?.exportKmz) ui.exportKmz.disabled = true;

    const brig = (ui.brigada.value || "").trim();
    if (!brig){
      alert("Escribe la brigada EXACTA para exportar su KMZ.");
      return;
    }

    const dateInput = document.getElementById("kmzDate");
    const chosen = (dateInput && dateInput.value) ? new Date(dateInput.value+"T00:00:00") : new Date();
    const ymd = toYMD(chosen);

    // 1) Leer trazo limpio ya guardado en rutas_brigadas_dia
    const { data, error } = await supa
      .from("rutas_brigadas_dia")
      .select("line_geojson,puntos,distancia_km")
      .eq("fecha", ymd)
      .eq("brigada", brig)
      .single();

    if (error){
      alert("⚠️ No hay trazo guardado para esa brigada/fecha.");
      return;
    }
    const line = data?.line_geojson;
    const coords = Array.isArray(line?.coordinates) ? line.coordinates : [];
    if (coords.length < 2){
      alert("⚠️ Trazo con pocos puntos. Aún no hay ruta limpia suficiente.");
      return;
    }

    // 2) Construir KML/KMZ (una única LineString)
    let kml = `<?xml version="1.0" encoding="UTF-8"?>` +
              `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
              `<name>${brig} - ${ymd}</name>` +
              `<Style id="routeStyle"><LineStyle><color>ffFF0000</color><width>4</width></LineStyle></Style>` +
              `<Placemark><name>${brig} (${ymd})</name><styleUrl>#routeStyle</styleUrl>` +
              `<LineString><tessellate>1</tessellate><coordinates>` +
              coords.map(c=>`${c[0]},${c[1]},0`).join(" ") +
              `</coordinates></LineString></Placemark>` +
              `</Document></kml>`;

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

    alert(`✅ KMZ listo: ${brig} (${ymd}) — ${coords.length} puntos en trazo limpio`);
    log("[KMZ] exportado desde rutas_brigadas_dia", brig, ymd, `pts=${coords.length}`);
  } catch(e){
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado","green");
    if (ui?.exportKmz) ui.exportKmz.disabled = false;
  }
}

// ====== Arranque ======
setStatus("Cargando...","gray");
fetchInitial(true);
