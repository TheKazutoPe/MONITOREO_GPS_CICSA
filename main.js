// ============================== main.js ==============================
const supa = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;
const STORAGE_BUCKET = "rutas_media"; // bucket para KMZ/PNG

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
  users: new Map(),
  pointsByUser: new Map(),
};

// ====== Ajustes trazado/matching ======
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
function bboxOfLngLatCoords(coords) {
  let minLon=Infinity, minLat=Infinity, maxLon=-Infinity, maxLat=-Infinity;
  for (const [lon,lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

// ====== Densificar / downsample ======
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

// ====== Limpieza y cortes ======
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
  return Math.max(10, Math.min(50, base)); // 10–50 m
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

  if (!r.ok){ return null; }

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
  return matched;
}

// ====== Directions plausibles ======
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
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20});
  state.map = L.map("map",{center:[-12.0464,-77.0428],zoom:12,layers:[state.baseLayers.osm]});
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

// =========================== Persistencia rutas ===========================
function toLineStringFromSegments(segments){
  const coords = [];
  for (const seg of segments){
    for (const p of seg) coords.push([p.lng, p.lat]);
  }
  return { type: "LineString", coordinates: coords };
}
function totalDistanceKmFromLngLat(coords){
  let d=0;
  for (let i=1;i<coords.length;i++){
    const a = { lat: coords[i-1][1], lng: coords[i-1][0] };
    const b = { lat: coords[i][1],   lng: coords[i][0] };
    d += distMeters(a,b);
  }
  return d/1000;
}
async function upsertRutaBrigada(fechaISO, brig, lineGeoJSON){
  try {
    const puntos = lineGeoJSON.coordinates.length;
    const bbox   = bboxOfLngLatCoords(lineGeoJSON.coordinates);
    const distKm = totalDistanceKmFromLngLat(lineGeoJSON.coordinates);
    const { error } = await supa.rpc("upsert_ruta_brigada", {
      p_fecha:   fechaISO,
      p_brigada: brig,
      p_line:    lineGeoJSON,
      p_puntos:  puntos,
      p_dist_km: distKm,
      p_bbox:    bbox
    });
    if (error) console.warn("upsert_ruta_brigada error:", error);
    return !error;
  } catch(e){ console.warn(e); return false; }
}
async function uploadKMZToStorage(blob, fechaISO, brig){
  try{
    const safeBrig = brig.replace(/[^a-zA-Z0-9_-]+/g,"_");
    const path = `kmz/${fechaISO}/RUTA_${safeBrig}_${fechaISO}.kmz`;
    const { error } = await supa.storage.from(STORAGE_BUCKET)
      .upload(path, blob, { contentType: "application/vnd.google-earth.kmz", upsert: true });
    if (error) console.warn("Storage upload error:", error);
    return !error;
  }catch(e){ console.warn(e); return false; }
}

// ======================= NUEVO: snapshot + upload PNG ======================
async function renderSnapshotAndUpload(fechaISO, brig, segments){
  return new Promise((resolve) => {
    try{
      if (!window.leafletImage){ console.warn("leaflet-image no cargado"); return resolve(false); }

      // 1) Capa temporal con el trazo (no toca tu cluster ni marcadores)
      const tempLayer = L.layerGroup();
      const bounds = [];
      for (const seg of segments){
        const latlngs = seg.map(p => [p.lat, p.lng]);
        if (latlngs.length > 1){
          L.polyline(latlngs, { weight: 4, opacity: 0.95 }).addTo(tempLayer);
          bounds.push(...latlngs);
        }
      }
      tempLayer.addTo(state.map);

      // 2) Enfocar a la ruta con padding
      if (bounds.length >= 2){
        state.map.fitBounds(bounds, { padding: [40,40] });
      }

      // 3) Esperar un poquito a que termine el render y sacar snapshot
      setTimeout(() => {
        leafletImage(state.map, async (err, canvas) => {
          try{
            if (err || !canvas) { console.warn(err); tempLayer.remove(); return resolve(false); }
            canvas.toBlob(async (blob) => {
              if (!blob) { tempLayer.remove(); return resolve(false); }
              const safeBrig = brig.replace(/[^a-zA-Z0-9_-]+/g,"_");
              const path = `png/${fechaISO}/${safeBrig}.png`;
              const { error } = await supa.storage.from(STORAGE_BUCKET)
                .upload(path, blob, { contentType: "image/png", upsert: true });
              if (error) console.warn("PNG upload error:", error);
              tempLayer.remove();
              resolve(!error);
            }, "image/png");
          } catch(e){
            console.warn(e); tempLayer.remove(); resolve(false);
          }
        });
      }, 400);
    } catch(e){
      console.warn(e); resolve(false);
    }
  });
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

    // Día completo en orden local
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

    // Procesar con tu pipeline (limpieza → cortes → matching → bridges)
    const rows1 = [all[0], ...cleanClosePoints(all.slice(1), CLEAN_MIN_METERS)];
    const segmentsRaw = splitOnGaps(rows1, GAP_MINUTES, GAP_JUMP_METERS);

    const renderedSegments = [];
    for (const seg of segmentsRaw){
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

    // === Persistir LineString diario ===
    const lineGeo = toLineStringFromSegments(renderedSegments);
    await upsertRutaBrigada(ymd, brig, lineGeo);

    // === KML/KMZ (descarga local + Storage) ===
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

    // Descarga local
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const safeBrig = brig.replace(/[^a-zA-Z0-9_-]+/g,"_");
    a.download = `recorrido_${safeBrig}_${ymd}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);

    // Subir KMZ (sobrescribe)
    await uploadKMZToStorage(blob, ymd, brig);

    // === NUEVO: generar/sobrescribir PNG de la ruta del día ===
    await renderSnapshotAndUpload(ymd, brig, renderedSegments);

    alert(`✅ KMZ y PNG listos y guardados.\nBrigada: ${brig}\nFecha: ${ymd}\nTramos: ${renderedSegments.length}`);
  } catch(e){
    console.error(e);
    alert("❌ No se pudo generar el KMZ/PNG: " + e.message);
  } finally {
    setStatus("Conectado","green");
    if (ui?.exportKmz) ui.exportKmz.disabled = prevDisabled;
  }
}

// ====== Arranque ======
setStatus("Cargando...","gray");
fetchInitial(true);
