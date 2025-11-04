// ====== Supabase client ======
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ====== UI refs ======
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
};

// ====== Estado ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),        // uid -> { marker, lastRow }
  pointsByUser: new Map(), // uid -> [rows]
};

// ====== Constantes de export ======
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

// --- Mejora de trazado (solo estos valores cambian respecto a tu original) ---
const CLEAN_MIN_METERS      = 6;      // suaviza "dientes"
const DENSIFY_STEP          = 15;     // curvatura más real
const MAX_MM_POINTS         = 60;     // trozos antes de densificar
const MAX_MATCH_INPUT       = 98;     // tope duro para URL del Map Matching (GET)
const MAX_DIST_RATIO        = 0.45;   // tolerancia matching vs cruda
const ENDPOINT_TOL          = 35;     // tolerancia en puntas (m)
const GAP_MINUTES           = 20;     // (tu valor original) si pasan >20 min -> nuevo tramo
const GAP_HARD_METERS       = 1500;   // (tu valor original) puente muy largo => evitar inventar
const PER_BLOCK_DELAY       = 150;    // (tu valor original) ritmo de llamadas
const DIRECTIONS_HOP_METERS = 450;    // (tu valor original) hops para bridges largos
const MAX_BRIDGE_DEVIATION  = 80;     // (tu valor original) validación de inicio del bridge
const DIRECTIONS_PROFILE    = "driving"; // puedes poner "driving-traffic" si quieres

// ====== Íconos ======
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

// ====== densificar una secuencia ======
function densifySegment(points, step = DENSIFY_STEP) {
  if (!points || points.length < 2) return points;
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const d = distMeters(a, b);
    if (d <= step) {
      out.push(a);
      continue;
    }
    const n = Math.ceil(d / step);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
        timestamp: a.timestamp
      });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

// ====== NUEVO helper: limitar puntos para que la URL GET no se vuelva gigante ======
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

// ====== para fallback: línea recta troceada ======
function straightInterpolate(a, b, step = 40) {
  const d = distMeters(a, b);
  if (d <= step) return [a, b];
  const n = Math.ceil(d / step);
  const out = [];
  for (let i=0;i<=n;i++){
    const t = i/n;
    out.push({
      lat: a.lat + (b.lat - a.lat)*t,
      lng: a.lng + (b.lng - a.lng)*t
    });
  }
  return out;
}

// ====== Mapa ======
function initMap(){
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20});
  state.map = L.map("map",{center:[-12.0464,-77.0428],zoom:12,layers:[state.baseLayers.osm]});
  state.cluster = L.markerClusterGroup({disableClusteringAtZoom:16});
  state.map.addLayer(state.cluster);

  ui.apply.onclick = () => fetchInitial(true);
  ui.exportKmz.onclick = () => exportKMZFromState();
}
initMap();

// ====== Status ======
function setStatus(text, kind){
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}

// ====== centrar en brigada ======
function focusOnUser(uid) {
  const u = state.users.get(uid);
  if (!u || !u.marker) return;
  const latlng = u.marker.getLatLng();
  state.map.setView(latlng, 17, { animate: true });
  u.marker.openPopup();
}

// ====== Popup ======
function buildPopup(r){
  const acc = Math.round(r.acc || 0);
  const spd = (r.spd || 0).toFixed(1);
  const ts = new Date(r.timestamp).toLocaleString();
  return `<div><b>${r.tecnico || "Sin nombre"}</b><br>Brigada: ${r.brigada || "-"}<br>Acc: ${acc} m · Vel: ${spd} m/s<br>${ts}</div>`;
}

// ====== Lista lateral ======
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
    el.onclick = () => {
      focusOnUser(uid);
      ui.brigada.value = brig;
    };
    ui.userList.appendChild(el);
  } else {
    el.className = `brigada-item ${cls} marker-pulse`;
    el.innerHTML = html;
    el.onclick = () => {
      focusOnUser(uid);
      ui.brigada.value = brig;
    };
    setTimeout(()=>el.classList.remove("marker-pulse"),600);
  }
}

// ====== Cargar últimas 24h ======
async function fetchInitial(clear){
  setStatus("Cargando…","gray");
  if (clear) ui.userList.innerHTML = "";

  const {data, error} = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now()-24*60*60*1000).toISOString())
    .order("timestamp",{ascending:false});

  if (error){
    setStatus("Error","gray");
    return;
  }

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

// ============================================================================
// ======================= KMZ: helpers =======================================
// ============================================================================

// quitar puntos pegados
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

// cortar por tiempo
function splitOnGaps(points, maxGapMin = GAP_MINUTES){
  const groups = [];
  let cur = [];
  for (let i=0;i<points.length;i++){
    const p = points[i];
    if (!cur.length){ cur.push(p); continue; }
    const prev = cur[cur.length-1];
    const dtMin = (new Date(p.timestamp) - new Date(prev.timestamp))/60000;
    if (dtMin > maxGapMin){
      if (cur.length>1) groups.push(cur);
      cur = [p];
    } else {
      cur.push(p);
    }
  }
  if (cur.length>1) groups.push(cur);
  return groups;
}

// pedir directions para UN TRAMO (puente por carretera)
async function directionsBetween(a, b) {
  if (!MAPBOX_TOKEN) return straightInterpolate(a, b, 40);
  const url = `https://api.mapbox.com/directions/v5/mapbox/${DIRECTIONS_PROFILE}/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) return straightInterpolate(a, b, 40);
  const j = await r.json();
  const coords = j.routes?.[0]?.geometry?.coordinates || [];
  if (!coords.length) return straightInterpolate(a, b, 40);

  // validar que el primer punto del bridge no se aleje mucho del final del bloque anterior
  const first = {lat: coords[0][1], lng: coords[0][0]};
  if (distMeters(a, first) > MAX_BRIDGE_DEVIATION) {
    return straightInterpolate(a, b, 40);
  }
  return coords.map(([lng,lat])=>({lat,lng}));
}

// puente inteligente (trocea en varios directions si es largo)
async function smartBridge(a, b) {
  const d = distMeters(a, b);
  if (d > GAP_HARD_METERS) {
    // muy largo, no inventamos (fallback suave)
    return straightInterpolate(a, b, 60);
  }
  if (d <= DIRECTIONS_HOP_METERS) {
    return directionsBetween(a, b);
  }
  // dividir en hops
  const hops = Math.ceil(d / DIRECTIONS_HOP_METERS);
  const out = [a];
  let prev = a;
  for (let i=1;i<=hops;i++){
    const t = i / hops;
    const mid = {
      lat: a.lat + (b.lat - a.lat)*t,
      lng: a.lng + (b.lng - a.lng)*t
    };
    const seg = await directionsBetween(prev, mid);
    out.push(...seg.slice(1));
    prev = mid;
    await sleep(80);
  }
  return out;
}

// ========= MEJORA CLAVE: Map Matching con timestamps + radiuses + downsample =========
async function mapMatchBlockSafe(seg){
  if (!MAPBOX_TOKEN) return null;
  if (seg.length < 2) return null;
  if (seg.length > MAX_MM_POINTS) return null;

  // densificar para curvatura real
  const dense0 = densifySegment(seg, DENSIFY_STEP);

  // limitar puntos para no exceder URL GET del endpoint
  const dense = downsamplePoints(dense0, MAX_MATCH_INPUT);

  // distancia cruda (para validación posterior)
  let rawDist = 0;
  for (let i=0;i<dense.length-1;i++){
    rawDist += distMeters(dense[i], dense[i+1]);
  }

  // construir parámetros con timestamps y radiuses (Mapbox pega a pista respetando tiempo)
  const coords = dense.map(p=>`${p.lng},${p.lat}`).join(";");
  const tsArr  = dense.map(p=>Math.floor(new Date(p.timestamp).getTime()/1000)).join(";");
  const radArr = dense.map(()=>25).join(";"); // 25m de tolerancia por punto

  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}` +
              `?geometries=geojson&overview=full&tidy=true` +
              `&timestamps=${tsArr}&radiuses=${radArr}` +
              `&access_token=${MAPBOX_TOKEN}`;

  let r;
  try {
    r = await fetch(url, { method: "GET", mode: "cors" });
  } catch (e) {
    console.warn("Map Matching fetch error:", e);
    return null;
  }
  if (!r.ok) {
    const txt = await r.text().catch(()=> "");
    console.warn("Map Matching bad status:", r.status, txt.slice(0,200));
    return null;
  }

  const j = await r.json().catch(()=> null);
  const match = j && j.matchings && j.matchings[0];
  if (!match || !match.geometry || !match.geometry.coordinates) return null;
  const matched = match.geometry.coordinates.map(([lng,lat])=>({lat,lng}));

  // distancia matcheada
  let mmDist=0;
  for (let i=0;i<matched.length-1;i++){
    mmDist += distMeters(matched[i], matched[i+1]);
  }
  const diff = Math.abs(mmDist - rawDist);
  if (diff / Math.max(rawDist,1) > MAX_DIST_RATIO) return null;

  // validar puntas (evitar “teleports”)
  if (distMeters(dense[0], matched[0]) > ENDPOINT_TOL) return null;
  if (distMeters(dense[dense.length-1], matched[matched.length-1]) > ENDPOINT_TOL) return null;

  // (Opcional) Propagar timestamps aproximados: útil si luego generas GPX (KML no los usa)
  for (let i=0;i<matched.length;i++){
    matched[i].timestamp = dense[Math.min(i, dense.length-1)].timestamp;
  }
  return matched;
}

// ============================================================================
// ============================= EXPORTAR KMZ =================================
// ============================================================================
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
      .select("latitud,longitud,timestamp,tecnico,usuario_id")
      .eq("brigada", brig)
      .gte("timestamp_pe", ymd)
      .lt("timestamp_pe", ymdNext)
      .order("timestamp_pe",{ascending:true});

    if (error) throw new Error(error.message);
    if (!data || data.length < 2){
      alert(`⚠️ No hay datos para "${brig}" en ${ymd}.`);
      return;
    }

    const byUser = new Map();
    for (const r of data){
      const uid = String(r.usuario_id || "0");
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid).push({
        lat: r.latitud,
        lng: r.longitud,
        timestamp: r.timestamp,
        tecnico: r.tecnico || `Tecnico ${uid}`
      });
    }

    let kml = `<?xml version="1.0" encoding="UTF-8"?>` +
              `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
              `<name>${brig} - ${ymd}</name>`;
    let placemarks = 0;

    for (const [uid, rows0] of byUser.entries()){
      if (rows0.length < 2) continue;
      const tecnicoName = (rows0[0].tecnico || `Tecnico ${uid}`).replace(/&/g,"&amp;");

      // 1) limpiar puntos pegados
      const rows1 = cleanClosePoints(rows0, CLEAN_MIN_METERS);
      // 2) cortar por huecos de tiempo
      const segments = splitOnGaps(rows1, GAP_MINUTES);

      for (const seg of segments){
        if (seg.length < 2) continue;

        // trocear en bloques
        const blocks = chunk(seg, MAX_MM_POINTS);
        let current = [];

        for (let i=0;i<blocks.length;i++){
          const block = blocks[i];

          // default: densificado (por si falla matching)
          let finalBlock = densifySegment(block, DENSIFY_STEP);

          // === MEJORA: Matching pegado a pista ===
          try {
            const mm = await mapMatchBlockSafe(block);
            if (mm && mm.length >= 2) finalBlock = mm;
          } catch(e){
            // si falla, seguimos con densificado
          }

          if (!current.length){
            current.push(...finalBlock);
          } else {
            // unir bloques con ruta por carretera (no diagonal)
            const last = current[current.length-1];
            const first = finalBlock[0];
            const gap = distMeters(last, first);

            if (gap < 5) {
              current.push(...finalBlock.slice(1));
            } else {
              // puente inteligente con Directions
              const bridge = await smartBridge(last, first);
              current.push(...bridge.slice(1));
              current.push(...finalBlock.slice(1));
            }
          }

          await sleep(PER_BLOCK_DELAY);
        }

        if (current.length > 1){
          const coords = current.map(p=>`${p.lng},${p.lat},0`).join(" ");
          kml += `
            <Placemark>
              <name>${tecnicoName} (${brig})</name>
              <Style>
                <LineStyle>
                  <color>ffFF0000</color>
                  <width>4</width>
                </LineStyle>
              </Style>
              <LineString><coordinates>${coords}</coordinates></LineString>
            </Placemark>`;
          placemarks++;
        }
      }
    }

    kml += `</Document></kml>`;

    if (!placemarks) throw new Error("No se generó ninguna traza válida.");

    const safeBrig = brig.replace(/[^a-zA-Z0-9_-]+/g,"_");
    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({
      type:"blob",
      compression:"DEFLATE",
      compressionOptions:{level:1}
    });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `recorrido_${safeBrig}_${ymd}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);

    alert(`✅ KMZ listo para "${brig}" (${placemarks} tramo(s))`);
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
fetchInitial(true);
