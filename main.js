// main.js (reemplazo completo)
const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ---------- UI refs ----------
const ui = {
  brigada: document.getElementById('brigadaFilter'),
  minAcc: document.getElementById('minAcc'),
  tailPoints: document.getElementById('tailPoints'),
  apply: document.getElementById('applyFilters'),
  userList: document.getElementById('userList'),
  status: document.getElementById('netStatus'),
  lastRefresh: document.getElementById('lastRefresh'),
  baseMap: document.getElementById('baseMap'),
  showAcc: document.getElementById('showAcc'),
  follow: document.getElementById('followSel'),
  playCount: document.getElementById('playCount'),
  playBtn: document.getElementById('playBtn'),
  clearBtn: document.getElementById('clearBtn'),
};

// ---------- Estado global ----------
let map; // <<--- una sola vez, global
const state = {
  cluster: null,
  pathLayer: null,
  users: new Map(), // uid -> { marker, path, last }
  selectedUid: null
};

// ---------- Iconos ----------
const carIcon = (z) =>
  L.icon({
    iconUrl: 'assets/carro.png',
    iconSize: [28, 18],
    className: 'speed' // usa clases para color por velocidad
  });

// ---------- Util ----------
function setStatus(text, kind = 'info') {
  ui.status.textContent = text;
  ui.status.className = `dot ${kind}`;
}
function timeAgo(date) {
  const m = Math.round((Date.now() - new Date(date).getTime()) / 60000);
  if (m < 1) return 'hace segundos';
  if (m === 1) return 'hace 1 min';
  return `hace ${m} min`;
}
function computeStatus(row) {
  const diffMin = (Date.now() - new Date(row.timestamp_pe).getTime()) / 60000;
  if (diffMin <= 10) return 'online';
  if (diffMin <= 60) return 'idle';
  return 'offline';
}

// ---------- Mapa ----------
function buildBaseLayer(kind) {
  switch (kind) {
    case 'sat':
      return L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
      });
    case 'terrain':
      return L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenTopoMap'
      });
    default: // callejero
      return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
      });
  }
}

function initMap() {
  // IMPORTANTE: usar la global, no redeclarar
  map = L.map('map', {
    zoomControl: true,
    minZoom: 3
  }).setView([-12.046, -77.042], 12);

  // capa base + grupos
  const base = buildBaseLayer(ui.baseMap.value || 'street');
  base.addTo(map);

  state.cluster = L.markerClusterGroup({
    maxClusterRadius: 50,
    showCoverageOnHover: false,
    disableClusteringAtZoom: 16
  });
  state.pathLayer = L.layerGroup();

  state.cluster.addTo(map);
  state.pathLayer.addTo(map);

  // Cambiar mapa base desde el selector
  ui.baseMap.addEventListener('change', () => {
    map.eachLayer(l => map.removeLayer(l));
    buildBaseLayer(ui.baseMap.value).addTo(map);
    state.cluster.addTo(map);
    state.pathLayer.addTo(map);
  });
}

// ---------- Carga inicial ----------
async function initialLoad(fit = false) {
  // limpiar capas y UI
  state.pathLayer.clearLayers();
  state.cluster.clearLayers();
  ui.userList.innerHTML = '';

  const brigada = ui.brigada.value.trim();
  const minAcc = Number(ui.minAcc.value || 0);
  const limitPerUser = Math.max(1, Number(ui.tailPoints.value || 100));

  // query: tomamos los últimos N por usuario (ventana por usuario + orden)
  const q = supa
    .from('ubicaciones_brigadas')
    .select('id,usuario_id,tecnico,brigada,latitud,longitud,acc,spd,timestamp_pe,timestamp', { count: 'exact' })
    .gte('acc', minAcc)
    .order('usuario_id', { ascending: true })
    .order('timestamp', { ascending: false });

  if (brigada) q.ilike('brigada', `%${brigada}%`);

  const { data, error } = await q;
  if (error) {
    console.error(error);
    setStatus('Error consultando datos', 'error');
    return;
  }

  // agrupar por usuario y tomar los últimos N
  const grouped = new Map();
  for (const r of data) {
    const g = grouped.get(r.usuario_id) || [];
    if (g.length < limitPerUser) g.push(r);
    grouped.set(r.usuario_id, g);
  }

  // pintar por usuario
  const bounds = [];
  grouped.forEach((rows, uid) => {
    rows.sort((a, b) => a.id - b.id); // asc por id (antiguo -> reciente)
    const last = rows[rows.length - 1];

    // elemento en la lista
    addUserItem(uid, last);

    // marker
    const m = L.marker([last.latitud, last.longitud], { icon: carIcon(map.getZoom()) })
      .bindTooltip(`${last.tecnico || ('#' + uid)}`, { direction: 'top' });

    // polyline
    const coords = rows.map(r => [r.latitud, r.longitud]);
    const p = L.polyline(coords, { color: '#2eaadc', weight: 3, opacity: 0.7 });

    state.cluster.addLayer(m);
    state.pathLayer.addLayer(p);

    state.users.set(uid, { marker: m, path: p, last: last });
    bounds.push([last.latitud, last.longitud]);
  });

  if (fit && bounds.length) {
    map.fitBounds(L.latLngBounds(bounds), { padding: [30, 30] });
  }

  ui.lastRefresh.textContent = `${timeAgo(new Date())}`;
  setStatus('Conectado', 'ok');
}

// ---------- Lista de usuarios ----------
function addUserItem(uid, r) {
  const li = document.createElement('li');
  const kind = computeStatus(r);
  const label =
    kind === 'online' ? 'Online' :
    kind === 'idle' ? 'Inactivo' : 'Offline';

  li.innerHTML = `
${r.tecnico || ('#' + uid)}
Brigada: ${r.brigada || ''} · Lat: ${r.latitud.toFixed(5)} · Lon: ${r.longitud.toFixed(5)}
Acc: ${Math.round(r.acc || 0)} m · Vel: ${(r.spd || 0).toFixed(1)} m/s
${timeAgo(r.timestamp)} · ${r.timestamp_pe ? '🕒 ' + r.timestamp_pe : ''}
${label}
  `;

  li.style.cursor = 'pointer';
  li.onclick = () => {
    state.selectedUid = uid;
    const u = state.users.get(uid);
    if (u) {
      map.setView(u.marker.getLatLng(), Math.max(map.getZoom(), 16));
      if (ui.follow.checked) {
        // al seguir seleccionado, centramos cada vez que llegue punto nuevo
      }
    }
  };

  ui.userList.appendChild(li);
}

// ---------- Tiempo real ----------
function subscribeRealtime() {
  supa
    .channel('realtime:ubicaciones')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ubicaciones_brigadas' }, payload => {
      const r = payload.new;
      const u = state.users.get(r.usuario_id);
      if (!u) {
        // usuario nuevo -> carga inicial, pero ligera
        initialLoad();
        return;
      }
      // actualizar marcador y trazo
      u.last = r;
      u.marker.setLatLng([r.latitud, r.longitud]);
      const latlngs = u.path.getLatLngs();
      latlngs.push([r.latitud, r.longitud]);
      // limitar a N últimos por usuario
      const maxN = Number(ui.tailPoints.value || 100);
      if (latlngs.length > maxN) latlngs.splice(0, latlngs.length - maxN);
      u.path.setLatLngs(latlngs);

      if (ui.follow.checked && state.selectedUid === r.usuario_id) {
        map.setView(u.marker.getLatLng());
      }
    })
    .subscribe();
}

// ---------- Bootstrap ----------
async function bootstrap() {
  try {
    setStatus('Conectando...', 'gray');
    initMap();
    await initialLoad(true);
    subscribeRealtime();
  } catch (e) {
    console.error(e);
    setStatus('Error al cargar', 'error');
  }
}

// Controles
ui.apply.addEventListener('click', () => initialLoad());
ui.clearBtn?.addEventListener('click', () => {
  state.pathLayer.clearLayers();
  state.users.forEach(u => {
    const latlng = u.marker.getLatLng();
    u.path.setLatLngs([latlng]);
  });
});

document.addEventListener('DOMContentLoaded', bootstrap);
