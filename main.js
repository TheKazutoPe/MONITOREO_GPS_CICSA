/* =========================================================
   Rutas en tiempo real con GraphHopper (Hosted)
   - Trazo pegado a pista (map-matching)
   - Guardado continuo: rutas_brigadas_dia (fecha+brigada)
   - KMZ desde lo guardado
   - Movimiento del carro en vivo
   ========================================================= */

const CONFIG = window.CONFIG;
const supa = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ------- UI refs -------
const ui = {
  status: document.getElementById("status"),
  brigada: document.getElementById("brigadaFilter"),
  apply: document.getElementById("applyFilters"),
  exportKmz: document.getElementById("exportKmzBtn"),
  userList: document.getElementById("userList")
};

// ------- Estado -------
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  users: new Map(),          // uid -> { marker, lastRow }
  pointsByUser: new Map()    // uid -> últimas filas
};

// ------- Iconos -------
const ICONS = {
  green: L.icon({ iconUrl: "assets/carro-green.png", iconSize: [40, 24], iconAnchor: [20, 12] }),
  yellow: L.icon({ iconUrl: "assets/carro-orange.png", iconSize: [40, 24], iconAnchor: [20, 12] }),
  gray:   L.icon({ iconUrl: "assets/carro-gray.png",   iconSize: [40, 24], iconAnchor: [20, 12] }),
};
function getIconFor(row){
  const mins = Math.round((Date.now() - new Date(row.timestamp))/60000);
  if (mins <= 2) return ICONS.green;
  if (mins <= 5) return ICONS.yellow;
  return ICONS.gray;
}

// ------- Parámetros de trazado -------
const CLEAN_MIN_METERS      = 6;
const DENSIFY_STEP          = 10;
const MAX_MM_POINTS         = 40;   // puntos por bloque
const MAX_MATCH_INPUT       = 90;   // re-dowsample
const GAP_MINUTES           = 8;
const GAP_JUMP_METERS       = 800;
const BRIDGE_MAX_METERS     = 800;
const DIRECTIONS_HOP_METERS = 300;
const MAX_BRIDGE_SPEED_KMH  = 70;
const MIN_BRIDGE_SPEED_KMH  = 3;
const CONFIDENCE_MIN        = 0.70;

// ------- Vivo + guardado -------
const SAVE_DEBOUNCE_MS = 30000;
const LIVE_WINDOW_MIN  = 20;
const live = {
  layer: null,
  polylines: new Map(),  // brigada -> polyline
  debouncers: new Map(),
  lastSavedAt: new Map()
};

// =================== Helpers básicos ===================
function setStatus(text, kind){
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || "gray"}`;
}
function toYMD(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), dd=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${dd}`;
}
function todayRangeLima(){
  const now = new Date();
  const ymd = toYMD(now);
  const next = new Date(now.getTime()+86400000);
  return { ymd, ymdNext: toYMD(next) };
}
function distMeters(a,b){
  const R=6371000, dLat=((b.lat-a.lat)*Math.PI)/180, dLng=((b.lng-a.lng)*Math.PI)/180;
  const s1 = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return 2*R*Math.atan2(Math.sqrt(s1), Math.sqrt(1-s1));
}
function chunk(arr,size){ const out=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function bboxOfLngLatCoords(coords){
  let minLon=Infinity,minLat=Infinity,maxLon=-Infinity,maxLat=-Infinity;
  for(const [lon,lat] of coords){ if(lon<minLon)minLon=lon; if(lon>maxLon)maxLon=lon; if(lat<minLat)minLat=lat; if(lat>maxLat)maxLat=lat; }
  return [minLon,minLat,maxLon,maxLat];
}

// =================== Limpieza / densificado ===================
function cleanClosePoints(points, minMeters=CLEAN_MIN_METERS){
  if(!points.length) return points;
  const out=[points[0]];
  for(let i=1;i<points.length;i++){
    if(distMeters(out[out.length-1], points[i]) >= minMeters) out.push(points[i]);
  }
  return out;
}
function splitOnGaps(points, maxGapMin=GAP_MINUTES, maxJumpM=GAP_JUMP_METERS){
  const groups=[]; let cur=[];
  for(let i=0;i<points.length;i++){
    const p=points[i];
    if(!cur.length){ cur.push(p); continue; }
    const prev=cur[cur.length-1];
    const dtMin=(new Date(p.timestamp)-new Date(prev.timestamp))/60000;
    const djump=distMeters(prev,p);
    if(dtMin>maxGapMin || djump>maxJumpM){ if(cur.length>1) groups.push(cur); cur=[p]; }
    else cur.push(p);
  }
  if(cur.length>1) groups.push(cur);
  return groups;
}
function densifySegment(points, step=DENSIFY_STEP){
  if(!points || points.length<2) return points;
  const out=[];
  for(let i=0;i<points.length-1;i++){
    const a=points[i], b=points[i+1];
    const d=distMeters(a,b);
    if(d<=step){ out.push(a); continue; }
    const n=Math.ceil(d/step);
    for(let k=0;k<n;k++){
      const t=k/n;
      out.push({ lat:a.lat+(b.lat-a.lat)*t, lng:a.lng+(b.lng-a.lng)*t, timestamp:a.timestamp, acc:a.acc });
    }
  }
  out.push(points[points.length-1]);
  return out;
}
function downsamplePoints(arr,maxN){
  if(!arr || arr.length<=maxN) return arr||[];
  const out=[]; const step=(arr.length-1)/(maxN-1);
  for(let i=0;i<maxN;i++){ out.push(arr[Math.round(i*step)]); }
  out[0]=arr[0]; out[out.length-1]=arr[arr.length-1];
  return out;
}
function adaptiveRadius(p){ const acc=(p&&p.acc!=null)?Number(p.acc):NaN; const base=isFinite(acc)?acc+5:25; return Math.max(10, Math.min(50, base)); }

// =================== GraphHopper ADAPTER ===================
// Map-Matching de un bloque (usa hosted GraphHopper)
async function mapMatchBlockSafe(seg){
  if (CONFIG.ROUTE_PROVIDER !== "graphhopper") return null;
  if (!seg || seg.length < 2) return null;

  // Prepara puntos con time (ms)
  const dense0 = densifySegment(seg, DENSIFY_STEP);
  const dense  = downsamplePoints(dense0, MAX_MATCH_INPUT);

  const body = {
    profile: "car",
    points_encoded: false,
    locale: "en",
    points: dense.map(p => ({ lat: p.lat, lon: p.lng, time: new Date(p.timestamp).getTime() }))
  };

  const url = `https://graphhopper.com/api/1/match?key=${encodeURIComponent(CONFIG.GRAPHHOPPER_KEY)}`;
  let r; try{ r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) }); } catch { return null; }
  if (!r.ok) return null;

  const j = await r.json().catch(()=>null);
  const coords = j?.paths?.[0]?.points?.coordinates;
  if (!coords || !coords.length) return null;
  return coords.map(([lon,lat]) => ({ lat, lng: lon }));
}

// Ruta entre dos puntos (para “puentes”)
async function directionsBetween(a,b){
  if (CONFIG.ROUTE_PROVIDER !== "graphhopper") return null;

  const params = new URLSearchParams({
    profile: "car",
    points_encoded: "false",
    locale: "en",
    point: `${a.lat},${a.lng}`,
    key: CONFIG.GRAPHHOPPER_KEY
  });
  params.append("point", `${b.lat},${b.lng}`);

  const url = `https://graphhopper.com/api/1/route?${params.toString()}`;
  let r; try{ r = await fetch(url); } catch { return null; }
  if (!r.ok) return null;

  const j = await r.json().catch(()=>null);
  const path = j?.paths?.[0];
  const coords = path?.points?.coordinates || [];
  const meters = path?.distance ?? 0;
  const secs   = path?.time ? path.time/1000 : 0;
  if (!coords.length || meters <= 0) return null;

  // Salvaguardas de velocidad/plausibilidad
  const dt = Math.max(1, (new Date(b.timestamp) - new Date(a.timestamp))/1000);
  const v_kmh_imp = (meters/1000) / (dt/3600);
  if (v_kmh_imp > MAX_BRIDGE_SPEED_KMH) return null;
  if (v_kmh_imp < MIN_BRIDGE_SPEED_KMH && dt < 300) return null;

  return coords.map(([lon,lat]) => ({ lat, lng: lon, timestamp: a.timestamp }));
}

// =================== Construcción de segmentos ===================
async function buildSegments(points){
  if(!points || points.length<2) return [];
  const cleaned = [points[0], ...cleanClosePoints(points.slice(1), CLEAN_MIN_METERS)];
  const rawSegs = splitOnGaps(cleaned, GAP_MINUTES, GAP_JUMP_METERS);

  const rendered=[];
  for(const seg of rawSegs){
    if(seg.length<2) continue;
    const blocks = chunk(seg, MAX_MM_POINTS);
    let current = [];
    for(const block of blocks){
      let finalBlock = densifySegment(block, DENSIFY_STEP);
      try{
        const mm = await mapMatchBlockSafe(block);
        if (mm && mm.length>=2) finalBlock = mm;
      }catch(_){}

      if (!current.length){
        current.push(...finalBlock);
      } else {
        const last=current[current.length-1], first=finalBlock[0];
        const gapM = distMeters(last, first);
        if (gapM > 5){
          let appended=false;
          if (gapM <= BRIDGE_MAX_METERS){
            const bridge = await directionsBetween(last, first);
            if (bridge?.length){ current.push(...bridge.slice(1)); appended=true; }
          }
          if (!appended){ if(current.length>1) rendered.push(current); current=[...finalBlock]; continue; }
        }
        current.push(...finalBlock.slice(1));
      }
      await sleep(60);
    }
    if(current.length>1) rendered.push(current);
  }
  return rendered;
}

// =================== Persistencia / dibujo ===================
function toLineStringFromSegments(segments){
  const coords=[];
  for(const seg of segments) for(const p of seg) coords.push([p.lng,p.lat]);
  return { type:"LineString", coordinates: coords };
}
function totalDistanceKmFromLngLat(coords){
  let d=0; for(let i=1;i<coords.length;i++){
    const a={lat:coords[i-1][1],lng:coords[i-1][0]};
    const b={lat:coords[i][1],  lng:coords[i][0]};
    d+=distMeters(a,b);
  }
  return d/1000;
}
async function upsertRutaBrigada(fechaISO, brig, line){
  try{
    const puntos = line.coordinates.length;
    const bbox   = bboxOfLngLatCoords(line.coordinates);
    const distKm = totalDistanceKmFromLngLat(line.coordinates);
    const { error } = await supa.rpc("upsert_ruta_brigada", {
      p_fecha: fechaISO, p_brigada: brig, p_line: line,
      p_puntos: puntos, p_dist_km: distKm, p_bbox: bbox
    });
    if (error) console.warn("upsert_ruta_brigada:", error);
  }catch(e){ console.warn(e); }
}

function drawLivePolyline(brig, segments){
  const latlngs = segments.flat().map(p=>[p.lat,p.lng]);
  const old = live.polylines.get(brig);
  if (old){ live.layer.removeLayer(old); live.polylines.delete(brig); }
  if (latlngs.length<2) return;
  const poly = L.polyline(latlngs, { weight:4, opacity:0.95 });
  poly.addTo(live.layer);
  live.polylines.set(brig, poly);
}

// =================== Fetch puntos ===================
async function fetchRecentPoints(brig, minutes=LIVE_WINDOW_MIN){
  const sinceIso = new Date(Date.now()-minutes*60000).toISOString();
  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("latitud,longitud,timestamp,timestamp_pe,acc,spd")
    .eq("brigada", brig)
    .gte("timestamp", sinceIso)
    .order("timestamp", { ascending:true });
  if (error || !data) return [];
  return data.map(r=>({
    lat:+r.latitud, lng:+r.longitud,
    timestamp: r.timestamp_pe || r.timestamp,
    acc:r.acc ?? null, spd:r.spd ?? null
  })).filter(p=>isFinite(p.lat)&&isFinite(p.lng)&&p.timestamp);
}
async function fetchTodayPoints(brig){
  const { ymd, ymdNext } = todayRangeLima();
  const { data, error } = await supa
    .from("ubicaciones_brigadas")
    .select("latitud,longitud,timestamp,timestamp_pe,acc,spd")
    .eq("brigada", brig)
    .gte("timestamp_pe", ymd)
    .lt("timestamp_pe", ymdNext)
    .order("timestamp_pe", { ascending:true });
  if (error || !data) return { ymd, points: [] };
  const points = data.map(r=>({
    lat:+r.latitud, lng:+r.longitud,
    timestamp: r.timestamp_pe || r.timestamp,
    acc:r.acc ?? null, spd:r.spd ?? null
  })).filter(p=>isFinite(p.lat)&&isFinite(p.lng)&&p.timestamp);
  return { ymd, points };
}

// =================== Guardado + vivo ===================
async function recomputeAndPersistDayRoute(brig){
  const { ymd, points } = await fetchTodayPoints(brig);
  if (points.length<2) return;
  const segs = await buildSegments(points);
  const line = toLineStringFromSegments(segs);
  await upsertRutaBrigada(ymd, brig, line);
  live.lastSavedAt.set(brig, Date.now());

  const recent = await fetchRecentPoints(brig, LIVE_WINDOW_MIN);
  const liveSegs = (recent.length>1) ? (await buildSegments(recent)) : segs;
  drawLivePolyline(brig, liveSegs);
}
function scheduleSave(brig, delay=SAVE_DEBOUNCE_MS){
  clearTimeout(live.debouncers.get(brig));
  const t = setTimeout(()=>recomputeAndPersistDayRoute(brig), delay);
  live.debouncers.set(brig, t);
}
function currentBrigadaFilter(){ return (ui.brigada.value||"").trim(); }
function triggerLiveUpdate(){ const brig=currentBrigadaFilter(); if (brig) scheduleSave(brig, 0); }

// =================== Movimiento de carro en vivo ===================
function buildPopup(r){
  const acc = Math.round(r.acc || 0);
  const spd = (r.spd || 0).toFixed(1);
  const ts  = new Date(r.timestamp).toLocaleString();
  return `<div><b>${r.tecnico || "Sin nombre"}</b><br>Brigada: ${r.brigada || "-"}<br>Acc: ${acc} m · Vel: ${spd} m/s<br>${ts}</div>`;
}
function focusOnUser(uid){
  const u = state.users.get(uid);
  if(!u || !u.marker) return;
  state.map.setView(u.marker.getLatLng(), 17, { animate:true });
  u.marker.openPopup();
}
function addOrUpdateUserInList(row){
  const uid=String(row.usuario_id||"0");
  let el=document.getElementById(`u-${uid}`);

  const mins=Math.round((Date.now()-new Date(row.timestamp))/60000);
  const brig=row.brigada||"-";
  const hora=new Date(row.timestamp).toLocaleTimeString();
  const ledColor = mins<=2? "#4ade80" : mins<=5? "#eab308" : "#777";
  const cls = mins<=2? "text-green" : mins<=5? "text-yellow" : "text-gray";

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
  if(!el){
    el=document.createElement("div"); el.id=`u-${uid}`; el.className=`brigada-item ${cls}`;
    el.innerHTML=html; el.onclick=()=>{ focusOnUser(uid); ui.brigada.value=brig; };
    ui.userList.appendChild(el);
  }else{
    el.className=`brigada-item ${cls} marker-pulse`;
    el.innerHTML=html; el.onclick=()=>{ focusOnUser(uid); ui.brigada.value=brig; };
    setTimeout(()=>el.classList.remove("marker-pulse"),600);
  }
}
function upsertOrMoveMarker(row){
  const uid=String(row.usuario_id||"0");
  const lat=Number(row.latitud), lng=Number(row.longitud);
  if(!isFinite(lat) || !isFinite(lng)) return;

  let u = state.users.get(uid);
  if(!u){
    const marker=L.marker([lat,lng],{icon:getIconFor(row)}).bindPopup(buildPopup(row));
    state.cluster.addLayer(marker);
    state.users.set(uid,{ marker, lastRow:row });
    addOrUpdateUserInList(row);
  }else{
    u.marker.setLatLng([lat,lng]);
    u.marker.setIcon(getIconFor(row));
    u.marker.setPopupContent(buildPopup(row));
    u.lastRow=row;
    state.users.set(uid,u);
    addOrUpdateUserInList(row);
  }
}

// =================== Inicialización mapa ===================
function initMap(){
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20});
  state.map = L.map("map",{center:[-12.0464,-77.0428],zoom:12,layers:[state.baseLayers.osm]});
  state.cluster = L.markerClusterGroup({ disableClusteringAtZoom:16 });
  state.map.addLayer(state.cluster);

  live.layer = L.layerGroup().addTo(state.map);

  ui.apply.onclick = () => { fetchInitial(true); triggerLiveUpdate(); };
  ui.exportKmz.onclick = () => exportKMZFromState();
}
initMap();

// =================== Carga inicial (24h) ===================
async function fetchInitial(clear){
  setStatus("Cargando…","gray");
  if (clear) ui.userList.innerHTML="";

  const {data, error} = await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now()-24*60*60*1000).toISOString())
    .order("timestamp", { ascending:false });

  if (error){ setStatus("Error","gray"); return; }

  const brigFilter=(ui.brigada.value||"").trim().toLowerCase();
  const grouped=new Map(); const perUser=100;

  for(const r of data){
    if (brigFilter && !(r.brigada||"").toLowerCase().includes(brigFilter)) continue;
    const uid=String(r.usuario_id||"0");
    if(!grouped.has(uid)) grouped.set(uid,[]);
    if(grouped.get(uid).length>=perUser) continue;
    grouped.get(uid).push(r);
  }

  state.pointsByUser.clear(); state.cluster.clearLayers(); state.users.clear();
  grouped.forEach((rows,uid)=>{
    const last=rows[0];
    const marker=L.marker([last.latitud,last.longitud],{icon:getIconFor(last)}).bindPopup(buildPopup(last));
    state.cluster.addLayer(marker);
    state.users.set(uid,{marker,lastRow:last});
    state.pointsByUser.set(uid,rows);
    addOrUpdateUserInList(last);
  });

  setStatus("Conectado","green");
}

// =================== Realtime ===================
supa.channel("realtime:ubicaciones_brigadas")
  .on("postgres_changes",{event:"INSERT",schema:"public",table:"ubicaciones_brigadas"}, (payload)=>{
    const row=payload.new;
    const brig=(row?.brigada||"").trim();
    const filter=(ui.brigada.value||"").trim().toLowerCase();

    // mover/crear marcador
    if(!filter || brig.toLowerCase().includes(filter)) upsertOrMoveMarker(row);

    // schedule guardado + vivo
    const last=live.lastSavedAt.get(brig)||0;
    const elapsed=Date.now()-last;
    const delay=(elapsed<10000)? 12000 : SAVE_DEBOUNCE_MS;
    scheduleSave(brig, delay);
  })
  .subscribe();

// =================== Exportar KMZ (desde la DB) ===================
async function exportKMZFromState(){
  try{
    setStatus("Generando KMZ…","gray"); if(ui?.exportKmz) ui.exportKmz.disabled=true;

    const brig=(ui.brigada.value||"").trim();
    if(!brig){ alert("Escribe la brigada exacta para exportar."); return; }

    const dateInput=document.getElementById("kmzDate");
    const chosen=(dateInput && dateInput.value) ? new Date(dateInput.value+"T00:00:00") : new Date();
    const ymd=toYMD(chosen);

    // 1) Leer trazo guardado
    let line=null;
    const { data:row } = await supa
      .from("rutas_brigadas_dia")
      .select("line_geojson")
      .eq("fecha", ymd).eq("brigada", brig).maybeSingle();
    line = row?.line_geojson;

    // 2) Si no hay, construir y guardar
    if(!line){
      const ymdNext = toYMD(new Date(chosen.getTime()+86400000));
      const { data, error } = await supa
        .from("ubicaciones_brigadas")
        .select("latitud,longitud,timestamp,timestamp_pe,acc,spd")
        .eq("brigada", brig)
        .gte("timestamp_pe", ymd).lt("timestamp_pe", ymdNext)
        .order("timestamp_pe",{ascending:true});
      if(error || !data || data.length<2){ alert(`Sin datos para ${brig} en ${ymd}`); return; }
      const points = data.map(r=>({ lat:+r.latitud, lng:+r.longitud, timestamp:r.timestamp_pe||r.timestamp, acc:r.acc??null }));
      const segs = await buildSegments(points);
      if(!segs.length){ alert("No se pudo generar el trazo."); return; }
      line = toLineStringFromSegments(segs);
      await upsertRutaBrigada(ymd, brig, line);
    }

    const coords=line.coordinates||[]; if(coords.length<2){ alert("Trazo insuficiente."); return; }
    let kml = `<?xml version="1.0" encoding="UTF-8"?>`+
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>`+
      `<name>${brig} - ${ymd}</name>`+
      `<Style id="s"><LineStyle><color>ffFF0000</color><width>4</width></LineStyle></Style>`+
      `<Placemark><name>${brig} (${ymd})</name><styleUrl>#s</styleUrl>`+
      `<LineString><tessellate>1</tessellate><coordinates>${
        coords.map(([lng,lat])=>`${lng},${lat},0`).join(" ")
      }</coordinates></LineString></Placemark>`+
      `</Document></kml>`;

    if (!window.JSZip){ await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"); }
    const zip = new JSZip(); zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({type:"blob",compression:"DEFLATE",compressionOptions:{level:1}});

    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob);
    const safeBrig=brig.replace(/[^a-zA-Z0-9_-]+/g,"_");
    a.download=`recorrido_${safeBrig}_${ymd}.kmz`;
    a.click(); URL.revokeObjectURL(a.href);

    alert(`✅ KMZ generado\nBrigada: ${brig}\nFecha: ${ymd}`);
  }catch(e){
    console.error(e);
    alert("❌ Error generando KMZ: "+e.message);
  }finally{
    setStatus("Conectado","green"); if(ui?.exportKmz) ui.exportKmz.disabled=false;
  }
}
