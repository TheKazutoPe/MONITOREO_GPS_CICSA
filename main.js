// --- Setup ---
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const ui = {
  brigada: document.getElementById('f_brigada'),
  acc: document.getElementById('f_acc'),
  limit: document.getElementById('f_limit'),
  base: document.getElementById('base_layer'),
  accuracy: document.getElementById('opt_accuracy'),
  follow: document.getElementById('opt_follow'),
  apply: document.getElementById('btn-apply'),
  export: document.getElementById('btn-export'),
  users: document.getElementById('users-list'),
  badge: document.getElementById('badge-conn'),
  theme: document.getElementById('btn-theme'),
  pbUser: document.getElementById('pb-user'),
  pbCount: document.getElementById('pb-count'),
  pbPlay: document.getElementById('pb-play'),
  pbClear: document.getElementById('pb-clear'),
};

const state = {
  users: new Map(),    // usuario_id -> { marker, circle, path, last, status }
  selectedUser: null,
  follow: false,
  accuracy: false,
  base: 'osm',
  lastFetchRows: [],
  cluster: null,
  pathLayer: L.layerGroup(),
  accuracyLayer: L.layerGroup(),
};

initTheme();
initMap();
wireEvents();
bootstrap();

async function bootstrap(){
  setBadge('Conectando…');
  await initialLoad();
  subscribeRealtime();
  setBadge('Conectado','success');
}

// --- Mapa ---
let map, baseLayers;

function initMap(){
  map = L.map('map',{ zoomControl:true, minZoom:4 }).setView([-12.046, -77.042], 12);

  baseLayers = {
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
      attribution:'© OpenStreetMap'
    }),
    esri: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{
      attribution:'Tiles © Esri'
    })
  };
  baseLayers.osm.addTo(map);

  state.cluster = L.markerClusterGroup({
    maxClusterRadius: 50,
    showCoverageOnHover:false,
    disableClusteringAtZoom: 17,
  });
  map.addLayer(state.cluster);
  state.pathLayer.addTo(map);
  state.accuracyLayer.addTo(map);
}

// --- UI events ---
function wireEvents(){
  ui.apply.onclick = () => initialLoad(true);
  ui.base.onchange = () => switchBase(ui.base.value);
  ui.accuracy.onchange = () => { state.accuracy = ui.accuracy.checked; refreshAccuracy(); };
  ui.follow.onchange = () => state.follow = ui.follow.checked;
  ui.export.onclick = () => exportView();
  ui.theme.onclick = toggleTheme;

  ui.pbPlay.onclick = () => playback();
  ui.pbClear.onclick = () => clearPlayback();
}

function switchBase(key){
  if (state.base === key) return;
  map.removeLayer(baseLayers[state.base]);
  state.base = key;
  baseLayers[state.base].addTo(map);
}

// --- Data load ---
async function initialLoad(fit=false){
  // limpia
  state.cluster.clearLayers();
  state.pathLayer.clearLayers();
  state.accuracyLayer.clearLayers();
  state.users.clear();
  ui.users.innerHTML = '';
  ui.pbUser.innerHTML = '';

  const cols = 'id,usuario_id,tecnico,brigada,contrata,zona,cargo,latitud,longitud,acc,spd,timestamp,timestamp_pe';
  let q = supa.from('ubicaciones_brigadas').select(cols);

  const minAcc = Number(ui.acc.value||0);
  const limitPerUser = Math.max(1, Number(ui.limit.value||100));
  const brig = (ui.brigada.value||'').trim();

  if (brig) q = q.ilike('brigada', `%${brig}%`);
  if (minAcc > 0) q = q.gte('acc', minAcc);

  // orden seguro (evita palabra reservada timestamp)
  q = q.order('id', { ascending:false }).limit(2000);

  const { data, error } = await q;
  if (error){ console.error(error); setBadge('Error al cargar','danger'); return; }
  state.lastFetchRows = data;

  // agrupa por usuario y toma los últimos N
  const grouped = new Map();
  for (const r of data){
    if (!grouped.has(r.usuario_id)) grouped.set(r.usuario_id, []);
    const arr = grouped.get(r.usuario_id);
    if (arr.length < limitPerUser) arr.push(r);
  }

  // dibuja
  for (const [uid, rows] of grouped){
    rows.sort((a,b)=>a.id-b.id);
    const last = rows[rows.length-1];
    paintUser(uid, rows, last);
    addUserItem(uid, last);
    addPbUserOption(uid, last);
  }

  if (fit) {
    try {
      map.fitBounds(state.cluster.getBounds(), { padding:[30,30] });
    } catch {}
  }
  refreshAccuracy();
}

function paintUser(uid, rows, last){
  const speed = Number(last.spd||0);
  const icon = L.icon({
    iconUrl:'assets/carro.png',
    iconSize: [28,18],
    className: speed>8 ? 'speed-fast' : (speed<1? 'speed-slow':'')
  });
  const m = L.marker([last.latitud,last.longitud],{icon, title: last.tecnico||('#'+uid)});
  m.on('click', ()=>selectUser(uid));

  state.cluster.addLayer(m);

  const coords = rows.map(r=>[r.latitud, r.longitud]);
  const path = L.polyline(coords, { color:'#2eaadc', weight:3, opacity:0.7 });
  state.pathLayer.addLayer(path);

  const entry = { marker:m, path, last, accuracyCircle:null, status:computeStatus(last) };
  state.users.set(uid, entry);
}

function computeStatus(row){
  const t = new Date(row.timestamp);
  const diffMin = (Date.now() - t.getTime())/60000;
  if (diffMin <= 1.5) return 'online';
  if (diffMin <= 10) return 'idle';
  return 'offline';
}

function addUserItem(uid, row){
  const li = document.createElement('div');
  li.className = 'user-item';
  li.onclick = ()=> selectUser(uid);

  const st = computeStatus(row);
  const badge = `<span class="badge ${st}">${st==='online'?'Online':st==='idle'?'Inactivo':'Offline'}</span>`;
  li.innerHTML = `
    <div class="user-head">
      <div>${row.tecnico||('#'+uid)}</div>
      ${badge}
    </div>
    <div class="user-meta">
      Brigada: ${row.brigada||'-'} · Lat: ${row.latitud.toFixed(5)} · Lon: ${row.longitud.toFixed(5)} ·
      Acc: ${Math.round(row.acc||0)} m · Vel: ${(row.spd||0).toFixed(1)} m/s ·
      ${timeAgo(row.timestamp)} (${row.timestamp_pe||''})
    </div>`;
  ui.users.appendChild(li);
}

function addPbUserOption(uid,row){
  const op = document.createElement('option');
  op.value = uid;
  op.textContent = `${row.tecnico||('#'+uid)} · ${row.brigada||''}`;
  ui.pbUser.appendChild(op);
}

// --- Selección, follow y precisión ---
function selectUser(uid){
  state.selectedUser = uid;
  const u = state.users.get(uid);
  if (!u) return;
  if (state.follow) map.setView(u.marker.getLatLng(), Math.max(map.getZoom(),16));
}

function refreshAccuracy(){
  state.accuracyLayer.clearLayers();
  if (!state.accuracy) return;
  for (const {last} of state.users.values()){
    if (!last || !last.acc) continue;
    const c = L.circle([last.latitud,last.longitud],{ radius: last.acc, color:'#aaa', fillOpacity:0.05 });
    state.accuracyLayer.addLayer(c);
  }
}

// --- Realtime ---
function subscribeRealtime(){
  supa.channel('realtime:ubicaciones')
    .on('postgres_changes',{event:'INSERT', schema:'public', table:'ubicaciones_brigadas'}, payload=>{
      const r = payload.new;
      const curr = state.users.get(r.usuario_id);
      if (curr){
        curr.last = r;
        curr.marker.setLatLng([r.latitud,r.longitud]);
        if (state.follow && state.selectedUser===r.usuario_id){
          map.setView([r.latitud,r.longitud]);
        }
      }else{
        // nuevo usuario, refresca lista sin perder subs
        initialLoad();
      }
    })
    .subscribe((status)=> {
      // opcional: status subscription
    });
}

// --- Export ---
function exportView(){
  const rows = state.lastFetchRows;
  if (!rows?.length) return;

  const asCSV = rows.map(r => ([
    r.id,r.usuario_id,`"${(r.tecnico||'').replace(/"/g,'""')}"`,
    r.brigada||'', r.contrata||'', r.zona||'', r.cargo||'',
    r.latitud, r.longitud, r.acc||0, r.spd||0, r.timestamp, r.timestamp_pe||''
  ].join(',')));

  asCSV.unshift('id,usuario_id,tecnico,brigada,contrata,zona,cargo,latitud,longitud,acc,spd,timestamp_utc,timestamp_pe');

  const blob = new Blob([asCSV.join('\n')],{type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'),{href:url,download:'monitoreo.csv'});
  a.click(); URL.revokeObjectURL(url);
}

// --- Playback simple ---
async function playback(){
  const uid = Number(ui.pbUser.value);
  const count = Math.max(10, Number(ui.pbCount.value||200));
  if (!uid) return;
  const { data, error } = await supa.from('ubicaciones_brigadas')
    .select('id,latitud,longitud,acc,spd,timestamp')
    .eq('usuario_id', uid)
    .order('id',{ascending:false})
    .limit(count);
  if (error || !data?.length) return;

  const pts = data.sort((a,b)=>a.id-b.id).map(d=>[d.latitud,d.longitud]);
  const pl = L.polyline(pts,{color:'#ff8c00',weight:4}).addTo(state.pathLayer);
  let i=0; const m = L.circleMarker(pts[0],{radius:6}).addTo(state.pathLayer);
  const timer = setInterval(()=>{
    if (i>=pts.length){ clearInterval(timer); return; }
    m.setLatLng(pts[i]); i++;
  }, 150);
}
function clearPlayback(){ state.pathLayer.clearLayers(); }

// --- Helpers ---
function timeAgo(ts){
  const d = new Date(ts); const m = Math.round((Date.now()-d.getTime())/60000);
  if (m<1) return 'hace segundos'; if (m===1) return 'hace 1 min'; return `hace ${m} min`;
}
function setBadge(text, kind){ ui.badge.textContent=text; ui.badge.className='badge'+(kind?(' '+kind):''); }

// Theme
function initTheme(){
  const saved = localStorage.getItem('theme')||'dark';
  if (saved==='light') document.documentElement.classList.add('light');
}
function toggleTheme(){
  const isLight = document.documentElement.classList.toggle('light');
  localStorage.setItem('theme', isLight?'light':'dark');
}
