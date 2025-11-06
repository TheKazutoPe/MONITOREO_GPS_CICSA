// ============================== main.js (reemplazo completo) ==============================
// Requiere window.CONFIG y supabase ya cargados en index.html
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const MAPBOX_TOKEN = CONFIG.MAPBOX_TOKEN;

// ====== UI refs (IDs existentes en tu HTML) ======
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
  pointsByUser: new Map(), // uid -> [rows]
  cleanRouteLayer: null,   // dibujo del trazo limpio del día (opcional)
};

// ====== Live pipeline (buffer por brigada y timers) ======
const live = {
  bufferByBrigada: new Map(),
  timerByBrigada: new Map(),
  BATCH_INTERVAL_MS: 20000, // cada ~20s procesa el buffer
  MIN_POINTS: 4,
};

// ====== Parámetros de trazado / matching ======
const CLEAN_MIN_METERS      = 6;     // suaviza “dientes”
const DENSIFY_STEP          = 10;    // curvatura urbana más real
const MAX_MM_POINTS         = 40;    // tamaño de bloque para matching
const MAX_MATCH_INPUT       = 90;    // límite de puntos en la URL GET
const MAX_DIST_RATIO        = 0.35;  // tolerancia matching vs crudo
const ENDPOINT_TOL          = 25;    // tolerancia en puntas (m)
const CONFIDENCE_MIN        = 0.70;  // confianza mínima Mapbox (0..1)
const GAP_MINUTES           = 8;     // gap de tiempo → nuevo segmento
const GAP_JUMP_METERS       = 800;   // salto espacial brusco → nuevo segmento
const BRIDGE_MAX_METERS     = 800;   // tope para “puente” con Directions
const DIRECTIONS_HOP_METERS = 300;   // hops si el puente es largo
const MAX_BRIDGE_SPEED_KMH  = 70;    // >70 km/h → no unir
const MIN_BRIDGE_SPEED_KMH  = 3;     // <3 km/h en gap corto → ruido
const DIRECTIONS_PROFILE    = "driving";
const PER_BLOCK_DELAY       = 150;

// ====== Iconos (como tenías) ======
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
function setStatus(text, kind){ ui.status.textContent=text; ui.status.className=`status-badge ${kind||"gray"}`; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function toYMD(d){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), dd=String(d.getDate()).padStart(2,"0"); return `${y}-${m}-${dd}`; }
function distMeters(a,b){
  const R=6371000, dLat=((b.lat-a.lat)*Math.PI)/180, dLng=((b.lng-a.lng)*Math.PI)/180;
  const s1 = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return 2*R*Math.atan2(Math.sqrt(s1),Math.sqrt(1-s1));
}
function densifySegment(points, step=DENSIFY_STEP){
  if (!points || points.length<2) return points;
  const out=[];
  for (let i=0;i<points.length-1;i++){
    const a=points[i], b=points[i+1], d=distMeters(a,b);
    if (d<=step){ out.push(a); continue; }
    const n=Math.ceil(d/step);
    for (let k=0;k<n;k++){
      const t=k/n;
      out.push({ lat:a.lat+(b.lat-a.lat)*t, lng:a.lng+(b.lng-a.lng)*t, timestamp:a.timestamp, acc:a.acc });
    }
  }
  out.push(points.at(-1)); return out;
}
function downsamplePoints(arr,maxN){
  if (!arr || arr.length<=maxN) return arr||[];
  const out=[]; const step=(arr.length-1)/(maxN-1);
  for (let i=0;i<maxN;i++) out.push(arr[Math.round(i*step)]);
  out[0]=arr[0]; out[out.length-1]=arr[arr.length-1]; return out;
}
function cleanClosePoints(points,minMeters=CLEAN_MIN_METERS){
  if (!points.length) return points;
  const out=[points[0]];
  for (let i=1;i<points.length;i++){ if (distMeters(out.at(-1),points[i])>=minMeters) out.push(points[i]); }
  return out;
}
function splitOnGaps(points,maxGapMin=GAP_MINUTES,maxJumpM=GAP_JUMP_METERS){
  const groups=[]; let cur=[];
  for (const p of points){
    if (!cur.length){ cur.push(p); continue; }
    const prev=cur.at(-1);
    const dtMin=(new Date(p.timestamp)-new Date(prev.timestamp))/60000;
    const dj=distMeters(prev,p);
    if (dtMin>maxGapMin || dj>maxJumpM){ if (cur.length>1) groups.push(cur); cur=[p]; } else cur.push(p);
  }
  if (cur.length>1) groups.push(cur);
  return groups;
}
function adaptiveRadius(p){
  const acc=(p && p.acc!=null) ? Number(p.acc) : NaN;
  const base=isFinite(acc)?acc+5:25;
  return Math.max(10,Math.min(50,base));
}

// ====== Map Matching (Mapbox) ======
async function mapMatchBlockSafe(seg){
  if (!MAPBOX_TOKEN || !seg || seg.length<2 || seg.length>MAX_MM_POINTS) return null;
  const dense0=densifySegment(seg,DENSIFY_STEP);
  const dense=downsamplePoints(dense0,MAX_MATCH_INPUT);

  let rawDist=0; for(let i=0;i<dense.length-1;i++) rawDist+=distMeters(dense[i],dense[i+1]);

  const coords=dense.map(p=>`${p.lng},${p.lat}`).join(";");
  const tsArr=dense.map(p=>Math.floor(new Date(p.timestamp).getTime()/1000)).join(";");
  const radArr=dense.map(p=>adaptiveRadius(p)).join(";");

  const url=`https://api.mapbox.com/matching/v5/mapbox/driving/${coords}?geometries=geojson&overview=full&tidy=true&timestamps=${tsArr}&radiuses=${radArr}&access_token=${MAPBOX_TOKEN}`;
  let r; try{ r=await fetch(url,{method:"GET",mode:"cors"}); } catch(e){ console.warn("❌ Matching fetch error:",e); return null; }
  if (!r.ok){ const txt=await r.text().catch(()=> ""); console.warn("❌ Matching status:",r.status,txt.slice(0,200)); return null; }

  const j=await r.json().catch(()=> null);
  const m=j?.matchings?.[0];
  if (!m?.geometry?.coordinates || (typeof m.confidence==="number" && m.confidence<CONFIDENCE_MIN)){
    if (dense.length>24){
      const mid=Math.floor(dense.length/2);
      const left=await mapMatchBlockSafe(dense.slice(0,mid));
      const right=await mapMatchBlockSafe(dense.slice(mid-1));
      if (left && right) return left.concat(right.slice(1));
    }
    return null;
  }

  const matched=m.geometry.coordinates.map(([lng,lat])=>({lat,lng}));
  let mmDist=0; for(let i=0;i<matched.length-1;i++) mmDist+=distMeters(matched[i],matched[i+1]);
  if ((Math.abs(mmDist-rawDist)/Math.max(rawDist,1))>MAX_DIST_RATIO) return null;
  if (distMeters(dense[0],matched[0])>ENDPOINT_TOL) return null;
  if (distMeters(dense.at(-1),matched.at(-1))>ENDPOINT_TOL) return null;

  for (let i=0;i<matched.length;i++){
    matched[i].timestamp=dense[Math.min(i,dense.length-1)].timestamp;
    matched[i].acc=dense[Math.min(i,dense.length-1)].acc;
  }
  return matched;
}

// ====== Directions (puentes plausibles) ======
async function directionsBetween(a,b){
  if (!MAPBOX_TOKEN) return null;
  const direct=distMeters(a,b); if (direct>BRIDGE_MAX_METERS) return null;
  const url=`https://api.mapbox.com/directions/v5/mapbox/${DIRECTIONS_PROFILE}/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full&annotations=distance,duration&access_token=${MAPBOX_TOKEN}`;
  let r; try{ r=await fetch(url);}catch{ return null; }
  if (!r.ok) return null;

  const j=await r.json().catch(()=> null);
  const route=j?.routes?.[0];
  const coords=route?.geometry?.coordinates||[];
  const meters=route?.distance??0;
  if (!coords.length || meters<=0) return null;

  const first={lat:coords[0][1],lng:coords[0][0]};
  if (distMeters(a,first)>80) return null;

  const dt=Math.max(1,(new Date(b.timestamp)-new Date(a.timestamp))/1000);
  const v=(meters/1000)/(dt/3600);
  if (v>MAX_BRIDGE_SPEED_KMH) return null;
  if (v<MIN_BRIDGE_SPEED_KMH && dt<300) return null;

  return coords.map(([lng,lat])=>({lat,lng,timestamp:a.timestamp}));
}
async function smartBridge(a,b){
  const d=distMeters(a,b); if (d>BRIDGE_MAX_METERS) return null;
  if (d<=DIRECTIONS_HOP_METERS) return await directionsBetween(a,b);

  const hops=Math.ceil(d/DIRECTIONS_HOP_METERS);
  const out=[a]; let prev=a;
  for (let i=1;i<=hops;i++){
    const t=i/hops;
    const mid={ lat:a.lat+(b.lat-a.lat)*t, lng:a.lng+(b.lng-a.lng)*t,
      timestamp:new Date(new Date(a.timestamp).getTime()+(new Date(b.timestamp)-new Date(a.timestamp))*t).toISOString() };
    const seg=await directionsBetween(prev,mid); if (!seg) return null;
    out.push(...seg.slice(1));
    prev=mid; await sleep(60);
  }
  return out;
}

// ====== Insert SOLO tail nuevo en public.rutas_limpias ======
async function pushCleanChunkToRutasLimpias(brig, points){
  if (!points || points.length < 1) return;

  // 1) último punto guardado (para cortar duplicados)
  const { data: lastRows, error: lastErr } = await supa
    .from("rutas_limpias")
    .select("latitud,longitud,timestamp")
    .eq("brigada", brig)
    .order("timestamp", { ascending: false })
    .limit(1);

  let startIdx = 0;
  if (!lastErr && lastRows && lastRows[0]) {
    const last = { lat: Number(lastRows[0].latitud), lng: Number(lastRows[0].longitud) };
    for (let i = points.length - 1; i >= 0; i--) {
      if (distMeters(points[i], last) < 8) { startIdx = i + 1; break; }
    }
  }

  const tail = points.slice(startIdx);
  if (tail.length < 1) {
    console.debug("⏩ sin tail nuevo rutas_limpias", brig);
    return;
  }

  // 2) filas a insertar
  const rows = tail.map(p => ({
    brigada: brig,
    latitud: p.lat,
    longitud: p.lng,
    timestamp: new Date(p.timestamp || Date.now()).toISOString(),
    usuario_id: null,
    tecnico: null,
    fuente_id: null,
    procesado: true
  }));

  // 3) insert por lotes
  let inserted = 0;
  for (let i=0; i<rows.length; i+=1000){
    const chunk = rows.slice(i, i+1000);
    const { error } = await supa.from("rutas_limpias").insert(chunk);
    if (error) { console.error("❌ INSERT rutas_limpias:", error.message); return; }
    inserted += chunk.length;
  }
  console.log(`📤 rutas_limpias +${inserted} (brigada ${brig})`);
}

// ====== Procesar buffer: limpiar, segmentar, matching, guardar tail ======
async function processLiveBuffer(brig){
  try{
    const buf = live.bufferByBrigada.get(brig) || [];
    console.debug("🧹 procesa buffer", brig, buf.length);
    if (buf.length < live.MIN_POINTS) return;

    // limpiar y cortar por gaps
    const cleaned = cleanClosePoints(buf, CLEAN_MIN_METERS);
    if (cleaned.length < live.MIN_POINTS) return;
    const segments = splitOnGaps(cleaned, GAP_MINUTES, GAP_JUMP_METERS);
    const seg = segments.length ? segments.at(-1) : cleaned;
    if (!seg || seg.length < live.MIN_POINTS) return;

    // matching o fallback
    let matched = await mapMatchBlockSafe(seg);
    if (!matched || matched.length < 2) {
      console.warn("⚠️ Matching falló; usando densify fallback");
      matched = densifySegment(seg, DENSIFY_STEP);
    }
    console.debug("🧭 matched", brig, matched?.length||0);

    // guardar tail nuevo en rutas_limpias
    await pushCleanChunkToRutasLimpias(brig, matched);

  } catch(e){
    console.warn("processLiveBuffer error:", e?.message || e);
  } finally {
    live.timerByBrigada.delete(brig);
    // conserva historial corto para continuidad
    const buf2 = live.bufferByBrigada.get(brig) || [];
    live.bufferByBrigada.set(brig, buf2.slice(-30));
  }
}

// ====== Mapa / Lista (tu flujo base) ======
function buildPopup(r){
  const acc=Math.round(r.acc||0), spd=(r.spd||0).toFixed(1), ts=new Date(r.timestamp).toLocaleString();
  return `<div><b>${r.tecnico||"Sin nombre"}</b><br>Brigada: ${r.brigada||"-"}<br>Acc: ${acc} m · Vel: ${spd} m/s<br>${ts}</div>`;
}
function addOrUpdateUserInList(row){
  const uid=String(row.usuario_id||"0"); let el=document.getElementById(`u-${uid}`);
  const mins=Math.round((Date.now()-new Date(row.timestamp))/60000);
  const brig=row.brigada||"-"; const hora=new Date(row.timestamp).toLocaleTimeString();
  const ledColor = mins<=2 ? "#4ade80" : mins<=5 ? "#eab308" : "#777";
  const cls = mins<=2 ? "text-green" : mins<=5 ? "text-yellow" : "text-gray";
  const html = `
    <div class="brigada-header">
      <div style="display:flex;gap:6px;align-items:flex-start;">
        <div class="brigada-dot" style="background:${ledColor};"></div>
        <div class="brigada-info">
          <b class="brig-name">${row.tecnico||"Sin nombre"}</b>
          <div class="brigada-sub">${brig}</div>
        </div>
      </div>
      <div class="brigada-hora">${hora}</div>
    </div>`;
  if (!el){
    el=document.createElement("div"); el.id=`u-${uid}`; el.className=`brigada-item ${cls}`;
    el.innerHTML=html; el.onclick=()=>{ focusOnUser(uid); ui.brigada.value=brig; };
    ui.userList.appendChild(el);
  } else {
    el.className=`brigada-item ${cls} marker-pulse`; el.innerHTML=html;
    el.onclick=()=>{ focusOnUser(uid); ui.brigada.value=brig; };
    setTimeout(()=>el.classList.remove("marker-pulse"),600);
  }
}
function focusOnUser(uid){
  const u=state.users.get(uid); if (!u || !u.marker) return;
  state.map.setView(u.marker.getLatLng(),17,{animate:true}); u.marker.openPopup();
}

async function fetchInitial(clear){
  setStatus("Cargando…","gray");
  if (clear) ui.userList.innerHTML="";

  const {data,error}=await supa
    .from("ubicaciones_brigadas")
    .select("*")
    .gte("timestamp", new Date(Date.now()-24*60*60*1000).toISOString())
    .order("timestamp",{ascending:false});

  if (error){ console.error("❌ fetch ubicaciones:",error.message); setStatus("Error","gray"); return; }

  const brigFilter=(ui.brigada.value||"").trim().toLowerCase();
  const grouped=new Map(); const perUser=100;

  for (const r of data){
    if (brigFilter && !(r.brigada||"").toLowerCase().includes(brigFilter)) continue;
    const uid=String(r.usuario_id||"0");
    if (!grouped.has(uid)) grouped.set(uid,[]);
    if (grouped.get(uid).length >= perUser) continue;
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

function initMap(){
  state.baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20});
  state.map = L.map("map",{center:[-12.0464,-77.0428],zoom:12,layers:[state.baseLayers.osm]});
  state.cluster = L.markerClusterGroup({disableClusteringAtZoom:16});
  state.map.addLayer(state.cluster);

  ui.apply.onclick = async () => {
    await fetchInitial(true);
    // opcional: si quieres pintar el trazo limpio del día desde rutas_limpias:
    const brig=(ui.brigada.value||"").trim();
    if (brig){ await paintCleanRouteFromRutasLimpias(brig); }
  };

  // Exportar KMZ del día desde rutas_limpias
  ui.exportKmz.onclick = () => exportKMZFromRutasLimpias();

  // Realtime → buffer por brigada → procesador cada 20s
  if (CONFIG.SEND_CLEAN_TO_SUPABASE) {
    const chan = supa
      .channel("rt-ubicaciones-send-clean")
      .on("postgres_changes",
        { event:"INSERT", schema:"public", table:"ubicaciones_brigadas" },
        async (payload)=>{
          try{
            const r=payload?.new;
            const brig=r?.brigada;
            console.log("📥 INSERT ubicaciones_brigadas", brig, r?.timestamp_pe||r?.timestamp, r?.latitud, r?.longitud);
            if (!brig || !isFinite(r?.latitud) || !isFinite(r?.longitud)) return;

            const p={ lat:+r.latitud, lng:+r.longitud,
              timestamp: r.timestamp_pe || r.timestamp || new Date().toISOString(),
              acc: r.acc ?? null, spd: r.spd ?? null };

            const buf=live.bufferByBrigada.get(brig)||[];
            buf.push(p);
            live.bufferByBrigada.set(brig, buf);

            if (!live.timerByBrigada.has(brig)) {
              const t=setTimeout(()=>processLiveBuffer(brig), live.BATCH_INTERVAL_MS);
              live.timerByBrigada.set(brig, t);
            }
          }catch(e){ console.warn("Realtime handler error:", e?.message||e); }
        }
      )
      .subscribe((status)=> console.log("🔌 Realtime status:", status));

    window.addEventListener("beforeunload", ()=>{ try{ supa.removeChannel(chan); }catch(_){} });
  }
}
initMap();

// ====== Pintar trazo limpio del día desde rutas_limpias (opcional) ======
async function paintCleanRouteFromRutasLimpias(brig){
  try{
    if (state.cleanRouteLayer){ state.map.removeLayer(state.cleanRouteLayer); state.cleanRouteLayer=null; }

    const dateInput=document.getElementById("kmzDate");
    const day=(dateInput && dateInput.value)? new Date(dateInput.value+"T00:00:00"): new Date();
    const ymd=toYMD(day);
    const ymdNext=toYMD(new Date(day.getTime()+24*60*60*1000));

    const { data, error } = await supa
      .from("rutas_limpias")
      .select("latitud,longitud,timestamp")
      .eq("brigada", brig)
      .gte("timestamp", ymd)
      .lt("timestamp", ymdNext)
      .order("timestamp", { ascending: true });

    if (error || !data || data.length<2) return;

    const latlngs = data.map(p => [p.latitud, p.longitud]);
    state.cleanRouteLayer = L.polyline(latlngs, { weight: 4, opacity: 0.9 }).addTo(state.map);
    try { state.map.fitBounds(state.cleanRouteLayer.getBounds(), { padding: [20,20] }); } catch(_){}
  } catch(_) {}
}

// ====== Exportar KMZ del día desde rutas_limpias ======
async function exportKMZFromRutasLimpias(){
  let prev=false;
  try{
    setStatus("Generando KMZ…","gray");
    if (ui?.exportKmz){ prev=ui.exportKmz.disabled; ui.exportKmz.disabled=true; }

    const brig=(ui.brigada.value||"").trim();
    if (!brig){ alert("Escribe la brigada EXACTA para exportar su KMZ."); return; }

    const dateInput=document.getElementById("kmzDate");
    const day=(dateInput && dateInput.value)? new Date(dateInput.value+"T00:00:00"): new Date();
    const ymd=toYMD(day);
    const ymdNext=toYMD(new Date(day.getTime()+24*60*60*1000));

    const { data, error } = await supa
      .from("rutas_limpias")
      .select("latitud,longitud,timestamp")
      .eq("brigada", brig)
      .gte("timestamp", ymd)
      .lt("timestamp", ymdNext)
      .order("timestamp", { ascending: true });

    if (error) throw new Error(error.message);
    if (!data || data.length < 2){
      alert(`⚠️ No hay trazo limpio para "${brig}" en ${ymd}.`);
      return;
    }

    const coordsStr = data.map(p => `${p.longitud},${p.latitud},0`).join(" ");

    let kml = `<?xml version="1.0" encoding="UTF-8"?>` +
              `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
              `<name>${brig} - ${ymd}</name>` +
              `<Style id="routeStyle"><LineStyle><color>ffFF0000</color><width>4</width></LineStyle></Style>` +
              `<Placemark><name>${brig} (${ymd})</name><styleUrl>#routeStyle</styleUrl>` +
              `<LineString><tessellate>1</tessellate><coordinates>${coordsStr}</coordinates></LineString>` +
              `</Placemark></Document></kml>`;

    if (!window.JSZip) {
      try { await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"); } catch{}
    }
    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({type:"blob",compression:"DEFLATE",compressionOptions:{level:1}});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `recorrido_${brig.replace(/[^a-zA-Z0-9_-]+/g,"_")}_${ymd}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);

    alert(`✅ KMZ listo: ${brig} (${ymd})`);
  } catch(e){
    console.error(e);
    alert("❌ No se pudo generar el KMZ: " + e.message);
  } finally {
    setStatus("Conectado","green");
    if (ui?.exportKmz) ui.exportKmz.disabled=prev;
  }
}

// ====== Arranque ======
setStatus("Cargando...","gray");
(async()=>{ await fetchInitial(true); })();
