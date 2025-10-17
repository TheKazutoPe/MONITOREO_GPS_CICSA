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
  pointsByUser: new Map(),   // uid -> [rows] (ordenados DESC por timestamp)
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

// Pre-carga para evitar parpadeo
['assets/carro.png','assets/carro-green.png','assets/carro-orange.png','assets/carro-gray.png']
  .forEach(src => { const i = new Image(); i.src = src; });

// ====== Helpers de animación y distancia ======
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t){ return a + (b - a) * t; }
function easeInOutCubic(t){ return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }

// Distancia Haversine aproximada (m)
function distMeters(a, b){
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat/2), s2 = Math.sin(dLng/2);
  const aa = s1*s1 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*s2*s2;
  return 2 * R * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
}

// ====== Anti-jitter / calidad ======
const JITTER_M = 8;          // ignora saltos < 8 m
const MAX_SPEED_KMH = 160;   // descarta puntos absurdos
const GAP_MINUTES = 3;       // si gap>3 min, no unir segmentos

function speedKmh(a, b){
  const d = distMeters(a, b) / 1000; // km
  const dtH = Math.max((new Date(b.timestamp) - new Date(a.timestamp)) / 3600000, 1e-6);
  return d / dtH;
}

// ====== Animación de marcador ======
function animateMarker(marker, from, to){
  if (!from || !to) return marker.setLatLng(to || from);
  const d = distMeters({lat:from.lat,lng:from.lng},{lat:to.lat,lng:to.lng});
  const dur = clamp(d/80*1000, 200, 3000); // 80 m/s = 288 km/h cap

  if (marker.__animFrame) cancelAnimationFrame(marker.__animFrame);
  if (marker._icon) marker._icon.classList.add('moving');

  const start = performance.now();
  const step = (now) => {
    const t = clamp((now - start) / dur, 0, 1);
    const k = easeInOutCubic(t);
    const cur = L.latLng(lerp(from.lat, to.lat, k), lerp(from.lng, to.lng, k));
    marker.setLatLng(cur);
    if (t < 1) {
      marker.__animFrame = requestAnimationFrame(step);
    } else {
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

// ====== UI: popup ======
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
    const l = state.baseLayers[ui.baseSel.value] || state.baseLayers.osm;
    l.addTo(state.map);
  };

  ui.apply.onclick = () => fetchInitial(true);
  ui.exportKmz.onclick = () => exportKMZFromState();
}
initMap();

// ====== Carga inicial ======
async function fetchInitial(clearList){
  setStatus('Cargando…', 'gray');
  if (clearList) ui.userList.innerHTML = '';

  // últimas 24h (descendente para quedarnos con los más recientes por usuario)
  const { data, error } = await supa
    .from('ubicaciones_brigadas')
    .select('*')
    .gte('timestamp', new Date(Date.now() - 24*60*60*1000).toISOString())
    .order('timestamp', { ascending: false });

  if (error){
    setStatus('Error al cargar', 'gray');
    console.error(error); return;
  }

  // Filtros UI
  const brig = (ui.brigada.value || '').trim();
  const minAcc = parseFloat(ui.minAcc.value) || 0;
  const perUser = Math.max(1, Math.min(parseInt(ui.lastN.value || '100', 10), 1000));

  // Agrupar por usuario y aplicar filtros / top N
  const grouped = new Map(); // uid -> rows
  for (const r of data){
    if (brig && (r.brigada || '').toLowerCase().indexOf(brig.toLowerCase()) === -1) continue;
    if ((r.acc || 0) < minAcc) continue;
    const uid = String(r.usuario_id || '0');
    if (!grouped.has(uid)) grouped.set(uid, []);
    if (grouped.get(uid).length >= perUser) continue;
    grouped.get(uid).push(r);
  }

  // mapear al estado y dibujar
  state.pointsByUser.clear();
  state.cluster.clearLayers();
  state.users.clear();
  state.selectedUid = null;
  state.userPaths.forEach(p => p.segments.forEach(pl => state.pathLayer.removeLayer(pl)));
  state.userPaths.clear();

  grouped.forEach((rows, uid) => {
    // tomar el más reciente (rows[0] porque vienen DESC)
    const last = rows[0];
    state.pointsByUser.set(uid, rows);

    const marker = L.marker([last.latitud, last.longitud], {
      icon: getIconFor(last),
      title: last.tecnico || `#${uid}`
    }).bindPopup(buildPopup(last));

    state.cluster.addLayer(marker);
    state.users.set(uid, { marker, lastRow: last });
    addUserItem(uid, last);

    // dibujar trazo inicial
    updateUserPath(uid);
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

function timeAgo(ts){
  const m = Math.round((Date.now() - new Date(ts).getTime())/60000);
  if (m < 1) return 'hace segundos';
  if (m === 1) return 'hace 1 min';
  return `hace ${m} min`;
}

// ====== Realtime ======
function subscribeRealtime(){
  const channel = supa.channel('ubicaciones_brigadas-changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ubicaciones_brigadas' }, (payload) => {
      onInsert(payload.new);
    })
    .subscribe((s) => {
      if (s === 'SUBSCRIBED') setStatus('Conectado', 'green');
    });
}

function onInsert(row){
  // Filtros UI vigentes
  const brig = (ui.brigada.value || '').trim();
  const minAcc = parseFloat(ui.minAcc.value) || 0;
  if (brig && (row.brigada || '').toLowerCase().indexOf(brig.toLowerCase()) === -1) return;
  if ((row.acc || 0) < minAcc) return;

  const uid = String(row.usuario_id || '0');
  if (!state.pointsByUser.has(uid)) state.pointsByUser.set(uid, []);
  const list = state.pointsByUser.get(uid);
  list.unshift(row); // mantenemos DESC (más recientes adelante)

  let u = state.users.get(uid);
  if (!u){
    const m = L.marker([row.latitud, row.longitud], {
      icon: getIconFor(row),
      title: row.tecnico || `#${uid}`
    }).bindPopup(buildPopup(row));
    state.cluster.addLayer(m);
    state.users.set(uid, { marker: m, lastRow: row });
    addUserItem(uid, row);
    updateUserPath(uid);
    return;
  }

  // --- anti-jitter + anti-glitch ---
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

  // actualizar trazo
  updateUserPath(uid);
}

// ====== Limpieza de marcadores viejos (ocultar offline) ======
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

// ====== Simplificación (Douglas-Peucker) ======
function simplifyRDP(points, epsilonMeters = 5){
  if (points.length <= 2) return points;
  const eps = epsilonMeters / 111320; // grados por metro (aprox)
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

// ====== Dibujo del trazo por usuario ======
function updateUserPath(uid){
  const rowsDesc = state.pointsByUser.get(uid) || [];
  const rows = rowsDesc.slice().reverse(); // cronológico

  if (!rows.length) return;

  // segmentación por gap y velocidad
  const segments = [];
  let cur = [];
  for (let i=0; i<rows.length; i++){
    const r = rows[i];
    const p = { lat: r.latitud, lng: r.longitud, timestamp: r.timestamp };
    const last = cur[cur.length-1];
    if (!last){ cur.push(p); continue; }

    const dtMin = (new Date(p.timestamp) - new Date(last.timestamp)) / 60000;
    const v = speedKmh(last, p);

    if (dtMin > GAP_MINUTES || v > MAX_SPEED_KMH){
      if (cur.length >= 2) segments.push(cur);
      cur = [p];
    } else {
      const d = distMeters(last, p);
      if (d >= JITTER_M) cur.push(p); // anti-jitter también en la línea
    }
  }
  if (cur.length >= 2) segments.push(cur);

  // simplificar
  const simplified = segments.map(seg => simplifyRDP(seg, 5).map(s => [s.lat, s.lng]));

  // pintar/actualizar
  let entry = state.userPaths.get(uid);
  if (!entry){
    const polys = simplified.map(coords => L.polyline(coords, { weight: 3, opacity: 0.9, color: '#2eaadc' }).addTo(state.pathLayer));
    state.userPaths.set(uid, { segments: polys });
  } else {
    entry.segments.forEach(pl => state.pathLayer.removeLayer(pl));
    entry.segments = simplified.map(coords => L.polyline(coords, { weight: 3, opacity: 0.9, color: '#2eaadc' }).addTo(state.pathLayer));
  }
}

// ====== Exportar KMZ del día completo ======
async function exportKMZFromState(){
  // rango del día local
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

  byUser.forEach((rows, uid) => {
    if (!rows.length) return;
    const name = (rows[0].tecnico || `Usuario ${uid}`).replace(/&/g,'&amp;').replace(/</g,'&lt;');

    // segmentar por gap/velocidad + anti-jitter
    const segs = [];
    let cur = [];
    for (let i=0;i<rows.length;i++){
      const r = rows[i];
      const p = { lat:r.latitud, lng:r.longitud, timestamp:r.timestamp };
      const prev = cur[cur.length-1];
      if (!prev){ cur.push(p); continue; }
      const dtMin = (new Date(p.timestamp)-new Date(prev.timestamp))/60000;
      const v = speedKmh(prev, p);
      if (dtMin > GAP_MINUTES || v > MAX_SPEED_KMH){
        if (cur.length>=2) segs.push(cur);
        cur = [p];
      } else {
        const d = distMeters(prev, p);
        if (d >= JITTER_M) cur.push(p);
      }
    }
    if (cur.length>=2) segs.push(cur);

    // simplificar y emitir cada segmento como LineString
    for (const seg of segs){
      const simp = simplifyRDP(seg, 5);
      const coords = simp.map(s => `${s.lng},${s.lat},0`).join(' ');
      kmlBody += `
        <Placemark>
          <name>${name}</name>
          <Style><LineStyle><color>ff2eaadc</color><width>3</width></LineStyle></Style>
          <LineString><coordinates>${coords}</coordinates></LineString>
        </Placemark>
      `;
    }
    // último punto del día
    const last = rows[rows.length-1];
    kmlBody += `
      <Placemark>
        <name>${name} (último)</name>
        <Point><coordinates>${last.longitud},${last.latitud},0</coordinates></Point>
      </Placemark>
    `;
  });

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

function setStatus(text, kind){
  ui.status.textContent = text;
  ui.status.className = `status-badge ${kind || 'gray'}`;
}

bootstrap();
