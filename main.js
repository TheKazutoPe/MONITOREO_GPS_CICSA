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
  traceRealtime: document.getElementById("toggleTraceRealtime"),
  traceMatched: document.getElementById("toggleTraceMatched"),
};

// ====== Estado del mapa/lista ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),        // uid -> { marker, lastRow }
  pointsByUser: new Map(), // uid -> [rows] (solo desde traceStart)
  routes: new Map(),       // uid -> { poly, segments }
  traceRealtime: ui.traceRealtime ? ui.traceRealtime.checked : false,
  traceMatched: ui.traceMatched ? ui.traceMatched.checked : true,
  routeRefreshTimer: null,
  traceStart: new Date(),  // solo trazamos puntos >= a este momento
};

// ====== Ajustes de trazado / matching ======
const CLEAN_MIN_METERS      = 6;      // limpia dientes pequeños
const DENSIFY_STEP          = 10;
const MAX_MM_POINTS         = 40;
const MAX_MATCH_INPUT       = 90;
const MAX_DIST_RATIO        = 0.35;
const ENDPOINT_TOL          = 25;
const CONFIDENCE_MIN        = 0.70;

// Gaps / saltos
const GAP_MINUTES           = 8;
const GAP_JUMP_METERS       = 800;

// Puentes (Directions)
const BRIDGE_MAX_METERS     = 800;
const DIRECTIONS_HOP_METERS = 300;
const MAX_BRIDGE_SPEED_KMH  = 70;
const MIN_BRIDGE_SPEED_KMH  = 3;
const DIRECTIONS_PROFILE    = "driving";

// Ritmo de refresco y carga
const ROUTE_REFRESH_INTERVAL_MS = 15000; // *** clave: 15 s ***
const PER_BLOCK_DELAY       = 150;

// Historial máximo por brigada para trazo en vivo
const MAX_HISTORY_POINTS    = 400;

// Quieto / “pasto azul”
const IDLE_RADIUS_METERS    = 25;   // radio máximo para considerarlo quieto
const IDLE_MIN_DURATION_MIN = 2;    // si estuvo ≥2 min dentro de ese radio → no dibujar línea

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
function chunk(arr,size){
  const out=[];
  for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
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

// ====== limitar puntos (evita URLs enormes) ======
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

// ====== segmentos quietos (no dibujar “pasto azul”) ======
function isIdleSegment(seg){
  if (!seg || seg.length < 2) return false;
  const first = seg[0];
  let maxD = 0;
  for (const p of seg){
    const d = distMeters(first, p);
    if (d > maxD) maxD = d;
    if (maxD > IDLE_RADIUS_METERS) return false; // ya no es quieto
  }
  const durMin = (new Date(seg.at(-1).timestamp) - new Date(first.timestamp)) / 60000;
  return durMin >= IDLE_MIN_DURATION_MIN;
}

// ====== Radio adaptativo ======
function adaptiveRadius(p){
  const acc = (p && p.acc != null) ? Number(p.acc) : NaN;
  const base = isFinite(acc) ? acc + 5 : 25;
  return Math.max(10, Math.min(50, base));   // 10–50 m
}

// ====== Map Matching ======
async function mapMatchBlockSafe(seg){
  if (!MAPBOX_TOKEN) return null;
  if (!seg || seg.length < 2) return null;
  if (seg.length > MAX_MM_POINTS) return null;

  const dense0 = densifySegment(seg, DENSIFY_STEP);
  const dense  = downsamplePoints(dense0, MAX_MATCH_INPUT);

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

// ====== Directions / bridge ======
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

// ====== Rutas en mapa ======
function clearAllRoutes(){
  state.routes.forEach(({ poly }) => {
    if (poly) {
      try { state.map.removeLayer(poly); } catch(_) {}
    }
  });
  state.routes.clear();
}

async function buildRouteForUser(uid){
  const rows = state.pointsByUser.get(uid);
  if (!rows || rows.length < 2) return;

  const pts = rows
    .map(r => ({
      lat: +(r.latitud ?? r.lat ?? r.latitude),
      lng: +(r.longitud ?? r.lng ?? r.longitude),
      timestamp: r.timestamp_pe || r.timestamp,
      acc: r.acc ?? null,
      spd: r.spd ?? null
    }))
    .filter(p => isFinite(p.lat) && isFinite(p.lng) && p.timestamp && new Date(p.timestamp) >= state.traceStart)
    .sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (pts.length < 2) return;

  const cleaned = [pts[0], ...cleanClosePoints(pts.slice(1), CLEAN_MIN_METERS)];
  const segments = splitOnGaps(cleaned, GAP_MINUTES, GAP_JUMP_METERS);
  const renderedSegments = [];

  for (const seg of segments){
    if (seg.length < 2) continue;
    if (isIdleSegment(seg)) continue; // *** no dibujar cuando está quieto ***

    if (state.traceMatched && MAPBOX_TOKEN){
      const blocks = chunk(seg, MAX_MM_POINTS);
      let current = [];
      for (const block of blocks){
        let finalBlock = densifySegment(block, DENSIFY_STEP);

        try{
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
              continue;
            }
          }
          current.push(...finalBlock.slice(1));
        }

        await sleep(PER_BLOCK_DELAY);
      }
      if (current.length > 1) renderedSegments.push(current);
    } else {
      const rawSeg = densifySegment(seg, DENSIFY_STEP);
      if (rawSeg.length > 1 && !isIdleSegment(rawSeg)) {
        renderedSegments.push(rawSeg);
      }
    }
  }

  if (!renderedSegments.length) return;

  const latlngs = renderedSegments.map(seg => seg.map(p => [p.lat, p.lng]));
  const poly = L.polyline(latlngs, {
    weight: 4,
    opacity: 0.85
  }).addTo(state.map);

  state.routes.set(uid, { poly, segments: renderedSegments });
}

// ====== Refresh de rutas (limitado a cada 15s) ======
function scheduleRouteRefresh(){
  if (!state.traceRealtime) return;
  if (state.routeRefreshTimer) return;

  state.routeRefreshTimer = setTimeout(async () => {
    state.routeRefreshTimer = null;
    if (!state.traceRealtime) return;
    clearAllRoutes();
    const uids = Array.from(state.pointsByUser.keys());
    for (const uid of uids){
      await buildRouteForUser(uid);
    }
  }, ROUTE_REFRESH_INTERVAL_MS);
}

// ====== Mapa / Lista ======
function initMap(){
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20});
  state.map = L.map("map",{center:[-12.0464,-77.0428],zoom:12,layers:[state.baseLayers.osm]});
  state.cluster = L.markerClusterGroup({disableClusteringAtZoom:16});
  state.map.addLayer(state.cluster);

  ui.apply.onclick = () => {
    fetchInitial(true);
  };
  ui.exportKmz.onclick = () => exportKMZFromState();

  if (ui.traceRealtime){
    ui.traceRealtime.onchange = () => {
      state.traceRealtime = ui.traceRealtime.checked;
      if (!state.traceRealtime){
        clearAllRoutes();
      } else {
        state.traceStart = new Date();      // nuevo tramo desde ahora
        scheduleRouteRefresh();
      }
    };
  }
  if (ui.traceMatched){
    ui.traceMatched.onchange = () => {
      state.traceMatched = ui.traceMatched.checked;
      if (state.traceRealtime){
        scheduleRouteRefresh();
      }
    };
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

// ====== Carga inicial ======
async function fetchInitial(clear){
  setStatus("Cargando…","gray");
  if (clear){
    ui.userList.innerHTML = "";
    clearAllRoutes();
    state.pointsByUser.clear();
    state.users.clear();
    state.cluster.clearLayers();
    state.traceStart = new Date(); // trazos en vivo solo desde este momento
  }

  // Solo buscamos última posición reciente por brigada / usuario (no toda la ruta)
  const {data, error} = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now()-2*60*60*1000).toISOString()) // últimas 2h
    .order("timestamp",{ascending:false});

  if (error){
    console.error(error);
    setStatus("Error","gray");
    return;
  }

  const brigFilter = (ui.brigada.value||"").trim().toLowerCase();
  const seen = new Set();

  for (const r of data){
    const uid = String(r.usuario_id || "0");
    if (seen.has(uid)) continue;
    if (brigFilter && !(r.brigada||"").toLowerCase().includes(brigFilter)) continue;
    seen.add(uid);

    const marker = L.marker([r.latitud,r.longitud],{icon:getIconFor(r)}).bindPopup(buildPopup(r));
    state.cluster.addLayer(marker);
    state.users.set(uid,{marker,lastRow:r});
    addOrUpdateUserInList(r);
  }

  setStatus("Conectado","green");
}

// ============================= EXPORTAR KMZ =============================
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
    const chosen = (dateInput && dateInput.value) ? new Date(dateInput.value+"T00:00:00") : new Date();
    const ymd = toYMD(chosen);
    const next = new Date(chosen.getTime() + 24*60*60*1000);
    const ymdNext = toYMD(next);

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
      if (isIdleSegment(seg)) continue; // también limpiamos quieto en KMZ

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

    alert(`✅ KMZ listo: ${brig} (${ymd}) — ${renderedSegments.length} tramo(s) plausibles`);
  } catch(e){
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado","green");
    if (ui?.exportKmz) ui.exportKmz.disabled = prevDisabled;
  }
}

// ============================= Realtime =============================
function startRealtime(){
  supa
    .channel("ubicaciones_brigadas_rt")
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "ubicaciones_brigadas" },
      (payload) => {
        const row = payload.new;
        if (!row) return;

        const uid = String(row.usuario_id || "0");
        const lat = +row.latitud;
        const lng = +row.longitud;
        if (!isFinite(lat) || !isFinite(lng)) return;

        // Marker
        let u = state.users.get(uid);
        if (!u){
          const marker = L.marker([lat,lng],{icon:getIconFor(row)}).bindPopup(buildPopup(row));
          state.cluster.addLayer(marker);
          u = { marker, lastRow: row };
          state.users.set(uid, u);
        } else {
          u.lastRow = row;
          u.marker.setLatLng([lat,lng]);
          u.marker.setIcon(getIconFor(row));
          u.marker.setPopupContent(buildPopup(row));
        }

        // Lista lateral
        addOrUpdateUserInList(row);

        // Historial para trazo en vivo (solo desde traceStart)
        const ts = new Date(row.timestamp_pe || row.timestamp || row.created_at || Date.now());
        if (ts >= state.traceStart){
          if (!state.pointsByUser.has(uid)) state.pointsByUser.set(uid, []);
          const list = state.pointsByUser.get(uid);
          const point = { ...row, timestamp: ts.toISOString() };
          const last = list[list.length - 1];
          if (!last || last.id !== point.id){
            list.push(point);
            if (list.length > MAX_HISTORY_POINTS){
              list.splice(0, list.length - MAX_HISTORY_POINTS);
            }
          }
        }

        // Programar recalculo (máx cada 15s)
        if (state.traceRealtime){
          scheduleRouteRefresh();
        }
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log("[RT] Suscripción ubicaciones_brigadas activa");
      }
    });
}

// ====== Arranque ======
setStatus("Cargando...","gray");
fetchInitial(true).then(() => {
  startRealtime();
});
