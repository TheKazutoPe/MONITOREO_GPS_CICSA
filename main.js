// === Config ===
const { DateTime } = luxon;
const SUPABASE_URL = (window.__ENV__ && window.__ENV__.SUPABASE_URL) || "";
const SUPABASE_ANON_KEY = (window.__ENV__ && window.__ENV__.SUPABASE_ANON_KEY) || "";
const TABLE = "ubicaciones_brigadas";
const RECENT_SECONDS = 60;     // offline si no llega nada en 60s
const STILL_METERS = 5;        // si movimiento <5m lo consideramos 'sin moverse'
let TAIL_POINTS = 100;         // puntos por usuario en polyline

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  alert("Faltan SUPABASE_URL o SUPABASE_ANON_KEY en config.js");
}

// === Supabase client ===
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// === Mapa ===
const map = L.map('map').setView([-12.0464, -77.0428], 12); // Lima centro
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap'
}).addTo(map);

// Iconos (ajusta tamaños si quieres el carro más grande)
const carOnline = L.icon({ iconUrl: './assets/carro-green.png', iconSize:[36,36], iconAnchor:[18,18] });
const carIdle   = L.icon({ iconUrl: './assets/carro-orange.png', iconSize:[36,36], iconAnchor:[18,18] });
const carOff    = L.icon({ iconUrl: './assets/carro-gray.png',  iconSize:[36,36], iconAnchor:[18,18] });

// Estado por usuario
const users = new Map(); // usuario_id -> { marker, poly, last, lastCoords, lastMovedAt, timer, animToken }
const userList = document.getElementById('userList');
const realtimeStatus = document.getElementById('realtimeStatus');
const lastRefresh = document.getElementById('lastRefresh');

function fmtPeru(ts) {
  // ts puede venir como ISO UTC; lo mostramos en America/Lima
  return DateTime.fromISO(ts, { zone: 'utc' }).setZone('America/Lima').toFormat('yyyy-LL-dd HH:mm:ss');
}

function distanceMeters(a, b) {
  // Haversine simple
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI/180;
  const dLon = (b.lon - a.lon) * Math.PI/180;
  const la1 = a.lat * Math.PI/180;
  const la2 = b.lat * Math.PI/180;
  const sinDLat = Math.sin(dLat/2), sinDLon = Math.sin(dLon/2);
  const h = sinDLat*sinDLat + Math.cos(la1)*Math.cos(la2)*sinDLon*sinDLon;
  return 2*R*Math.asin(Math.sqrt(h));
}

function statusPill(u) {
  const now = DateTime.now().toUTC();
  const last = DateTime.fromISO(u.last.timestamp).toUTC();
  const seconds = now.diff(last, 'seconds').seconds;
  const online = seconds <= RECENT_SECONDS;
  const movedRecently = u.lastMovedAt && now.diff(u.lastMovedAt, 'seconds').seconds <= RECENT_SECONDS;
  let cls = 'offline', txt = 'Offline';
  if (online && movedRecently) { cls = 'online'; txt = 'Online'; }
  else if (online) { cls = ''; txt = 'Inactivo'; }

  return `<span class="badge ${cls || ''}">${txt}</span>`;
}

function renderUserList() {
  const arr = [...users.entries()].map(([id, u]) => ({ id, ...u }));
  arr.sort((a,b)=> (a.last?.tecnico||'').localeCompare(b.last?.tecnico||''));
  userList.innerHTML = arr.map(u => {
    const name = [u.last?.tecnico, u.last?.brigada].filter(Boolean).join(' · ');
    const ts = u.last ? fmtPeru(u.last.timestamp) : '—';
    return `<li>
      <div>
        <div><strong>${name || 'Usuario ' + u.id}</strong></div>
        <div style="font-size:12px;color:#666">Lat: ${u.last?.latitud?.toFixed(6) ?? '—'} · Lon: ${u.last?.longitud?.toFixed(6) ?? '—'} · ${ts}</div>
      </div>
      ${statusPill(u)}
    </li>`;
  }).join('');
}

// ===== Animación suave del marcador =====
function easeInOutCubic(t) {
  return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
}

function animateMarker(marker, fromLatLng, toLatLng, duration = 800, tokenObj) {
  // tokenObj: referencia para cancelar si llega un nuevo punto
  const start = performance.now();
  const startLat = fromLatLng[0], startLng = fromLatLng[1];
  const dLat = toLatLng[0] - startLat, dLng = toLatLng[1] - startLng;
  const myToken = Symbol('anim');
  tokenObj.current = myToken;

  function step(now) {
    // Si se emitió un nuevo token, cancelar esta animación
    if (tokenObj.current !== myToken) return;

    const t = Math.min(1, (now - start) / duration);
    const k = easeInOutCubic(t);
    marker.setLatLng([startLat + dLat * k, startLng + dLng * k]);

    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      // Mini efecto "pop" al terminar (si existe el ícono)
      if (marker._icon) {
        marker._icon.style.transition = 'transform 220ms';
        marker._icon.style.transform = 'scale(1.08)';
        setTimeout(() => {
          if (marker._icon) marker._icon.style.transform = 'scale(1)';
        }, 220);
      }
    }
  }

  requestAnimationFrame(step);
}

// ========================================

function ensureUser(u) {
  let entry = users.get(u.usuario_id);
  if (!entry) {
    entry = {
      marker: L.marker([u.latitud, u.longitud], { icon: carOff }).addTo(map),
      poly: L.polyline([], { weight: 3, opacity: 0.8 }).addTo(map),
      last: null,
      lastCoords: null,
      lastMovedAt: null,
      timer: null,
      id: u.usuario_id,
      animToken: { current: null } // token para cancelar/encadenar animaciones
    };
    users.set(u.usuario_id, entry);
  }
  return entry;
}

function updateUser(u) {
  const e = ensureUser(u);
  const latlng = [u.latitud, u.longitud];

  // trayectoria (solo guardamos puntos, no animamos el trazo)
  const pts = e.poly.getLatLngs();
  pts.push(latlng);
  if (pts.length > TAIL_POINTS) pts.splice(0, pts.length - TAIL_POINTS);
  e.poly.setLatLngs(pts);

  // movimiento / actividad reciente
  const now = DateTime.now().toUTC();
  if (e.lastCoords) {
    const dist = distanceMeters({lat:e.lastCoords[0], lon:e.lastCoords[1]}, {lat:latlng[0], lon:latlng[1]});
    if (dist >= STILL_METERS) e.lastMovedAt = now;
  } else {
    e.lastMovedAt = now;
  }

  // ANIMACIÓN DEL MARCADOR
  if (e.lastCoords) {
    // si había una pos previa: animar desde lastCoords a latlng
    animateMarker(e.marker, e.lastCoords, latlng, 800, e.animToken);
  } else {
    // primera vez sin animación
    e.marker.setLatLng(latlng);
  }
  e.lastCoords = latlng;

  // icono y popup
  const movedRecently = e.lastMovedAt && now.diff(e.lastMovedAt, 'seconds').seconds <= RECENT_SECONDS;
  e.marker.setIcon(movedRecently ? carOnline : carIdle);
  const peruTs = fmtPeru(u.timestamp);
  const html = `<div>
    <strong>${u.tecnico || '—'}</strong><br/>
    Brigada: ${u.brigada || '—'}<br/>
    Zona: ${u.zona || '—'}<br/>
    ${peruTs}<br/>
    ${u.latitud.toFixed(6)}, ${u.longitud.toFixed(6)} · acc ${u.acc?.toFixed?.(1) ?? '—'} m · spd ${u.spd?.toFixed?.(1) ?? '—'} m/s
  </div>`;
  e.marker.bindPopup(html);

  e.last = u;

  // offline timer (si no llega nada en RECENT_SECONDS => icono gris)
  if (e.timer) clearTimeout(e.timer);
  e.timer = setTimeout(() => {
    e.marker.setIcon(carOff);
    renderUserList();
  }, RECENT_SECONDS * 1000);

  renderUserList();
}

// Filtros
const brigadaFilter = document.getElementById('brigadaFilter');
const minAcc = document.getElementById('minAcc');
const tailPoints = document.getElementById('tailPoints');
document.getElementById('applyFilters').addEventListener('click', () => {
  TAIL_POINTS = Math.max(10, Math.min(5000, parseInt(tailPoints.value || '100', 10)));
  loadInitial();
});

function setRealtimeStatus(ok) {
  if (ok) {
    realtimeStatus.textContent = 'Conectado';
    realtimeStatus.className = 'dot green';
  } else {
    realtimeStatus.textContent = 'Desconectado';
    realtimeStatus.className = 'dot red';
  }
}

// Carga inicial: último punto por usuario (y opcionalmente últimos N para polilínea)
async function loadInitial() {
  try {
    const filters = [];
    if (brigadaFilter.value) filters.push(`brigada=eq.${brigadaFilter.value}`);
    if (minAcc.value) filters.push(`acc=gte.${Number(minAcc.value)}`);
    // Traemos últimas 1000 filas recientes para reconstruir recorridos por usuario
    const url = new URL(`${SUPABASE_URL}/rest/v1/${TABLE}`);
    url.searchParams.set('select', 'usuario_id,tecnico,brigada,contrata,zona,cargo,latitud,longitud,timestamp,acc,spd');
    url.searchParams.set('order', 'timestamp.desc');
    url.searchParams.set('limit', '1000');
    if (filters.length) url.searchParams.set('and', `(${filters.join(',')})`);
    const resp = await fetch(url.toString(), {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Accept: 'application/json'
      }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const rows = await resp.json();

    // Limpiar estado actual
    users.forEach(u => {
      map.removeLayer(u.marker);
      map.removeLayer(u.poly);
    });
    users.clear();

    // Insertar del más antiguo al más nuevo para armar trazo y que la animación quede coherente
    rows.reverse().forEach(r => updateUser(r));

    // Ajustar vista al conjunto si hay puntos
    const all = [];
    users.forEach(u => { if (u.lastCoords) all.push(u.lastCoords); });
    if (all.length) {
      const bounds = L.latLngBounds(all);
      map.fitBounds(bounds.pad(0.2));
    }

    lastRefresh.textContent = 'Actualizado: ' + DateTime.now().setZone('America/Lima').toFormat('HH:mm:ss');
  } catch (e) {
    console.error('loadInitial error', e);
    lastRefresh.textContent = 'Error al cargar';
  }
}

// Realtime
let subscription;
async function startRealtime() {
  if (subscription) {
    sb.removeChannel(subscription);
    subscription = null;
  }
  subscription = sb
    .channel('realtime:ubicaciones_brigadas')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TABLE }, (payload) => {
      const r = payload.new;
      // filtros en cliente
      if (brigadaFilter.value && String(r.brigada || '') !== brigadaFilter.value) return;
      if (minAcc.value && Number(r.acc || 0) < Number(minAcc.value)) return;
      updateUser(r);
    })
    .subscribe((status) => {
      setRealtimeStatus(status === 'SUBSCRIBED');
    });
}

// Init
loadInitial();
startRealtime();
