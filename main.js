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
};

// ====== Estado del mapa/lista ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),        // uid -> { marker, lastRow, lastUiUpdate }
  pointsByUser: new Map(), // uid -> [rows] (snapshot inicial)
};

// ====== Estado de rutas limpias (por brigada) ======
const routeState = {
  // brigada -> { date, polyline, coordsAll, lock, usuario_id, lastAccepted, _raw }
  byBrigada: new Map()
};

// =================== Parámetros clave ===================

// Limpieza básica
const CLEAN_MIN_METERS      = 6;

// Densificación / matching
const DENSIFY_STEP          = 10;
const MAX_MM_POINTS         = 40;
const MAX_MATCH_INPUT       = 90;
const MAX_DIST_RATIO        = 0.35;
const ENDPOINT_TOL          = 25;
const CONFIDENCE_MIN        = 0.70;

// Gaps (por si luego los usas en otros flujos)
const GAP_MINUTES           = 8;
const GAP_JUMP_METERS       = 800;

// Puentes (reservado)
const BRIDGE_MAX_METERS     = 800;
const DIRECTIONS_HOP_METERS = 300;
const MAX_BRIDGE_SPEED_KMH  = 70;
const MIN_BRIDGE_SPEED_KMH  = 3;
const DIRECTIONS_PROFILE    = "driving";

// Anti-saturación de Matching (tu app manda 15s, así que esto casi ni afecta)
const PER_BLOCK_DELAY       = 0;

// Anti-garabato cuando está quieto
const STAY_RADIUS_METERS    = 25;   // zona de “sigo en el mismo punto”
const MAX_STAY_SPEED_M_S    = 1.2;  // si se mueve lento dentro del radio => parado

// Suavizar UI: no refrescar marker/lista si llegan puntos demasiado seguidos
const MIN_UI_UPDATE_MS      = 8000; // mínimo ~8s entre updates visibles por usuario

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

// ============================== Helpers ==============================
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

// ====== limitar puntos ======
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

// ====== limpieza simple ======
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

// ====== Radio adaptativo ======
function adaptiveRadius(p){
  const acc = (p && p.acc != null) ? Number(p.acc) : NaN;
  const base = isFinite(acc) ? acc + 5 : 25;
  return Math.max(10, Math.min(50, base));
}

// ================= Map Matching (Mapbox) =================
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
  if (!m?.geometry?.coordinates ||
      (typeof m.confidence === "number" && m.confidence < CONFIDENCE_MIN)) {
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

// ========= Directions (opcional) =========
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

// ================= Utilidades ruta limpia / Supabase =================
function ensureRouteState(brigada, usuario_id) {
  const today = toYMD(new Date());
  let rs = routeState.byBrigada.get(brigada);
  if (!rs || rs.date !== today) {
    if (rs?.polyline && state.map) {
      state.map.removeLayer(rs.polyline);
    }
    const poly = L.polyline([], {
      color: "#00f5ff",
      weight: 3,
      opacity: 0.9
    }).addTo(state.map);
    rs = {
      date: today,
      polyline: poly,
      coordsAll: [],
      lock: false,
      usuario_id: usuario_id || null,
      lastAccepted: null,
      _raw: []
    };
    routeState.byBrigada.set(brigada, rs);
  }
  return rs;
}

function computeDistanceKmFromCoords(coords) {
  if (!coords || coords.length < 2) return 0;
  let total = 0;
  for (let i=0; i<coords.length-1; i++) {
    const a = { lat: coords[i][1], lng: coords[i][0] };
    const b = { lat: coords[i+1][1], lng: coords[i+1][0] };
    total += distMeters(a,b);
  }
  return total / 1000;
}

function computeBboxFromCoords(coords) {
  if (!coords || !coords.length) return null;
  let minLon = coords[0][0], maxLon = coords[0][0];
  let minLat = coords[0][1], maxLat = coords[0][1];
  for (const [lng,lat] of coords) {
    if (lng < minLon) minLon = lng;
    if (lng > maxLon) maxLon = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

// ========== Trazo limpio incremental (Mapbox + anti-garabato) ==========
async function pushPointForLiveRoute(brigada, p) {
  if (!brigada || !p) return;
  const rs = ensureRouteState(brigada, p.usuario_id);

  const candidate = {
    lat: +p.lat,
    lng: +p.lng,
    timestamp: p.timestamp || new Date().toISOString(),
    acc: p.acc ?? null,
    spd: p.spd ?? null,
    usuario_id: p.usuario_id || null
  };

  // 1) Si sigue en el mismo sitio (ruido) -> no agregamos al trazo
  if (rs.lastAccepted) {
    const d = distMeters(
      { lat: rs.lastAccepted.lat, lng: rs.lastAccepted.lng },
      { lat: candidate.lat,       lng: candidate.lng }
    );
    const dt = (new Date(candidate.timestamp) - new Date(rs.lastAccepted.timestamp)) / 1000;
    const v_geom = dt > 0 ? d / dt : 0;
    const v = (candidate.spd != null && candidate.spd >= 0) ? candidate.spd : v_geom;

    if (d < STAY_RADIUS_METERS && v <= MAX_STAY_SPEED_M_S) {
      rs.lastAccepted.timestamp = candidate.timestamp;
      return;
    }
  }

  // 2) Movimiento real -> este punto sí cuenta para la ruta
  rs.lastAccepted = { ...candidate };

  if (rs.lock) return;
  rs.lock = true;

  try {
    rs._raw.push(candidate);
    const MAX_LOCAL_POINTS = 120;
    if (rs._raw.length > MAX_LOCAL_POINTS) {
      rs._raw.splice(0, rs._raw.length - MAX_LOCAL_POINTS);
    }
    if (rs._raw.length < 2) {
      rs.lock = false;
      return;
    }

    const sliceSize = Math.min(MAX_MM_POINTS, rs._raw.length);
    const recent = rs._raw.slice(-sliceSize);

    const cleaned = cleanClosePoints(recent, CLEAN_MIN_METERS);
    if (cleaned.length < 2) {
      rs.lock = false;
      return;
    }

    // Mapbox Matching para pegar a pista
    let seg = null;
    try {
      const mm = await mapMatchBlockSafe(cleaned);
      if (mm && mm.length >= 2) seg = mm;
    } catch(e){
      console.warn("Matching parcial falló, uso densify:", e);
    }

    if (!seg) seg = densifySegment(cleaned, DENSIFY_STEP);
    if (!seg || seg.length < 2) {
      rs.lock = false;
      return;
    }

    // Agregar coords corregidas evitando duplicados
    const newCoords = seg.map(p => [p.lng, p.lat]);
    const existing = rs.coordsAll;
    if (existing.length) {
      const [elng, elat] = existing[existing.length - 1];
      const [nlng, nlat] = newCoords[0];
      if (Math.abs(elng - nlng) < 1e-6 && Math.abs(elat - nlat) < 1e-6) {
        newCoords.shift();
      }
    }
    if (!newCoords.length) {
      rs.lock = false;
      return;
    }

    rs.coordsAll = existing.concat(newCoords);

    // Actualizar polyline en mapa
    const latlngs = rs.coordsAll.map(([lng,lat]) => L.latLng(lat, lng));
    rs.polyline.setLatLngs(latlngs);

    // Guardar en rutas_brigadas_dia
    if (rs.coordsAll.length >= 2) {
      const distancia_km = computeDistanceKmFromCoords(rs.coordsAll);
      const bbox = computeBboxFromCoords(rs.coordsAll);
      const line_geojson = {
        type: "LineString",
        coordinates: rs.coordsAll
      };

      await supa
        .from("rutas_brigadas_dia")
        .upsert(
          {
            fecha: rs.date,
            brigada,
            usuario_id: rs.usuario_id,
            line_geojson,
            puntos: rs.coordsAll.length,
            distancia_km,
            bbox
          },
          { onConflict: "fecha,brigada" }
        );
    }

    if (PER_BLOCK_DELAY > 0) await sleep(PER_BLOCK_DELAY);
  } catch(e){
    console.warn("Error actualizando ruta en tiempo real para", brigada, e);
  } finally {
    rs.lock = false;
  }
}

// ======================= Mapa / Lista =======================
function initMap(){
  state.baseLayers.osm = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {maxZoom:20}
  );
  state.map = L.map("map",{
    center:[-12.0464,-77.0428],
    zoom:12,
    layers:[state.baseLayers.osm]
  });
  state.cluster = L.markerClusterGroup({disableClusteringAtZoom:16});
  state.map.addLayer(state.cluster);

  ui.apply.onclick = () => fetchInitial(true);
  ui.exportKmz.onclick = () => exportKMZFromCleanTable();
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
    el.className = `brigada-item ${cls}`;
    el.innerHTML = html;
    el.onclick = () => { focusOnUser(uid); ui.brigada.value = brig; };
  }
}

// ======================= Snapshot inicial =======================
async function fetchInitial(clear){
  setStatus("Cargando…","gray");
  if (clear) ui.userList.innerHTML = "";

  const {data, error} = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now()-24*60*60*1000).toISOString())
    .order("timestamp",{ascending:false});

  if (error){
    console.error(error);
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

  const now = Date.now();
  grouped.forEach((rows, uid)=>{
    const last = rows[0];
    const marker = L.marker(
      [last.latitud,last.longitud],
      {icon:getIconFor(last)}
    ).bindPopup(buildPopup(last));
    state.cluster.addLayer(marker);
    state.users.set(uid,{
      marker,
      lastRow:last,
      lastUiUpdate: now
    });
    state.pointsByUser.set(uid, rows);
    addOrUpdateUserInList(last);
  });

  setStatus("Conectado","green");
  subscribeRealtimeUbicaciones();
}

// ======================= Realtime Supabase =======================
function subscribeRealtimeUbicaciones() {
  supa
    .channel("ubicaciones_brigadas_stream")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "ubicaciones_brigadas" },
      payload => {
        const r = payload.new;
        if (!r) return;

        const point = {
          latitud: +r.latitud,
          longitud: +r.longitud,
          timestamp: r.timestamp || r.timestamp_pe || new Date().toISOString(),
          tecnico: r.tecnico || "",
          brigada: r.brigada || "",
          usuario_id: r.usuario_id || null,
          acc: r.acc ?? null,
          spd: r.spd ?? null
        };

        handleRealtimePoint(point);
      }
    )
    .subscribe(status => {
      if (status === "SUBSCRIBED") {
        console.log("Realtime suscrito ubicaciones_brigadas");
      }
    });
}

function handleRealtimePoint(p) {
  if (!p.latitud || !p.longitud || !p.brigada) return;

  const uid = String(p.usuario_id || "0");
  const row = { ...p, timestamp: p.timestamp };

  const now = Date.now();
  let u = state.users.get(uid);

  // ===== Suavizado de UI =====
  if (u && u.lastRow) {
    const prevTs = new Date(u.lastRow.timestamp).getTime();
    const newTs  = new Date(row.timestamp).getTime();
    const dtMs   = newTs - prevTs;

    // Si llegan puntos muy seguidos (< MIN_UI_UPDATE_MS) y casi en el mismo lugar,
    // no refrescamos la UI (pero igual actualizamos el trazo limpio abajo).
    const d = distMeters(
      { lat: u.lastRow.latitud, lng: u.lastRow.longitud },
      { lat: row.latitud,       lng: row.longitud }
    );

    if (dtMs > 0 && dtMs < MIN_UI_UPDATE_MS && d < 5) {
      // No tocamos marker ni lista; seguimos con el trazo limpio.
    } else {
      // Actualizamos marker + popup + lista cuando el cambio es real
      u.lastRow = row;
      u.lastUiUpdate = now;
      u.marker.setLatLng([p.latitud,p.longitud]);
      u.marker.setIcon(getIconFor(row));
      u.marker.setPopupContent(
        buildPopup({ ...row, latitud: p.latitud, longitud: p.longitud })
      );
      addOrUpdateUserInList(row);
    }
  } else {
    // Primera vez para este uid
    const marker = L.marker(
      [p.latitud,p.longitud],
      { icon: getIconFor(row) }
    ).bindPopup(buildPopup({ ...row, latitud: p.latitud, longitud: p.longitud }));
    state.cluster.addLayer(marker);
    state.users.set(uid, {
      marker,
      lastRow: row,
      lastUiUpdate: now
    });
    addOrUpdateUserInList(row);
  }

  // ===== Trazo limpio incremental (siempre procesa cada INSERT) =====
  pushPointForLiveRoute(p.brigada, {
    lat: p.latitud,
    lng: p.longitud,
    timestamp: p.timestamp,
    acc: p.acc,
    spd: p.spd,
    usuario_id: p.usuario_id
  });
}

// ======================= Exportar KMZ =======================
async function exportKMZFromCleanTable(){
  try {
    setStatus("Generando KMZ…","gray");
    if (ui?.exportKmz) ui.exportKmz.disabled = true;

    const brig = (ui.brigada.value || "").trim();
    if (!brig){
      alert("Escribe la brigada EXACTA para exportar su KMZ.");
      return;
    }

    const dateInput = document.getElementById("kmzDate");
    const chosen = (dateInput && dateInput.value)
      ? new Date(dateInput.value+"T00:00:00")
      : new Date();
    const ymd = toYMD(chosen);

    const { data, error } = await supa
      .from("rutas_brigadas_dia")
      .select("line_geojson")
      .eq("fecha", ymd)
      .eq("brigada", brig)
      .maybeSingle();

    if (error && error.code !== "PGRST116") {
      throw new Error(error.message || "Error consultando rutas_brigadas_dia");
    }

    if (!data || !data.line_geojson || !data.line_geojson.coordinates ||
        data.line_geojson.coordinates.length < 2) {
      alert(`⚠️ No hay traza limpia registrada para "${brig}" en ${ymd}.`);
      return;
    }

    const coords = data.line_geojson.coordinates;

    let kml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
      `<name>${brig} - ${ymd}</name>` +
      `<Style id="routeStyle"><LineStyle><color>ffFF0000</color><width>4</width></LineStyle></Style>`;

    const coordsStr = coords.map(([lng,lat]) => `${lng},${lat},0`).join(" ");
    kml += `
      <Placemark>
        <name>${brig} (${ymd})</name>
        <styleUrl>#routeStyle</styleUrl>
        <LineString><tessellate>1</tessellate><coordinates>${coordsStr}</coordinates></LineString>
      </Placemark>
    `;

    kml += `</Document></kml>`;

    if (!window.JSZip) {
      try { await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"); } catch(_){}
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

    alert(`✅ KMZ listo desde rutas_brigadas_dia: ${brig} (${ymd})`);
  } catch(e){
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado","green");
    if (ui?.exportKmz) ui.exportKmz.disabled = false;
  }
}

// ======================= Arranque =======================
setStatus("Cargando...","gray");
fetchInitial(true);
