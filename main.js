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

// ====== Estado global ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),        // uid -> { marker, lastRow }
  pointsByUser: new Map(), // uid -> [rows]
};

// ====== Constantes (modo preciso) ======
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

// bajamos el tamaño del bloque para que mapbox “adivine” menos
const MAX_MM_POINTS = 50;        // antes 90
const GAP_MINUTES = 20;          // si pasan >20 min -> corte
const GAP_METERS = 120;          // si salto >120 m -> corte
const SMALL_BRIDGE_METERS = 80;  // solo puentear si el hueco es <= 80 m
const CLEAN_MIN_METERS = 4;      // limpiar puntos pegados
const DENSIFY_STEP = 20;         // insertar punto cada 20 m antes de mapbox
const MAX_DIST_RATIO = 0.35;     // validación mapbox
const ENDPOINT_TOL = 25;         // no mover puntas más de 25 m
const PER_BLOCK_DELAY = 150;     // un poco más de tiempo entre requests

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
  for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
}

// ====== densificar entre 2 puntos ======
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

// ====== centrar en brigada desde la lista ======
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

// ====== Cargar últimas 24h en el mapa ======
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
// ======================= KMZ: helpers precisos ==============================
// ============================================================================

// 1) quitar puntos muy pegados
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

// 2) partir por huecos (cortes reales)
function splitOnGaps(points, maxGapMin = GAP_MINUTES, maxGapMeters = GAP_METERS){
  const groups = [];
  let cur = [];
  for (let i=0;i<points.length;i++){
    const p = points[i];
    if (!cur.length){ cur.push(p); continue; }
    const prev = cur[cur.length-1];
    const dtMin = (new Date(p.timestamp) - new Date(prev.timestamp))/60000;
    const dm    = distMeters(prev, p);
    if (dtMin > maxGapMin || dm > maxGapMeters){
      if (cur.length>1) groups.push(cur);
      cur = [p];
    } else {
      cur.push(p);
    }
  }
  if (cur.length>1) groups.push(cur);
  return groups;
}

// 3) pequeño puente si el hueco es MUY chico (≤80m)
async function smallBridge(a, b){
  const gap = distMeters(a, b);
  if (gap <= 5) return [a, b];
  if (gap > SMALL_BRIDGE_METERS) return [a, b]; // no puentear grande
  if (!MAPBOX_TOKEN) return [a, b];             // sin token, recto cortito

  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) return [a, b];
  const j = await r.json();
  const coords = j.routes?.[0]?.geometry?.coordinates || [];
  if (!coords.length) return [a, b];
  return coords.map(([lng,lat])=>({lat,lng}));
}

// 4) map-matching SEGURO (con densificado!)
async function mapMatchBlockSafe(seg){
  if (!MAPBOX_TOKEN) return null;
  if (seg.length < 2) return null;
  if (seg.length > MAX_MM_POINTS) return null;

  // densificar antes de mandar a mapbox
  const dense = densifySegment(seg, DENSIFY_STEP);

  // distancia cruda
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

  // distancia matcheada
  let mmDist=0;
  for (let i=0;i<matched.length-1;i++){
    mmDist += distMeters(matched[i], matched[i+1]);
  }

  const diff = Math.abs(mmDist - rawDist);
  if (diff / Math.max(rawDist,1) > MAX_DIST_RATIO) return null;

  // no mover puntas
  if (distMeters(dense[0], matched[0]) > ENDPOINT_TOL) return null;
  if (distMeters(dense[dense.length-1], matched[matched.length-1]) > ENDPOINT_TOL) return null;

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

    // agrupar por usuario_id
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

      // 2) partir por huecos
      const segments = splitOnGaps(rows1, GAP_MINUTES, GAP_METERS);

      for (const seg of segments){
        if (seg.length < 2) continue;

        // si es corto → intentar mapbox completo
        if (seg.length <= MAX_MM_POINTS){
          // densificar + mapbox
          const mm = await mapMatchBlockSafe(seg);
          const finalSeg = mm ? mm : densifySegment(seg, DENSIFY_STEP);
          const coords = finalSeg.map(p=>`${p.lng},${p.lat},0`).join(" ");
          kml += `
            <Placemark>
              <name>${tecnicoName} (${brig})</name>
              <Style><LineStyle><color>ff00a6ff</color><width>4</width></LineStyle></Style>
              <LineString><coordinates>${coords}</coordinates></LineString>
            </Placemark>`;
          placemarks++;
          continue;
        }

        // si es largo → trocear y unir SOLO huecos chicos
        const blocks = chunk(seg, MAX_MM_POINTS);
        let currentLine = [];  // iremos metiendo los bloques aquí

        for (let i=0;i<blocks.length;i++){
          const block = blocks[i];

          // densificar y mapbox
          let finalBlock = densifySegment(block, DENSIFY_STEP);
          try {
            const mm = await mapMatchBlockSafe(block);
            if (mm && mm.length >= 2) {
              finalBlock = mm;
            }
          } catch(e){
            // nos quedamos con el densificado
          }

          if (!currentLine.length){
            currentLine.push(...finalBlock);
          } else {
            const last = currentLine[currentLine.length-1];
            const first = finalBlock[0];
            const gap = distMeters(last, first);
            if (gap <= SMALL_BRIDGE_METERS){
              // puente corto → lo pedimos
              const bridge = await smallBridge(last, first);
              currentLine.push(...bridge.slice(1));
              currentLine.push(...finalBlock.slice(1));
            } else {
              // hueco grande → cerramos placemark y empezamos otro
              const coords = currentLine.map(p=>`${p.lng},${p.lat},0`).join(" ");
              kml += `
                <Placemark>
                  <name>${tecnicoName} (${brig})</name>
                  <Style><LineStyle><color>ff00a6ff</color><width>4</width></LineStyle></Style>
                  <LineString><coordinates>${coords}</coordinates></LineString>
                </Placemark>`;
              placemarks++;
              currentLine = [...finalBlock];
            }
          }

          await sleep(PER_BLOCK_DELAY);
        }

        // cerrar el último de este segmento
        if (currentLine.length > 1){
          const coords = currentLine.map(p=>`${p.lng},${p.lat},0`).join(" ");
          kml += `
            <Placemark>
              <name>${tecnicoName} (${brig})</name>
              <Style><LineStyle><color>ff00a6ff</color><width>4</width></LineStyle></Style>
              <LineString><coordinates>${coords}</coordinates></LineString>
            </Placemark>`;
          placemarks++;
        }
      }
    }

    kml += `</Document></kml>`;

    if (!placemarks) throw new Error("No se generó ninguna traza válida.");

    // descargar KMZ
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

    alert(`✅ KMZ preciso listo para "${brig}" (${placemarks} tramo(s))`);
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
