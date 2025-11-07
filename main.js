// ============================== main.js (FRONT + MAPBOX MATCH + rutas_brigadas_dia) ==============================

const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN || null;

// ============================== UI ==============================
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList"),
  kmzDate: document.getElementById("kmzDate"),              // <input type="date">
  showCleanRoute: document.getElementById("showCleanRoute") // <input type="checkbox">
};

// ============================== Estado ==============================
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),
  cleanRouteLayer: null,
};

// ============================== Iconos ==============================
const ICONS = {
  green: L.icon({ iconUrl: "assets/carro-green.png",  iconSize: [40,24], iconAnchor:[20,12] }),
  yellow:L.icon({ iconUrl: "assets/carro-orange.png", iconSize: [40,24], iconAnchor:[20,12] }),
  gray:  L.icon({ iconUrl: "assets/carro-gray.png",   iconSize: [40,24], iconAnchor:[20,12] }),
};

function getIconFor(row){
  const ts = row.timestamp_pe || row.timestamp;
  const mins = ts ? Math.round((Date.now() - new Date(ts))/60000) : 999;
  if (mins <= 2) return ICONS.green;
  if (mins <= 5) return ICONS.yellow;
  return ICONS.gray;
}

// ============================== Helpers ==============================
function setStatus(text, kind){
  if (!ui.status) return;
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}

function toYMD(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

function distMeters(a,b){
  const R=6371000;
  const dLat=((b.lat-a.lat)*Math.PI)/180;
  const dLng=((b.lng-a.lng)*Math.PI)/180;
  const s1=
    Math.sin(dLat/2)**2 +
    Math.cos(a.lat*Math.PI/180) *
    Math.cos(b.lat*Math.PI/180) *
    Math.sin(dLng/2)**2;
  return 2*R*Math.atan2(Math.sqrt(s1),Math.sqrt(1-s1));
}

function focusOnUser(uid){
  const u = state.users.get(uid);
  if (!u || !u.marker) return;
  state.map.setView(u.marker.getLatLng(),17,{animate:true});
  u.marker.openPopup();
}

function buildPopup(r){
  const acc = r.acc != null ? Math.round(r.acc) : "-";
  const spd = r.spd != null ? Number(r.spd).toFixed(1) : "-";
  const tsRaw = r.timestamp_pe || r.timestamp;
  const ts = tsRaw ? new Date(tsRaw).toLocaleString() : "-";
  const brig = r.brigada || "-";
  const tecnico = r.tecnico || "Sin nombre";
  return `
    <div>
      <b>${tecnico}</b><br>
      Brigada: ${brig}<br>
      Acc: ${acc} m · Vel: ${spd} m/s<br>
      ${ts}
    </div>
  `;
}

function addOrUpdateUserInList(row){
  if (!ui.userList) return;

  const uid = String(row.usuario_id || "0");
  const brig = row.brigada || "-";
  const tecnico = row.tecnico || "Sin nombre";
  const tsRaw = row.timestamp_pe || row.timestamp;
  const hora = tsRaw ? new Date(tsRaw).toLocaleTimeString() : "-";
  const mins = tsRaw ? Math.round((Date.now() - new Date(tsRaw))/60000) : 999;

  const ledColor = mins <= 2 ? "#4ade80" : mins <= 5 ? "#eab308" : "#777";
  const cls = mins <= 2 ? "text-green" : mins <= 5 ? "text-yellow" : "text-gray";

  const html = `
    <div class="brigada-header">
      <div style="display:flex;gap:6px;align-items:flex-start;">
        <div class="brigada-dot" style="background:${ledColor};"></div>
        <div class="brigada-info">
          <b class="brig-name">${tecnico}</b>
          <div class="brigada-sub">${brig}</div>
        </div>
      </div>
      <div class="brigada-hora">${hora}</div>
    </div>
  `;

  let el = document.getElementById(`u-${uid}`);
  if (!el){
    el = document.createElement("div");
    el.id = `u-${uid}`;
    el.className = `brigada-item ${cls}`;
    el.innerHTML = html;
    el.onclick = () => {
      if (ui.brigada) ui.brigada.value = brig;
      focusOnUser(uid);
      loadCleanRouteForCurrentSelection();
    };
    ui.userList.appendChild(el);
  } else {
    el.className = `brigada-item ${cls} marker-pulse`;
    el.innerHTML = html;
    el.onclick = () => {
      if (ui.brigada) ui.brigada.value = brig;
      focusOnUser(uid);
      loadCleanRouteForCurrentSelection();
    };
    setTimeout(() => el.classList.remove("marker-pulse"), 600);
  }
}

// ============================== Inicializar mapa ==============================
function initMap(){
  state.baseLayers.osm = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {maxZoom:20}
  );

  state.map = L.map("map",{
    center:[-12.0464,-77.0428],
    zoom:12,
    layers:[state.baseLayers.osm],
  });

  state.cluster = L.markerClusterGroup({disableClusteringAtZoom:16});
  state.map.addLayer(state.cluster);

  if (ui.apply){
    ui.apply.onclick = () => {
      fetchInitial(true);
      loadCleanRouteForCurrentSelection();
    };
  }

  if (ui.exportKmz){
    ui.exportKmz.onclick = () => exportKMZWithAutoCleanRoute();
  }

  if (ui.kmzDate){
    ui.kmzDate.addEventListener("change", () => {
      loadCleanRouteForCurrentSelection();
    });
  }

  if (ui.showCleanRoute){
    ui.showCleanRoute.addEventListener("change", () => {
      loadCleanRouteForCurrentSelection();
    });
  }
}

// ============================== Cargar ubicaciones tiempo real ==============================
async function fetchInitial(clear){
  try{
    setStatus("Cargando ubicaciones…","gray");
    if (clear && ui.userList) ui.userList.innerHTML = "";

    const since = new Date(Date.now()-24*60*60*1000).toISOString();

    const {data, error} = await supa
      .from("ubicaciones_brigadas")
      .select("*")
      .gte("timestamp", since)
      .order("timestamp",{ascending:false});

    if (error){
      console.error(error);
      setStatus("Error al cargar ubicaciones","gray");
      return;
    }

    const brigFilter = (ui.brigada?.value || "").trim().toLowerCase();
    const grouped = new Map();
    const maxPerUser = 100;

    for (const r of data || []){
      if (brigFilter && !(r.brigada || "").toLowerCase().includes(brigFilter)) continue;
      const uid = String(r.usuario_id || "0");
      if (!grouped.has(uid)) grouped.set(uid,[]);
      if (grouped.get(uid).length >= maxPerUser) continue;
      grouped.get(uid).push(r);
    }

    state.cluster.clearLayers();
    state.users.clear();

    grouped.forEach((rows, uid) => {
      if (!rows.length) return;
      const last = rows[0];
      const marker = L.marker([last.latitud,last.longitud],{
        icon:getIconFor(last),
      }).bindPopup(buildPopup(last));

      state.cluster.addLayer(marker);
      state.users.set(uid,{marker,lastRow:last});
      addOrUpdateUserInList(last);
    });

    setStatus("Conectado","green");
  }catch(e){
    console.error(e);
    setStatus("Error","gray");
  }
}

// ============================== Lógica de trazo limpio (front + Mapbox) ==============================

// Limpia la capa actual
function clearCleanRouteLayer(){
  if (state.cleanRouteLayer){
    state.map.removeLayer(state.cleanRouteLayer);
    state.cleanRouteLayer = null;
  }
}

// Obtiene brigada/fecha seleccionados
function getCurrentSelection(){
  const brig = (ui.brigada?.value || "").trim();
  if (!brig) return null;

  const baseDate =
    ui.kmzDate && ui.kmzDate.value
      ? new Date(ui.kmzDate.value + "T00:00:00")
      : new Date();
  const ymd = toYMD(baseDate);
  return { brig, ymd };
}

// Split de segmentos por saltos grandes (no queremos diagonales)
function splitSegments(points, maxGapMin = 8, maxJumpM = 800){
  if (points.length < 2) return [];
  const segs = [];
  let cur = [points[0]];

  for (let i=1; i<points.length; i++){
    const prev = cur[cur.length-1];
    const p = points[i];
    const dtMin = (p.ts - prev.ts)/60000;
    const d = distMeters({lat:prev.lat,lng:prev.lng},{lat:p.lat,lng:p.lng});
    if (dtMin > maxGapMin || d > maxJumpM){
      if (cur.length > 1) segs.push(cur);
      cur = [p];
    } else {
      cur.push(p);
    }
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}

// Map Matching de un segmento usando Mapbox
async function mapMatchSegment(points){
  if (!MAPBOX_TOKEN) return null;
  if (points.length < 2) return null;

  // ordenar por tiempo
  points = [...points].sort((a,b) => a.ts - b.ts);

  // limitar a 100 puntos (Mapbox)
  let idxs = [];
  if (points.length <= 100) {
    idxs = points.map((_,i)=>i);
  } else {
    idxs = [0];
    const step = (points.length - 1) / 99;
    for (let i=1; i<99; i++){
      idxs.push(Math.round(i*step));
    }
    idxs.push(points.length-1);
    idxs = Array.from(new Set(idxs)).sort((a,b)=>a-b);
  }

  const sel = idxs.map(i => points[i]);
  const coordsStr = sel.map(p => `${p.lng},${p.lat}`).join(";");
  const tsStr = sel.map(p => Math.floor(p.ts/1000)).join(";");

  const url =
    `https://api.mapbox.com/matching/v5/mapbox/driving/${coordsStr}` +
    `?geometries=geojson&overview=full&tidy=true` +
    `&timestamps=${tsStr}` +
    `&access_token=${MAPBOX_TOKEN}`;

  const resp = await fetch(url);
  if (!resp.ok){
    console.warn("Mapbox matching error:", resp.status);
    return null;
  }

  const data = await resp.json().catch(()=>null);
  const matchings = data && data.matchings || [];
  if (!matchings.length) return null;

  // Tomamos el de mayor confidence
  let best = matchings[0];
  for (const m of matchings){
    if ((m.confidence || 0) > (best.confidence || 0)) best = m;
  }

  const geom = best.geometry || {};
  const coords = geom.coordinates || [];
  if (!coords.length) return null;

  // coords = [[lon,lat], ...]
  return coords;
}

// Construye/actualiza rutas_brigadas_dia desde ubicaciones_brigadas si no existe
async function getOrCreateCleanRoute(brig, ymd){
  // 1) Revisar si ya existe en rutas_brigadas_dia
  let { data: ruta, error: errRuta } = await supa
    .from("rutas_brigadas_dia")
    .select("line_geojson,puntos,distancia_km,bbox")
    .eq("brigada", brig)
    .eq("fecha", ymd)
    .maybeSingle();

  if (!errRuta && ruta && ruta.line_geojson){
    return ruta;
  }

  // 2) Construir desde ubicaciones_brigadas usando Mapbox (solo segmentos válidos)
  const nextDay = new Date(ymd + "T00:00:00");
  nextDay.setDate(nextDay.getDate() + 1);
  const ymdNext = toYMD(nextDay);

  const { data: ptsRaw, error: errPts } = await supa
    .from("ubicaciones_brigadas")
    .select("latitud,longitud,timestamp,timestamp_pe")
    .eq("brigada", brig)
    .gte("timestamp_pe", ymd)
    .lt("timestamp_pe", ymdNext)
    .order("timestamp_pe",{ascending:true});

  if (errPts){
    console.error("Error ubicaciones_brigadas:", errPts);
    return null;
  }
  if (!ptsRaw || ptsRaw.length < 2) return null;

  // Normalizar puntos
  let pts = ptsRaw
    .map(r => {
      const tsStr = r.timestamp_pe || r.timestamp;
      const ts = tsStr ? new Date(tsStr).getTime() : null;
      const lat = parseFloat(r.latitud);
      const lng = parseFloat(r.longitud);
      if (!ts || !isFinite(lat) || !isFinite(lng)) return null;
      return { lat, lng, ts };
    })
    .filter(Boolean)
    .sort((a,b) => a.ts - b.ts);

  if (pts.length < 2) return null;

  // Filtro básico: quitar puntos con velocidad absurda
  const MAX_SPEED_KMH = 150;
  const cleaned = [];
  let prev = null;
  for (const p of pts){
    if (!prev){
      cleaned.push(p);
      prev = p;
      continue;
    }
    const dt = (p.ts - prev.ts)/1000;
    if (dt <= 0){
      // mismo tiempo o desorden, salta
      continue;
    }
    const d = distMeters(
      {lat:prev.lat,lng:prev.lng},
      {lat:p.lat,lng:p.lng}
    );
    const v = (d/1000)/(dt/3600);
    if (v <= MAX_SPEED_KMH){
      cleaned.push(p);
      prev = p;
    } else {
      // outlier, lo saltamos
    }
  }

  if (cleaned.length < 2) return null;

  // Cortar en segmentos para evitar diagonales
  const segments = splitSegments(cleaned, 8, 800);
  if (!segments.length) return null;

  const matchedSegments = [];
  for (const seg of segments){
    const mm = await mapMatchSegment(seg);
    if (mm && mm.length >= 2){
      matchedSegments.push(mm); // mm ya es [[lon,lat],...]
    }
  }

  if (!matchedSegments.length) return null;

  // Resumen para guardar
  let totalPts = 0;
  let totalM = 0;
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;

  for (const line of matchedSegments){
    totalPts += line.length;
    for (let i=0; i<line.length; i++){
      const [lon,lat] = line[i];
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLng) minLng = lon;
      if (lon > maxLng) maxLng = lon;
      if (i>0){
        const [plon,plat] = line[i-1];
        totalM += distMeters(
          {lat:plat,lng:plon},
          {lat, lng:lon}
        );
      }
    }
  }

  if (!totalPts || minLat === 90) return null;

  const bbox = [minLng, minLat, maxLng, maxLat];
  const distancia_km = +(totalM / 1000).toFixed(3);

  let line_geojson;
  if (matchedSegments.length === 1){
    line_geojson = {
      type: "LineString",
      coordinates: matchedSegments[0],
    };
  } else {
    line_geojson = {
      type: "MultiLineString",
      coordinates: matchedSegments,
    };
  }

  const newRow = {
    fecha: ymd,
    brigada: brig,
    line_geojson,
    puntos: totalPts,
    distancia_km,
    bbox,
  };

  const { error: upErr } = await supa
    .from("rutas_brigadas_dia")
    .upsert(newRow, { onConflict: "fecha,brigada" });

  if (upErr){
    console.error("Error upsert rutas_brigadas_dia:", upErr);
    // Igual devolvemos el trazo para usarlo en memoria
  }

  return newRow;
}

// ============================== Mostrar trazo limpio en mapa ==============================
async function loadCleanRouteForCurrentSelection(){
  clearCleanRouteLayer();
  if (!ui.showCleanRoute || !ui.showCleanRoute.checked) return;

  const sel = getCurrentSelection();
  if (!sel) return;
  const { brig, ymd } = sel;

  setStatus(`Cargando trazo limpio ${brig} (${ymd})…`,"gray");

  const ruta = await getOrCreateCleanRoute(brig, ymd);
  if (!ruta || !ruta.line_geojson){
    setStatus("Sin trazo limpio disponible","gray");
    return;
  }

  const geojson = ruta.line_geojson;
  state.cleanRouteLayer = L.geoJSON(geojson, {
    style: { color:"#ff0000", weight:4, opacity:0.9 }
  }).addTo(state.map);

  const bounds = state.cleanRouteLayer.getBounds();
  if (bounds.isValid()){
    state.map.fitBounds(bounds,{padding:[40,40]});
  }

  setStatus("Conectado","green");
}

// ============================== KMZ desde rutas_brigadas_dia (auto-generando si falta) ==============================
function buildKMLFromLineGeoJSON(brig, ymd, line_geojson){
  if (!line_geojson) return null;

  const segments = [];
  if (line_geojson.type === "LineString"){
    if (Array.isArray(line_geojson.coordinates))
      segments.push(line_geojson.coordinates);
  } else if (line_geojson.type === "MultiLineString"){
    for (const line of line_geojson.coordinates || []){
      if (Array.isArray(line) && line.length >= 2)
        segments.push(line);
    }
  } else {
    return null;
  }

  if (!segments.length) return null;

  let kml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
    `<name>${brig} - ${ymd}</name>` +
    `<Style id="routeStyle"><LineStyle><color>ff0000ff</color><width>4</width></LineStyle></Style>`;

  for (const line of segments){
    const coordsStr = line.map(([lng,lat]) => `${lng},${lat},0`).join(" ");
    kml += `
      <Placemark>
        <name>${brig} (${ymd})</name>
        <styleUrl>#routeStyle</styleUrl>
        <LineString>
          <tessellate>1</tessellate>
          <coordinates>${coordsStr}</coordinates>
        </LineString>
      </Placemark>
    `;
  }

  kml += `</Document></kml>`;
  return kml;
}

async function exportKMZWithAutoCleanRoute(){
  if (!ui.exportKmz) return;

  const sel = getCurrentSelection();
  if (!sel){
    alert("Selecciona brigada y fecha para exportar.");
    return;
  }
  const { brig, ymd } = sel;

  let prevDisabled = ui.exportKmz.disabled;
  try{
    ui.exportKmz.disabled = true;
    setStatus(`Preparando trazo limpio ${brig} (${ymd})…`,"gray");

    const ruta = await getOrCreateCleanRoute(brig, ymd);
    if (!ruta || !ruta.line_geojson){
      alert("No se pudo generar un trazo limpio válido para esa brigada y fecha.");
      setStatus("Sin trazo limpio","gray");
      return;
    }

    const kml = buildKMLFromLineGeoJSON(brig, ymd, ruta.line_geojson);
    if (!kml){
      alert("El trazo limpio no tiene segmentos válidos para KMZ.");
      return;
    }

    if (!window.JSZip){
      await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js");
    }

    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({
      type:"blob",
      compression:"DEFLATE",
      compressionOptions:{level:1}
    });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const safeBrig = brig.replace(/[^a-zA-Z0-9_-]+/g,"_");
    a.download = `recorrido_${safeBrig}_${ymd}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);

    setStatus("Conectado","green");
    alert("✅ KMZ generado desde trazo limpio (Mapbox + rutas_brigadas_dia).");

  }catch(e){
    console.error(e);
    setStatus("Error","gray");
    alert("Error al generar KMZ: " + e.message);
  }finally{
    ui.exportKmz.disabled = prevDisabled;
  }
}

// ============================== Arranque ==============================
initMap();
setStatus("Cargando…","gray");
fetchInitial(true);
loadCleanRouteForCurrentSelection();
