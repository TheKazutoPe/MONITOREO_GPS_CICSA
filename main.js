// ====== Supabase client ======
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ====== UI refs ======
const ui = {
  status: document.getElementById('status'),
  brigada: document.getElementById('brigadaFilter'),
  minAcc: document.getElementById('minAcc'),
  lastN: document.getElementById('lastN'),
  baseSel: document.getElementById('baseMapSel'),
  showAcc: document.getElementById('showAcc'),
  followSel: document.getElementById('followSel'),
  apply: document.getElementById('applyFilters'),
  exportKmz: document.getElementById('exportKmzBtn'),
  userList: document.getElementById('userList')
};

// ====== Estado ======
const state = {
  map: null,
  baseLayers: {},
  cluster: null,
  pathLayer: null,
  users: new Map(),          // uid -> { marker, lastRow }
  pointsByUser: new Map(),   // uid -> [rows]
  selectedUid: null
};

// ====== Ícono de carro (más grande) ======
const carIcon = L.icon({
  iconUrl: 'assets/carro.png',
  iconSize: [40, 24],
  iconAnchor: [20, 12],
  popupAnchor: [0, -12]
});

// ====== Arranque ======
initMap();
bootstrap();

ui.apply.addEventListener('click', () => fetchInitial(true));
ui.baseSel.addEventListener('change', switchBase);
ui.exportKmz.addEventListener('click', exportKMZFromState);

// ====== Mapa y capas base ======
function initMap(){
  const m = L.map('map', {
    zoomControl: true,
    minZoom: 3,
    maxZoom: 19
  });

  // Callejero OSM
  const calle = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap'
  });

  // Esri Satélite
  const sat = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: '&copy; Esri' }
  );

  // Esri Topográfico
  const topo = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    { attribution: '&copy; Esri' }
  );

  state.baseLayers = { calle, sat, topo };

  calle.addTo(m);  // default
  m.setView([-12.046, -77.042], 13); // Lima centro aprox

  state.cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 40
  });
  m.addLayer(state.cluster);

  state.pathLayer = L.layerGroup().addTo(m);

  state.map = m;
}

function switchBase(){
  const v = ui.baseSel.value; // 'calle' | 'sat' | 'topo'
  Object.values(state.baseLayers).forEach(l => state.map.removeLayer(l));
  state.baseLayers[v].addTo(state.map);
}

// ====== Lógica de estado (online / inactivo / offline) ======
function minutesSince(ts){
  return (Date.now() - new Date(ts).getTime()) / 60000;
}
function computeStatus(row){
  const m = minutesSince(row.timestamp);
  if (m <= 2) return 'green';   // Online
  if (m <= 5) return 'yellow';  // Inactivo visible
  return 'gray';                // Offline (>5min)
}
function isVisible(row){
  return minutesSince(row.timestamp) <= 5;
}

// ====== Carga inicial ======
async function fetchInitial(centerToData = false){
  setStatus('Conectando…', 'gray');

  // limpiamos
  state.cluster.clearLayers();
  state.pathLayer.clearLayers();
  state.users.clear();
  state.pointsByUser.clear();
  ui.userList.innerHTML = '';

  // traemos últimas 24h (ajusta si quieres)
  const { data, error } = await supa
    .from('ubicaciones_brigadas')
    .select('*')
    .gte('timestamp', new Date(Date.now() - 24*60*60*1000).toISOString())
    .order('timestamp', { ascending: false });

  if (error){
    setStatus(`Error al cargar`, 'gray');
    console.error(error);
    return;
  }

  // filtros UI
  const brig = (ui.brigada.value || '').trim();
  const minAcc = parseFloat(ui.minAcc.value) || 0;
  const perUser = Math.max(1, Math.min(parseInt(ui.lastN.value || '100', 10), 1000));

  // agrupar por usuario y aplicar filtros / top N
  const grouped = new Map(); // uid -> rows
  for (const r of data){
    if (brig && (r.brigada || '').toLowerCase().indexOf(brig.toLowerCase()) === -1) continue;
    if ((r.acc || 0) < minAcc) continue;
    const uid = String(r.usuario_id || '0');
    if (!grouped.has(uid)) grouped.set(uid, []);
    if (grouped.get(uid).length >= perUser) continue;
    grouped.get(uid).push(r);
  }

  // pintar último punto por usuario (si visible)
  const bounds = [];
  grouped.forEach((rows, uid) => {
    const last = rows[0];
    if (!last || !isVisible(last)) return;

    const m = L.marker([last.latitud, last.longitud], { icon: carIcon, title: last.tecnico || `#${uid}` })
      .bindPopup(buildPopup(last));

    state.cluster.addLayer(m);
    state.users.set(uid, { marker: m, lastRow: last });
    state.pointsByUser.set(uid, rows);
    addUserItem(uid, last);

    bounds.push([last.latitud, last.longitud]);
  });

  if (bounds.length && centerToData){
    state.map.fitBounds(bounds, { padding: [30,30] });
  }

  setStatus('Conectado', 'green');
}

// ====== Popup HTML ======
function buildPopup(r){
  const st = computeStatus(r);
  const badge = `<span class="badge ${st}">${st==='green'?'Online':st==='yellow'?'Inactivo':'Offline'}</span>`;
  const when = new Date(r.timestamp).toLocaleString('es-PE', { hour12: true });

  return `
    <div>
      <div style="font-weight:600">${r.tecnico || '-'}</div>
      <div style="font-size:12px; color:#aab4bf">Brigada: ${r.brigada || '-'}</div>
      <div style="font-size:12px; margin-top:6px">Lat: ${r.latitud?.toFixed(6)} · Lon: ${r.longitud?.toFixed(6)}</div>
      <div style="font-size:12px">Acc: ${Math.round(r.acc||0)} m · Vel: ${(r.spd||0).toFixed(1)} m/s</div>
      <div style="font-size:12px; color:#aab4bf; margin-top:4px">${when}</div>
      <div style="margin-top:6px">${badge}</div>
    </div>
  `;
}

// ====== Lista de usuarios ======
function addUserItem(uid, row){
  const li = document.createElement('div');
  li.className = 'user';
  li.dataset.uid = uid;

  li.innerHTML = `
    <div class="name">${row.tecnico || ('#'+uid)}</div>
    <div class="meta">
      Brig: ${row.brigada || '-'} · Lat: ${row.latitud?.toFixed(6)} · Lon: ${row.longitud?.toFixed(6)}<br/>
      Acc: ${Math.round(row.acc||0)} m · Vel: ${(row.spd||0).toFixed(1)} m/s<br/>
      ${timeAgo(row.timestamp)}
    </div>
  `;

  li.onclick = () => {
    const u = state.users.get(uid);
    if (!u) return;
    if (ui.followSel.checked){
      state.map.setView(u.marker.getLatLng(), Math.max(state.map.getZoom(), 16));
    } else {
      u.marker.openPopup();
    }
    state.selectedUid = uid;
  };

  ui.userList.appendChild(li);
}

function timeAgo(ts){
  const m = Math.round((Date.now() - new Date(ts).getTime())/60000);
  if (m < 1) return 'hace segundos';
  if (m === 1) return 'hace 1 min';
  return `hace ${m} min`;
}

// ====== Realtime ======
function subscribeRealtime(){
  supa
    .channel('realtime:ubicaciones_brigadas')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ubicaciones_brigadas' }, payload => {
      onInsert(payload.new);
    })
    .subscribe();
}

function onInsert(row){
  // filtros activos
  const brig = (ui.brigada.value || '').trim();
  const minAcc = parseFloat(ui.minAcc.value) || 0;
  const perUser = Math.max(1, Math.min(parseInt(ui.lastN.value || '100', 10), 1000));
  if (brig && (row.brigada || '').toLowerCase().indexOf(brig.toLowerCase()) === -1) return;
  if ((row.acc || 0) < minAcc) return;

  const uid = String(row.usuario_id || '0');

  // actualizar buffer por usuario
  const rows = state.pointsByUser.get(uid) || [];
  rows.unshift(row);
  if (rows.length > perUser) rows.length = perUser;
  state.pointsByUser.set(uid, rows);

  // si lleva >5 min no mostrar (ni actualizar marker)
  if (!isVisible(row)) {
    pruneOldMarkers(); // por si estaba visible
    return;
  }

  // crear/actualizar marker
  let u = state.users.get(uid);
  if (!u){
    const m = L.marker([row.latitud, row.longitud], { icon: carIcon, title: row.tecnico || `#${uid}` })
      .bindPopup(buildPopup(row));
    state.cluster.addLayer(m);
    state.users.set(uid, { marker: m, lastRow: row });
    addUserItem(uid, row);
  } else {
    u.lastRow = row;
    u.marker.setLatLng([row.latitud, row.longitud]);
    u.marker.setPopupContent(buildPopup(row));
    // autoseguir
    if (ui.followSel.checked && state.selectedUid === uid){
      state.map.setView(u.marker.getLatLng(), Math.max(state.map.getZoom(), 16));
    }
    refreshUserListItem(uid, row);
  }

  pruneOldMarkers(); // limpieza oportunista
}

function refreshUserListItem(uid, row){
  const card = ui.userList.querySelector(`[data-uid="${uid}"]`);
  if (!card) return;
  card.querySelector('.meta').innerHTML =
    `Brig: ${row.brigada || '-'} · Lat: ${row.latitud?.toFixed(6)} · Lon: ${row.longitud?.toFixed(6)}<br/>
     Acc: ${Math.round(row.acc||0)} m · Vel: ${(row.spd||0).toFixed(1)} m/s<br/>
     ${timeAgo(row.timestamp)}`;
}

// ====== Limpieza periódica: ocultar >5 min ======
function pruneOldMarkers(){
  const now = Date.now();
  const lim = 5; // min

  // markers
  state.users.forEach((u, uid) => {
    const rows = state.pointsByUser.get(uid);
    const last = rows && rows[0];
    if (!last) return;

    const diff = (now - new Date(last.timestamp).getTime())/60000;
    if (diff > lim){
      state.cluster.removeLayer(u.marker);
      state.users.delete(uid);
      // (mantenemos pointsByUser para exportar si quieres histórico corto)
      // Opcional: quitarlo también de lista
      const card = ui.userList.querySelector(`[data-uid="${uid}"]`);
      if (card) card.remove();
    }
  });
}
setInterval(pruneOldMarkers, 60*1000);

// ====== Exportar KMZ (con trazo por usuario) ======
async function exportKMZFromState(){
  // KML
  const kmlHeader =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n` +
    `<name>Monitoreo GPS - Rutas</name>\n`;

  const kmlFooter = `</Document>\n</kml>`;

  let kmlBody = '';

  state.pointsByUser.forEach((rows, uid) => {
    if (!rows || rows.length === 0) return;

    // nombre
    const name = (rows[0].tecnico || `Usuario ${uid}`).replace(/&/g,'&amp;').replace(/</g,'&lt;');

    // LineString (lon,lat,alt0)
    const coords = rows.slice().reverse().map(r => `${r.longitud},${r.latitud},0`).join(' ');

    kmlBody += `
      <Placemark>
        <name>${name}</name>
        <Style>
          <LineStyle><color>ff2eaadc</color><width>3</width></LineStyle>
          <IconStyle><scale>1.1</scale></IconStyle>
        </Style>
        <LineString>
          <coordinates>${coords}</coordinates>
        </LineString>
      </Placemark>
    `;

    // último punto (icono)
    const last = rows[0];
    kmlBody += `
      <Placemark>
        <name>${name} (último)</name>
        <Point><coordinates>${last.longitud},${last.latitud},0</coordinates></Point>
      </Placemark>
    `;
  });

  const kml = kmlHeader + kmlBody + kmlFooter;

  // KMZ (zip con doc.kml)
  const zip = new JSZip();
  zip.file('doc.kml', kml);
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `monitoreo_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.kmz`;
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
