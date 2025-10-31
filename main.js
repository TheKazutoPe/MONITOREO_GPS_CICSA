// ========================= Supabase client =========================
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ========================= UI refs =========================
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
};

// ========================= Estado global =========================
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),        // uid -> { marker, lastRow }
  pointsByUser: new Map(), // uid -> rows[]
};

// ========================= Constantes de KMZ / rutas =========================
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

// precisión / limpieza
const MAX_MM_POINTS = 50;          // máx puntos por request de map-matching
const GAP_MINUTES = 20;            // si pasan más de 20 min -> nuevo tramo
const GAP_HARD_METERS = 1500;      // huecos muy largos ya no los inventamos
const CLEAN_MIN_METERS = 4;        // quitar puntos muy pegados
const DENSIFY_STEP = 20;           // densificar entre puntos
const MAX_DIST_RATIO = 0.35;       // validar que map-matching no se aleje mucho
const ENDPOINT_TOL = 25;           // no mover puntas más de 25 m
const PER_BLOCK_DELAY = 150;       // esperar entre llamadas
const DIRECTIONS_HOP_METERS = 450; // si hay hueco largo, trocear en este largo
const MAX_BRIDGE_DEVIATION = 80;   // si directions se aleja más de esto, descartar

// candados contra rutas locas
const BRIDGE_MAX_LENGTH_FACTOR = 1.8;  // si la ruta es 1.8x la recta -> no
const BRIDGE_MAX_POINT_DEVIATION = 70; // si un punto del bridge se va >70m -> no

// ANTI ARAÑA FUERTE
const NOISY_STOP_RADIUS = 50;      // radio de puntos considerados "en la misma parada"
const NOISY_STOP_MIN_POINTS = 5;   // con 5 puntos ya lo tomamos como parada ruidosa
const NOISY_STOP_MAX_MIN = 20;     // si duró hasta 20 min seguimos colapsando
const SPEEDY_JUMP_METERS = 35;     // saltos chicos pero bruscos que ignoramos

// ========================= Íconos de brigadas =========================
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

// ========================= Helpers generales =========================
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

// distancia punto-recta para validar puentes
function distPointToSegment(p, a, b) {
  const A = {x: a.lng, y: a.lat};
  const B = {x: b.lng, y: b.lat};
  const P = {x: p.lng, y: p.lat};
  const ABx = B.x - A.x;
  const ABy = B.y - A.y;
  const APx = P.x - A.x;
  const APy = P.y - A.y;
  const ab2 = ABx*ABx + ABy*ABy;
  const t = ab2 === 0 ? 0 : (APx*ABx + APy*ABy)/ab2;
  const clamped = Math.max(0, Math.min(1, t));
  const proj = { x: A.x + ABx*clamped, y: A.y + ABy*clamped };
  const dx = P.x - proj.x;
  const dy = P.y - proj.y;
  // grado -> metros
  const meterPerDeg = 111320;
  return Math.sqrt(dx*dx + dy*dy) * meterPerDeg;
}

// promedio de puntos (para colapsar parada)
function averagePoint(arr){
  let lat=0, lng=0;
  for (const p of arr){ lat+=p.lat; lng+=p.lng; }
  lat /= arr.length; lng /= arr.length;
  return {
    lat, lng,
    timestamp: arr[Math.floor(arr.length/2)].timestamp
  };
}

// ========================= densificar =========================
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

// ========================= fallback recto =========================
function straightInterpolate(a, b, step = 30) {
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

// ========================= init mapa =========================
function initMap(){
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20});
  state.map = L.map("map",{center:[-12.0464,-77.0428],zoom:12,layers:[state.baseLayers.osm]});
  state.cluster = L.markerClusterGroup({disableClusteringAtZoom:16});
  state.map.addLayer(state.cluster);

  ui.apply.onclick = () => fetchInitial(true);
  ui.exportKmz.onclick = () => exportKMZFromState();
}
initMap();

// ========================= Status =========================
function setStatus(text, kind){
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}

// ========================= centrar en brigada =========================
function focusOnUser(uid) {
  const u = state.users.get(uid);
  if (!u || !u.marker) return;
  const latlng = u.marker.getLatLng();
  state.map.setView(latlng, 17, { animate: true });
  u.marker.openPopup();
}

// ========================= Popup =========================
function buildPopup(r){
  const acc = Math.round(r.acc || 0);
  const spd = (r.spd || 0).toFixed(1);
  const ts = new Date(r.timestamp).toLocaleString();
  return `<div><b>${r.tecnico || "Sin nombre"}</b><br>Brigada: ${r.brigada || "-"}<br>Acc: ${acc} m · Vel: ${spd} m/s<br>${ts}</div>`;
}

// ========================= Lista lateral =========================
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

// ========================= Cargar últimas 24h =========================
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

// ===================================================================
// ========================= KMZ helpers =============================
// ===================================================================

// 1) limpiar puntos muy pegados
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

// 2) colapsar PARADA RUIDOSA (la “araña”)
function collapseNoisyStops(points) {
  if (!points.length) return points;
  const out = [];
  let bucket = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const first = bucket[0];
    const d = distMeters(first, p);
    const dtMin = (new Date(p.timestamp) - new Date(first.timestamp)) / 60000;

    if (d <= NOISY_STOP_RADIUS && dtMin <= NOISY_STOP_MAX_MIN) {
      bucket.push(p);
    } else {
      if (bucket.length >= NOISY_STOP_MIN_POINTS) {
        out.push(averagePoint(bucket));
      } else {
        out.push(...bucket);
      }
      bucket = [p];
    }
  }
  if (bucket.length >= NOISY_STOP_MIN_P
OINTS) {
    out.push(averagePoint(bucket));
  } else {
    out.push(...bucket);
  }
  return out;
}

// 3) cortar por tiempo
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

// pedir directions con validaciones
async function directionsBetween(a, b) {
  if (!MAPBOX_TOKEN) return straightInterpolate(a, b, 30);

  const dStraight = distMeters(a, b);
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) return straightInterpolate(a, b, 30);

  const j = await r.json();
  const coords = j.routes?.[0]?.geometry?.coordinates || [];
  if (!coords.length) return straightInterpolate(a, b, 30);

  let routeLen = 0;
  for (let i=0;i<coords.length-1;i++){
    const p1 = {lat: coords[i][1], lng: coords[i][0]};
    const p2 = {lat: coords[i+1][1], lng: coords[i+1][0]};
    routeLen += distMeters(p1, p2);
  }
  if (routeLen > BRIDGE_MAX_LENGTH_FACTOR * dStraight) {
    return straightInterpolate(a, b, 30);
  }

  for (const [lng,lat] of coords) {
    const p = {lat, lng};
    const dv = distPointToSegment(p, a, b);
    if (dv > BRIDGE_MAX_POINT_DEVIATION) {
      return straightInterpolate(a, b, 30);
    }
  }

  return coords.map(([lng,lat])=>({lat,lng}));
}

// bridge troceado
async function smartBridge(a, b) {
  const d = distMeters(a, b);
  if (d > GAP_HARD_METERS) {
    return straightInterpolate(a, b, 50);
  }
  if (d <= DIRECTIONS_HOP_METERS) {
    return await directionsBetween(a, b);
  }
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

// map-matching seguro
async function mapMatchBlockSafe(seg){
  if (!MAPBOX_TOKEN) return null;
  if (seg.length < 2) return null;
  if (seg.length > MAX_MM_POINTS) return null;

  const dense = densifySegment(seg, DENSIFY_STEP);

  let rawDist = 0;
  for (let i=0;i<dense.length-1;i++){
    rawDist += distMeters(dense[i], dense[i+1]);
  }

  const coords = dense.map(p=>`${p.lng},${p.lat}`).join(";");
  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?geometries=geojson&overview=full&tidy=true&access_token=${MAPBOX_TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const match = j.matchings && j.matchings[0];
  if (!match || !match.geometry || !match.geometry.coordinates) return null;
  const matched = match.geometry.coordinates.map(([lng,lat])=>({lat,lng}));

  let mmDist = 0;
  for (let i=0;i<matched.length-1;i++){
    mmDist += distMeters(matched[i], matched[i+1]);
  }
  const diff = Math.abs(mmDist - rawDist);
  if (diff / Math.max(rawDist,1) > MAX_DIST_RATIO) return null;

  if (distMeters(dense[0], matched[0]) > ENDPOINT_TOL) return null;
  if (distMeters(dense[dense.length-1], matched[matched.length-1]) > ENDPOINT_TOL) return null;

  return matched;
}

// ===================================================================
// ========================= EXPORTAR KMZ =============================
// ===================================================================
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

    // agrupar por usuario
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

    for (const [uid, rawRows] of byUser.entries()){
      if (rawRows.length < 2) continue;
      const tecnicoName = (rawRows[0].tecnico || `Tecnico ${uid}`).replace(/&/g,"&amp;");

      // 1) limpiar pegados
      let rows = cleanClosePoints(rawRows, CLEAN_MIN_METERS);
      // 2) colapsar parada ruidosa (esto mata la araña)
      rows = collapseNoisyStops(rows);
      // 3) partir en segmentos por tiempo
      const segments = splitOnGaps(rows, GAP_MINUTES);

      for (const seg of segments){
        if (seg.length < 2) continue;

        const blocks = chunk(seg, MAX_MM_POINTS);
        let current = [];

        for (let i=0;i<blocks.length;i++){
          const block = blocks[i];

          // quitar saltos bruscos estando casi parado
          const filteredBlock = [];
          for (let j=0;j<block.length;j++){
            if (!filteredBlock.length) { filteredBlock.push(block[j]); continue; }
            const prev = filteredBlock[filteredBlock.length-1];
            const cur  = block[j];
            const dt = (new Date(cur.timestamp) - new Date(prev.timestamp))/1000;
            const dm = distMeters(prev, cur);
            if (dt < 20 && dm > SPEEDY_JUMP_METERS) {
              // ruido -> no lo meto
              continue;
            }
            filteredBlock.push(cur);
          }

          let finalBlock = densifySegment(filteredBlock, DENSIFY_STEP);
          try {
            const mm = await mapMatchBlockSafe(filteredBlock);
            if (mm && mm.length >= 2) finalBlock = mm;
          } catch(e){}

          if (!current.length){
            current.push(...finalBlock);
          } else {
            const last = current[current.length-1];
            const first = finalBlock[0];
            const gap = distMeters(last, first);

            if (gap < 5){
              current.push(...finalBlock.slice(1));
            } else {
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

// ========================= Arranque =========================
setStatus("Cargando...","gray");
fetchInitial(true);
