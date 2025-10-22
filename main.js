// main.js (integración Mapbox Directions + animación + KMZ con rutas "snap-to-road")
// Usa CONFIG desde tu config.js (asegúrate que contenga MAPBOX_TOKEN y SUPABASE_*). :contentReference[oaicite:1]{index=1}

// ====== Supabase client ======
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ====== UI refs ======
const ui = {
  status: document.getElementById('status'),
  brigada: document.getElementById('brigadaFilter'),
  minAcc: document.getElementById('minAcc'),
  baseSel: document.getElementById('baseMapSel'),
  apply: document.getElementById('applyFilters'),
  exportKmz: document.getElementById('exportKmzBtn'),
  userList: document.getElementById('userList'),
};

// ====== Estado ======
const state = {
  map: null,
  baseLayers: {},
  markers: new Map(),       // uid -> { marker, lastRow, color }
  paths: new Map(),         // uid -> [L.Polyline,...]
  brigadaColors: new Map(), // brigada -> color (HSL)
  routeCache: new Map(),    // cache key "lat1,lng1|lat2,lng2" -> [[lat,lng],...]
  lastMapboxCall: 0,       // timestamp for rate-limiting
  MAPBOX_DELAY_MS: 120,    // delay between mapbox calls
};

// ====== Helpers ======
function randColor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 75%, 55%)`;
}
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function lerp(a,b,t){ return a + (b-a)*t; }
function easeInOut(t){ return t<.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function minsAgo(ts){ return Math.round((Date.now() - new Date(ts).getTime())/60000); }
function fmtTimeAgo(ts){ const m = minsAgo(ts); if(m<1) return 'hace segundos'; if(m===1) return 'hace 1 min'; return `hace ${m} min`; }

// Haversine meters
function distMeters(a,b){
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI/180;
  const dLng = (b.lng - a.lng) * Math.PI/180;
  const la1 = a.lat * Math.PI/180;
  const la2 = b.lat * Math.PI/180;
  const s1 = Math.sin(dLat/2), s2 = Math.sin(dLng/2);
  const aa = s1*s1 + Math.cos(la1)*Math.cos(la2)*s2*s2;
  return 2 * R * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
}

// ====== Map init ======
function initMap(){
  state.baseLayers.osm  = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:20 });
  state.baseLayers.sat  = L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', { subdomains:['mt0','mt1','mt2','mt3'] });
  state.baseLayers.dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png');
  state.baseLayers.light= L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png');
  state.baseLayers.topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png');
  state.baseLayers.gray = L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/toner-lite/{z}/{x}/{y}.png');

  state.map = L.map('map', { center:[-12.0464,-77.0428], zoom:12, layers:[state.baseLayers.osm] });
  ui.baseSel.onchange = () => {
    Object.values(state.baseLayers).forEach(l=>state.map.removeLayer(l));
    (state.baseLayers[ui.baseSel.value] || state.baseLayers.osm).addTo(state.map);
  };
  ui.apply.onclick = ()=>fetchInitial(true);
  ui.exportKmz.onclick = ()=>exportKmzAll();
}
initMap();

// ====== Marker animation ======
function animateMarker(marker, from, to, spd){
  if(!from || !to) return marker.setLatLng(to||from);
  const d = distMeters(from,to);
  // convert spd (m/s) to duration heuristic: faster speed -> shorter duration
  const speed = (spd && spd > 0) ? spd : clamp(d/5, 1, 20); // fallback
  const dur = clamp((d / (speed || 5)) * 300, 250, 3500);
  const start = performance.now();
  if(marker.__anim) cancelAnimationFrame(marker.__anim);
  function step(now){
    const t = clamp((now-start)/dur, 0, 1);
    const k = easeInOut(t);
    marker.setLatLng(L.latLng(lerp(from.lat, to.lat, k), lerp(from.lng, to.lng, k)));
    if(t < 1) marker.__anim = requestAnimationFrame(step);
    else marker.__anim = null;
  }
  marker.__anim = requestAnimationFrame(step);
}

// ====== Popup / status ======
function buildPopup(r){
  return `
    <div style="font-weight:600">${r.tecnico || '(sin nombre)'}</div>
    <div>Brigada: ${r.brigada || '-'}</div>
    <div>Zona: ${r.zona || '-'}</div>
    <div>Vel: ${(r.spd||0).toFixed(1)} m/s · Acc: ${(r.acc||0).toFixed(1)} m</div>
    <div style="font-size:12px;opacity:.9">${new Date(r.timestamp).toLocaleString()}</div>
  `;
}
function computeStatus(r){
  const m = minsAgo(r.timestamp);
  if(m <= 2) return 'green';
  if(m <= 5) return 'yellow';
  return 'gray';
}
function setStatus(text, kind){ ui.status.textContent = text; ui.status.className = `status ${kind}`; }

// ====== Mapbox Directions helper (with caching & rate-limit) ======
async function getSnappedRoute(from, to){
  // from, to: {lat, lng}
  if(!CONFIG || !CONFIG.MAPBOX_TOKEN || CONFIG.MAPBOX_TOKEN.indexOf('pk.') !== 0){
    // no token -> fallback direct line
    return [[from.lat, from.lng], [to.lat, to.lng]];
  }
  const key = `${from.lat},${from.lng}|${to.lat},${to.lng}`;
  if(state.routeCache.has(key)) return state.routeCache.get(key);

  // enforce delay between Mapbox calls
  const elapsed = Date.now() - state.lastMapboxCall;
  if(elapsed < state.MAPBOX_DELAY_MS) await sleep(state.MAPBOX_DELAY_MS - elapsed);

  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?geometries=geojson&overview=full&steps=false&access_token=${encodeURIComponent(CONFIG.MAPBOX_TOKEN)}`;

  try {
    state.lastMapboxCall = Date.now();
    const resp = await fetch(url);
    if(!resp.ok) throw new Error(`Mapbox ${resp.status}`);
    const j = await resp.json();
    const routeCoords = (j.routes && j.routes[0] && j.routes[0].geometry && j.routes[0].geometry.coordinates) || null;
    if(routeCoords && routeCoords.length){
      // convert [lng,lat] -> [lat,lng]
      const out = routeCoords.map(([lng,lat]) => [lat, lng]);
      state.routeCache.set(key, out);
      // small pause to be gentler
      await sleep(30);
      return out;
    }
  } catch(e){
    console.warn('getSnappedRoute error', e);
  }
  // fallback
  const fallback = [[from.lat, from.lng], [to.lat, to.lng]];
  state.routeCache.set(key, fallback);
  return fallback;
}

// ====== Draw / update path functions ======
async function drawPathForUser(uid, rows, color){
  // rows: array of rows chronological (older->newer)
  // Clean existing
  const existing = state.paths.get(uid);
  if(existing) existing.forEach(p => state.map.removeLayer(p));
  const segments = [];

  if(rows.length < 2){
    // nothing to snap, draw single point as small polyline
    const p = L.polyline([[rows[0].latitud, rows[0].longitud]], { color, weight:4, opacity:0.9 }).addTo(state.map);
    state.paths.set(uid, [p]);
    return;
  }

  // iterate consecutive pairs, get snapped coords and create polylines
  for(let i=1;i<rows.length;i++){
    const a = rows[i-1], b = rows[i];
    const gapMin = (new Date(b.timestamp) - new Date(a.timestamp))/60000;
    const style = gapMin > 4
      ? { color, weight:3, opacity:0.6, dashArray:'6,6' }
      : { color, weight:4, opacity:0.95 };

    try {
      const from = { lat: a.latitud, lng: a.longitud }, to = { lat: b.latitud, lng: b.longitud };
      // for performance, skip snapping for extremely short segments
      const d = distMeters(from,to);
      const useSnap = d > 8; // only request Mapbox if >8m (tiny jitter avoid)
      const coords = useSnap ? await getSnappedRoute(from,to) : [[from.lat, from.lng],[to.lat,to.lng]];
      const poly = L.polyline(coords, style).addTo(state.map);
      segments.push(poly);
    } catch(err){
      console.warn('drawPathForUser fallback', err);
      const poly = L.polyline([[a.latitud,a.longitud],[b.latitud,b.longitud]], style).addTo(state.map);
      segments.push(poly);
    }
  }

  state.paths.set(uid, segments);
}

// Called on new incoming pair; appends one segment to existing path
async function appendSegment(uid, fromRow, toRow){
  const color = state.markers.get(uid)?.color || randColor(String(toRow.brigada||uid));
  const gapMin = (new Date(toRow.timestamp) - new Date(fromRow.timestamp))/60000;
  const style = gapMin > 4
    ? { color, weight:3, opacity:0.6, dashArray:'6,6' }
    : { color, weight:4, opacity:0.95 };

  try {
    const from = { lat: fromRow.latitud, lng: fromRow.longitud }, to = { lat: toRow.latitud, lng: toRow.longitud };
    const d = distMeters(from,to);
    const coords = (d > 8) ? await getSnappedRoute(from,to) : [[from.lat,from.lng],[to.lat,to.lng]];
    const poly = L.polyline(coords, style).addTo(state.map);
    const arr = state.paths.get(uid) || [];
    arr.push(poly);
    state.paths.set(uid, arr);
  } catch(e){
    console.warn('appendSegment error', e);
    const poly = L.polyline([[fromRow.latitud,fromRow.longitud],[toRow.latitud,toRow.longitud]], style).addTo(state.map);
    const arr = state.paths.get(uid) || [];
    arr.push(poly);
    state.paths.set(uid, arr);
  }
}

// ====== UI list helpers ======
function addUserItem(uid, row){
  const li = document.createElement('li');
  li.className = 'user-item';
  li.dataset.uid = uid;
  li.innerHTML = `
    <div class="title">
      <span class="dot ${computeStatus(row)}"></span>
      ${row.tecnico || '(sin nombre)'}
    </div>
    <div class="meta">Brig: ${row.brigada || '-'} · ${fmtTimeAgo(row.timestamp)}</div>
  `;
  li.onclick = () => {
    const u = state.markers.get(uid);
    if(u) state.map.setView(u.marker.getLatLng(), 15);
  };
  ui.userList.appendChild(li);
}
function refreshUserItem(uid, row){
  const card = ui.userList.querySelector(`[data-uid="${uid}"]`);
  if(!card) return;
  card.querySelector('.dot').className = `dot ${computeStatus(row)}`;
  card.querySelector('.meta').innerHTML = `Brig: ${row.brigada || '-'} · ${fmtTimeAgo(row.timestamp)}`;
}

// ====== Initial load ======
async function fetchInitial(clearList){
  setStatus('Cargando…','gray');
  if(clearList){
    ui.userList.innerHTML = '';
    state.markers.forEach(m => state.map.removeLayer(m.marker));
    state.markers.clear();
    state.paths.forEach(arr => arr.forEach(p => state.map.removeLayer(p)));
    state.paths.clear();
  }

  const { data, error } = await supa
    .from('ubicaciones_brigadas')
    .select('*')
    .gte('timestamp', new Date(Date.now() - 24*3600*1000).toISOString())
    .order('timestamp', { ascending: true }); // chronological

  if(error){ console.error(error); setStatus('Error', 'gray'); return; }

  const brigFilter = (ui.brigada.value || '').trim().toLowerCase();
  const minAcc = parseFloat(ui.minAcc.value) || 0;
  const byUser = new Map();

  // group chronologically
  for(const r of data){
    if(brigFilter && !((r.brigada||'').toLowerCase().includes(brigFilter))) continue;
    if((r.acc || 0) < minAcc) continue;
    const uid = String(r.usuario_id || 0);
    if(!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(r);
  }

  // create markers & paths
  for(const [uid, rows] of byUser.entries()){
    if(!rows.length) continue;
    const last = rows[rows.length-1]; // newest
    const brig = last.brigada || `Brig-${uid}`;
    const color = state.brigadaColors.get(brig) || randColor(brig);
    state.brigadaColors.set(brig, color);

    const icon = L.icon({ iconUrl: 'assets/carro-animado.png', iconSize:[42,26], iconAnchor:[21,13] });
    const marker = L.marker([last.latitud, last.longitud], { icon }).bindPopup(buildPopup(last)).addTo(state.map);

    state.markers.set(uid, { marker, lastRow: last, color });
    addUserItem(uid, last);

    // draw full path snapped (async)
    (async ()=> {
      await drawPathForUser(uid, rows, color);
    })();
  }

  setStatus('Conectado','green');
}

// ====== Realtime subscribe ======
function subscribeRealtime(){
  supa.channel('ubicaciones_brigadas-changes')
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'ubicaciones_brigadas' }, payload => {
      // call async handler (don't await inside event loop)
      handleInsert(payload.new).catch(e=>console.error(e));
    })
    .subscribe((s) => {
      if(s === 'SUBSCRIBED') setStatus('Conectado','green');
    });
}
subscribeRealtime();

// async handler for new rows
async function handleInsert(row){
  const brigFilter = (ui.brigada.value || '').trim().toLowerCase();
  const minAcc = parseFloat(ui.minAcc.value) || 0;
  if(brigFilter && !((row.brigada||'').toLowerCase().includes(brigFilter))) return;
  if((row.acc || 0) < minAcc) return;

  const uid = String(row.usuario_id || 0);
  const brig = row.brigada || `Brig-${uid}`;
  const color = state.brigadaColors.get(brig) || randColor(brig);
  state.brigadaColors.set(brig, color);

  let entry = state.markers.get(uid);
  if(!entry){
    const icon = L.icon({ iconUrl:'assets/carro-animado.png', iconSize:[42,26], iconAnchor:[21,13] });
    const marker = L.marker([row.latitud, row.longitud], { icon }).bindPopup(buildPopup(row)).addTo(state.map);
    state.markers.set(uid, { marker, lastRow: row, color });
    addUserItem(uid, row);
    // draw trivial path (single point) until more points arrive
    state.paths.set(uid, []);
    return;
  }

  const prev = entry.lastRow;
  const from = { lat: prev.latitud, lng: prev.longitud };
  const to   = { lat: row.latitud,  lng: row.longitud  };
  const gapMin = (new Date(row.timestamp) - new Date(prev.timestamp))/60000;

  // animate marker
  animateMarker(entry.marker, from, to, row.spd || 4);
  entry.marker.setPopupContent(buildPopup(row));
  entry.lastRow = row;
  entry.color = color;
  refreshUserItem(uid, row);

  // append snapped segment
  await appendSegment(uid, prev, row);
}

// ====== Export KMZ (snapped) ======
async function exportKmzAll(){
  try {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0,0,0);
    const end   = new Date(today.getFullYear(), today.getMonth(), today.getDate()+1, 0,0,0);

    const { data, error } = await supa
      .from('ubicaciones_brigadas')
      .select('*')
      .gte('timestamp', start.toISOString())
      .lt('timestamp', end.toISOString())
      .order('timestamp', { ascending: true });

    if(error){ console.error(error); alert('Error al consultar datos para KMZ'); return; }
    if(!data.length){ alert('No hay datos para exportar hoy'); return; }

    // group by user
    const byUser = new Map();
    for(const r of data){
      const uid = String(r.usuario_id || 0);
      if(!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid).push(r);
    }

    // Build KML
    let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n`;
    kml += `<name>Monitoreo_CICSA_${start.toISOString().slice(0,10)}</name>\n`;

    for(const [uid, rows] of byUser.entries()){
      if(!rows.length) continue;
      const name = (rows[rows.length-1].tecnico || `Usuario ${uid}`).replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const brig = rows[rows.length-1].brigada || `Brig-${uid}`;
      const colorHsl = state.brigadaColors.get(brig) || randColor(brig);

      // Convert HSL to KML ABGR hex (KML expects aabbggrr). We'll build hex rgb then invert order.
      const rgbHex = hslToHex(colorHsl); // returns "rrggbb"
      const kmlColorSolid = `ff${rgbHex.slice(4,6)}${rgbHex.slice(2,4)}${rgbHex.slice(0,2)}`; // aa bb gg rr
      const kmlColorFade  = `7d${rgbHex.slice(4,6)}${rgbHex.slice(2,4)}${rgbHex.slice(0,2)}`;

      kml += `<Folder><name>${brig} - ${name}</name>\n`;
      // for each consecutive pair build snapped coords and create Placemark
      for(let i=1;i<rows.length;i++){
        const a = rows[i-1], b = rows[i];
        const gapMin = (new Date(b.timestamp) - new Date(a.timestamp))/60000;
        const dash = gapMin > 4;
        const styleId = dash ? 'reconstruido' : 'normal';
        // add style block
        kml += `<Style id="${styleId}"><LineStyle><color>${dash? kmlColorFade : kmlColorSolid}</color><width>${dash?3:4}</width></LineStyle></Style>\n`;

        const from = { lat: a.latitud, lng: a.longitud }, to = { lat: b.latitud, lng: b.longitud };
        // attempt to snap (but fallback on direct coords)
        let coordsArr;
        try {
          const d = distMeters(from,to);
          coordsArr = (d > 8) ? await getSnappedRoute(from,to) : [[from.lat, from.lng],[to.lat,to.lng]];
        } catch(e){
          coordsArr = [[from.lat, from.lng],[to.lat,to.lng]];
        }
        const coordsStr = coordsArr.map(c => `${c[1]},${c[0]},0`).join(' ');
        kml += `<Placemark><styleUrl>#${styleId}</styleUrl><LineString><coordinates>${coordsStr}</coordinates></LineString></Placemark>\n`;
      }
      // last point marker
      const last = rows[rows.length-1];
      kml += `<Placemark><name>${name} (último)</name><Point><coordinates>${last.longitud},${last.latitud},0</coordinates></Point></Placemark>\n`;
      kml += `</Folder>\n`;
    }

    kml += `</Document></kml>`;

    const zip = new JSZip();
    zip.file('doc.kml', kml);
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `CICSA_Monitoreo_${start.toISOString().slice(0,10)}.kmz`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch(err){
    console.error('exportKmzAll error', err);
    alert('Error al generar KMZ');
  }
}

// convert CSS hsl string "hsl(H, S%, L%)" to "rrggbb"
function hslToHex(hslStr){
  // quick parser
  const m = hslStr.match(/hsl\((\d+),\s*([\d.]+)%,\s*([\d.]+)%\)/i);
  if(!m) return '00a6ff';
  const h = Number(m[1])/360, s = Number(m[2])/100, l = Number(m[3])/100;
  const hue2rgb = (p,q,t) => {
    if(t < 0) t += 1;
    if(t > 1) t -= 1;
    if(t < 1/6) return p + (q - p) * 6 * t;
    if(t < 1/2) return q;
    if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  let r,g,b;
  if(s === 0){ r=g=b=l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p,q,h + 1/3);
    g = hue2rgb(p,q,h);
    b = hue2rgb(p,q,h - 1/3);
  }
  const toHex = v => Math.round(v*255).toString(16).padStart(2,'0');
  return `${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// ====== Boot ======
fetchInitial(true);
setInterval(()=>fetchInitial(false), 5*60*1000);
