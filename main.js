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
  toggleRoutesBtn: document.getElementById("toggleRoutesBtn"), // ← NUEVO
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
const MAX_MM_POINTS         = 40;    // tamaño de bloque crudo
const MAX_MATCH_INPUT       = 90;    // límite duro para URL GET del Matching
const MAX_DIST_RATIO        = 0.35;  // tolerancia matching vs crudo
const ENDPOINT_TOL          = 25;    // tolerancia de puntas (m)
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

// Ritmo de llamadas para no saturar API
const PER_BLOCK_DELAY       = 150;

// ====== Iconos/estética (como tu base) ======
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
  return 2 * R * Math.asin(Math.sqrt(s1));
}
function toYMD(d){const y=d.getFullYear();const m=String(d.getMonth()+1).padStart(2,"0");const dd=String(d.getDate()).padStart(2,"0");return `${y}-${m}-${dd}`;}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function chunk(arr, size){ const out=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }

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

// ====== densificar (curvatura) ======
function interpolate(a,b,t){ return { lat: a.lat+(b.lat-a.lat)*t, lng: a.lng+(b.lng-a.lng)*t, timestamp: b.timestamp }; }
function densifySegment(points, stepMeters = DENSIFY_STEP){
  if (!points.length) return points;
  const out = [points[0]];
  for (let i=1;i<points.length;i++){
    const A = out[out.length-1];
    const B = points[i];
    const d = distMeters(A,B);
    if (d > stepMeters){
      const n = Math.floor(d/stepMeters);
      for (let k=1;k<=n;k++){
        out.push(interpolate(A,B,k/(n+1)));
      }
    }
    out.push(B);
  }
  return out;
}

// ====== Map Matching (bloque seguro con fallback a crudo densificado) ======
async function mapMatchBlockSafe(block){
  // prepara URL GET (<= MAX_MATCH_INPUT coordenadas)
  const use = block.slice(0, Math.min(block.length, MAX_MATCH_INPUT));
  const coords = use.map(p => `${p.lng},${p.lat}`).join(";");
  const radiuses = use.map(_ => 10).join(";"); // 10m
  const timestamps = use.map(p => Math.floor(new Date(p.timestamp).getTime()/1000)).join(";");

  const url = `https://api.mapbox.com/matching/v5/mapbox/${DIRECTIONS_PROFILE}/${coords}?radiuses=${radiuses}&timestamps=${timestamps}&geometries=geojson&tidy=true&access_token=${MAPBOX_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Map Matching error " + res.status);
  const js = await res.json();

  const match = (js.matchings && js.matchings[0]) ? js.matchings[0] : null;
  if (!match || (typeof match.confidence === "number" && match.confidence < CONFIDENCE_MIN)){
    return densifySegment(use, DENSIFY_STEP);
  }

  const coordsOut = match.geometry.coordinates.map(([lng,lat]) => ({ lat, lng, timestamp: use[0].timestamp }));
  // chequear proporción de distancia vs crudo
  const dCrudo = use.slice(1).reduce((acc,cur,i)=>acc+distMeters(use[i],cur),0);
  const dMatch = coordsOut.slice(1).reduce((acc,cur,i)=>acc+distMeters(coordsOut[i],cur),0);
  if (dCrudo>50 && dMatch/dCrudo > (1+MAX_DIST_RATIO)) {
    return densifySegment(use, DENSIFY_STEP);
  }
  return coordsOut;
}

// ====== Directions para “puentes” plausibles ======
async function directionsBetween(a, b) {
  const url = `https://api.mapbox.com/directions/v5/mapbox/${DIRECTIONS_PROFILE}/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&access_token=${MAPBOX_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const js = await res.json();
  const route = js.routes && js.routes[0];
  if (!route) return null;

  const coords = route.geometry.coordinates;
  const meters = route.distance || 0;

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

// ====== Bridge en varios “hops” y con cancelación si un tramo no es plausible ======
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
      timestamp: b.timestamp
    };
    const seg = await directionsBetween(prev, mid);
    if (!seg || !seg.length) return null;
    out.push(...seg.slice(1));
    prev = mid;
  }
  // cierre al destino
  const lastHop = await directionsBetween(prev, b);
  if (!lastHop || !lastHop.length) return null;
  out.push(...lastHop.slice(1));
  return out;
}

// ============================= MAPA / CARGA INICIAL =============================
function buildPopup(row){
  const ts = new Date(row.timestamp);
  return `
    <div class="popup">
      <div><b>${row.brigada || "-"}</b></div>
      <div>${row.usuario || row.tecnico || "-"}</div>
      <div>${row.latitud?.toFixed(6)}, ${row.longitud?.toFixed(6)}</div>
      <div>${ts.toLocaleString()}</div>
    </div>`;
}
function addOrUpdateUserInList(last) {
  const uid = last.telefono || last.usuario || last.tecnico || "?" ;
  let el = document.querySelector(`[data-uid="${uid}"]`);
  const label = `${last.brigada || "?"} — ${last.usuario || last.tecnico || uid}`;
  if (!el){
    el = document.createElement("div");
    el.className = "brigada-item";
    el.dataset.uid = uid;
    el.textContent = label;
    ui.userList.appendChild(el);
  } else {
    el.textContent = label;
  }
}
function setStatus(text, color="gray"){
  ui.status.textContent = text.toUpperCase();
  ui.status.className = `status-badge ${color}`;
}

async function fetchInitial(first=false){
  try {
    setStatus("Cargando...","gray");
    if (!state.map){
      state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20});
      state.map = L.map("map",{center:[-12.0464,-77.0428],zoom:12,layers:[state.baseLayers.osm]});
      state.cluster = L.markerClusterGroup({disableClusteringAtZoom:16});
      state.map.addLayer(state.cluster);
    }

    state.cluster.clearLayers();
    state.users.clear();
    state.pointsByUser.clear();

    // filtro por brigada (opcional)
    const brig = (ui.brigada.value || "").trim();
    let q = supa
      .from("ubicaciones_brigadas")
      .select("*")
      .order("timestamp",{ascending:false})
      .limit(400);

    if (brig) q = q.eq("brigada", brig);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) return;

    // agrupar por uid/telefono
    const grouped = new Map();
    for (const r of data){
      const uid = r.telefono || r.usuario || r.tecnico || "?";
      if (!grouped.has(uid)) grouped.set(uid, []);
      grouped.get(uid).push(r);
    }

    grouped.forEach((rows, uid)=>{
      const last = rows[0];
      const marker = L.marker([last.latitud,last.longitud],{icon:getIconFor(last)}).bindPopup(buildPopup(last));
      state.cluster.addLayer(marker);
      state.users.set(uid,{marker,lastRow:last});
      state.pointsByUser.set(uid, rows);
      addOrUpdateUserInList(last);
    });

    setStatus("Conectado","green");
  } catch(e){
    console.error(e);
    setStatus("Error","red");
  }
}

// ============================= EXPORTAR KMZ =============================
// Recorre TODO el día de la brigada (desde el PRIMER punto del día), en orden,
// con matching a pista y puentes plausibles. Si no hay forma plausible, corta tramo.
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

    // 1) obtener puntos del día elegido (00:00–23:59 locales)
    const startLocal = `${ymd} 00:00:00`;
    const endLocal   = `${ymd} 23:59:59`;

    let query = supa
      .from("ubicaciones_brigadas")
      .select("latitud,longitud,timestamp,timestamp_pe,acc,spd,brigada",{count:"exact"})
      .eq("brigada", brig)
      .gte("timestamp_pe", startLocal)
      .lte("timestamp_pe", endLocal)
      .order("timestamp_pe",{ascending:true})
      .limit(20000);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    if (!Array.isArray(data) || data.length<2) throw new Error("No hay suficientes puntos en ese día.");

    const rows = data
      .map(r=>({ lat:+r.latitud, lng:+r.longitud, timestamp:r.timestamp_pe||r.timestamp, acc:r.acc??null, spd:r.spd??null }))
      .filter(p=>isFinite(p.lat)&&isFinite(p.lng)&&p.timestamp)
      .sort((a,b)=> new Date(a.timestamp)-new Date(b.timestamp));

    if (rows.length<2) throw new Error("Datos insuficientes tras limpiar.");

    // 2) construir segmentos (matching + puentes)
    const segments = splitOnGaps([rows[0], ...cleanClosePoints(rows.slice(1), CLEAN_MIN_METERS)], GAP_MINUTES, GAP_JUMP_METERS);
    const renderedSegments = [];
    for (const seg of segments){
      if (seg.length<2) continue;
      const blocks = chunk(seg, MAX_MM_POINTS);
      let current=[];
      for (let i=0;i<blocks.length;i++){
        const block = blocks[i];
        let finalBlock = densifySegment(block, DENSIFY_STEP);
        try{
          const mm = await mapMatchBlockSafe(block);
          if (mm && mm.length>=2) finalBlock = mm;
        }catch(_){}
        if (!current.length){
          current.push(...finalBlock);
        } else {
          const last=current[current.length-1];
          const first=finalBlock[0];
          const gapM = distMeters(last, first);
          if (gapM>5){
            let appended=false;
            if (gapM<=BRIDGE_MAX_METERS){
              const bridge = await smartBridge(last, first);
              if (bridge?.length){
                current.push(...bridge.slice(1));
                appended=true;
              }
            }
            if (!appended){
              if (current.length>1) renderedSegments.push(current);
              current=[...finalBlock];
              await sleep(PER_BLOCK_DELAY);
              continue;
            }
          }
          current.push(...finalBlock.slice(1));
        }
        await sleep(PER_BLOCK_DELAY);
      }
      if (current.length>1) renderedSegments.push(current);
    }

    // 3) generar KMZ simple
    const zip = new JSZip();
    const kmlParts = [];
    kmlParts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    kmlParts.push(`<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${brig} ${ymd}</name>`);
    renderedSegments.forEach((seg,idx)=>{
      const coords = seg.map(p=>`${p.lng},${p.lat},0`).join(" ");
      kmlParts.push(`<Placemark><name>Tramo ${idx+1}</name><Style><LineStyle><color>ff0000ff</color><width>4</width></LineStyle></Style><LineString><coordinates>${coords}</coordinates></LineString></Placemark>`);
    });
    kmlParts.push(`</Document></kml>`);
    const kml = kmlParts.join("");

    zip.file(`${brig}_${ymd}.kml`, kml);
    const kmzBlob = await zip.generateAsync({type:"blob"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(kmzBlob);
    a.download = `${brig}_${ymd}.kmz`;
    a.click();

    alert(`✅ KMZ listo: ${brig} (${ymd}) — ${renderedSegments.length} tramo(s) plausibles`);
  } catch(e){
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado","green");
    if (ui?.exportKmz) ui.exportKmz.disabled = prevDisabled;
  }
}

// ======================= RUTAS DEL DÍA (TRAZO EN MAPA) =======================

// --- Parámetros seguros ---
const MAX_POINTS_DAY   = 8000;   // cota de seguridad para no reventar el matching
const ROUTE_REFRESH_MS = 30000;  // 30s: ajusta a 60–120s si quieres

// --- Estado para rutas (capa y toggles) ---
if (!window.__routeState) {
  window.__routeState = {
    routeLayer: null,         // L.LayerGroup
    routeLines: new Map(),    // brigada -> polylines
    routesVisible: false,
    layerMountedOn: null      // referencia a state.map cuando se montó
  };
}
const RSTATE = window.__routeState;

// Helper: capa instalada de forma *perezosa*
function ensureRouteLayer() {
  if (!window.state || !state.map) return false;
  if (!RSTATE.routeLayer) {
    RSTATE.routeLayer = L.layerGroup();
  }
  if (RSTATE.layerMountedOn !== state.map) {
    // (re)montar capa en el mapa actual
    RSTATE.routeLayer.addTo(state.map);
    RSTATE.layerMountedOn = state.map;
  }
  return true;
}

// Límites “HOY” en local Lima
function getTodayBoundsLocal() {
  const now = new Date(); // navegador (America/Lima)
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return {
    startLocal: `${y}-${m}-${d} 00:00:00`,
    endLocal:   `${y}-${m}-${d} 23:59:59`,
  };
}

// Dibuja segmentos en el mapa
function drawSegmentsOnMap(brig, segments){
  if (!ensureRouteLayer()) return;

  // limpia lo anterior de esa brigada
  const prev = RSTATE.routeLines.get(brig) || [];
  prev.forEach(pl => RSTATE.routeLayer.removeLayer(pl));
  RSTATE.routeLines.delete(brig);

  // pinta
  const polylines = [];
  for (const seg of segments){
    const latlngs = seg.map(p => [p.lat, p.lng]);
    const pl = L.polyline(latlngs, { weight: 4, opacity: 0.95 });
    pl.addTo(RSTATE.routeLayer);
    polylines.push(pl);
  }
  RSTATE.routeLines.set(brig, polylines);
}

// Construye segmentos matcheados a vía desde puntos crudos
async function buildMatchedSegmentsFromPoints(points){
  if (!points || points.length < 2) return [];

  // 1) limpiar puntos demasiado cercanos (evitar ruido)
  const rows1 = [points[0], ...cleanClosePoints(points.slice(1), CLEAN_MIN_METERS)];

  // 2) cortar por huecos / saltos
  const segments = splitOnGaps(rows1, GAP_MINUTES, GAP_JUMP_METERS);

  // 3) matching por bloques + puentes Directions (misma lógica que KMZ)
  const rendered = [];
  for (const seg of segments){
    if (seg.length < 2) continue;

    const blocks = chunk(seg, MAX_MM_POINTS);
    let current = [];
    for (let i=0;i<blocks.length;i++){
      const block = blocks[i];

      // fallback densificado
      let finalBlock = densifySegment(block, DENSIFY_STEP);

      try {
        const mm = await mapMatchBlockSafe(block);
        if (mm && mm.length >= 2) finalBlock = mm;
      } catch(_){}

      if (!current.length){
        current.push(...finalBlock);
      } else {
        const last  = current[current.length-1];
        const first = finalBlock[0];
        const gapM  = distMeters(last, first);

        if (gapM > 5){
          let appended = false;
          if (gapM <= BRIDGE_MAX_METERS){
            const bridge = await smartBridge(last, first);
            if (bridge?.length){
              current.push(...bridge.slice(1));
              appended = true;
            }
          }
          if (!appended){
            if (current.length > 1) rendered.push(current);
            current = [...finalBlock];
            await sleep(PER_BLOCK_DELAY);
            continue;
          }
        }
        current.push(...finalBlock.slice(1));
      }

      await sleep(PER_BLOCK_DELAY);
    }
    if (current.length > 1) rendered.push(current);
  }

  return rendered;
}

// Render del trazo DEL DÍA (00:00–23:59) para la brigada del filtro
async function renderLiveRouteForCurrentBrigada(){
  try{
    if (!ensureRouteLayer()) return;

    const brig = (ui.brigada.value || "").trim();
    if (!brig){
      alert("Escribe la brigada EXACTA para ver su trazo.");
      return;
    }
    if (!RSTATE.routesVisible){
      return; // si toggle está OFF, no pintamos
    }

    const { startLocal, endLocal } = getTodayBoundsLocal();

    // Consulta del DÍA en timestamp local
    let query = supa
      .from("ubicaciones_brigadas")
      .select("latitud,longitud,timestamp,timestamp_pe,acc,spd,brigada", { count: "exact" })
      .eq("brigada", brig)
      .gte("timestamp_pe", startLocal)
      .lte("timestamp_pe", endLocal)
      .order("timestamp_pe", { ascending: true })
      .limit(MAX_POINTS_DAY);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    if (!Array.isArray(data) || data.length < 2){
      // limpia capa si no hay nada que pintar
      RSTATE.routeLayer.clearLayers();
      RSTATE.routeLines.clear();
      return;
    }

    // Normalizar (preferir timestamp_pe si existe)
    const all = data
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
      RSTATE.routeLayer.clearLayers();
      RSTATE.routeLines.clear();
      return;
    }

    // Matching + puentes
    const segments = await buildMatchedSegmentsFromPoints(all);

    // Pintar
    drawSegmentsOnMap(brig, segments);

    // Focus al último punto
    const last = all.at(-1);
    if (last && state?.map) {
      state.map.setView([last.lat, last.lng], Math.max(state.map.getZoom() || 12, 15), { animate: true });
    }
  }catch(e){
    console.warn("renderLiveRouteForCurrentBrigada (day) error:", e);
  }
}

// Toggle del botón + montaje de capa
(function wireRouteToggle(){
  if (!ui || !ui.toggleRoutesBtn) return;

  ui.toggleRoutesBtn.addEventListener("click", async () => {
    RSTATE.routesVisible = !RSTATE.routesVisible;
    ui.toggleRoutesBtn.textContent = RSTATE.routesVisible ? "👣 Ocultar trazos" : "👣 Ver trazos";

    if (!RSTATE.routesVisible){
      if (RSTATE.routeLayer) RSTATE.routeLayer.clearLayers();
      RSTATE.routeLines.clear();
      return;
    }
    await renderLiveRouteForCurrentBrigada();
  });

  // Auto-refresh cada 30s cuando el toggle está activo
  setInterval(async () => {
    if (RSTATE.routesVisible) {
      await renderLiveRouteForCurrentBrigada();
    }
  }, ROUTE_REFRESH_MS);
})();

// ====== Arranque ======
setStatus("Cargando...","gray");
fetchInitial(true);
