// ====== Supabase client ======
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ====== UI refs ======
const ui = {
  status:      document.getElementById('status'),
  brigada:     document.getElementById('brigadaFilter'),
  minAcc:      document.getElementById('minAcc'),
  lastN:       document.getElementById('lastN'),
  baseSel:     document.getElementById('baseMapSel'),
  showAcc:     document.getElementById('showAcc'),
  followSel:   document.getElementById('followSel'),
  snapRoads:   document.getElementById('snapRoads'), // NUEVO
  apply:       document.getElementById('applyFilters'),
  exportKmz:   document.getElementById('exportKmzBtn'),
  userList:    document.getElementById('userList')
};

// ====== Estado ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  pathLayer: null,
  users: new Map(),          // uid -> { marker, lastRow }
  pointsByUser: new Map(),   // uid -> [rows] (DESC por timestamp)
  selectedUid: null,
  userPaths: new Map(),      // uid -> { segments: L.Polyline[] }
};

// ====== Íconos por estado ======
const ICONS = {
  green : L.icon({ iconUrl: 'assets/carro-green.png',  iconSize:[40,24], iconAnchor:[20,12], popupAnchor:[0,-12] }),
  yellow: L.icon({ iconUrl: 'assets/carro-orange.png', iconSize:[40,24], iconAnchor:[20,12], popupAnchor:[0,-12] }),
  gray  : L.icon({ iconUrl: 'assets/carro-gray.png',   iconSize:[40,24], iconAnchor:[20,12], popupAnchor:[0,-12] }),
  base  : L.icon({ iconUrl: 'assets/carro.png',        iconSize:[40,24], iconAnchor:[20,12], popupAnchor:[0,-12] }),
};
function getIconFor(row){
  const st = computeStatus(row); // 'green'|'yellow'|'gray'
  return ICONS[st] || ICONS.base;
}

// Pre-carga
['assets/carro.png','assets/carro-green.png','assets/carro-orange.png','assets/carro-gray.png']
  .forEach(src => { const i = new Image(); i.src = src; });

// ====== Helpers base ======
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t){ return a + (b - a) * t; }
function easeInOutCubic(t){ return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }
function toRad(x){ return x*Math.PI/180; }
function toDeg(x){ return x*180/Math.PI; }
const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

// Distancia Haversine (m)
function distMeters(a, b){
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat/2), s2 = Math.sin(dLng/2);
  const aa = s1*s1 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*s2*s2;
  return 2 * R * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
}

// ====== Calidad / anti-ruido ======
let JITTER_M = 8;            // ignora saltos cortos
let MAX_SPEED_KMH = 160;     // descarta glitches
let GAP_MINUTES = 3;         // corta segmentos por gap

// Estancias y picos
let STAY_RADIUS_M = 20;      // radio para detectar “parado”
let STAY_MIN_MIN  = 2;       // duración mínima estancia
let ANGLE_SPIKE_DEG = 135;   // giro imposible (descartar punto central)

function speedKmh(a, b){
  const d = distMeters(a, b) / 1000; // km
  const dtH = Math.max((new Date(b.timestamp) - new Date(a.timestamp)) / 3600000, 1e-6);
  return d / dtH;
}
function bearing(a, b){
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1)*Math.cos(la2) - Math.sin(la1)*Math.sin(la2)*Math.cos(dLng);
  const brng = Math.atan2(y, x);
  return (toDeg(brng) + 360) % 360;
}
function angleBetween(a, b, c){
  let diff = Math.abs(bearing(b, c) - bearing(b, a));
  if (diff > 180) diff = 360 - diff;
  return diff;
}

// Colapsa estancias
function collapseStays(points){
  if (points.length === 0) return points;
  const out = [];
  let cluster = [points[0]];

  const commit = () => {
    if (!cluster.length) return;
    const tFirst = new Date(cluster[0].timestamp);
    const tLast  = new Date(cluster[cluster.length-1].timestamp);
    const durMin = (tLast - tFirst)/60000;
    let maxR = 0;
    const c0 = cluster[0];
    for (const p of cluster) maxR = Math.max(maxR, distMeters(c0, p));
    if (durMin >= STAY_MIN_MIN && maxR <= STAY_RADIUS_M){
      const lat = cluster.reduce((s,p)=>s+p.lat,0)/cluster.length;
      const lng = cluster.reduce((s,p)=>s+p.lng,0)/cluster.length;
      out.push({ lat, lng, timestamp: cluster[cluster.length-1].timestamp, __stay:true });
    } else {
      out.push(...cluster);
    }
    cluster = [];
  };

  for (let i=1; i<points.length; i++){
    const prev = points[i-1], p = points[i];
    const d = distMeters(prev, p);
    const dtMin = (new Date(p.timestamp)-new Date(prev.timestamp))/60000;
    if (d <= STAY_RADIUS_M && dtMin <= 5){
      if (cluster.length === 0) cluster.push(prev);
      cluster.push(p);
    } else {
      commit();
      out.push(p);
    }
  }
  commit();
  return out;
}

// Simplificación Douglas-Peucker (epsilon en metros)
function simplifyRDP(points, epsilonMeters = 5){
  if (points.length <= 2) return points;
  const eps = epsilonMeters / 111320; // aprox grados/metro
  const sq = x => x*x;
  const distToSeg = (p, a, b) => {
    const t = Math.max(0, Math.min(1, ((p.lat-a.lat)*(b.lat-a.lat)+(p.lng-a.lng)*(b.lng-a.lng)) / (sq(b.lat-a.lat)+sq(b.lng-a.lng) || 1)));
    const proj = { lat: a.lat + t*(b.lat-a.lat), lng: a.lng + t*(b.lng-a.lng) };
    const dLat = p.lat - proj.lat, dLng = p.lng - proj.lng;
    return Math.sqrt(dLat*dLat + dLng*dLng);
  };
  const dp = (pts, i, j, keep) => {
    let maxD = 0, idx = -1;
    for (let k=i+1; k<j; k++){
      const d = distToSeg(pts[k], pts[i], pts[j]);
      if (d > maxD){ maxD = d; idx = k; }
    }
    if (maxD > eps){
      keep.add(idx);
      dp(pts, i, idx, keep);
      dp(pts, idx, j, keep);
    }
  };
  const keep = new Set([0, points.length-1]);
  dp(points, 0, points.length-1, keep);
  return points.filter((_,i)=>keep.has(i));
}

// Construye segmentos limpios
function buildSegmentsFromRows(rows){
  if (!rows.length) return [];
  let pts = rows.map(r => ({ lat:r.latitud, lng:r.longitud, timestamp:r.timestamp }));
  pts = collapseStays(pts);

  if (pts.length > 2){
    const cleaned = [pts[0]];
    for (let i=1;i<pts.length-1;i++){
      const a = cleaned[cleaned.length-1], b = pts[i], c = pts[i+1];
      const ang = angleBetween(a,b,c);
      const dAB = distMeters(a,b), dBC = distMeters(b,c);
      const vAB = speedKmh(a,b), vBC = speedKmh(b,c);
      const smallMove = (dAB < 2*JITTER_M || dBC < 2*JITTER_M);
      if (ang >= ANGLE_SPIKE_DEG && smallMove && (vAB < MAX_SPEED_KMH && vBC < MAX_SPEED_KMH)) continue;
      cleaned.push(b);
    }
    cleaned.push(pts[pts.length-1]);
    pts = cleaned;
  }

  const segments = [];
  let cur = [];
  for (let i=0;i<pts.length;i++){
    const p = pts[i];
    const last = cur[cur.length-1];
    if (!last){ cur.push(p); continue; }

    const dtMin = (new Date(p.timestamp)-new Date(last.timestamp))/60000;
    const v = speedKmh(last, p);
    if (dtMin > GAP_MINUTES || v > MAX_SPEED_KMH){
      if (cur.length >= 2) segments.push(cur);
      cur = [p];
    } else {
      const d = distMeters(last, p);
      if (d >= JITTER_M) cur.push(p);
    }
  }
  if (cur.length >= 2) segments.push(cur);
  return segments.map(seg => simplifyRDP(seg, 5));
}

// ====== Ruteo / Snap a vías ======
async function routeBetween(a, b){
  const prov = (CONFIG.ROUTE_PROVIDER || 'none').toLowerCase();
  try{
    if (prov === 'mapbox' && CONFIG.MAPBOX_TOKEN){
      const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full&access_token=${encodeURIComponent(CONFIG.MAPBOX_TOKEN)}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('Mapbox error');
      const j = await resp.json();
      const coords = j.routes?.[0]?.geometry?.coordinates || [];
      return coords.map(([lng,lat]) => ({lat,lng}));
    }
  } catch(e){
    console.warn('routing failed, fallback line', e);
  }
  return [a,b]; // fallback recta
}

// Muestrea un segmento y lo “snapea” a vías
async function snapSegmentToRoad(seg, maxPairs=60, delayMs=120){
  if (seg.length < 2) return seg;
  const out = [];
  const step = Math.max(1, Math.ceil((seg.length-1)/maxPairs));
  for (let i=0; i<seg.length-1; i+=step){
    const a = seg[i];
    const b = seg[Math.min(i+step, seg.length-1)];
    const geom = await routeBetween(a, b);
    if (out.length && geom.length) geom.shift(); // evita duplicar
    out.push(...geom);
    await sleep(delayMs);
  }
  return out;
}

// ====== Animación de marcador ======
function animateMarker(marker, from, to){
  if (!from || !to) return marker.setLatLng(to || from);
  const d = distMeters({lat:from.lat,lng:from.lng},{lat:to.lat,lng:to.lng});
  const dur = clamp(d/80*1000, 200, 3000); // 80 m/s cap

  if (marker.__animFrame) cancelAnimationFrame(marker.__animFrame);
  if (marker._icon) marker._icon.classList.add('moving');

  const start = performance.now();
  const step = (now) => {
    const t = clamp((now - start) / dur, 0, 1);
    const k = easeInOutCubic(t);
    const cur = L.latLng(lerp(from.lat, to.lat, k), lerp(from.lng, to.lng, k));
    marker.setLatLng(cur);
    if (t < 1) marker.__animFrame = requestAnimationFrame(step);
    else {
      marker.__animFrame = null;
      if (marker._icon) marker._icon.classList.remove('moving');
    }
  };
  marker.__animFrame = requestAnimationFrame(step);
}

function smoothUpdateMarker(userObj, newRow){
  const marker = userObj.marker;
  const from = marker.getLatLng();
  const to = L.latLng(newRow.latitud, newRow.longitud);
  animateMarker(marker, from, to);
  marker.setPopupContent(buildPopup(newRow));
}

// ====== UI: popup y status ======
function buildPopup(r){
  const acc = Math.round(r.acc || 0);
  const spd = (r.spd || 0).toFixed(1);
  const ts = new Date(r.timestamp);
  const status = computeStatus(r);
  const badge =
    status === 'green'  ? '<span class="badge green">online</span>' :
    status === 'yellow' ? '<span class="badge yellow">inactivo</span>' :
                          '<span class="badge gray">offline</span>';

  return `
    <div>
      <div style="font-weight:600">${r.tecnico || '(sin nombre)'} ${badge}</div>
      <div>Brigada: ${r.brigada || '-'}</div>
      <div>Lat: ${Number(r.latitud).toFixed(6)} · Lon: ${Number(r.longitud).toFixed(6)}</div>
      <div>Acc: ${acc} m · Vel: ${spd} m/s</div>
      <div>${ts.toLocaleString()}</div>
    </div>
  `;
}
function computeStatus(r){
  const mins = Math.round((Date.now() - new Date(r.timestamp).getTime())/60000);
  if (mins <= 2) return 'green';
  if (mins <= 5) return 'yellow';
  return 'gray';
}
function setStatus(text, kind){
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || 'gray'}`;
}
function timeAgo(ts){
  const m = Math.round((Date.now() - new Date(ts).getTime())/60000);
  if (m < 1) return 'hace segundos';
  if (m === 1) return 'hace 1 min';
  return `hace ${m} min`;
}

// ====== Mapa ======
function initMap(){
  state.baseLayers.osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20 });
  state.baseLayers.sat = L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', { subdomains:['mt0','mt1','mt2','mt3'] });
  state.baseLayers.dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png');

  state.map = L.map('map', { center: [-12.0464, -77.0428], zoom: 12, layers:[state.baseLayers.osm] });
  state.cluster = L.markerClusterGroup({ disableClusteringAtZoom: 16 });
  state.pathLayer = L.layerGroup().addTo(state.map);
  state.map.addLayer(state.cluster);

  ui.baseSel.onchange = () => {
    Object.values(state.baseLayers).forEach(l => state.map.removeLayer(l));
    (state.baseLayers[ui.baseSel.value] || state.baseLayers.osm).addTo(state.map);
  };

  ui.apply.onclick = () => fetchInitial(true);
  ui.exportKmz.onclick = () => exportKMZFromState();
}
initMap();

// ====== Carga inicial ======
async function fetchInitial(clearList){
  setStatus('Cargando…', 'gray');
  if (clearList) ui.userList.innerHTML = '';

  // últimas 24h (DESC)
  const { data, error } = await supa
    .from('ubicaciones_brigadas')
    .select('*')
    .gte('timestamp', new Date(Date.now() - 24*60*60*1000).toISOString())
    .order('timestamp', { ascending: false });

  if (error){ setStatus('Error al cargar', 'gray'); console.error(error); return; }

  const brig = (ui.brigada.value || '').trim();
  const minAcc = parseFloat(ui.minAcc.value) || 0;
  const perUser = Math.max(1, Math.min(parseInt(ui.lastN.value || '100', 10), 1000));

  const grouped = new Map(); // uid -> rows
  for (const r of data){
    if (brig && (r.brigada || '').toLowerCase().indexOf(brig.toLowerCase()) === -1) continue;
    if ((r.acc || 0) < minAcc) continue;
    const uid = String(r.usuario_id || '0');
    if (!grouped.has(uid)) grouped.set(uid, []);
    if (grouped.get(uid).length >= perUser) continue;
    grouped.get(uid).push(r);
  }

  state.pointsByUser.clear();
  state.cluster.clearLayers();
  state.users.clear();
  state.selectedUid = null;
  state.userPaths.forEach(p => p.segments.forEach(pl => state.pathLayer.removeLayer(pl)));
  state.userPaths.clear();

  grouped.forEach((rows, uid) => {
    const last = rows[0]; // más reciente
    state.pointsByUser.set(uid, rows);

    const marker = L.marker([last.latitud, last.longitud], {
      icon: getIconFor(last),
      title: last.tecnico || `#${uid}`
    }).bindPopup(buildPopup(last));

    state.cluster.addLayer(marker);
    state.users.set(uid, { marker, lastRow: last });
    addUserItem(uid, last);

    drawUserPath(uid); // con snap opcional
  });

  setStatus('OK', 'green');
}

// ====== Lista lateral ======
function addUserItem(uid, row){
  const li = document.createElement('li');
  li.className = 'user-item';
  li.dataset.uid = uid;
  li.innerHTML = `
    <div class="title">
      <span class="dot ${computeStatus(row)}"></span>
      ${row.tecnico || '(sin nombre)'}
    </div>
    <div class="meta">Brig: ${row.brigada || '-'} · Lat: ${row.latitud?.toFixed(6)} · Lon: ${row.longitud?.toFixed(6)}<br/>
      Acc: ${Math.round(row.acc||0)} m · Vel: ${(row.spd||0).toFixed(1)} m/s<br/>${timeAgo(row.timestamp)}</div>
  `;
  li.onclick = () => {
    const u = state.users.get(uid);
    if (!u) return;
    if (ui.followSel && ui.followSel.checked){
      state.map.setView(u.marker.getLatLng(), Math.max(state.map.getZoom(), 16));
    } else {
      u.marker.openPopup();
    }
    state.selectedUid = uid;
  };
  ui.userList.appendChild(li);
}
function refreshUserListItem(uid, row){
  const card = ui.userList.querySelector(`[data-uid="${uid}"]`);
  if (!card) return;
  card.querySelector('.meta').innerHTML =
    `Brig: ${row.brigada || '-'} · Lat: ${row.latitud?.toFixed(6)} · Lon: ${row.longitud?.toFixed(6)}<br/>
     Acc: ${Math.round(row.acc||0)} m · Vel: ${(row.spd||0).toFixed(1)} m/s<br/>
     ${timeAgo(row.timestamp)}`;
}

// ====== Realtime ======
function subscribeRealtime(){
  supa.channel('ubicaciones_brigadas-changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ubicaciones_brigadas' }, (payload) => {
      onInsert(payload.new);
    })
    .subscribe((s) => { if (s === 'SUBSCRIBED') setStatus('Conectado', 'green'); });
}
function onInsert(row){
  const brig = (ui.brigada.value || '').trim();
  const minAcc = parseFloat(ui.minAcc.value) || 0;
  if (brig && (row.brigada || '').toLowerCase().indexOf(brig.toLowerCase()) === -1) return;
  if ((row.acc || 0) < minAcc) return;

  const uid = String(row.usuario_id || '0');
  if (!state.pointsByUser.has(uid)) state.pointsByUser.set(uid, []);
  const list = state.pointsByUser.get(uid);
  list.unshift(row); // DESC

  let u = state.users.get(uid);
  if (!u){
    const m = L.marker([row.latitud, row.longitud], {
      icon: getIconFor(row),
      title: row.tecnico || `#${uid}`
    }).bindPopup(buildPopup(row));
    state.cluster.addLayer(m);
    state.users.set(uid, { marker: m, lastRow: row });
    addUserItem(uid, row);
    drawUserPath(uid);
    return;
  }

  // anti-jitter + anti-glitch
  const prev = u.lastRow;
  const from = L.latLng(prev.latitud, prev.longitud);
  const to   = L.latLng(row.latitud, row.longitud);
  const d = distMeters({lat:from.lat,lng:from.lng},{lat:to.lat,lng:to.lng});
  const v = speedKmh({lat:from.lat,lng:from.lng,timestamp:prev.timestamp}, {lat:to.lat,lng:to.lng,timestamp:row.timestamp});

  if (d < JITTER_M || v > MAX_SPEED_KMH) {
    u.lastRow = row;
    u.marker.setPopupContent(buildPopup(row));
  } else {
    u.lastRow = row;
    smoothUpdateMarker(u, row);
    u.marker.setIcon(getIconFor(row));
    if (ui.followSel && ui.followSel.checked && state.selectedUid === uid){
      state.map.setView(u.marker.getLatLng(), Math.max(state.map.getZoom(), 16));
    }
  }
  refreshUserListItem(uid, row);
  drawUserPath(uid);
}

// ====== Dibujo del trazo (snap opcional) ======
async function drawUserPath(uid){
  const rowsDesc = state.pointsByUser.get(uid) || [];
  const rows = rowsDesc.slice().reverse(); // cronológico
  if (!rows.length) return;

  const segs = buildSegmentsFromRows(rows);

  const useSnap = ui.snapRoads?.checked && (CONFIG.ROUTE_PROVIDER || 'none') !== 'none';

  let renderedSegs = [];
  if (useSnap){
    for (const seg of segs){
      if (seg.length <= 40){ // solo segmentos cortos en vivo
        const snapped = await snapSegmentToRoad(seg, 40, 100);
        renderedSegs.push(snapped);
      } else {
        renderedSegs.push(seg);
      }
    }
  } else {
    renderedSegs = segs;
  }

  let entry = state.userPaths.get(uid);
  if (!entry){
    const polys = renderedSegs.map(seg => L.polyline(seg.map(s=>[s.lat,s.lng]), { weight: 3, opacity: 0.9, color: '#f2c200' }).addTo(state.pathLayer));
    state.userPaths.set(uid, { segments: polys });
  } else {
    entry.segments.forEach(pl => state.pathLayer.removeLayer(pl));
    entry.segments = renderedSegs.map(seg => L.polyline(seg.map(s=>[s.lat,s.lng]), { weight: 3, opacity: 0.9, color: '#f2c200' }).addTo(state.pathLayer));
  }
}

// ====== Limpieza de marcadores viejos ======
function pruneOldMarkers(){
  const now = Date.now();
  const lim = 5*60*1000; // 5 min
  state.users.forEach((u, uid) => {
    const diff = now - new Date(u.lastRow.timestamp).getTime();
    if (diff > lim){
      state.cluster.removeLayer(u.marker);
      state.users.delete(uid);
      const card = ui.userList.querySelector(`[data-uid="${uid}"]`);
      if (card) card.remove();
    }
  });
}
setInterval(pruneOldMarkers, 60*1000);

// ====== Exportar KMZ del día (mismo pipeline + snap si está activo) ======
async function exportKMZFromState(){
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0,0,0);
  const end   = new Date(today.getFullYear(), today.getMonth(), today.getDate()+1, 0,0,0);

  const brig = (ui.brigada.value || '').trim();
  const minAcc = parseFloat(ui.minAcc.value) || 0;

  const { data, error } = await supa
    .from('ubicaciones_brigadas')
    .select('*')
    .gte('timestamp', start.toISOString())
    .lt('timestamp', end.toISOString())
    .order('timestamp', { ascending: true });

  if (error){ console.error(error); alert('Error al consultar datos del día'); return; }

  // agrupar + filtros
  const byUser = new Map();
  for (const r of data){
    if (brig && (r.brigada || '').toLowerCase().indexOf(brig.toLowerCase()) === -1) continue;
    if ((r.acc || 0) < minAcc) continue;
    const uid = String(r.usuario_id || '0');
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(r);
  }

  const kmlHeader =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n` +
    `<name>Monitoreo GPS - Rutas ${start.toISOString().slice(0,10)}</name>\n`;
  const kmlFooter = `</Document>\n</kml>`;
  let kmlBody = '';

  const useSnap = ui.snapRoads?.checked && (CONFIG.ROUTE_PROVIDER || 'none') !== 'none';

  for (const [uid, rows] of byUser.entries()){
    if (!rows.length) continue;
    const name = (rows[0].tecnico || `Usuario ${uid}`).replace(/&/g,'&amp;').replace(/</g,'&lt;');
    const segs = buildSegmentsFromRows(rows);

    for (const seg of segs){
      const geom = useSnap ? await snapSegmentToRoad(seg, 100, 90) : seg;
      const coords = geom.map(s => `${s.lng},${s.lat},0`).join(' ');
      kmlBody += `
        <Placemark>
          <name>${name}</name>
          <Style><LineStyle><color>ff00c0ff</color><width>3</width></LineStyle></Style>
          <LineString><coordinates>${coords}</coordinates></LineString>
        </Placemark>
      `;
    }

    const last = rows[rows.length-1];
    kmlBody += `
      <Placemark>
        <name>${name} (último)</name>
        <Point><coordinates>${last.longitud},${last.latitud},0</coordinates></Point>
      </Placemark>
    `;
  }

  const kml = kmlHeader + kmlBody + kmlFooter;

  const zip = new JSZip();
  zip.file('doc.kml', kml);
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `monitoreo_${start.toISOString().slice(0,10)}.kmz`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ====== Boot ======
async function bootstrap(){
  await fetchInitial(true);
  subscribeRealtime();
  setStatus('Conectado', 'green');
}
bootstrap();
